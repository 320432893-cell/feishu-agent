/**
 * 测试用假 MCP server（不打网、不碰真数据）：
 *   node 假MCP.mjs      → 正常应答 initialize / tools/list / tools/call
 *   node 假MCP.mjs 死   → 一起来就退出（模拟子进程崩了）
 *   调 tools/call 且工具名是「中途死」→ 不回复直接退出（模拟正在等结果时子进程崩了）
 *   调 tools/call 且工具名是「不回」  → 活着但永不回复（模拟卡死，验超时）
 */
if (process.argv[2] === '死') process.exit(3);

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue; // 通知（notifications/initialized）不回
    if (m.method === 'tools/call' && m.params?.name === '中途死') process.exit(4); // 不回复，直接死
    if (m.method === 'tools/call' && m.params?.name === '不回') continue;          // 活着，但这条永不回复
    const result = m.method === 'tools/list'
      ? { tools: [{ name: '查库存', description: '查', inputSchema: { type: 'object', properties: {} } }] }
      : m.method === 'tools/call' ? { content: [{ type: 'text', text: '假结果' }] }
        : { protocolVersion: '2024-11-05' };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
  }
});
