/**
 * MCP 客户端测试：守「子进程死了必须立刻红，不许干等超时」这个洞。
 * 原来的洞：MCP server 崩了之后，客户端不知道——每个调用都要卡满超时才失败，bot 进程自己还活着，
 * 守护看不出问题、不重启，群里每条查询都挂但机器「绿着」。
 * 正反双向：① 正常路径必须绿（不然这套断言本身没意义）；②③④ 死了必须 3 秒内红。
 * 只认退出码。不打网。
 */
import { fileURLToPath } from 'node:url';
import { 起MCP } from '../lib/mcp客户端.mjs';

// 必须 fileURLToPath：路径里有中文，URL.pathname 会给出百分号编码的串，spawn 出去找不到文件。
const 假 = fileURLToPath(new URL('./假MCP.mjs', import.meta.url));
let 挂 = 0, n = 0;
const 真 = (得, 说) => { n++; if (!得) { 挂++; console.log(`✗ ${说}`); } else console.log(`✓ ${说}`); };
const eq = (得, 期, 说) => { n++; if (得 !== 期) { 挂++; console.log(`✗ ${说}｜得 ${JSON.stringify(得)} 期 ${JSON.stringify(期)}`); } else console.log(`✓ ${说}`); };
const 抓 = async (f) => { try { await f(); return null; } catch (e) { return e; } };

// —— ① 正常路径必须绿（反向验：这套断言不是恒红的）——
{
  const c = 起MCP(process.execPath, [假]);
  await c.初始化();
  const ts = await c.列工具();
  真(ts.length === 1 && ts[0].name === '查库存', '正常：列到工具');
  eq(await c.调工具('查库存', {}), '假结果', '正常：调工具拿到结果');
  c.关();
}

// —— ② 一起来就死：初始化必须立刻报错，不是等满超时 ——
{
  const t0 = Date.now();
  const d = 起MCP(process.execPath, [假, '死']);
  const 错 = await 抓(() => d.初始化());
  真(错 !== null, '起来就死：初始化报错（不是静默成功）');
  真(Date.now() - t0 < 3000, `起来就死：3 秒内失败（实际 ${Date.now() - t0}ms，旧代码要等满超时）`);
  真(/退出|起不来|管道|断/.test(错?.message || ''), `起来就死：错误说清是进程没了（得到「${错?.message}」）`);
}

// —— ③ 正在等结果时子进程崩了：在等的那个请求必须立刻被拒 ——
{
  const e = 起MCP(process.execPath, [假]);
  await e.初始化();
  const t0 = Date.now();
  const 错 = await 抓(() => e.调工具('中途死', {}));
  真(错 !== null, '中途死：在等的请求被拒（不是永远挂着）');
  真(Date.now() - t0 < 3000, `中途死：3 秒内被拒（实际 ${Date.now() - t0}ms）`);

  // —— ④ 死过之后再调，立刻拒，不再往死管道写 ——
  const 错2 = await 抓(() => e.列工具());
  真(错2 !== null, '死过之后：后续调用立刻拒');
}

// —— ⑤ on死 回调必须被触发（bot 靠它退出、让守护把整个进程拉起来）——
{
  let 收到 = null;
  const f = 起MCP(process.execPath, [假, '死'], {}, { on死: (因) => { 收到 = 因; } });
  await 抓(() => f.初始化());
  await new Promise((r) => setTimeout(r, 200));
  真(typeof 收到 === 'string' && 收到.length > 0, `on死：回调收到死因（「${收到}」）`);
}

// —— ⑥ 超时可配：给 300ms，卡住的调用要在 300ms 后红（不是 120 秒）——
{
  const g = 起MCP(process.execPath, [假], {}, { 超时毫秒: 300 });
  await g.初始化();
  const t0 = Date.now();
  const 错 = await 抓(() => g.调工具('不回', {})); // 假 server 对这个工具名永不回复
  真(错 !== null && Date.now() - t0 < 2000, `超时可配：300ms 超时真的生效（实际 ${Date.now() - t0}ms）`);
  g.关();
}

console.log(`\n检查了 ${n} 条判据，失败 ${挂}`);
process.exit(挂 ? 1 : 0);
