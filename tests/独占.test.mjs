/**
 * 「只准跑一个 bot」。守的是 2026-08-24 那次：两个 bot 同时订阅飞书事件，
 * **同一句话被答了两遍**，各烧一百多秒，而两边日志各看各的都正常、退出码都是 0。
 *
 * 这个模块最容易做错的方向不是「拦不住」，是「拦过头」——
 * 上次被 kill -9 留下的死锁文件如果不认，bot 就永远起不来了，那比重复跑还糟。
 * 所以两边都要测：**活着必须拒、死了必须放**。只认返回值，不打网、不起真进程。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { 能占吗, 默认还活着, 占住 } from '../lib/独占.mjs';

const 临 = mkdtempSync(join(tmpdir(), 'bot-lock-'));
let 挂 = 0, n = 0;
const eq = (得, 期, 说) => { n++; if (JSON.stringify(得) !== JSON.stringify(期)) { 挂++; console.log(`✗ ${说}｜得 ${JSON.stringify(得)} 期 ${JSON.stringify(期)}`); } else console.log(`✓ ${说}`); };
const 真 = (得, 说) => eq(!!得, true, 说);

const 都活着 = () => true;
const 都死了 = () => false;

// —— 纯判断：两个方向都必须测到 ——
{
  eq(能占吗('4242', 999, 都活着).能, false, '**锁里那个还活着 → 拒**（这是这个模块存在的理由）');
  eq(能占吗('4242', 999, 都活着).占着的, 4242, '拒的时候要说出是谁占着 —— 不然人不知道该 kill 谁');
  eq(能占吗('4242', 999, 都死了).能, true, '**锁里那个已经没了 → 放**（kill -9 留下的死锁不许把 bot 永远挡在外面）');
  eq(能占吗('', 999, 都活着).能, true, '空锁文件 → 放');
  eq(能占吗(null, 999, 都活着).能, true, '压根没有锁文件 → 放');
  eq(能占吗('这不是数字', 999, 都活着).能, true, '锁文件被写坏了 → 放（当成没有锁，不是当成有人占着）');
  eq(能占吗('0', 999, 都活着).能, true, 'pid 0 → 放（不是合法 pid）');
  eq(能占吗('-5', 999, 都活着).能, true, '负数 pid → 放');
  eq(能占吗('999', 999, 都活着).能, true, '锁里写的就是我自己 → 放（重入不该把自己挡住）');
}

// —— 默认的活性判断：进程在 **且** 命令行对得上，两条都要 ——
{
  真(默认还活着(process.pid, 'node'), '**我自己肯定活着**（命令行里有 node）—— 这条要是红的说明 ps 那套整个不工作了');
  eq(默认还活着(process.pid, '绝不可能出现在命令行里的字符串'), false,
    '**pid 在、但命令行对不上 → 当它不是我们的进程**（pid 会被系统回收给别的程序，只看 pid 在会把真 bot 永远挡在外面）');
  eq(默认还活着(2147480000, 'node'), false, '一个几乎不可能存在的 pid → 不活着（ps 退 1 且没输出 = 真没了，不是查不动）');
}

// —— 占住()：真读写文件 ——
{
  const 锁 = join(临, '子目录', 'bot.pid'); // 故意多一层，验它会自己建目录
  const a = 占住(锁, { 我的pid: 111, 还活着: 都活着 });
  真(a.ok, '第一个占得住');
  eq(readFileSync(锁, 'utf8'), '111', '占住之后 pid 写进了文件（后来的那个靠读它才知道该拒谁）');

  const b = 占住(锁, { 我的pid: 222, 还活着: 都活着 });
  eq(b.ok, false, '**第二个占不住**');
  eq(b.占着的, 111, '第二个知道是 111 占着');
  eq(readFileSync(锁, 'utf8'), '111', '被拒的那个**不许把锁文件改成自己** —— 改了的话真正在跑的那个就丢了标记');

  const c = 占住(锁, { 我的pid: 222, 还活着: 都死了 });
  真(c.ok, '111 已经没了 → 222 接管');
  eq(readFileSync(锁, 'utf8'), '222', '接管之后锁文件换成新 pid');
}

// —— 锁写不进去：**放行但要喊**。缓存目录不可写不该让 bot 起不来 ——
{
  const 只读目录 = join(临, '只读');
  mkdirSync(只读目录, { recursive: true });
  writeFileSync(join(只读目录, 'bot.pid'), '');
  chmodSync(只读目录, 0o500); // 能进能读，不能写
  const r = 占住(join(只读目录, 'bot.pid'), { 我的pid: 333, 还活着: 都活着 });
  真(r.ok, '**锁写不进去也放行** —— 一个缓存目录不可写不该让 bot 整个起不来（代价是这一轮没保护，日志里会喊）');
  chmodSync(只读目录, 0o700);
}

// —— 接线检查：bot.mjs 真的调了它，而且在起 MCP 之前 ——
// 光有模块没接线 = 这些判据全绿而线上照样能跑两个。上次「⏹ 停」就是这么 100% 不工作的。
{
  const 源 = readFileSync(new URL('../bot.mjs', import.meta.url), 'utf8');
  const 占的位置 = 源.indexOf('占住(');
  const 起MCP位置 = 源.indexOf("起只读('/Users");
  真(占的位置 > 0, 'bot.mjs 里真的调了 占住() —— 不调的话这个文件只是摆设');
  真(起MCP位置 > 0, '找得到起 MCP 那一行（找不到说明它被改写了，下面这条判据当场失效，得跟着改）');
  真(占的位置 < 起MCP位置,
    '**占锁排在起 MCP 之前** —— 排后面的话第二个 bot 会先拉起两个子进程、预热同一批 31 张飞书表，那正是上次把查询从 15 秒拖到 112 秒的原因');
  真(/process\.exit\(1\)/.test(源.slice(占的位置, 占的位置 + 800)), '占不住要 exit(1)，不是打一行日志接着跑');
}

rmSync(临, { recursive: true, force: true });
console.log(`\n检查了 ${n} 条判据，失败 ${挂}`);
process.exit(挂 ? 1 : 0);
