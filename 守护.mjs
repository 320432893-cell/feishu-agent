/**
 * 进程守护：起 bot.mjs，崩了/退了自动重启（退避防崩溃循环）。这是最外层——bot 整个挂了它拉起来。
 * **持久日志**：bot 的 stdout/stderr 落到 `~/.cache/feishu-agent/logs/bot-YYYY-MM-DD.log`（按天切、留 14 天），
 * 重启不丢、出问题可追溯（[收到]/[答复]/[出错] 都在里面）。同时也回显到控制台。
 * 开机自启：让 OS 启动这个脚本即可（Mac=launchd、Windows=任务计划程序，见 部署.md）。
 * 用法：node 守护.mjs
 */
import { spawn } from 'node:child_process';
import { 同伴 } from './lib/资源位置.mjs';
import { join } from 'node:path';
import { mkdirSync, createWriteStream, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';

// bot 在哪：跟守护同目录（源码跑是仓库根，打包后两个产物放一块）。
// 不用 import.meta.url 算——打包后它指向 dist/ 里被内联掉的原始路径，起不来 bot 而且不好查。
const 日志目录 = process.env.BOT_LOG_DIR || join(homedir(), '.cache', 'feishu-agent', 'logs');
mkdirSync(日志目录, { recursive: true });

// 本地日期，不是 UTC：toISOString 是 UTC，东八区下午 4 点之后就滚进"明天"的文件，
// 反过来凌晨起的 bot 会把一整天写进昨天那个名字里（实测 08-21 00:51 起的进程写的是 bot-2026-08-20.log）。
const 今日 = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const 今日日志 = () => join(日志目录, `bot-${今日()}.log`);
function 清旧日志(留几天 = 14) {
  try {
    const fs = readdirSync(日志目录).filter((f) => /^bot-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
    for (const f of fs.slice(0, -留几天)) rmSync(join(日志目录, f)); // 只删按这个名字生成的旧日志
  } catch { /* 清不动不影响 */ }
}

let 延时 = 2000;
function 起bot() {
  清旧日志();
  let 流 = createWriteStream(今日日志(), { flags: 'a' });
  let 流日期 = 今日();
  // 跨零点要换文件：不换的话，连着跑几周的 bot 会把所有日志堆进开机那天那一个文件，
  // 而 清旧日志 只在 bot 重启时跑一次，等于永远清不到它。
  const 记 = (s) => {
    try {
      if (今日() !== 流日期) { 流.end(); 流 = createWriteStream(今日日志(), { flags: 'a' }); 流日期 = 今日(); 清旧日志(); }
      流.write(s);
    } catch { /* 落盘失败别拖垮 */ }
    process.stderr.write(s);
  };
  const p = spawn(process.execPath, [同伴('bot.mjs')], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => 记(d.toString()));
  p.stderr.on('data', (d) => 记(d.toString()));
  const 起时 = Date.now();
  p.on('exit', (c) => {
    const 活了 = Date.now() - 起时;
    延时 = 活了 > 60000 ? 2000 : Math.min(延时 * 2, 60000); // 稳跑过 1 分钟才清退避；否则退避，防"起来就崩"死循环刷屏
    记(`[守护] bot 退出 code=${c}，活了 ${Math.round(活了 / 1000)}s，${延时 / 1000}s 后重启\n`);
    流.end();
    setTimeout(起bot, 延时);
  });
  p.on('error', (e) => 记('[守护] 起 bot 失败：' + e.message + '\n'));
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
起bot();
process.stderr.write(`[守护] 起来了，盯着 bot——崩了自动重启。日志落 ${日志目录}/bot-YYYY-MM-DD.log（留 14 天）\n`);
