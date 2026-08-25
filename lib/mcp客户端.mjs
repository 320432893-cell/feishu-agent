/**
 * 极简 MCP stdio 客户端：起一个 MCP server 子进程，做 JSON-RPC（initialize / tools/list / tools/call）。
 * 只读 bot 用它把 cmdb/inventory 的工具接进 agent。零依赖。
 *
 * **子进程死了必须立刻红**：exit/error/管道断 → 收尸：在等的请求全部拒掉、以后每次调用立刻拒、
 * 回调 on死 通知上层（bot 收到就退出，让守护把整个进程拉起来）。
 * 不这么做的后果实测过：子进程一死，调用要卡满超时才失败，而 bot 自己还活着——守护看不出问题、
 * 不重启，群里每条查询都挂但机器「绿着」。tests/mcp客户端.test.mjs 守着这条。
 */
import { spawn } from 'node:child_process';

/**
 * @param 超时毫秒 单次请求等多久（默认 120s：eval 里的重查询要用；bot 传 45s，短于它自己的 60s 整条超时）
 * @param on死 子进程没了时回调一次，参数是死因文本
 */
export function 起MCP(cmd, args = [], env = {}, { 超时毫秒 = 120000, on死 = null } = {}) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', 序 = 0; const 待 = new Map(); // id → {res, rej}
  let 死因 = null;

  function 收尸(因) {
    if (死因) return; // 只收一次（exit 和 stdin error 会一起来）
    死因 = 因;
    for (const { rej } of 待.values()) rej(new Error(因)); // 在等的全部立刻拒，别让它们干等超时
    待.clear();
    if (on死) { try { on死(因); } catch { /* 回调自己的事 */ } }
  }
  p.on('exit', (c, sig) => 收尸(`MCP 子进程退出（code=${c}${sig ? ` signal=${sig}` : ''}）：${cmd} ${args.join(' ')}`));
  p.on('error', (e) => 收尸(`MCP 子进程起不来：${e.message}`));
  p.stdin.on('error', (e) => 收尸(`MCP 管道断了：${e.message}`)); // 没这行，往死管道写会变成未捕获异常

  p.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const 等 = m.id !== undefined && 待.get(m.id);
      if (等) { 待.delete(m.id); 等.res(m); }
    }
  });

  // **单次可以放宽超时**（`这次超时`）。默认那道闸管的是「某个工具卡住了」，
  // 但少数工具本来就慢：`日更` 干跑实测热 29-33 秒、冷 43.6 秒，而默认闸是 45 秒 ——
  // 冷跑只剩 1.4 秒余量，必然翻车。整体调大是错的（那样一个真卡死的调用会留两分钟僵尸），
  // 所以只给知道自己慢的那几个调用单独放宽。**超时消息里带上用的是哪个数**，
  // 不然日志里两种超时长得一模一样，分不出是「工具卡死」还是「闸开小了」。
  const 发 = (method, params, 这次超时 = 超时毫秒) => new Promise((res, rej) => {
    if (死因) { rej(new Error(死因)); return; } // 死过之后不再往管道里写
    const id = ++序;
    const t = setTimeout(() => {
      if (待.has(id)) { 待.delete(id); rej(new Error(`MCP ${method} 超过 ${Math.round(这次超时 / 1000)} 秒没回`)); }
    }, 这次超时);
    待.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    try { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
    catch (e) { 待.delete(id); clearTimeout(t); rej(new Error(`MCP 写不进去：${e.message}`)); }
  });

  return {
    async 初始化() {
      await 发('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'feishu-agent', version: '1' } });
      if (死因) throw new Error(死因);
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    async 列工具() { const r = await 发('tools/list'); return r.result?.tools || []; },
    async 调工具(name, args, { 超时毫秒: 这次超时 } = {}) {
      const r = await 发('tools/call', { name, arguments: args || {} }, 这次超时 || 超时毫秒);
      if (r.error) return `工具出错：${r.error.message}`;
      const c = r.result?.content?.[0];
      return c?.text ?? JSON.stringify(r.result);
    },
    关() { try { p.kill(); } catch { /* 已退 */ } },
  };
}
