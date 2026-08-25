/**
 * 流式（SSE）重组测试。mock fetch 返回一个分片的 event-stream，验：
 *  ① content 增量拼全 + onDelta 每次拿到「累积」文本（不是单片）
 *  ② tool_calls 分片（id/name/arguments 拆在不同片）按 index 归并拼回
 *  ③ 一个 data: 行被拆在两次 read 之间（TCP 边界）也能拼对——这是流式解析最容易漏的坑
 * 只认退出码。不打网。
 */
import { 问模型 } from '../lib/模型.mjs';

// 把若干「原始字节块」做成 fetch 返回体；每个块是一段字符串（可能跨行、可能切在 JSON 中间）
function 造流(块们) {
  let i = 0;
  return {
    ok: true, status: 200,
    body: { getReader: () => ({
      read: async () => (i < 块们.length ? { done: false, value: new TextEncoder().encode(块们[i++]) } : { done: true }),
    }) },
  };
}
/** 造一个「永远不吐第一个字」的响应体：模拟模型挂了但连接还开着。read() 永不 resolve，只认 abort。 */
function 造哑流(signal) {
  return {
    ok: true,
    status: 200,
    body: { getReader: () => ({
      read: () => new Promise((_, rej) => {
        if (signal) signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
      }),
    }) },
  };
}
const data = (o) => `data: ${JSON.stringify(o)}\n`;
const 片 = (delta) => data({ choices: [{ delta }] });

let 挂 = 0, n = 0;
const 真 = (得, 说) => { n++; if (!得) { 挂++; console.log(`✗ ${说}`); } else console.log(`✓ ${说}`); };
const eq = (得, 期, 说) => { n++; if (JSON.stringify(得) !== JSON.stringify(期)) { 挂++; console.log(`✗ ${说}｜得 ${JSON.stringify(得)} 期 ${JSON.stringify(期)}`); } else console.log(`✓ ${说}`); };

const 配 = { base: 'b', key: 'k', models: ['M'], messages: [{ role: 'user', content: 'hi' }] };

// ① content 增量 + onDelta 累积
{
  globalThis.fetch = async () => 造流([片({ content: '你好' }), 片({ content: '，世界' }), 片({ content: '！' }), 'data: [DONE]\n']);
  const 累积 = [];
  const msg = await 问模型({ ...配, onDelta: (t) => 累积.push(t) });
  eq(msg.content, '你好，世界！', '① content 拼全');
  eq(累积, ['你好', '你好，世界', '你好，世界！'], '① onDelta 每次拿到累积（非单片）');
  真(msg._model === 'M', '① 带回用的模型');
}

// ② tool_calls 分片归并（name 一片、arguments 拆两片）
{
  globalThis.fetch = async () => 造流([
    片({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'cmdb_透视', arguments: '' } }] }),
    片({ tool_calls: [{ index: 0, function: { arguments: '{"资产类型":"整' } }] }),
    片({ tool_calls: [{ index: 0, function: { arguments: '机","机型":"CPU"}' } }] }),
    'data: [DONE]\n',
  ]);
  const msg = await 问模型({ ...配, onDelta: () => {} });
  真(msg.tool_calls?.length === 1, '② 归并成 1 个 tool_call');
  eq(msg.tool_calls[0].id, 'call_1', '② id 归并');
  eq(msg.tool_calls[0].function.name, 'cmdb_透视', '② name 归并');
  eq(JSON.parse(msg.tool_calls[0].function.arguments), { 资产类型: '整机', 机型: 'CPU' }, '② arguments 三片拼回合法 JSON');
}

// ③ 一个 data: 行被切在两次 read 之间（跨块边界）
{
  const 整 = 片({ content: 'ABC' });         // "data: {...}\n"
  const 切 = Math.floor(整.length / 2);
  globalThis.fetch = async () => 造流([整.slice(0, 切), 整.slice(切), 'data: [DONE]\n']); // 从中间劈开
  const msg = await 问模型({ ...配, onDelta: () => {} });
  eq(msg.content, 'ABC', '③ 跨 read 边界的半行能缓冲拼对');
}

