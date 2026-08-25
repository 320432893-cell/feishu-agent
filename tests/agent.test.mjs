/**
 * agent 循环 + 模型 fallback + config 测试。mock 掉 fetch（不打真 API）、注入假 MCP。只认退出码。
 * 守的洞：写工具必须被白名单挡掉、坏参数不能默默空跑、CSV 要检测到、fallback 要换模型、上下文要带进去。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { 跑一句 } from '../lib/agent.mjs';
import { 问模型, _熔断状态 } from '../lib/模型.mjs';
import { 读配置, 读提醒chat } from '../config.mjs';

// —— mock fetch ——
let 请求记录 = []; let 脚本 = []; let 坏模型 = new Set(); let 应答前钩子 = null;
globalThis.fetch = async (url, opt) => {
  const body = JSON.parse(opt.body);
  请求记录.push(body);
  if (应答前钩子) 应答前钩子(); // 测「模型回来的路上被取消」用
  if (坏模型.has(body.model)) return { status: 500, text: async () => JSON.stringify({ error: { message: 'model down' } }) };
  // 脚本项里的 _finish/_usage 是**响应级**字段（不在 message 里），要抬到 choices[0] 和顶层，
  // 否则测的就不是网关真实的形状了。真实形状见 scratchpad/探流式字段.mjs 的实测输出。
  const { _finish = null, _usage = null, ...msg } = 脚本.shift() || { content: '(脚本空了)' };
  return { status: 200, text: async () => JSON.stringify({ choices: [{ message: msg, finish_reason: _finish }], usage: _usage }) };
};

let 挂 = 0, n = 0;
const eq = (得, 期, 说) => { n++; if (JSON.stringify(得) !== JSON.stringify(期)) { 挂++; console.log(`✗ ${说}｜得 ${JSON.stringify(得)} 期 ${JSON.stringify(期)}`); } else console.log(`✓ ${说}`); };
const 真 = (得, 说) => eq(!!得, true, 说);

let 调了 = [];
const 假MCP = {
  列工具: async () => [
    { name: '查库存', description: '查', inputSchema: { type: 'object', properties: { 型号: { type: 'string' } } } },
    { name: '写占用', description: '写', inputSchema: { type: 'object', properties: {} } }, // 写工具，必须被白名单挡
  ],
  调工具: async (name, args) => { 调了.push({ name, args }); return name === '查库存' ? '闵行 21406，明细已导出到 /Users/x/明细.csv' : 'wrote'; },
};
const 模型配置 = { base: 'b', key: 'k', models: ['M'] };
const 跑 = (问, 历史) => 跑一句(问, { 模型配置, MCP们: [{ 前缀: 'inv', client: 假MCP }], 历史 });

// —— 模型 fallback ——
{ 坏模型 = new Set(['A']); 脚本 = [{ content: 'ok' }]; 请求记录 = [];
  const m = await 问模型({ base: 'b', key: 'k', models: ['A', 'B'], messages: [{ role: 'user', content: 'hi' }] });
  真(m._model === 'B' && m.content === 'ok', 'fallback：A 挂 → 自动用 B');
  坏模型 = new Set();
}

// —— 熔断：挂过的模型不再每轮重试（2026-08-21 GLM 整个挂掉，每轮白等 30 秒，一条查询 63 秒在等死模型）——
{
  _熔断状态().clear();
  坏模型 = new Set(['A']); 脚本 = [{ content: 'ok' }, { content: 'ok2' }]; 请求记录 = [];
  await 问模型({ base: 'b', key: 'k', models: ['A', 'B'], messages: [{ role: 'user', content: 'hi' }] });
  eq(请求记录.length, 2, '熔断：第一次照常试 A（挂）再试 B');
  真(_熔断状态().has('A'), '熔断：A 被记上了');
  请求记录 = [];
  const m2 = await 问模型({ base: 'b', key: 'k', models: ['A', 'B'], messages: [{ role: 'user', content: 'hi' }] });
  eq(请求记录.length, 1, '熔断：第二次直接跳过 A，只打了 B 一次（这就是省下来的 30 秒）');
  eq(m2._model, 'B', '熔断：答案来自 B');
  // 冷却到期要能自己恢复，否则模型活过来还得重启 bot
  _熔断状态().set('A', Date.now() - 1); 坏模型 = new Set(); 脚本 = [{ content: 'A活了' }]; 请求记录 = [];
  const m3 = await 问模型({ base: 'b', key: 'k', models: ['A', 'B'], messages: [{ role: 'user', content: 'hi' }] });
  eq(m3._model, 'A', '熔断：冷却过期后自动再试 A，活了就用它');
  真(!_熔断状态().has('A'), '熔断：成功一次就撤销记录');
  _熔断状态().clear();
}

// —— 白名单 + 派发 + CSV + 用的模型 ——
{ 请求记录 = []; 调了 = [];
  脚本 = [{ tool_calls: [{ id: '1', function: { name: 'inv_查库存', arguments: '{"型号":"400G"}' } }] }, { content: '闵行 21406' }];
  const r = await 跑('查400G');
  eq(r.回答, '闵行 21406', '派发：拿到最终答案');
  真(r.用了.includes('查库存'), '派发：调了查库存');
  真(调了.some((c) => c.name === '查库存' && c.args.型号 === '400G'), '派发：工具收到正确参数');
  eq(r.csv路径们, ['/Users/x/明细.csv'], 'CSV：从工具结果里检测到路径');
  eq(r.用的模型, 'M', '记录：用了哪个模型');
  const tools = 请求记录[0].tools || [];
  真(tools.some((t) => t.function.name === 'inv_查库存'), '白名单：只读工具给了模型');
  真(!tools.some((t) => t.function.name === 'inv_写占用'), '白名单：写工具没给模型（结构挡死）');
}

// —— 一轮里好几个工具各导出一张表，一张都不许丢 ——
// 2026-08-22 你问「闵行的光模块和网卡各多少」时没踩到（网卡没超 40 行、压根没导出），
// 但两边都超阈值时就会踩：原来 csv路径 是标量、在 Promise.all 的回调里赋值，
// **后跑完的覆盖先跑完的、谁先跑完还不确定**，人收到一张、另一张静默消失。
{ 请求记录 = []; 调了 = [];
  const 两表MCP = {
    列工具: async () => [{ name: '查库存', description: '查', inputSchema: { type: 'object', properties: { 资产类型: { type: 'string' } } } }],
    调工具: async (名, args) => `${args.资产类型} 共 N 根，明细见 ~/.cache/inventory-mcp/导出/明细-${args.资产类型}-2026.csv`,
  };
  脚本 = [
    { tool_calls: [
      { id: 'a', function: { name: 'inv_查库存', arguments: '{"资产类型":"光模块"}' } },
      { id: 'b', function: { name: 'inv_查库存', arguments: '{"资产类型":"网卡"}' } },
    ] },
    { content: '光模块 85093、网卡 4235' },
  ];
  const r = await 跑一句('闵行的光模块和网卡各多少', { 模型配置, MCP们: [{ 前缀: 'inv', client: 两表MCP }] });
  eq(r.csv路径们.length, 2, 'CSV：两个工具各导一张 → **两张都收着**（原来只剩最后跑完的那张）');
  真(r.csv路径们.some((x) => x.includes('光模块')) && r.csv路径们.some((x) => x.includes('网卡')),
    'CSV：两张分别是光模块和网卡，不是同一张的两份');
}
{ 请求记录 = []; 调了 = [];
  const 重复MCP = {
    列工具: async () => [{ name: '查库存', description: '查', inputSchema: { type: 'object', properties: {} } }],
    调工具: async () => '明细见 ~/x.csv，再说一遍：~/x.csv',
  };
  脚本 = [{ tool_calls: [{ id: '1', function: { name: 'inv_查库存', arguments: '{}' } }] }, { content: 'ok' }];
  const r = await 跑一句('x', { 模型配置, MCP们: [{ 前缀: 'inv', client: 重复MCP }] });
  eq(r.csv路径们, ['~/x.csv'], 'CSV：同一个路径被提到两次只算一份（别把同一张表发两遍）');
}

// —— 写闸：干跑放行、真写截住。**最要命的一条是「截住时工具绝对不能被调用」** ——
// 调了就等于人还没点确认、数据已经写进去了，那这道闸就是个摆设。
{
  请求记录 = []; 调了 = [];
  脚本 = [{ tool_calls: [{ id: '1', function: { name: 'inv_写占用', arguments: '{"工单号":"31796","真写":true}' } }] }];
  const r = await 跑一句('把工单占上', { 模型配置, MCP们: [{ 前缀: 'inv', client: 假MCP }], 可写: true });
  真(r.待确认, '写闸：真写被截住，返回待确认');
  eq(r.待确认.工具名, '写占用', '写闸：待确认里带着工具名');
  eq(r.待确认.参数.工单号, '31796', '写闸：参数原样带出来（真执行时用这份，不重新生成）');
  eq(调了.length, 0, '写闸：**截住时一次都没调工具**（调了=人还没点就已经写进去了）');
}
{
  请求记录 = []; 调了 = [];
  脚本 = [{ tool_calls: [{ id: '1', function: { name: 'inv_写占用', arguments: '{"工单号":"31796"}' } }] }, { content: '干跑结果：占 3 条' }];
  const r = await 跑一句('先算算要占什么', { 模型配置, MCP们: [{ 前缀: 'inv', client: 假MCP }], 可写: true });
  真(!r.待确认, '写闸：不带真写=干跑，不拦');
  真(调了.some((c) => c.name === '写占用'), '写闸：干跑正常派发下去（模型可以自由地算一遍给人看）');
}
{
  请求记录 = []; 调了 = [];
  脚本 = [{ content: '这个要人在系统里操作' }];
  await 跑一句('把工单占上', { 模型配置, MCP们: [{ 前缀: 'inv', client: 假MCP }] }); // 不传可写
  const tools = 请求记录[0].tools || [];
  真(!tools.some((t) => t.function.name === 'inv_写占用'), '写闸：可写没开时，写工具根本不给模型（默认关）');
}

// —— 坏参数不空跑，把"重发"喂回模型 ——
{ 请求记录 = []; 调了 = [];
  脚本 = [{ tool_calls: [{ id: '1', function: { name: 'inv_查库存', arguments: '{"型号":' } }] }, { content: 'x' }]; // 截断的坏 JSON
  await 跑('x');
  真(!调了.some((c) => c.name === '查库存'), '坏参数：不拿空参默默跑工具');
  真(JSON.stringify(请求记录[1].messages).includes('不是合法 JSON'), '坏参数：把"重发"错误喂回模型');
}

// —— 历史上下文带进 messages ——
{ 请求记录 = []; 脚本 = [{ content: 'ans' }];
  await 跑('追问', [{ role: 'user', content: '前一句' }, { role: 'assistant', content: '前一答' }]);
  真(JSON.stringify(请求记录[0].messages).includes('前一句'), '历史：上文带进了 messages');
}

// —— 取消：上层超时后必须真停（原来只是"不等了"，循环还在跑、还会刷卡片盖掉超时提示）——
{ 请求记录 = []; 调了 = []; 脚本 = [{ content: 'x' }];
  const ac = new AbortController(); ac.abort();
  let 错 = null;
  try { await 跑一句('x', { 模型配置, MCP们: [{ 前缀: 'inv', client: 假MCP }], signal: ac.signal }); } catch (e) { 错 = e; }
  真(错 && /取消/.test(错.message), '取消：已取消的 signal 进来直接抛');
  eq(请求记录.length, 0, '取消：一次模型都没请求');
}
{ 请求记录 = []; 调了 = [];
  const ac = new AbortController();
  应答前钩子 = () => ac.abort(); // 模型这一轮回来时，上层刚好超时
  脚本 = [{ tool_calls: [{ id: '1', function: { name: 'inv_查库存', arguments: '{}' } }] }, { content: '不该跑到这' }];
  let 错 = null;
  try { await 跑一句('x', { 模型配置, MCP们: [{ 前缀: 'inv', client: 假MCP }], signal: ac.signal }); } catch (e) { 错 = e; }
  应答前钩子 = null;
  真(错 && /取消/.test(错.message), '取消：模型回来后发现被取消，立刻停');
  eq(调了.length, 0, '取消：取消之后一个工具都不派发');
  eq(请求记录.length, 1, '取消：不会再问第二轮');
}

// ============ 三处「坏了但看起来是绿的」（2026-08-22 全部先实测证实、再修） ============

// —— ① finish_reason：以前全项目 0 次引用，被 max_tokens 砍断和正常答完长得一模一样 ——
{ 请求记录 = []; 调了 = [];
  脚本 = [{ content: '光模块在库合计 119,582 根，分布如下：闵行 85,093、移动45号楼', _finish: 'length' }];
  const r = await 跑('光模块还有多少');
  eq(r.截断, 'answer', '截断：答案撞 max_tokens → 标成 answer（群里会多一行「写到一半被截断」）');
}
{ 请求记录 = []; 调了 = [];
  脚本 = [{ content: '闵行 85,093 根', _finish: 'stop' }];
  const r = await 跑('光模块还有多少');
  eq(r.截断, null, '截断：正常答完（stop）不许误报 —— 误报一次人就再也不信这行字了');
}
{ 请求记录 = []; 调了 = [];
  // 砍在工具参数上：那串 JSON 解析不了，和「答案被砍」是两种病，要分开报
  脚本 = [{ tool_calls: [{ id: '1', function: { name: 'inv_查库存', arguments: '{"型号":' } }], _finish: 'length' }, { content: 'x' }];
  const r = await 跑('x');
  eq(r.截断, 'tool_args', '截断：砍在工具参数上 → 标成 tool_args，不和答案截断混为一谈');
}

// —— ② usage：网关每次都回，以前整个丢掉。没它「这条为什么慢」只能重做实验 ——
{ 请求记录 = []; 调了 = [];
  脚本 = [
    { tool_calls: [{ id: '1', function: { name: 'inv_查库存', arguments: '{}' } }],
      _usage: { prompt_tokens: 1500, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 180 } } },
    { content: '答完了', _usage: { prompt_tokens: 2000, completion_tokens: 649, completion_tokens_details: { reasoning_tokens: 622 } } },
  ];
  const r = await 跑('x');
  eq(r.用量, { 输入: 3500, 输出: 849, 思考: 802, 峰值输入: 2000 }, 'token 账：**两轮累加**，不是只记最后一轮');
  真(r.用量.思考 / r.用量.输出 > 0.9, 'token 账：思考占比算得出来（实测九成输出是思考，不是写字）');
}
{ 请求记录 = []; 调了 = [];
  脚本 = [{ content: '答完了' }]; // 网关没回 usage 的情形
  const r = await 跑('x');
  eq(r.用量, { 输入: 0, 输出: 0, 思考: 0, 峰值输入: 0 }, 'token 账：网关没给 usage 时是 0，不是 undefined（别让统计端崩）');
}

// —— ③ 工具挂了不许炸掉整条查询（2026-08-22 生产日志实证：`[出错] MCP tools/call 超过 45 秒没回`）——
{ 请求记录 = []; 调了 = [];
  const 会挂的MCP = {
    列工具: async () => [{ name: '透视', description: 'p', inputSchema: { type: 'object', properties: {} } },
      { name: '查库存', description: '查', inputSchema: { type: 'object', properties: {} } }],
    调工具: async (name) => { if (name === '透视') throw new Error('MCP tools/call 超过 45 秒没回'); 调了.push({ name }); return '闵行 21406'; },
  };
  脚本 = [
    { tool_calls: [{ id: '1', function: { name: 'inv_透视', arguments: '{}' } },
      { id: '2', function: { name: 'inv_查库存', arguments: '{}' } }] },
    { content: '透视那块没查成，库存是 21406' },
  ];
  let 错 = null; let r = null;
  try { r = await 跑一句('x', { 模型配置, MCP们: [{ 前缀: 'inv', client: 会挂的MCP }] }); } catch (e) { 错 = e; }
  真(!错, '工具挂：一个工具 throw **不再炸掉整条查询**（原来 Promise.all 快速失败，直接抛给上层）');
  eq(r?.回答, '透视那块没查成，库存是 21406', '工具挂：循环继续走完，还是答得出来');
  真(调了.some((c) => c.name === '查库存'), '工具挂：**同一轮里另一个工具的结果没丢**');
  真(JSON.stringify(请求记录[1].messages).includes('45 秒没回'), '工具挂：错误原文喂回模型（它才能换个法子重试或如实说查不到）');
  真(JSON.stringify(请求记录[1].messages).includes('缩小范围'), '工具挂：连「下一步怎么办」一起喂回去，不是光扔个错误');
}
{ // 反向：上层取消不是「工具坏了」，必须原样抛出去，不能被这个 catch 吞掉当普通错误继续跑
  请求记录 = []; 调了 = [];
  const ac = new AbortController();
  const 取消式MCP = { 列工具: async () => [{ name: '透视', description: 'p', inputSchema: { type: 'object', properties: {} } }],
    调工具: async () => { ac.abort(); throw new Error('已取消（上层不等了）'); } };
  脚本 = [{ tool_calls: [{ id: '1', function: { name: 'inv_透视', arguments: '{}' } }] }, { content: '不该跑到这' }];
  let 错 = null;
  try { await 跑一句('x', { 模型配置, MCP们: [{ 前缀: 'inv', client: 取消式MCP }], signal: ac.signal }); } catch (e) { 错 = e; }
  真(错, '工具挂：**上层取消照样抛**，不许被「工具挂了」这条兜底吞掉变成继续跑');
  eq(请求记录.length, 1, '工具挂：取消之后不会再问模型第二轮');
}

// —— ④ 回包截断要留印（实测 `查库存` 回 7197 字，砍掉的 1197 字里正好有一条告警）——
// **造多长要跟着 回包上限 走，不能写死一个数**：2026-08-24 把上限从 6000 抬到 20000 时，
// 这里原来写死的 6100 字一下子不再超限，两条判据当场变红 —— 红得对（它确实没截断了），
// 但那是测试跟不上常量，不是代码坏了。跟着环境变量算，以后再调常量这条不会假红也不会假绿。
{ 请求记录 = []; 调了 = [];
  const 上限 = Number(process.env.AGENT_TOOL_RESULT_MAX || 20000);
  const 长回包 = `开头AAA${'x'.repeat(上限 + 100)}结尾里有个数 99887766`;
  const 大MCP = { 列工具: async () => [{ name: '查库存', description: '查', inputSchema: { type: 'object', properties: {} } }],
    调工具: async () => 长回包 };
  脚本 = [{ tool_calls: [{ id: '1', function: { name: 'inv_查库存', arguments: '{}' } }] }, { content: '合计 99887766 根' }];
  await 跑一句('x', { 模型配置, MCP们: [{ 前缀: 'inv', client: 大MCP }] });
  const 喂了 = JSON.stringify(请求记录[1].messages);
  真(喂了.includes('这条回包被截断'), '回包截断：**留印**，模型知道自己只看到一部分（原来一刀切、无痕）');
  真(喂了.includes(String(长回包.length)), '回包截断：告诉它原文多少字');
  真(!喂了.includes('99887766'), '回包截断：尾巴确实没喂给模型（不然这条测试是假绿）');
}
{ 请求记录 = []; 调了 = [];
  const 小MCP = { 列工具: async () => [{ name: '查库存', description: '查', inputSchema: { type: 'object', properties: {} } }],
    调工具: async () => '闵行 21406' };
  脚本 = [{ tool_calls: [{ id: '1', function: { name: 'inv_查库存', arguments: '{}' } }] }, { content: '21406' }];
  await 跑一句('x', { 模型配置, MCP们: [{ 前缀: 'inv', client: 小MCP }] });
  const 喂 = JSON.stringify(请求记录[1].messages);
  真(!喂.includes('被截断'), '回包截断：没超上限的回包不许加那段话（噪音）');
  真(喂.includes('闵行 21406'), '回包截断：没超上限时原样喂（不然上一条是假绿——什么都没喂也不含"被截断"）');
}

// —— 上下文预算：快满了把最老的工具回包挪出去 ——
// 实测这个网关上限 288954 token，正常查询只用 12486，所以这道闸平时不响；
// 它管的是「回包上限被调大」「读表数据拉回一整列」这类往上顶的情况。
// **撞上去是 400 硬错**：fallback 会拿同一堆 messages 去问下一个模型、同样撞，最后群里一句「所有模型都失败」。
{
  process.env.AGENT_CONTEXT_TOKENS = '4000'; // 调到很小，让闸在测试里响
  process.env.AGENT_CONTEXT_RATIO = '0.75';  // 压缩线 = 3000 token ≈ 3750 字
  const { 跑一句: 跑2 } = await import('../lib/agent.mjs?上下文验证=1'); // 重新载，让新的 env 生效
  请求记录 = []; 调了 = [];
  const 大MCP = { 列工具: async () => [{ name: '查库存', description: '查', inputSchema: { type: 'object', properties: {} } }],
    调工具: async () => '甲'.repeat(2500) };
  脚本 = [
    { tool_calls: [{ id: 't1', function: { name: 'inv_查库存', arguments: '{}' } }] },
    { tool_calls: [{ id: 't2', function: { name: 'inv_查库存', arguments: '{}' } }] },
    { content: '答完了' },
  ];
  const r = await 跑2('x', { 模型配置, MCP们: [{ 前缀: 'inv', client: 大MCP }] });
  真(r.压缩过 > 0, `上下文：快满了会挪走最老的工具回包（挪了 ${r.压缩过} 条）`);
  const 最后一轮 = 请求记录.at(-1).messages;
  const 工具消息 = 最后一轮.filter((m) => m.role === 'tool');
  真(工具消息[0].content.startsWith('〔已挪出上下文'), '上下文：**最老的那条**被挪走，留下一句说明');
  真(工具消息[0].content.includes('2500'), '上下文：说明里写着原来多少字（不是悄悄删掉）');
  eq(工具消息.length, 2, '上下文：**消息条数不变** —— 少一条 API 会报「tool_calls 没有对应的 tool 回复」');
  真(工具消息.every((m) => m.tool_call_id), '上下文：tool_call_id 全都还在');
  eq(最后一轮[0].role, 'system', '上下文：系统提示没被动');
  真(最后一轮.some((m) => m.role === 'user' && m.content === 'x'), '上下文：用户那句问话没被动');

  // 反向：正常大小的对话不许压（压了就是把还要用的数据白扔了）
  请求记录 = []; 调了 = [];
  const 小MCP = { 列工具: async () => [{ name: '查库存', description: '查', inputSchema: { type: 'object', properties: {} } }],
    调工具: async () => '闵行 21406' };
  脚本 = [{ tool_calls: [{ id: 't1', function: { name: 'inv_查库存', arguments: '{}' } }] }, { content: '21406' }];
  const r2 = await 跑2('x', { 模型配置, MCP们: [{ 前缀: 'inv', client: 小MCP }] });
  eq(r2.压缩过, 0, '上下文：**没到线就一条都不许挪**（误压=把还要用的数据白扔了）');
  真(请求记录.at(-1).messages.some((m) => m.role === 'tool' && m.content === '闵行 21406'), '上下文：没到线时回包原样');
  delete process.env.AGENT_CONTEXT_TOKENS; delete process.env.AGENT_CONTEXT_RATIO;
}

// —— 峰值输入：判「离上下文上限还有多远」要看单轮最大，不是累计 ——
{ 请求记录 = []; 调了 = [];
  脚本 = [
    { tool_calls: [{ id: '1', function: { name: 'inv_查库存', arguments: '{}' } }], _usage: { prompt_tokens: 9000, completion_tokens: 10 } },
    { content: '答完了', _usage: { prompt_tokens: 13000, completion_tokens: 10 } },
  ];
  const r = await 跑('x');
  eq(r.用量.输入, 22000, 'token 账：输入是**累计**（算成本用）');
  eq(r.用量.峰值输入, 13000, 'token 账：峰值输入是**单轮最大**（判离上限还有多远用）—— 累计再大也撞不到上限');
}

// —— 「什么时候用我」挪到工具自己身上（原来是系统提示里一大段清单）——
{ 请求记录 = []; 调了 = [];
  const 多工具MCP = { 列工具: async () => [
    { name: '透视', description: '按维度聚合计数', inputSchema: { type: 'object', properties: {} } },
    { name: '看变动', description: '看最近变动', inputSchema: { type: 'object', properties: {} } }, // 没给它写补充说明
  ], 调工具: async () => 'ok' };
  脚本 = [{ content: '答完了' }];
  await 跑一句('x', { 模型配置, MCP们: [{ 前缀: 'inv', client: 多工具MCP }] });
  const tools = 请求记录[0].tools;
  const 透视描述 = tools.find((t) => t.function.name === 'inv_透视').function.description;
  真(透视描述.includes('按维度聚合计数'), '工具说明：MCP 服务端自己的描述还在（讲「我是什么」）');
  真(透视描述.includes('什么时候用我'), '工具说明：**本项目的选型规则挂在工具身上**，不在系统提示里');
  真(透视描述.includes('订单号'), '工具说明：「行维度填订单号不是订单编号」这种细节跟着工具走');
  真(透视描述.includes('别用 `查资产` 拉全量'), '工具说明：**「什么时候别选我」也写了** —— 只说该用啥不够，得说别用啥');
  const 看变动描述 = tools.find((t) => t.function.name === 'inv_看变动').function.description;
  eq(看变动描述, '看最近变动', '工具说明：没写补充说明的工具，描述一个字不加（别硬凑）');
  // 系统提示里那段清单要真的被删掉，不然等于两处各写一份、改一处忘一处
  const 系统 = 请求记录[0].messages[0].content;
  真(!系统.includes('常见问法→工具'), '工具说明：**系统提示里那段清单删干净了**（留着就会两处不一致）');
  真(!系统.includes('哪些维度快、哪些慢'), '工具说明：维度快慢那段也搬走了');
  真(系统.includes('每个工具的说明里都写了'), '工具说明：系统提示改成指路，让模型去看工具自己的说明');
}
{
  // 键写错=这条说明静默失效（模型看不到、也没有任何报错）。所以键必须是真工具名，import 时就炸。
  const { _补充说明的键, _是已知工具 } = await import('../lib/agent.mjs');
  const 野的 = _补充说明的键().filter((k) => !_是已知工具(k));
  eq(野的, [], '工具说明：**每个键都是真工具名** —— 写错一个字这条说明就没人看得到，而且不报错');
  真(_补充说明的键().length >= 10, `工具说明：搬过来 ${_补充说明的键().length} 条（0 或偏小=没搬成，不是没规则）`);
}

// —— 问术语：模型提议、人一键确认。**和写闸同构 —— 模型能猜能提，落库那一下必须人按下去** ——
// 它自己偷偷记的话，术语表影响所有人的结果，而出错时没人知道是什么时候记歪的。
{ 请求记录 = []; 调了 = [];
  脚本 = [{ tool_calls: [{ id: '1', function: { name: '问术语', arguments: '{"词":"小八","猜的意思":"800G 光模块"}' } }] }];
  const r = await 跑一句('小八还有多少', { 模型配置, MCP们: [{ 前缀: 'inv', client: 假MCP }], 可教术语: true });
  真(r.待教术语, '问术语：被截住，交给上层去问人');
  eq(r.待教术语.词, '小八', '问术语：词原样带出来');
  eq(r.待教术语.猜, '800G 光模块', '问术语：模型的猜测也带出来（人改一改就行，比空着强）');
  eq(调了.length, 0, '问术语：**一个工具都没被调用** —— 它不是个真工具，是个「暂停问人」的信号');
}
{ 请求记录 = []; 调了 = [];
  脚本 = [{ tool_calls: [{ id: '1', function: { name: '问术语', arguments: '{"猜的意思":"不知道"}' } }] }, { content: '查不到' }];
  const r = await 跑一句('x', { 模型配置, MCP们: [{ 前缀: 'inv', client: 假MCP }], 可教术语: true });
  真(!r.待教术语, '问术语：**没给「词」就不算数**（不能弹一张问「undefined 是什么」的卡片）');
  真(JSON.stringify(请求记录[1].messages).includes('没给「词」'), '问术语：不合格时把原因喂回模型，让它自己继续');
}
{ 请求记录 = []; 调了 = [];
  脚本 = [{ content: '查不到' }];
  await 跑一句('x', { 模型配置, MCP们: [{ 前缀: 'inv', client: 假MCP }] }); // 不传 可教术语
  const tools = 请求记录[0].tools || [];
  真(!tools.some((t) => t.function.name === '问术语'),
    '问术语：**上层接不住就不给这个工具**（给了没人接，模型问了石沉大海，比不给还糟）');
}

// —— 翻记录：**范围不是参数，是结构** ——
// 工具的入参里根本没有「搜谁的」，`谁` 从 bot 传、模型碰不到。
// 想让它翻别人的记录没有入口 —— 这比在提示词里写「只准搜自己的」硬得多。
{ 请求记录 = []; 调了 = [];
  脚本 = [{ content: '答完了' }];
  await 跑一句('x', { 模型配置, MCP们: [{ 前缀: 'inv', client: 假MCP }], 谁: 'ou_甲' });
  const 翻 = (请求记录[0].tools || []).find((t) => t.function.name === '翻记录');
  真(翻, '翻记录：知道是谁在问时才给这个工具');
  eq(Object.keys(翻.function.parameters.properties).sort(), ['关键词', '几条'],
    '翻记录：**入参里没有「谁」** —— 模型没有翻别人记录的入口，这是结构不是嘱咐');
  真(翻.function.description.includes('别人的翻不到'), '翻记录：描述里也说清了范围（省它白试一轮）');
}
{ 请求记录 = []; 调了 = [];
  脚本 = [{ content: 'ok' }];
  await 跑一句('x', { 模型配置, MCP们: [{ 前缀: 'inv', client: 假MCP }] }); // 不传 谁
  真(!(请求记录[0].tools || []).some((t) => t.function.name === '翻记录'),
    '翻记录：**不知道是谁在问就不给这个工具** —— 按人切是它唯一的边界，切不了宁可不给');
}

// —— 范围锁：人指定了「就看这张表」，读别的表要在派发前被拦掉 ——
// 光在提示词里嘱咐不算数（今天验过「给了工具不等于它会用」，反过来「说了别用不等于它不用」）。
{ 请求记录 = []; 调了 = [];
  const 表MCP = {
    列工具: async () => [{ name: '读表数据', description: '读表', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } }],
    调工具: async (名, args) => { 调了.push({ 名, args }); return `读到了 ${args.url}`; },
  };
  const 范围 = { url: 'https://x.feishu.cn/sheets/AAAAAAAAAAAAAAAAAAA', sheet名: '转固清单', 表头行: 51 };
  脚本 = [
    { tool_calls: [{ id: '1', function: { name: 'inv_读表数据', arguments: '{"url":"https://x.feishu.cn/sheets/BBBBBBBBBBBBBBBBBBB"}' } }] },
    { content: '那张表里没有' },
  ];
  const r = await 跑一句('照这张表对一下', { 模型配置, MCP们: [{ 前缀: 'inv', client: 表MCP }], 范围 });
  eq(调了.length, 0, '范围锁：**读别的表时工具一次都没被调用**（拦在派发前，不是事后补救）');
  真(JSON.stringify(请求记录[1].messages).includes('别换表'), '范围锁：把「别换表」喂回模型，它才知道下一步怎么办');
  eq(r.回答, '那张表里没有', '范围锁：拦完循环继续走，不是把整条查询炸掉');
}
{ 请求记录 = []; 调了 = [];
  const 表MCP = {
    列工具: async () => [{ name: '读表数据', description: '读表', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } }],
    调工具: async (名, args) => { 调了.push({ 名, args }); return '读到了'; },
  };
  const 范围 = { url: 'https://x.feishu.cn/sheets/AAAAAAAAAAAAAAAAAAA', sheet名: '转固清单', 表头行: 51 };
  脚本 = [{ tool_calls: [{ id: '1', function: { name: 'inv_读表数据', arguments: '{}' } }] }, { content: 'ok' }];
  await 跑一句('对一下', { 模型配置, MCP们: [{ 前缀: 'inv', client: 表MCP }], 范围 });
  eq(调了.length, 1, '范围锁：指对了（这里是没给 url）照常放行');
  eq(调了[0].args.url, 范围.url, '范围锁：**url 自动补成锁定的那张**（模型省参数是常事，补比拒省一轮）');
  eq(调了[0].args.sheet名, '转固清单', '范围锁：sheet 名补上');
  eq(调了[0].args.range, 'A51:BZ451', '范围锁：**表头行顶进 range** —— 表头不在第 1 行时模型基本必猜错');
  真(请求记录[0].messages[0].content.includes('只准看这一张表'), '范围锁：提示词里也说一句（省它白试一轮）');
}
{ 请求记录 = []; 调了 = [];
  脚本 = [{ tool_calls: [{ id: '1', function: { name: 'inv_查库存', arguments: '{"型号":"400G"}' } }] }, { content: 'ok' }];
  await 跑一句('查400G', { 模型配置, MCP们: [{ 前缀: 'inv', client: 假MCP }], 范围: { url: 'https://x.feishu.cn/sheets/AAAAAAAAAAAAAAAAAAA' } });
  真(调了.some((c) => c.name === '查库存'), '范围锁：**不误伤非读表工具** —— 锁的是"看哪张表"，不是"不许查库存"');
}

// —— config 组模型列表 ——
{ process.env.AGENT_API_BASE = 'b'; process.env.AGENT_API_KEY = 'k'; process.env.AGENT_MODEL = 'GLM-5.2';
  const c = 读配置();
  eq(c.models[0], 'GLM-5.2', 'config：主模型放队首');
  真(c.models.length === 2 && new Set(c.models).size === 2 && c.models.includes('DeepSeek-V4-Flash-0731'), 'config：只留 GLM+Flash 两个、去重无冗余（砍了 Pro/Kimi）');
}

// —— 读提醒chat：env > .creds.json > 空。三条路都要验，因为「没设」= 令牌过期提醒静默失效 ——
{
  const 临 = mkdtempSync(join(tmpdir(), 'feishu-agent-测试-'));
  const 存 = process.env.BOT_NUDGE_CHAT; delete process.env.BOT_NUDGE_CHAT;
  eq(读提醒chat(临), '', '提醒chat：文件和 env 都没有 → 空串（bot 据此喊警告）');
  writeFileSync(join(临, '.creds.json'), JSON.stringify({ key: 'x', nudge_chat: '  oc_文件里的  ' }));
  eq(读提醒chat(临), 'oc_文件里的', '提醒chat：回退到 .creds.json，两边空格去掉');
  process.env.BOT_NUDGE_CHAT = 'oc_环境变量的';
  eq(读提醒chat(临), 'oc_环境变量的', '提醒chat：env 压过文件');
  if (存 === undefined) delete process.env.BOT_NUDGE_CHAT; else process.env.BOT_NUDGE_CHAT = 存;
  rmSync(临, { recursive: true, force: true });
}

/*
 * —— 写闸认两种干跑形状 ——
 *
 * 2026-08-24 加的第二种：`写工单评论` 的干跑不是「不传 真写」，而是「第①步不带确认票」。
 * 闸只认第一种的话，它的**真写调用会被当成只读直接派发下去** —— 那就已经写进工单了
 * （评论不可删、别人看得见），而闸、日志、群里那条消息全都是绿的。
 *
 * 两个方向都要测，**「干跑那步不许被拦」和「真写那步必须拦」一样重要**：
 * 拦过头的话模型永远拿不到确认票，第②步根本无从谈起，功能整个不通。
 */
{
  const { 是真写吗, _取规矩 } = await import('../lib/agent.mjs');

  const 占 = _取规矩('写占用');
  真(占, '写占用 在写工具表里');
  eq(是真写吗(占, { 工单号: '31796' }), false, '写占用：不传 真写 = 干跑，**放行**');
  eq(是真写吗(占, { 工单号: '31796', 真写: false }), false, '写占用：真写=false 是干跑，放行');
  eq(是真写吗(占, { 工单号: '31796', 真写: true }), true, '写占用：真写=true → **拦**');
  eq(是真写吗(占, { 真写: 'true' }), false, '写占用：真写是字符串不是布尔 → 不算真写（只认严格 true）');

  const 评 = _取规矩('写工单评论');
  真(评, '写工单评论 在写工具表里');
  eq(是真写吗(评, { 工单号: '31796', 文本: '满足' }), false,
    '**写工单评论：第①步（工单号+文本、不带票）是干跑，必须放行** —— 拦了的话模型永远拿不到确认票');
  eq(是真写吗(评, { 确认票: 'abc', 用户选择: '真写' }), true, '写工单评论：带票 + 选「真写」→ **拦**');
  eq(是真写吗(评, { 确认票: 'abc', 用户选择: '不写' }), false, '写工单评论：带票但选「不写」→ 不是真写');
  eq(是真写吗(评, { 确认票: 'abc' }), false, '写工单评论：有票没选择 → 不是真写');
  eq(是真写吗(评, { 用户选择: '真写' }), false, '写工单评论：有选择没票 → 不是真写（MCP 那边也会拒）');
  eq(是真写吗(评, { 确认票: '', 用户选择: '真写' }), false, '写工单评论：空票不算票');

  const 决 = _取规矩('记下决定');
  真(决, '记下决定 在「只能人点」表里');
  eq(是真写吗(决, {}), true, '**记下决定：空参数也拦** —— 它没有干跑这回事，一调就写下去了');
  eq(是真写吗(决, { 资产类型: '光模块', 要的: 'A', 顶上的: 'B', 结论: '能顶', 依据: 'x', 谁拍的: '张三' }), true,
    '记下决定：**每一次调用都拦**，不看参数');
  eq(决.人字段, '谁拍的', '记下决定：标了「谁拍的」要换成点按钮那个人（模型编的名字将来没人认账）');

  eq(是真写吗(null, { 真写: true }), false, '不在任何表里的工具 → 不拦（只读工具照常跑）');
  eq(是真写吗(undefined, {}), false, '规矩是 undefined → 不拦');
}

