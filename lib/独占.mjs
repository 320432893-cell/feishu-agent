/**
 * **只准跑一个 bot。**
 *
 * 2026-08-24 真踩到：机器上同时跑着两个 bot（一个是守护的亲儿子，一个是手工 nohup 起的），
 * 两个都订阅了同一批飞书事件，于是**同一句话被答了两遍**，各烧一百多秒。
 * 最糟的是**哪儿都不红**：两边日志各自看都正常，退出码 0，飞书那头也不报错 ——
 * 只有人在群里看到两条回复才知道。典型的「坏了但看起来是绿的」。
 *
 * 为什么用 pid 文件而不是端口/信号量：bot 不监听任何端口，pid 文件是唯一不用引入依赖的办法。
 * **光有文件不算数，必须验它还活着** —— 上次被 kill -9 的话文件还在，那把锁会永远卡住谁都起不来。
 * 而只验「pid 存在」也不够：pid 会被系统回收给别的进程，所以还要看它的命令行像不像我们。
 */
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

/**
 * **纯判断**：给锁文件里的内容 + 我自己的 pid + 一个「那个 pid 还活着吗」的函数，决定能不能占。
 * 抽出来是为了能双向验 —— 「活着就必须拒」和「死了就必须放」两边都得测到。
 * @returns {{能:boolean, 占着的?:number, 因为:string}}
 */
export function 能占吗(锁文本, 我的pid, 还活着) {
  const pid = Number(String(锁文本 ?? '').trim());
  if (!Number.isInteger(pid) || pid <= 0) return { 能: true, 因为: '锁文件是空的/不是个 pid' };
  if (pid === 我的pid) return { 能: true, 因为: '锁里写的就是我自己' };
  if (!还活着(pid)) return { 能: true, 因为: `锁里写的 ${pid} 已经不在了（上次没退干净）` };
  return { 能: false, 占着的: pid, 因为: `${pid} 还活着，它才是正在跑的那个` };
}

/**
 * 默认的「还活着吗」：**进程在 + 命令行里有这个特征串**，两条都要。
 * 只看进程在的话，pid 被系统回收给别的程序时会误判成「bot 还在跑」，于是真的 bot 再也起不来。
 * 查不动（ps 不给、权限不够）时返回 **true = 保守当它活着** —— 宁可多起不来一次让人看见，
 * 也不要悄悄放行第二个进程，因为后者不报错。
 */
export function 默认还活着(pid, 特征 = 'bot.mjs') {
  try {
    // stderr 丢掉：pid 不存在/超范围时 ps 会往 stderr 抱怨一句，那会原样漏进 bot 的启动日志。
    const 命令行 = execFileSync('ps', ['-p', String(pid), '-o', 'command='],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return 命令行.includes(特征);
  } catch (e) {
    // ps 对不存在的 pid 退非 0 且不输出 —— 那是「真没了」，不是「查不动」
    if (e && e.status === 1 && !String(e.stdout || '').trim()) return false;
    process.stderr.write(`[独占] 查 pid ${pid} 查不动（${String(e?.message).slice(0, 60)}）——保守当它还活着\n`);
    return true;
  }
}

/**
 * 占锁。占得住就写下自己的 pid 并挂上退出时清理；占不住返回谁占着。
 * **写不进去也要占得住**（返回 ok 但喊一声）：锁写不了顶多退化成没有保护，
 * 不该因为一个缓存目录不可写就让 bot 起不来。
 * @returns {{ok:boolean, 占着的?:number, 因为:string}}
 */
export function 占住(锁路径, { 我的pid = process.pid, 还活着 = 默认还活着 } = {}) {
  let 原有 = '';
  try { 原有 = readFileSync(锁路径, 'utf8'); } catch { /* 没有锁文件=没人占 */ }
  const 判 = 能占吗(原有, 我的pid, 还活着);
  if (!判.能) return { ok: false, 占着的: 判.占着的, 因为: 判.因为 };
  try {
    mkdirSync(dirname(锁路径), { recursive: true });
    writeFileSync(锁路径, String(我的pid));
  } catch (e) {
    process.stderr.write(`[独占] ⚠ 锁文件写不进去（${String(e?.message).slice(0, 80)}）——`
      + `**这一轮没有「只准跑一个」的保护**，别再手工起第二个\n`);
    return { ok: true, 因为: '锁写不进去，放行但没保护' };
  }
  const 松开 = () => { try { if (readFileSync(锁路径, 'utf8').trim() === String(我的pid)) unlinkSync(锁路径); } catch { /* 松不开就算了，下次靠活性判断 */ } };
  process.on('exit', 松开);
  for (const 信号 of ['SIGTERM', 'SIGINT']) process.on(信号, () => { 松开(); process.exit(0); });
  return { ok: true, 因为: 判.因为 };
}