// ④ 多个 data: 行挤在一个块里
{
  globalThis.fetch = async () => 造流([片({ content: 'X' }) + 片({ content: 'Y' }) + 片({ content: 'Z' }), 'data: [DONE]\n']);
  const msg = await 问模型({ ...配, onDelta: () => {} });
  eq(msg.content, 'XYZ', '④ 一个块里多行都解析到');
}

// ⑤ 首字节闸：模型一个字都不吐 → 必须在首字节超时内判死并换下一个，不许陪它耗满 30 秒总超时
//    这条守的是 2026-08-21 那次 GLM 整个挂掉：原来每轮白等 30 秒，一条查询 63 秒在等死模型。
{
  process.env.AGENT_FIRST_BYTE_MS = '300';
  const { 问模型: 问2, _熔断状态 } = await import('../lib/模型.mjs?首字节验证=1'); // 重新载，让新的 env 生效
  _熔断状态().clear();
  let 打过谁 = [];
  globalThis.fetch = async (url, opt) => {
    const m = JSON.parse(opt.body).model;
    打过谁.push(m);
    if (m === '哑巴') return 造哑流(opt.signal);          // 永远不吐字
    return 造流([片({ content: '备用答了' }), 'data: [DONE]\n']);
  };
  const t = Date.now();
  const msg = await 问2({ base: 'b', key: 'k', models: ['哑巴', '备用'], messages: [{ role: 'user', content: 'hi' }], onDelta: () => {} });
  const 用了 = Date.now() - t;
  eq(msg.content, '备用答了', '⑤ 首字节闸：哑巴模型被跳过，备用模型答的');
  eq(打过谁, ['哑巴', '备用'], '⑤ 首字节闸：两个都打了，顺序对');
  真(用了 < 3000, `⑤ 首字节闸：${用了}ms 就切走了（闸设 300ms；没这条闸要等 30000ms）`);
  delete process.env.AGENT_FIRST_BYTE_MS;
}

// ⑥ finish_reason / usage 要从**流式**里捞出来。
// 这条单独钉住是因为：生产走流式、而 agent.test.mjs 走的是非流式那条路 ——
// 只在那边验，等于「答案被砍断」这件事在真实路径上一条测试都没有。
// 形状照 2026-08-22 实测的网关原样：finish_reason 在最后一块的 choices[0]（delta 是空对象），usage 在顶层。
{
  globalThis.fetch = async () => 造流([
    片({ content: '闵行 85,093' }),
    data({ choices: [{ index: 0, finish_reason: 'length', delta: {} }], usage: { prompt_tokens: 19, completion_tokens: 3000, completion_tokens_details: { text_tokens: 1501, reasoning_tokens: 1499 } } }),
    'data: [DONE]\n',
  ]);
  const msg = await 问模型({ ...配, onDelta: () => {} });
  eq(msg._finish, 'length', '⑥ 流式：finish_reason 从最后一块捞出来（agent 据此标「答案被砍断」）');
  eq(msg._usage?.completion_tokens, 3000, '⑥ 流式：usage 从顶层捞出来');
  eq(msg._usage?.completion_tokens_details?.reasoning_tokens, 1499, '⑥ 流式：思考 token 也拿到（短问题里它占九成）');
  eq(msg.content, '闵行 85,093', '⑥ 流式：捞这两个字段没影响正文拼接');
}
{
  globalThis.fetch = async () => 造流([片({ content: 'ok' }), 'data: [DONE]\n']);
  const msg = await 问模型({ ...配, onDelta: () => {} });
  eq(msg._finish, null, '⑥ 流式：网关没给 finish_reason 就是 null，不许瞎猜成 length');
  eq(msg._usage, null, '⑥ 流式：没给 usage 就是 null');
}

console.log(`\n检查了 ${n} 条判据，失败 ${挂} 项`);
process.exit(挂 ? 1 : 0);