/*
 * —— 「只能人点」那一类**不受 可写 管，但必须每次都被截住** ——
 * 它进模型的工具表（模型要能提议），但任何一次调用都拦下来。
 * 这两条要一起测：只测「给了模型」会漏掉「结果真派发出去了」，只测「被拦」会漏掉「压根没给模型」。
 */
{
  const 带记下决定的MCP = {
    列工具: async () => [
      { name: '查库存', description: '查', inputSchema: { type: 'object', properties: {} } },
      { name: '记下决定', description: '记', inputSchema: { type: 'object', properties: {} } },
    ],
    调工具: async (name, args) => { 调了.push({ name, args }); return 'ok'; },
  };
  请求记录 = []; 调了 = [];
  脚本 = [{ tool_calls: [{ id: '1', function: { name: 'inv_记下决定', arguments: JSON.stringify({ 资产类型: '光模块', 要的: 'QSFP', 顶上的: 'QSFP28', 结论: '能顶', 依据: '客户说的', 谁拍的: 'AI助手' }) } }] }];
  const r = await 跑一句('记一下 QSFP28 能顶 QSFP', { 模型配置, MCP们: [{ 前缀: 'inv', client: 带记下决定的MCP }] }); // 注意：**没传可写**
  const tools = 请求记录[0].tools || [];
  真(tools.some((t) => t.function.name === 'inv_记下决定'),
    '**没开 BOT_WRITE 也把 记下决定 给了模型** —— 它每次都被拦，模型在结构上不可能让它执行');
  真(r.待确认, '**模型调它 → 立刻截住走人确认**');
  eq(r.待确认.工具名, '记下决定', '待确认里带着工具名');
  eq(r.待确认.人字段, '谁拍的', '**人字段跟着票走** —— bot 靠它知道要把「谁拍的」换掉');
  eq(r.待确认.参数.谁拍的, 'AI助手', '模型填的那个原样带出来（好让日志能对比出「换掉了什么」）');
  真(Array.isArray(r.待确认.摘要字段) && r.待确认.摘要字段.includes('依据'), '摘要字段跟着票走，卡片才摆得出人话');
  eq(调了.length, 0, '**一次都没真调 MCP** —— 调了就已经落库了，而它没有干跑可以回退');
}

console.log(`\n检查了 ${n} 条判据，失败 ${挂}`);
process.exit(挂 ? 1 : 0);
