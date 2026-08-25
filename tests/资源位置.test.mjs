/**
 * 守「位置不许从代码所在处推出来」这条不变量（`lib/资源位置.mjs`）。
 *
 * 为什么要棘轮：`import.meta.url` 写起来太顺手，加一个不会报错——源码跑得好好的，
 * 只有打包成单文件、拷到那台 Windows 上才炸。这个仓库炸的方式尤其安静：
 * `.creds.json` 读不到 → 换不到飞书 token → **静默退回慢的 lark-cli**（3.5s/条 vs 0.4s），
 * 或者模型 key 读不到、bot 起不来。所以必须在提交档挡住。
 *
 * 只认退出码。
 */
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { 入口目录, 候选, 凭证档, 同伴 } from '../lib/资源位置.mjs';

let 挂 = 0;
const ok = (c, s) => { if (!c) { 挂++; console.log('✗ ' + s); } else console.log('✓ ' + s); };
const 仓库根 = dirname(dirname(fileURLToPath(import.meta.url))); // 只测试里用：定位被测仓库

ok(入口目录() === dirname(process.argv[1]), '入口目录 = 正在跑的入口所在目录，不是某个模块的位置');

// 把模块搬到别处再 import —— 这就是"打包后换了个家"的模拟
const 临 = mkdtempSync(join(tmpdir(), 'wz-'));
try {
  writeFileSync(join(临, 'x.mjs'), readFileSync(join(仓库根, 'lib', '资源位置.mjs'), 'utf8'));
  const 搬家后 = await import(join(临, 'x.mjs'));
  ok(搬家后.入口目录() === 入口目录(), '模块搬到别的目录后入口目录不变 —— 这正是 import.meta.url 做不到的');
  ok(搬家后.同伴('bot.mjs') === 同伴('bot.mjs'), '同伴脚本的位置也不受模块搬家影响（守护靠它找 bot）');
} finally { rmSync(临, { recursive: true, force: true }); }

const 旧 = { ...process.env };
try {
  delete process.env.AGENT_HOME;
  const c1 = 候选('.creds.json');
  ok(c1[0] === join(入口目录(), '.creds.json'), '没设 AGENT_HOME 时第一顺位是入口旁边');
  ok(c1.some((p) => p === join(homedir(), '.config', 'feishu-agent', '.creds.json')), '兜底含用户级配置目录');
  process.env.AGENT_HOME = '/tmp/家';
  ok(候选('.creds.json')[0] === '/tmp/家/.creds.json', 'AGENT_HOME 设了就排第一');
} finally { process.env = 旧; }

// 凭证档：有就用那份、没有才给第一顺位新建。写入方靠这条别在错的位置新建（改完不生效还不报错）
ok(existsSync(凭证档()) || 凭证档() === 候选('.creds.json')[0],
  '凭证档 = 已存在的那份，一个都没有才给第一顺位（供新建）');

// ---------- 棘轮：非测试代码里不许再出现 import.meta.url ----------
const 去注释 = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
const 犯规 = [];
let 扫过 = 0;
for (const d of ['.', 'lib']) {
  for (const f of readdirSync(join(仓库根, d))) {
    if (!f.endsWith('.mjs') || f === 'eslint.config.mjs') continue;
    扫过++;
    if (/import\.meta\.url/.test(去注释(readFileSync(join(仓库根, d, f), 'utf8')))) 犯规.push(join(d, f));
  }
}
ok(犯规.length === 0,
  `非测试代码里 0 处 import.meta.url（实际 ${犯规.length}${犯规.length ? '：' + 犯规.join(' ') : ''}）—— 找文件走 资源位置.mjs`);
ok(扫过 >= 10, `棘轮真扫了 ${扫过} 个 .mjs（0 或明显偏小 = 没检查，不是没问题）`);

console.log(挂 ? `\n${挂} 挂` : '\n全过');
process.exit(挂 ? 1 : 0);
