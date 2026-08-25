/**
 * 飞书群机器人守护进程（只读）：
 *   lark-cli event consume im.message.receive_v1  → 收"群里 @ 机器人 / 私信 bot"的消息
 *   → 跑 agent（GLM + 只读 MCP 工具）→ bot 回到同一个会话
 * 常开机上跑。cmdb 类查询要公司网；只 inventory 的话走飞书、不挑网。
 * 用法：node bot.mjs   （前台跑；上线用 launchd/任务计划守着）
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename as 取文件名, join } from 'node:path';
import { 起MCP } from './lib/mcp客户端.mjs';
import { 跑一句 } from './lib/agent.mjs';
import { 去at, 该理会吗, 建限流, 建刷, 建看门狗, 说人话, 卡片元素, 认反馈, 认澄清, 澄清卡片元素, 认确认, 确认卡片元素, 认要SN, 认导表, 认停, 认停口令, 认表单, 认限表, 认解除范围, 认帮助口令, 认历史口令, 历史正文, 认表情, 例行确认卡片元素, 认例行确认 } from './lib/护栏.mjs';
import { 建清单 } from './lib/清单.mjs';
import { 读配置, 读提醒chat, 读飞书凭证, 读例行定时, 读例行chat } from './config.mjs';
import { 记一条, 我问过 } from './lib/问答日志.mjs';
import { 认口令, 加术语, 改术语, 删术语, 列术语, 术语段, 教术语卡, 教术语按钮名 } from './lib/术语表.mjs';
import { 建持久表 } from './lib/持久表.mjs';
import { 占住 } from './lib/独占.mjs';
import { 例行们, 认例行口令, 认例行近似, 解干跑, 改名提示, 认改名判断, 回执正文, 解定时, 该跑吗, 定时说法 } from './lib/例行更新.mjs';
import { 合CSV, 解CSV } from './lib/合表.mjs';
import { 建在线表 } from './lib/飞书表格.mjs';
import { 该压吗, 压一次, 摘要消息, 压完怎么写 } from './lib/对话摘要.mjs';
import { 认范围口令, 范围回执, 范围表单卡, 表单转范围, 设范围按钮名, 取表token, 表格工具 } from './lib/表格范围.mjs';
import { 问模型 } from './lib/模型.mjs';
import { 预热直连, 我的openid as 取我的openid, 发消息 as 直发消息, 改消息 as 直改消息, 上传文件 as 直上传, 就地改卡, 查人名, 拉最近消息, 列群会话 } from './lib/飞书.mjs';
import { 建补收 } from './lib/补收.mjs';

const LC = process.env.LARK_CLI || `${homedir()}/.workbuddy/binaries/node/cli-connector-packages/lib/node_modules/@larksuite/cli/bin/lark-cli`;
const ENV = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };
const 模型配置 = 读配置();
const 调试原始事件 = process.env.BOT_DEBUG === '1';

// —— 只准跑一个。**必须抢在起 MCP 子进程之前** ——
// 第二个 bot 光是启动就会拉起两个 MCP 子进程、去预热同一批 31 张飞书表，
// 那正是 2026-08-24 那次的伤害来源：两个进程抢同一份飞书接口配额，
// 第一个 `看变动` 撞 45 秒超时，整条查询从 15 秒变成 112 秒 —— 而且**同一句话被答了两遍**。
// 这件事哪儿都不红：两边日志各看各的都正常、退出码 0、飞书也不报错，只有人在群里看到两条回复。
const 锁 = 占住(join(process.env.BOT_STATE_DIR || join(homedir(), '.cache', 'feishu-agent', '状态'), 'bot.pid'));
if (!锁.ok) {
  process.stderr.write(`[独占] **已经有一个 bot 在跑了（pid ${锁.占着的}），这个不起了。**\n`
    + `[独占] 两个 bot 会同时订阅飞书事件、同一句话答两遍，而且哪儿都不报错。\n`
    + `[独占] 真要换掉它：先 kill ${锁.占着的}（它要是守护的亲儿子，得先停守护，不然会被拉起来）。\n`);
  process.exit(1);
}
process.stderr.write(`[独占] 占住了（pid ${process.pid}）——${锁.因为}\n`);

// —— 起只读 MCP：inventory（走飞书不挑网）+ cmdb（查资产/SN/工单，要公司网+令牌新鲜）——
// MCP 子进程死了就整个退出，交给守护重启。别活着装好人：那样每条查询都失败，守护还以为一切正常。
// 单次请求 45 秒封顶（短于下面整条查询的 60 秒），免得一个卡死的工具调用留下两分钟的僵尸。
// 把飞书应用凭证传给子进程：inventory 读占用台账靠它直连多维表（1.5 秒），没有就退回 lark-cli（8.8 秒）。
// 「够不够」这类需求匹配每次都要读占用，所以这一下省的是每一次匹配的 7 秒。
const 飞书凭证 = 读飞书凭证();
const MCP环境 = 飞书凭证 ? { LARK_APP_ID: 飞书凭证.id, LARK_APP_SECRET: 飞书凭证.secret } : {};
const 起只读 = (路径, 名) => 起MCP('node', [路径], MCP环境, {
  超时毫秒: 45000,
  on死: (因) => { process.stderr.write(`[MCP挂了] ${名}：${因}\n[MCP挂了] 整个 bot 退出，交给守护重启。\n`); process.exit(1); },
});
const inv = 起只读('/Users/mumuyuchen/projects/company/inventory-mcp/server.mjs', 'inventory');
await inv.初始化();
const cmdb = 起只读('/Users/mumuyuchen/projects/company/cmdb-mcp/server.mjs', 'cmdb');
await cmdb.初始化();
const MCP们 = [{ 前缀: 'inv', client: inv }, { 前缀: 'cmdb', client: cmdb }];

// —— 护栏 / 限流 / 上下文（env 覆盖，默认宽松：现在能用、铺开再收紧）——
const 并发上限 = Number(process.env.BOT_CONCURRENCY || 3);      // 同时最多跑几个查询
const 每人每时上限 = Number(process.env.BOT_RATE_PER_HOUR || 30); // 每人每小时最多几条
const 白名单 = new Set((process.env.BOT_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean)); // 空=不限
const 提醒chat = 读提醒chat();                                   // 令牌过期提醒发到哪个 chat_id（env > .creds.json；空=只写日志不发飞书）
const 上下文分钟 = Number(process.env.BOT_CONTEXT_MIN || 30);    // 追问带上文的时间窗（10→30：隔一会儿回来还能接着问）
const 保留轮 = Number(process.env.BOT_CONTEXT_ROUNDS || 6);      // 原文留几轮，更早的折进摘要
const 空闲秒 = Number(process.env.BOT_IDLE_SEC || 60);           // 多久没进展判死（要 > MCP 单次 45 秒，否则工具正常跑也会被误杀）
const 硬顶秒 = Number(process.env.BOT_HARD_SEC || 180);          // 一直有进展也最多给这么久
const 心跳分钟 = Number(process.env.BOT_HEARTBEAT_MIN || 30);    // 多久打一行心跳（可调小用来验证心跳真在打）
let 并发 = 0;
// 心跳计数：旧进程连着跑 10 小时、一条消息都没收到，而它自己毫无察觉——日志里一片祥和。
// 这几个数就是拿来 grep 的：`[心跳]` 一行看得出它到底聋没聋。
const 计数 = { 收到: 0, 答复: 0, 出错: 0, 重连: 0, 反馈: 0, 最后收到: 0 };
const 超限 = 建限流(每人每时上限);
// 哪些工具查出来的东西能再往下要 SN。**按工具白名单，不按答案里有没有数字** ——
// 挂在一个给不出 SN 的答案上，人点了只会得到一句「查不到」，比不挂还糟。
const SN能给的工具 = new Set(['查库存', '看分布', '找替代', '看有哪些型号']);
const 票过期毫秒 = 15 * 60 * 1000;
// 例行公事（日更/周更/导工单）的确认票活得久一些：定时那条是推过来的，人可能开会/出去吃饭，
// 回来才看到卡片。15 分钟等于推了个必然失效的按钮 —— 那比不推还糟（人点了才发现没用）。
const 例行票过期毫秒 = Number(process.env.BOT_DAILY_TICKET_MIN || 240) * 60 * 1000;
// 定时表：`{日更:[{时,分}], 周更:[{星期,时,分}]}`。空=不定时，口令那条路照样能用。
const 定时表 = Object.fromEntries(Object.keys(例行们).map((名) => [名, 解定时(读例行定时(名))]));
// **每件事自己一个 Set**：共用一个的话，日更和周更配在同一个时间点时，
// 先跑的那件会把标记占掉、后一件当天永远不跑 —— 而它表现成「周更今天没到点」，不报任何错。
const 例行跑过 = Object.fromEntries(Object.keys(例行们).map((名) => [名, new Set()]));
const 澄清过期毫秒 = 15 * 60 * 1000;
// 下面六张表都**落盘**（`lib/持久表.mjs`）。原来是 `new Map()`，重启就没 ——
// 而重启是常事（改一行代码、守护拉一次、关机）。丢票的表现不是"少点上下文"：
// 人对着「确认写入」的卡片点下去，`处理确认` 找不到票，只写一行日志就 return，**群里一个字都没有**。
// 唯一故意不落盘的是「跑中」：进程一没那些查询本来就死了，读回来只剩一堆停不掉的僵尸票。
const 上下文 = 建持久表('上下文', { 存活毫秒: 上下文分钟 * 60000 }); // chat|sender → { 历史, ts }
// 等人点选项的那些问题。**只存原问题不存半截会话**：点了之后是把「原问题+你选的」重问一遍，
// 不是从中断处续跑 —— 续跑要重构 处理()（最关键那个函数），而工具现在几乎免费（12ms~2s），
// 重查一次的代价小于动它的风险。等真有人用起来再说。
const 待澄清 = 建持久表('澄清票', { 存活毫秒: 澄清过期毫秒 }); // 问答id → { 问, chat_id, sender, ts }
// **写开关默认关**：从「只读天然安全」变成「能改数据」是质变，得显式打开（BOT_WRITE=1）。
const 可写 = process.env.BOT_WRITE === '1';
// 等人点「确认写入」的那些。**存的是模型当时给的参数原样**——真执行时用这份，
// 不重新让模型生成一遍（否则人确认的和实际写的可能不是一回事）。
// 导表票：点「导出到飞书表格」时得知道这一轮导了哪几个 CSV。**存路径不存内容** ——
// 内容几百 KB，而票是要落盘的；文件本来就在缓存目录躺着，点的时候现读就行。
// 存活期跟着导出文件的寿命走（缓存目录里的导出会被清），给 2 小时。
// **在跑的那些查询**，给「停」用。故意不落盘：进程一重启，那些查询本来就没了，
// 把它们的票留到下次开机只会让人点到一张停不掉任何东西的按钮。
const 跑中 = new Map(); // 问答id → { 停, chat_id, sender, 起手 }
// 答案消息 → 这一轮是谁问的哪条。**表情事件只给 message_id**，没有 chat_id 也没有问答id，
// 不存这张表的话，人对着答案打表情我根本不知道那是哪条答案。
const 消息到问答 = 建持久表('消息到问答', { 存活毫秒: 24 * 60 * 60 * 1000 }); // 消息id → { 问答id, chat_id, sender, ts }
const 教术语票 = 建持久表('教术语票', { 存活毫秒: 30 * 60 * 1000 }); // chat|人 → { 问, 词, ts }
const 导表票 = 建持久表('导表票', { 存活毫秒: 2 * 60 * 60 * 1000 }); // 问答id → { 路径们, chat_id, sender, ts }
const 待写 = 建持久表('写入票', { 存活毫秒: 票过期毫秒 }); // 票id → { 全名, 工具名, 参数, chat_id, sender, ts }
// message_id 去重。**必须落盘**：不是为了防「同一条消息处理两遍」这种老需求（内存 Set 本来够）——
// 是给下面的「补收」用。补收把长连接断线期间漏收的消息拉回来重新喂给 处理()，
// 靠的正是这张表分清「哪些已经真答过了」；不落盘的话重启一次这张表就空了，
// 补收会把重启前已经答过的老消息全部当成没处理过，重新答一遍。
// **`.has`/`.set` 是同步的**（底层就是内存 Map，落盘是副作用）——事件流和补收两条路
// 并发调 处理() 撞上同一条消息时，check-then-set 之间没有 await，谁先到谁赢，不会答两遍。
const 已处理 = 建持久表('已处理消息', { 存活毫秒: 24 * 60 * 60 * 1000 }); // message_id → { ts }
const 见过会话 = 建持久表('见过会话', { 存活毫秒: 30 * 24 * 60 * 60 * 1000 }); // chat_id → { ts }，给补收用（私聊不在 列群会话() 里）

let 直连 = false; // 启动预热定：true=fetch 直连飞书(~200ms/条)，false=退回 lark-cli(~3.5s/条 冷启动)
// 反馈按钮默认关：回调（card.action.trigger）要先在飞书后台订阅，没订阅就发出去只会得到点了没反应的按钮。
const 反馈开关 = process.env.BOT_FEEDBACK === '1';
const 卡片内容 = (md, 问答id = null, 选项 = {}) => ({ config: { wide_screen_mode: true }, elements: 卡片元素(md, 反馈开关 ? 问答id : null, 选项) });
// 卡片长度硬上限：飞书卡片有大小限制，太长会被拒发。超了截断 + 指向文件——SN 上万这类绝不整段塞卡片（明细走 CSV 文件）。
const 卡上限 = 2800;
const 截卡 = (md) => (md && md.length > 卡上限 ? md.slice(0, 卡上限) + '\n…（内容较多，完整明细见下方文件）' : (md || ''));

// —— lark-cli 兜底发送（直连没配/失败时用）。返回 message_id 或 null，两条路口径一致。——
function 发_cli(chat_id, msg_type, content) {
  return new Promise((res) => {
    const p = spawn(LC, ['api', 'POST', '/open-apis/im/v1/messages', '--as', 'bot',
      '--params', JSON.stringify({ receive_id_type: 'chat_id' }),
      '--data', JSON.stringify({ receive_id: chat_id, msg_type, content: JSON.stringify(content) }),
      '--format', 'json'], { env: ENV });
    let o = ''; p.stdout.on('data', (d) => { o += d; });
    p.on('close', () => { try { res(JSON.parse(o).data?.message_id || null); } catch { res(null); } });
  });
}
function 上传_cli(buf, 文件名) {
  return new Promise((res) => {
    const p = spawn(LC, ['im', 'files', 'create', '--as', 'bot', '--data', JSON.stringify({ file_type: 'stream', file_name: 文件名 }), '--file', 'file=-', '--format', 'json'], { env: ENV });
    let o = ''; p.stdout.on('data', (d) => { o += d; });
    p.on('close', () => { try { res(JSON.parse(o).data?.file_key || null); } catch { res(null); } });
    p.stdin.write(buf); p.stdin.end();
  });
}

// —— 统一入口：直连优先，失败退 lark-cli。发消息返回 message_id（供流式 PATCH 用）——
// 直连失败必须看得见：不打日志的话，token 换不动/密钥轮换之后每条消息都偷偷慢 8 倍（0.4s→3.5s），
// 而启动那行还写着"直连就绪"。连着失败 3 次就认账关掉直连（也就关掉流式刷卡），日志说明白。
let 我的openid = '';   // 启动时取一次，群里那道 @ 闸靠它（见文件末尾 [身份]）
let 直连连败 = 0;
async function 发(chat_id, msg_type, content) {
  if (直连) {
    const mid = await 直发消息(chat_id, msg_type, content).catch((e) => { process.stderr.write(`[直连失败] 发消息：${String(e.message).slice(0, 120)}\n`); return null; });
    if (mid) { 直连连败 = 0; return mid; }
    直连连败++;
    process.stderr.write(`[直连失败] 第 ${直连连败} 次，这条退回 lark-cli（慢 ~3.5s）\n`);
    if (直连连败 >= 3) { 直连 = false; process.stderr.write('[直连关闭] 连续 3 次失败，之后全走 lark-cli，卡片流式刷新一并停掉。重连要重启 bot。\n'); }
  }
  return 发_cli(chat_id, msg_type, content);
}
const 发文本 = (chat_id, text) => 发(chat_id, 'text', { text });
/**
 * 点了按钮之后回话：**先试着把那张卡片就地改掉**，改不成才另发一条。
 * 就地改是「点了有反应」最自然的形态 —— 点一次多一条消息，聊天记录很快就糊了。
 * token 30 分钟有效、最多用 2 次；用完了/过期了会走退路，日志里 [就地改卡] 那行会说为什么。
 */
async function 回话(f, md) {
  if (f?.回调token && await 就地改卡(f.回调token, 卡片内容(md), f.谁)) {
    process.stderr.write('[就地改卡] 改成了（没另发消息）\n');
    return true;
  }
  if (f?.聊天) { await 发文本(f.聊天, md); return false; }
  return false;
}
const 发卡片 = (chat_id, md, 问答id = null, 选项 = {}) => 发(chat_id, 'interactive', 卡片内容(md, 问答id, 选项));
const 元素卡 = (元素) => ({ config: { wide_screen_mode: true }, elements: 元素 });
const 发元素卡 = (chat_id, 元素) => 发(chat_id, 'interactive', 元素卡(元素));
const 改元素卡 = (mid, 元素) => (直连 && mid ? 直改消息(mid, 元素卡(元素)).catch(() => false) : Promise.resolve(false));
// 刷已发卡片（只有直连支持；lark-cli 冷启动太慢、流式没意义）。返回是否刷成功。
// **同一张卡片的更新排队，一个做完再发下一个。**
//
// 2026-08-24 真事（用户截图）：卡片上只剩「匹配」两个字，而日志里那条答案是完整的。
// 原来这里是发出去就不管——中途刷新和最终答案是两个并发的 HTTP PATCH，谁先到服务端不确定。
// 早发的那个后到，就把完整答案盖回半截了。这种「谁先落地看运气」正是它**间歇**发作的原因。
//
// 排队之后顺序就定死了：中途刷新 → …… → 最终答案，最终答案永远是最后一个写进去的。
// 代价是最终那次要多等前面几个刷新回来（每个约 200ms），但那几个本来也在飞，不是新增等待。
// **队列按 mid 分**：不同卡片之间没有先后关系，混在一条队里会互相拖慢。
const 卡片队列 = new Map(); // mid -> 最后一个还没完成的更新
const 改卡片 = (mid, md, 问答id = null, 选项 = {}) => {
  if (!直连 || !mid) return Promise.resolve(false);
  const 前一个 = 卡片队列.get(mid) || Promise.resolve();
  // catch 挡住前一个失败时把整条队带崩；这一次自己的失败照旧回 false（调用方要靠它退回「另发一条」）
  const 这一个 = 前一个.catch(() => {}).then(() => 直改消息(mid, 卡片内容(md, 问答id, 选项)).catch(() => false));
  卡片队列.set(mid, 这一个);
  // 队尾做完就把这张卡从表里删掉，别让 Map 一直涨（长跑进程里这是内存泄漏）
  这一个.finally(() => { if (卡片队列.get(mid) === 这一个) 卡片队列.delete(mid); });
  return 这一个;
};
async function 上传(buf, 文件名) {
  if (直连) { const fk = await 直上传(buf, 文件名).catch(() => null); if (fk) return fk; }
  return 上传_cli(buf, 文件名);
}
// 直接把内存里的 Buffer 当文件发（合出来的 xlsx 不落磁盘：它是几个 CSV 的派生物，
// 留一份在磁盘上只会多一个会过期、没人清的东西）。
async function 发字节(chat_id, buf, 文件名) {
  const fk = await 上传(buf, 文件名);
  if (fk) { await 发(chat_id, 'file', { file_key: fk }); return true; }
  return false;
}

// 大结果：把工具导出的 CSV 传上去、发文件到群
async function 发文件(chat_id, 路径) {
  const 真路径 = 路径.startsWith('~/') ? homedir() + 路径.slice(1) : 路径; // 工具回的短路径 ~ 展开成真路径，否则读不到
  let buf; try { buf = readFileSync(真路径); } catch { return false; }
  const fk = await 上传(buf, 取文件名(真路径));
  if (fk) { await 发(chat_id, 'file', { file_key: fk }); return true; }
  return false;
}

async function 处理(e) {
  if (调试原始事件) process.stderr.write('[原始事件] ' + JSON.stringify(e).slice(0, 600) + '\n');
  const mid = e.message_id || e.id;
  if (mid && 已处理.has(mid)) return;
  if (mid) { 已处理.清过期(); 已处理.set(mid, { ts: Date.now() }); } // 24 小时自动过期，不用自己管上限
  if (e.sender_type && e.sender_type !== 'user') return; // 别回机器人/自己
  const chat_id = e.chat_id; const sender = e.sender_id;
  const 问 = 去at(e.content, e.mentions); // 精确去 @占位（名字带空格也不切错）
  if (!chat_id || !问) return;
  // **群里没真被 @ 就别理**：2026-08-24 真事，同事在群里正常聊天（没 @ 机器人）也被当成一次
  // 查询处理掉了——飞书把这个 app 的群消息事件全量推过来，不是只推 @ 了它的那些。
  // 私聊不受这条管，见 该理会吗 的说明。
  if (!该理会吗(e.chat_type, e.content, e.mentions, 我的openid)) return;
  // **记一笔「这个会话我们说过话」，给补收用。** 私聊不在 列群会话() 的结果里 ——
  // 补收要盯的会话集合，群靠接口列，私聊只能靠「见过」记下来。TTL 30 天：
  // 断联超过一个月的私聊，不值得每轮补收都去拉一次。
  见过会话.set(chat_id, { ts: Date.now() });
  // **收到就记一笔，排在所有分支前面。**
  // 2026-08-24 踩到：这一行原来排在口令分支后面，于是打「日更」「帮助」「我问过什么」的消息
  // **在日志和心跳里完全隐形** —— 心跳照旧说「上次收到消息：从没收到过」，看起来像聋了。
  // 那天我自己就照着这个 grep 误判成「消息全丢了」，而实际上它收到了也办了。
  // 判据：日志里能不能看出「它收到过什么」，不能就是瞎的，跟功能对不对无关。
  计数.收到++; 计数.最后收到 = Date.now();
  process.stderr.write(`[收到] ${e.chat_type} 并发${并发} ${chat_id} sender=${sender}：${问}\n`);
  // 护栏：白名单 → 限流 → 并发
  if (白名单.size && sender && !白名单.has(sender)) { await 发文本(chat_id, '你还没开通这个查询机器人，找管理员加下白名单～'); return; }
  if (sender && 超限(sender)) { await 发文本(chat_id, '你这一小时问得有点多了，歇会儿再问哈～'); return; }
  if (并发 >= 并发上限) { await 发文本(chat_id, `手头有 ${并发} 个查询在跑，稍等几秒再 @ 我。`); return; }
  // 术语口令直达：不进模型。术语表影响所有人的查询结果，所以只有人能改、且记下是谁改的。
  // 「限定表格范围」口令：发一条带链接的消息就设好，**不进模型**。
  // 卡片输入框那条路 2026-08-23 验下来两处都卡（v1 压根不渲染输入框、v2 表单提交报错且事件到不了），
  // 而发消息是百分之百通的，还天然支持多张（一行一张）。
  // 打字「停」：按钮之外再给一条路 —— 手机上点按钮不方便时，一句「停」比找那张卡片快。
  if (认停口令(问)) {
    const 我的 = [...跑中.values()].filter((x) => x.chat_id === chat_id && x.sender === sender);
    process.stderr.write(`[停] ${sender} 打字喊停，找到 ${我的.length} 条在跑的\n`);
    for (const x of 我的) x.停.abort();
    await 发文本(chat_id, 我的.length ? `好，停了（${我的.length} 条）。重新问一遍吧。` : '你现在没有在跑的查询。');
    return;
  }
  // 帮助：**这些能力现在全靠背，背不住就等于不存在**。按钮解决「答案出来那一刻」的入口，
  // 解决不了「我还能干嘛」——所以再给一条能问出来的路。
  // 「我问过什么」：翻自己的记录。**只翻自己的** —— 所有人的问答在同一个文件里，
  // 不按人切的话，一句「老王问过什么」就能把别人的全翻出来。这是边界不是省事。
  if (认历史口令(问)) {
    const 条们 = 我问过(sender, { 几条: 10 });
    process.stderr.write(`[我问过] ${sender} 翻到 ${条们.length} 条\n`);
    await 发卡片(chat_id, 历史正文(条们));
    return;
  }
  if (认帮助口令(问)) {
    process.stderr.write(`[帮助] ${sender}\n`);
    await 发卡片(chat_id, 帮助正文(), null, { 可限表: true, 聊天: chat_id });
    return;
  }
  // 日更 / 周更 / 导工单：**口令在 bot 层直接办，不进模型**。理由和术语口令一样 ——
  // 都是固定的例行公事，没有什么要模型去理解的；让模型转述回执还会丢数。
  // 模型只在「疑似改名」那一步出场（日更/周更有，导工单没有）。
  const 例行 = 认例行口令(问);
  if (例行) { await 跑例行(例行, { chat_id, sender }); return; }
  // **说得像但没打准**（「执行下日更」这类）：2026-08-24 真事 —— 这种话直接落给模型，
  // 它拿只读工具东拼西凑答一段话，日更那条链**根本没被触发**，人以为问清楚了、其实什么也没跑。
  // 弹个按钮而不是直接跑：猜错的代价不对称，多问一句不点就没事，猜着跑起来是白等半分钟。
  const 例行猜 = 认例行近似(问);
  if (例行猜) {
    process.stderr.write(`[例行] 像「${例行猜.名}」但没打准口令，弹确认：${问.slice(0, 40)}\n`);
    await 发(chat_id, 'interactive', { config: { wide_screen_mode: true }, elements: 例行确认卡片元素(例行猜.名, 问, chat_id) });
    return;
  }
  const 范令 = 认范围口令(问);
  if (范令) {
    // key 在这儿自己算：这段在 `const key = …` 之前（口令不占并发、也不该占）。
    // 少了这一行会是「用在定义之前」——eslint 的 no-use-before-define 当场就逮住了。
    const 范key = `${chat_id}|${sender}`;
    const 上 = 上下文.get(范key) || { 历史: [], 摘要: '' };
    if (范令.要卡片) {
      process.stderr.write(`[范围] ${sender} 要输入框卡片\n`);
      await 发(chat_id, 'interactive', 范围表单卡());
      return;
    }
    if (范令.清) {
      上下文.set(范key, { ...上, 范围们: undefined, ts: Date.now() });
      process.stderr.write(`[范围] ${sender} 解除限定\n`);
      记一条({ chat: chat_id, sender, 类型: '范围解除' });
      await 发文本(chat_id, '好，不限表了，恢复成什么都能查。');
      return;
    } else {
      上下文.set(范key, { ...上, 范围们: 范令.设, ts: Date.now() });
      process.stderr.write(`[范围] ${sender} 限定 ${范令.设.length} 张：${范令.设.map((x) => x.sheet名 || '(未指定sheet)').join('、')}\n`);
      记一条({ chat: chat_id, sender, 类型: '范围限定', 张数: 范令.设.length });
      /**
       * **链接旁边还带着一句实质的话 = 带着表来问问题，不是设范围。**
       *
       * 2026-08-24 真事：「SP4交换机 10 TD3-10G 交换机 1 … 匹配下交换机 <链接>」被整个当成范围口令，
       * 设完范围回一张「已限定」卡片就 `return`，**那句要匹配的话一个字都没进模型**。
       * 人看到的是答非所问 → 点「解除」→ 重发 → 又被吃掉一次（日志里 19:12/19:13 连着三条）。
       *
       * 门槛 8 个字：纯口令抠掉链接和参数之后基本不剩什么（「只看这张：<链接>」→ 空），
       * 而带问题的那种剩一大截。判错的代价不对称：**多答一句没事，吞掉问题是彻底的答非所问**。
       */
      if ((范令.剩下 || '').length >= 8) {
        process.stderr.write(`[范围] 链接旁边还有话，限定完接着答：${范令.剩下.slice(0, 50)}\n`);
        await 发文本(chat_id, `📌 先限定到你给的${范令.设.length > 1 ? `这 ${范令.设.length} 张表` : '这张表'}，接着答你的问题…`);
        // **故意不 return** —— 落到下面正常处理。范围已经写进上下文，下面 `范围们` 读得到（同一个 key）。
      } else {
        // **回执必须复述** —— 认岔了要当场看见，而不是等答案错了才发现
        await 发卡片(chat_id, 范围回执(范令.设), null, { 可解除: true, 聊天: chat_id });
        return;
      }
    }
    // 走到这儿只有一条路：**设了范围、而且链接旁边还有实质的问题** —— 不 return，往下正常答。
  }
  const 令 = 认口令(问);
  if (令) {
    await 办口令(令, chat_id, sender);
    return;
  }
  并发++;
  const key = `${chat_id}|${sender}`;
  const 上 = 上下文.get(key);
  const 在窗内 = 上 && Date.now() - 上.ts < 上下文分钟 * 60000; // 时间窗内的追问才带上文
  const 摘要 = 在窗内 ? (上.摘要 || '') : '';
  // 摘要以一条 system 消息打头，后面接最近几轮原文。**摘要是被压掉那些轮的替身**，
  // 没有它的话，同事连着问五六句之后，最早那句定调的话（「我说的是临港那批」「按在库口径」）
  // 就悄悄没了 —— 而模型不会说"我忘了"，它会按默认口径接着答。
  const 摘要头 = 摘要消息(摘要);
  const 范围们 = 在窗内 ? (上.范围们 || null) : null; // 范围跟着追问上下文的时间窗走，过期自动松开
  const 原历史 = 在窗内 ? (上.历史 || []) : [];              // 存着的原文轮次（往后接、往后压的是这份）
  const 历史 = [...(摘要头 ? [摘要头] : []), ...原历史];      // 发给模型的那份 = 摘要 + 原文轮次
  const 起手 = Date.now(); // 从「收到并决定处理」开始算，用来在 [答复] 里拆耗时
  const 问答id = `${起手.toString(36)}${(mid || '').slice(-4)}`; // 这次问答的编号，带进反馈按钮
  // （`[收到]` 和收到计数已经在函数开头打过了 —— 排在所有口令分支之前，见那里的注释。
  //  sender 打在那一行：填白名单只能靠它，飞书没给这个 app 读群成员的权限。）
  // 发一张初始卡片当"收到"，后面往这张上刷（直连才刷得动；没直连就最后另发一张）。返回它的 message_id。
  const 卡id = await 发卡片(chat_id, '⏳ 收到，正在查…', null, { 可停: true, 问答id, 聊天: chat_id });
  // 超时/出错后作废：agent 那边就算还有半口气也不许再刷这张卡，否则会把刚写的超时提示盖回半截答案。
  const 停 = new AbortController();
  跑中.set(问答id, { 停, chat_id, sender, 起手 });
  // 刷卡片：节流 600ms + 作废闸（逻辑在 lib/护栏.mjs 建刷，tests/护栏.test.mjs 双向验过）。
  const 刷 = 建刷((md) => { if (直连 && 卡id) 改卡片(卡id, md); }, { 节流毫秒: 600, signal: 停.signal });
  let 步数 = 0, 最后工具 = '';                                  // 记进度，超时时好说清卡在哪
  // 看门狗：有进展就续命，卡住不动才杀。onStep/onDelta 本来就是"进展"的信号，顺手喂它。
  // 原来是一刀切 60 秒总时长——实测对账 54.3s、对齐 44.8s，离线只剩几秒，表大一点就翻。
  let 判死原因 = null, 拒 = null;
  const 到期了 = new Promise((_, rej) => { 拒 = rej; });
  const 看门狗 = 建看门狗({
    空闲毫秒: 空闲秒 * 1000,
    硬顶毫秒: 硬顶秒 * 1000,
    到期: (因) => { 判死原因 = 因; 停.abort(); 拒(new Error(`这条查询${因}`)); },
  });
  // 这条查询自己的一份清单。**按查询建、不跨查询、不落盘** —— 进程没了那条查询本来就死了。
  // 它管的不是"让模型更聪明"，是**已经办完的事别因为后面卡住而白做**（见 lib/清单.mjs）。
  const 清单 = 建清单();
  const onStep = (名) => { 步数++; 最后工具 = 名; 看门狗.喂(); 刷(`🔍 正在查 **${名}**…（第 ${步数} 步）${清单.进度文()}`); };
  // 阶段提示。**不假装在出字**：公司网关缓冲完才吐，所以「一个字一个字冒出来」做不到；
  // 能给的真实反馈只有「在想调什么」→「在查 X」→「查完了在整理」这三段，其中最后一段常要等十几秒。
  const on想 = (轮) => { 看门狗.喂(); 刷(轮 === 0 ? '⏳ 收到，正在想怎么查…' : `✍️ 查完了（调了 ${步数} 次），正在整理答案…`); };
  const onDelta = (t) => { 看门狗.喂(); 刷(截卡(t)); }; // 答案到了就刷上去（去掉了假光标，它并不是逐字来的）
  try {
    const 结果 = await Promise.race([
      跑一句(问, { 模型配置, MCP们, 历史, onDelta, onStep, on想, signal: 停.signal, 可反问: true, 可写, 可教术语: true, 谁: sender, 术语: 术语段(), 范围: 范围们, 清单 }),
      到期了,
    ]);
    const { 回答, 用了, csv路径们, 用的模型, 收敛, 耗时, 用量, 截断, 压缩过 } = 结果;
    if (结果.待澄清) {
      const { 问题, 选项 } = 结果.待澄清;
      待澄清.清过期();
      待澄清.set(问答id, { 问, chat_id, sender, ts: Date.now() });
      const 元素 = 澄清卡片元素(问题, 选项, 问答id, chat_id);
      process.stderr.write(`[澄清] 反问：${问题} ｜ 选项 ${选项.join(' / ')}\n`);
      if (直连 && 卡id) { const ok = await 改元素卡(卡id, 元素); if (!ok) await 发元素卡(chat_id, 元素); }
      else await 发元素卡(chat_id, 元素);
      记一条({ 问答id, chat: chat_id, sender, 问, 类型: '反问', 问题, 选项, 总毫秒: Date.now() - 起手 });
      return; // 这一轮暂停在这儿，等人点
    }
    if (结果.待教术语) {
      const { 词, 猜 } = 结果.待教术语;
      教术语票.清过期();
      教术语票.set(key, { 问, 词, ts: Date.now() });
      process.stderr.write(`[问术语] 模型问「${词}」是什么${猜 ? `（猜：${猜}）` : '（猜不出）'}\n`);
      记一条({ 问答id, chat: chat_id, sender, 问, 类型: '问术语', 词, 猜, 总毫秒: Date.now() - 起手 });
      // **带输入框的卡片（schema 2.0）只能新发，绝不能 PATCH 到进度卡上。**
      // 2026-08-23 真踩的：改上去 API 回成功、`updated:true`，但飞书渲染不了，
      // 那张 ⏳ 进度卡当场变成一句「请升级至最新版本客户端，以查看内容」—— 看着就是卡死，
      // 而日志、退出码、API 返回**全是绿的**。同一张卡用 POST 新发是好的（输入框正常显示）。
      const 发了 = await 发(chat_id, 'interactive', 教术语卡(词, 猜));
      process.stderr.write(`[问术语] 卡片${发了 ? `发出去了（${发了}）` : '**没发成**'}\n`);
      // 进度卡改成一句话（v1 改 v1，安全），免得它一直停在「正在查…」上
      if (直连 && 卡id) await 改卡片(卡id, `❓ 有个词我不认识：**${词}**。看下面那张卡片，填完我就接着查。`);
      return; // 等人填
    }
    if (结果.待确认) {
      const { 全名, 工具名, 参数 } = 结果.待确认;
      待写.清过期();
      const { 人字段, 摘要字段 } = 结果.待确认;
      const 票id = `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
      待写.set(票id, { 全名, 工具名, 参数, 人字段, chat_id, sender, ts: Date.now() });
      // **摘要字段给了就按人话摆，没给才退回 JSON**。整块 JSON 人得逐行读才知道要写什么，
      // 而这张卡的全部意义就是让人一眼看出「这是不是我要的」——看不清就等于没确认。
      const 摘要 = 摘要字段?.length
        ? `工具：**${工具名}**\n${摘要字段.filter((k) => 参数[k] !== undefined)
          .map((k) => `· ${k}：${typeof 参数[k] === 'object' ? JSON.stringify(参数[k]).slice(0, 300) : String(参数[k]).slice(0, 300)}`).join('\n')}`
          + (人字段 ? `\n· ${人字段}：**你**（点确认那一下我按点的人填，不用模型写的）` : '')
        : `工具：**${工具名}**\n参数：\n\`\`\`json\n${JSON.stringify(参数, null, 2).slice(0, 1200)}\n\`\`\``;
      const 元素 = 确认卡片元素(摘要, 票id, chat_id);
      process.stderr.write(`[待写] ${工具名} 票=${票id} 发起人=${sender}\n`);
      if (直连 && 卡id) { const ok = await 改元素卡(卡id, 元素); if (!ok) await 发元素卡(chat_id, 元素); }
      else await 发元素卡(chat_id, 元素);
      记一条({ 问答id, chat: chat_id, sender, 问, 类型: '待写', 工具: 工具名, 票id, 总毫秒: Date.now() - 起手 });
      return; // 等人点
    }
    计数.答复++;
    // 耗时拆到「模型/工具」两栏：只报总时长的话，下次再说「慢」还是只能猜是谁慢
    const 秒 = (ms) => (ms / 1000).toFixed(1);
    const 拆 = 耗时 ? `｜耗时 ${秒(Date.now() - 起手)}s = 模型 ${秒(耗时.模型毫秒)}s + 工具 ${秒(耗时.工具毫秒)}s + 其余 ${秒(Date.now() - 起手 - 耗时.模型毫秒 - 耗时.工具毫秒)}s（${耗时.轮数} 轮）` : '';
    // token 也打出来：模型那几秒到底花在「想」还是「写」上，只有这一行看得出来
    const 账 = 用量?.输出 ? `｜token 入${用量.输入}/出${用量.输出}（思考 ${用量.思考}，单轮峰值 ${用量.峰值输入}）` : '';
    process.stderr.write(`[答复] 模型=${用的模型 || '?'} 收敛=${收敛} 用了 ${用了.join('、') || '(无工具)'}${csv路径们?.length ? ` +CSV×${csv路径们.length}` : ''} 直连=${直连}${范围们 ? `｜限定${范围们.length}张表` : ''}${拆}${账}\n[回答] ${String(回答).replace(/\n/g, ' ').slice(0, 200)}\n`);
    // 降级要让群里看得见：主力挂了只在日志里写一行「模型=备用」，用户端只感觉到「慢」，没人知道为什么
    记一条({ 问答id, chat: chat_id, sender, 问, 模型: 用的模型, 收敛, 用了, 轮数: 耗时?.轮数,
      模型毫秒: 耗时?.模型毫秒, 工具毫秒: 耗时?.工具毫秒, 总毫秒: Date.now() - 起手, CSV几个: csv路径们?.length || undefined,
      // token 账：耗时 ≈ 输出token × 6.4ms（2026-08-22 实测），而**短问题里九成输出是思考**。
      // 记下来，下次问「这条为什么慢」就不用再做一遍实验。
      输入token: 用量?.输入, 输出token: 用量?.输出, 思考token: 用量?.思考,
      峰值输入token: 用量?.峰值输入, 挪走回包: 压缩过 || undefined, 截断: 截断 || undefined, 答: 回答 });
    const 主力 = (模型配置.models || [])[0];
    const 降级说明 = (用的模型 && 主力 && 用的模型 !== 主力)
      ? `\n\n---\n⚠ 主力模型 **${主力}** 没响应，这条是备用模型 **${用的模型}** 答的，可能更慢或更笨。`
      : '';
    // **被 max_tokens 砍断要让群里看见**：半截答案和完整答案长得一模一样，
    // 不说的话同事会把「…临港9号楼有」当成一句说完的话拿去用。
    const 截断说明 = 截断 === 'answer'
      ? '\n\n---\n⚠ 这条答案**写到一半被长度上限截断了**（不是查完了），最后一句可能没说完。让我分几次问、或者把范围缩小些再问一遍。'
      : '';
    const 终 = 截卡(回答 || '(没查到内容)') + 截断说明 + 降级说明; // 定稿也过硬上限，防超长卡片被飞书拒
    // 定稿：直连就把最终答案刷进那张卡片（去掉光标）；没直连（改不动卡）就另发一张。
    // 挂不挂「要 SN 明细」按钮：只在这次真查了库存类工具时挂。
    // 别到处挂 —— 挂在一个给不出 SN 的答案上，点了只会得到一句「查不到」。
    const 能给SN = 用了.some((x) => SN能给的工具.has(x));
    // 这一轮真导出了明细才挂「导出到飞书表格」—— 没数据可导时挂着，点了只会得到一句「没有明细」
    const 能导表 = (csv路径们 || []).length > 0;
    // **这一轮真读了飞书表、而且还没限定过** 才挂「只看某张表」——
    // 已经限定了还挂，人会以为点了能换一张（其实是追加），反而绕。
    const 读过表 = 用了.some((x) => 表格工具.has(x));
    const 能限表 = 读过表 && !范围们;
    // 链接优先从人这次问话里抠（他多半是贴了链接的）；抠不到就给空表单，让他自己贴。
    const 限表链接 = 取表token(问) ? (问.match(/https?:\/\/[^\s|，,]+/) || [''])[0] : '';
    if (能导表) {
      导表票.清过期();
      导表票.set(问答id, { 路径们: csv路径们, chat_id, sender, ts: Date.now() });
    }
    const 卡选项 = { 要SN: 能给SN, 可导表: 能导表, 可限表: 能限表, 限表链接, 聊天: chat_id };
    // **写最终答案之前先掐掉中途刷新**：中途那些 `改卡片` 是发出去就不管的异步请求，
    // 不掐的话，早先某个还在飞的请求会在最终答案落地之后才到、把完整答案盖回半截。
    // 2026-08-24 真事：用户截图卡片上只剩「匹配」两个字（答案的前两字），而日志里那条答案是完整的。
    刷.收尾();
    let 答卡id = 卡id;
    if (直连 && 卡id) { const ok = await 改卡片(卡id, 终, 问答id, 卡选项); if (!ok) 答卡id = await 发卡片(chat_id, 终, 问答id, 卡选项); }
    else 答卡id = await 发卡片(chat_id, 终, 问答id, 卡选项);
    // 记下这条答案的 message_id，人对它打表情时才找得回来是哪一轮
    if (答卡id) { 消息到问答.清过期(); 消息到问答.set(答卡id, { 问答id, chat_id, sender, ts: Date.now() }); }
    // **一轮可能导出好几张表**（问「光模块和整机各多少」＝两次查库存＝两张表）。
    // 两张以上就合成**一个 xlsx、一个 sheet 一张表** —— 发两个文件的话人要下两次、开两次、
    // 自己对照，而它们本来就是一件事的两半。一张就直接发，别为了统一形式给单张表套个壳。
    await 发明细(chat_id, csv路径们 || []);
    // —— 存上下文 + 压缩 ——
    // 留几轮：从 4 轮提到 保留轮（默认 6）。多带几轮几乎不花钱 —— 实测输入 12486 token
    // 在一条 4.7 秒的查询里占比很小，而上限是 288954。答案也从截 1200 字放宽到 2500，
    // 原来那刀常常正好切掉答案末尾的数字。
    上下文.清过期(); // 这张表本来只增不减
    // 往 **原历史** 上接，不是往发给模型那份上接 —— 那份前面挂着摘要，
    // 接上去会把摘要当成一轮对话再压一次，越滚越大还重复。
    const 全历史 = [...原历史, { role: 'user', content: 问 }, { role: 'assistant', content: String(回答).slice(0, 2500) }];
    const { 留, 压 } = 该压吗(全历史, 保留轮);
    // **压缩没回来之前先把完整历史存着**。原来这里直接存 留（砍掉老的），而摘要要 6 秒后才到 ——
    // 那 6 秒里被砍的几轮**在历史和摘要里都不在**，这期间的追问会凭空少一轮上文。
    // 砍这一下挪到压缩回来之后做（压成没压成都砍，见 压完怎么写）。
    上下文.set(key, { 历史: 压.length ? 全历史 : 留, 摘要, 范围们, ts: Date.now() });
    // **压缩放在答复发出之后**：它是一次额外的模型调用（2-4 秒）。放前面就是让同事白等，
    // 而压缩对这一轮的答案毫无帮助 —— 它是给下一轮用的。压失败保持原样（退回「丢掉老的」）。
    if (压.length) {
      压一次({ 问模型, 模型配置, 旧摘要: 摘要, 要压的: 压 }).then((新摘要) => {
        const 写 = 压完怎么写(上下文.get(key), { 保留轮, 旧摘要: 摘要, 新摘要 });
        if (!写) { process.stderr.write(`[压缩] ${key.slice(0, 24)}… 这期间上下文过期或被别的查询压过了，这次不写回\n`); return; }
        上下文.set(key, 写);
        process.stderr.write(`[压缩] ${key.slice(0, 24)}… 把 ${压.length / 2} 轮折进摘要`
          + `${新摘要 === 摘要 ? '**没压成，保持原样**' : `，摘要现在 ${新摘要.length} 字`}`
          + `，原文留 ${写.历史.length / 2} 轮\n`);
      }).catch(() => { /* 压缩失败不许影响任何东西 */ });
    }
  } catch (err) {
    停.abort(); // 出错也一样：先把还在跑的那半停掉，免得它继续刷卡片盖掉下面这条提示
    计数.出错++;
    记一条({ 问答id, chat: chat_id, sender, 问, 出错: String(err.message).slice(0, 120), 判死: 判死原因 || null,
      步数, 最后工具: 最后工具 || null, 总毫秒: Date.now() - 起手 });
    process.stderr.write(`[出错] ${err.message} | 步数=${步数} 最后=${最后工具}\n`);
    // 别只甩"太重或卡了"——说清它干到哪、为啥慢、怎么办（治"比静默还可恶"）
    // 判死原因用看门狗给的那句，不再拿正则去猜错误文本（文案一改正则就悄悄失配）
    // **先交半份，再说卡在哪。** 顺序是故意的：人要的是数据，不是故障说明。
    // 原来这条路只回一句「卡住了」—— 一条 9 步的查询在第 8 步撞硬顶，前 7 步查到的东西
    // **一个字都没给人**。有清单就把办完的那几项原样交出去（`lib/清单.mjs` 的 交半份）。
    // 没清单时它回空串，整段退回原来的样子，不多一个字。
    const 半份 = 清单.交半份();
    const 卡在哪 = 判死原因
      ? `这条**${判死原因}**（不是崩，是卡住或太重）。它已经调了 **${步数}** 次查询${最后工具 ? `，卡在「${最后工具}」这步` : ''}。\n`
        + '多半是「读大表 + 逐个撞 CMDB」这类**批量匹配**，群里的轻量模型干不动。**怎么办**：\n'
        + '① 缩小范围——先问一两个具体型号/SN/订单，别整列整表一次问；\n'
        + '② 大批量对账（整列型号补规格这种）让管理员在 WorkBuddy 里跑，那边扛得住。'
      : 说人话(err.message); // 原文已经进了上面那行 [出错] 日志，给人的这句只说大白话 + 怎么办
    const 提示 = 半份 ? `${半份}\n\n---\n${卡在哪}` : 卡在哪;
    if (直连 && 卡id) { const ok = await 改卡片(卡id, 提示); if (!ok) await 发文本(chat_id, 提示); }
    else await 发文本(chat_id, 提示);
  // **跑完一定要从「跑中」里摘掉**：不摘的话这张表只增不减，而且人点一张老卡片上的「停」，
  // 会去 abort 一个早就结束的 controller —— 表面上"停了"，实际什么都没发生。
  } finally { 看门狗.停(); 并发--; 跑中.delete(问答id); }
}

// —— ① cmdb 令牌保活：定期验令牌，快过期/过期了就在提醒群 @ 人去开内网CMDB（confidential client 没法自动续，只能提醒）——
// 没配 chat 也要查、也要写日志：日志是持久的（守护.mjs 落盘），只有「发进飞书」这步才需要 chat_id。
// 原来第一行是 if (!提醒chat) return —— 没配就整个不查，令牌过期时群里只会开始报错、日志里一个字都没有。
async function 查令牌(首次 = false) {
  try {
    const s = JSON.parse(await cmdb.调工具('验令牌', {}));
    const 剩 = s.剩余分钟 ?? 0;
    // 开机那次不管好坏都打一行：不然「日志里没有 [令牌]」既可能是健康、也可能是这条检查自己挂了，分不出来。
    if (首次 && s.新鲜 && 剩 >= 60) process.stderr.write(`[令牌] 正常，剩 ${剩} 分钟（约 ${(剩 / 60).toFixed(1)} 小时）\n`);
    if (!s.新鲜 || 剩 < 60) {
      if (!查令牌._提醒过) {
        process.stderr.write(`[令牌] 内网CMDB令牌快过期/已过期（剩 ${剩} 分钟）——查资产/透视/工单要开始失败了。开一下内网CMDB页面让小油猴送新令牌。\n`);
        if (提醒chat) await 发文本(提醒chat, `⚠ 内网CMDB令牌快过期/已过期（剩 ${剩} 分钟），查资产/工单会失败。请开一下内网CMDB页面让小油猴送新令牌。`);
        查令牌._提醒过 = true;
      }
    } else 查令牌._提醒过 = false; // 恢复后重置，下次过期再提醒一次
  } catch (e) { process.stderr.write(`[令牌] 验令牌这一步自己失败了：${String(e.message).slice(0, 120)}\n`); } // 原来这里是空 catch，cmdb 挂了也悄无声息
}
setInterval(查令牌, 30 * 60 * 1000);
查令牌(true); // 起来就先查一次：拿着一张已经快过期的令牌开机，不该等 30 分钟才知道

// —— 心跳：只写日志、不发飞书。发飞书报警会误报（晚上本来就没人 @），
//    但"它是不是聋了"必须能查——grep `[心跳]` 一行就知道收到过几条、上次是什么时候。——
setInterval(() => {
  const 距 = 计数.最后收到 ? `${Math.round((Date.now() - 计数.最后收到) / 60000)} 分钟前` : '从没收到过';
  process.stderr.write(`[心跳] 收到 ${计数.收到} / 答复 ${计数.答复} / 出错 ${计数.出错} / 事件重连 ${计数.重连} 次｜反馈 ${计数.反馈}｜上次收到消息：${距}｜直连=${直连}｜并发 ${并发}\n`);
}, 心跳分钟 * 60 * 1000);

// —— 日更定时：每分钟看一眼到点没有。**不用精确定时器**，因为进程会重启、机器会睡 ——
//    到点那一刻恰好没在跑的话，精确定时器就永远错过了；而「到点了没跑过就跑」醒来还能补。
//    补跑的窗口是一小时（在 该跑吗 里）：早上 9 点的日更下午 3 点才跑没有意义，数据早就变了。
const 例行chat = 读例行chat();
{
  const 开了的 = Object.entries(定时表).filter(([, 点们]) => 点们.length);
  if (开了的.length && !例行chat) {
    // **配了时间却没有收件人 = 定时静默失效**，表现和「今天没到点」一模一样。喊出来。
    process.stderr.write(`[例行] ⚠ **配了 ${开了的.map(([名]) => 名).join('/')} 的时间但没有发到哪的会话** —— `
      + '这些定时都不会生效。在 .creds.json 里写 daily_chat（或 nudge_chat）。\n');
  } else if (开了的.length) {
    for (const [名, 点们] of 开了的) process.stderr.write(`[例行] ${名} 定时开着：${定时说法(点们)}，推到 ${例行chat}\n`);
    process.stderr.write('[例行] **定时推的卡片没有发起人，那个会话里任何人都能点「确认写入」**\n');
    setInterval(() => {
      for (const [名, 点们] of 开了的) {
        const 标记 = 该跑吗(new Date(), 点们, 例行跑过[名]);
        if (!标记) continue;
        例行跑过[名].add(标记); // **先记再跑**：跑失败也不重跑，否则一分钟一次刷屏
        process.stderr.write(`[例行] ${名} 到点了（${标记}）\n`);
        跑例行(例行们[名], { chat_id: 例行chat, sender: '', 定时: true })
          .catch((e) => process.stderr.write(`[例行] ${名} 定时那趟挂了：${String(e?.message).slice(0, 150)}\n`));
      }
    }, 60 * 1000);
  } else {
    process.stderr.write('[例行] 定时都没开（.creds.json 里没写 daily_at/weekly_at/orders_at）——打「日更」「周更」「导工单」照样能跑\n');
  }
}

// —— 补收：飞书长连接**每天断 33-76 次**（2026-08-24 实测），断的那几秒发的消息永久丢失，
// 而 bot 完全看不见 —— 断在 lark-cli 内部，子进程没死，起事件() 的重连计数是 0，心跳一片祥和。
// 那天 11:59 的一条「日更」就是这么没的：飞书那边有这条消息，bot 这边零记录，人以为机器人掉线了。
// **不靠检测断线**：改成定期把最近几分钟的消息拉一遍，多拉的靠去重（已处理 表）挡掉。
let 群缓存 = []; let 群缓存时刻 = 0;
async function 补收会话们() {
  // 群列表缓存 5 分钟才刷一次——这是个 API 调用，补收每 90 秒跑一次没必要每次都打。
  if (Date.now() - 群缓存时刻 > 5 * 60 * 1000) {
    try { 群缓存 = await 列群会话(); 群缓存时刻 = Date.now(); }
    catch (e) { process.stderr.write(`[补收] 列群会话失败，用旧缓存（${群缓存.length} 个）：${String(e.message).slice(0, 100)}\n`); }
  }
  // 私聊不在 列群会话() 里，只能靠「见过会话」记下来的那些。
  return [...new Set([...群缓存, ...[...见过会话].map(([id]) => id)])];
}
let 待补收会话缓存 = [];
/**
 * **进程起来之前的消息一律不补。**
 *
 * 2026-08-24 真踩到：15:45 答完一条「匹配下」，15:52 我为了上线改动重启了 bot，
 * 15:53 补收第一轮就把那条**重新答了一遍** —— 第二次没调任何工具、凭上下文把上一次的
 * 答案复述了一遍，烧了 33 秒和一次模型调用。
 *
 * 根因：`已处理` 是当天才加的持久表，那条消息被答的时候跑的还是没有这张表的旧代码，
 * 从来没写进去过。但**这不是一次性的历史遗留**——只要一条消息在重启前 10 分钟内被答过、
 * 而它的 id 因为任何原因不在表里（表被清、TTL 过期、换了台机器、改了 BOT_STATE_DIR），
 * 补收就会重答一遍，而且**每次重启都可能重犯**。
 *
 * 补收要救的是「长连接断线那几秒丢的消息」，那些消息**必然发生在进程活着的时候**。
 * 进程起来之前的消息，要么早被上一个进程答过、要么是那个进程死透了期间的——
 * 后者补了也是几分钟后的过期答案，不如不补。所以拿启动时刻当硬边界，比去修去重表可靠。
 */
const 启动时刻 = Date.now();
const 补一轮 = 建补收({
  拉: (chat, 从秒) => 拉最近消息(chat, 从秒),
  // 两条都要：启动前的直接当「见过」挡掉；启动后的才查去重表。
  // **注意这里拿不到消息时刻**，只有 id —— 所以真正的时刻判断放在 建补收 的 回看毫秒 上，
  // 这里只挡去重表那条路。见下面 回看毫秒 的算法。
  见过: (mid) => 已处理.has(mid),
  记下: () => {}, // **故意什么都不做**：真正的「标记已处理」必须只在 处理() 里做（check 和 set 之间没有 await），
  //                 补收和事件流才不会在同一条消息上竞态、答两遍。这里标记了反而会让 处理() 误判成「已经处理过」而直接跳过。
  办: (e) => 处理(e),
  会话们: () => 待补收会话缓存, // 同步读缓存；缓存由下面的定时器异步刷新
  // **REST 拉不到 chat_type，只能靠「在不在群列表里」反推**：在 群缓存 里的就是群，
  // 不在的当私聊。群缓存 是 列群会话() 的结果，理论上覆盖了机器人在的所有群。
  会话类型: (chat) => (群缓存.includes(chat) ? 'group' : 'p2p'),
  不早于: 启动时刻, // 见上面那段注释：进程起来之前的消息一律不补
});
setInterval(async () => {
  try { 待补收会话缓存 = await 补收会话们(); } catch (e) { process.stderr.write(`[补收] 刷会话列表失败：${String(e.message).slice(0, 100)}\n`); return; }
  try {
    const r = await 补一轮();
    if (r?.补了) process.stderr.write(`[补收] 扫了 ${r.扫了} 条，补上 ${r.补了} 条（**这些是长连接断线期间飞书那边收到、bot 没收到的**）\n`);
  } catch (e) { process.stderr.write(`[补收] 这轮出错：${String(e.message).slice(0, 150)}\n`); }
}, 90 * 1000);
process.stderr.write('[补收] 每 90 秒把最近 10 分钟的消息对一遍，长连接断线丢的会被补上（不额外发确认，直接当收到处理）\n');

// —— ③ 全局兜底：一个查询/回调抛错不许整个 bot 崩掉 ——
process.on('unhandledRejection', (e) => process.stderr.write('[未捕获rejection] ' + String(e?.message || e).slice(0, 200) + '\n'));
process.on('uncaughtException', (e) => process.stderr.write('[未捕获异常] ' + String(e?.message || e).slice(0, 200) + '\n'));

// —— ② 消费事件（NDJSON，一行一个）+ 断了自动重连（不用手动 event stop 重启）——
let 重连延时 = 3000;
function 起事件() {
  const ev = spawn(LC, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'], { env: ENV });
  let buf = '';
  ev.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      重连延时 = 3000; // 收到事件=连接健康，重连退避归零
      处理(e).catch((err) => process.stderr.write('[处理出错] ' + err.message + '\n'));
    }
  });
  ev.stderr.on('data', (d) => process.stderr.write('[event] ' + d.toString().slice(0, 200)));
  ev.on('close', (c) => {
    计数.重连++;
    process.stderr.write(`[event consume 退出 code=${c}] ${重连延时 / 1000}s 后自动重连…\n`);
    try { spawn(LC, ['event', 'stop'], { env: ENV }); } catch { /* 先停卡住的总线再重连 */ }
    setTimeout(起事件, 重连延时);
    重连延时 = Math.min(重连延时 * 2, 60000); // 退避，最多 60s，防连炸时刷屏
  });
}
// —— 预热飞书直连：成功=发消息走 fetch(~200ms/条)，失败=退回 lark-cli(~3.5s/条 冷启动) ——
try { const app = await 预热直连(); 直连 = true; process.stderr.write(`[直连] 飞书 REST 直连就绪（app=${app}），发消息走 fetch（~200ms）\n`); }
catch (e) { process.stderr.write(`[直连] 未启用：${String(e.message).slice(0, 100)} → 退回 lark-cli 发消息（~3.5s/条）\n`); }

/**
 * **取机器人自己的 open_id** —— 群里那道「@ 的是不是我」的闸要拿它去比 mentions。
 * 拿不到的话闸会**一律不理群消息**（见 `该理会吗`）：群里多嘴的代价比漏答大得多，
 * 所以这一行取不到必须喊出来，不然表现是「它在群里突然不说话了」而没人知道为什么。
 */
try {
  我的openid = await 取我的openid();
  process.stderr.write(`[身份] 我的 open_id=${我的openid} —— 群里只理 @ 到这个 id 的消息\n`);
} catch (e) {
  process.stderr.write(`[身份] **拿不到自己的 open_id**：${String(e.message).slice(0, 140)}\n`
    + '[身份] **群里的消息一条都不会理了**（宁可漏答，也不插进别人的对话）。私聊不受影响。\n');
}

起事件();

// —— 表情事件（im.message.reaction.created_v1）。2026-08-23 实测**已经订阅好了**，
//    直接 consume 就连得上，不用去后台配。
function 起表情事件() {
  const ev = spawn(LC, ['event', 'consume', 'im.message.reaction.created_v1', '--as', 'bot'], { env: ENV });
  let buf = '';
  ev.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const f = 认表情(e);
      if (!f) { process.stderr.write('[表情] 认不出这个事件，原样：' + JSON.stringify(e).slice(0, 400) + '\n'); continue; }
      处理表情(f).catch((err) => process.stderr.write('[表情] 处理出错：' + err.message + '\n'));
    }
  });
  ev.stderr.on('data', (d) => process.stderr.write('[表情event] ' + d.toString().slice(0, 200)));
  ev.on('close', (c) => process.stderr.write(`[表情event 退出 code=${c}] 表情通道停了（不影响查询）\n`));
}
起表情事件();

// —— 反馈按钮的事件（card.action.trigger）。**默认不起**：回调没在飞书后台订阅时，
//    lark-cli 会直接报 failed_precondition，起了只会刷屏。订阅之后用 BOT_FEEDBACK=1 打开。——
// 人点了澄清选项 → 把「原问题 + 你选的」重问一遍。**明确告诉模型别再问**，否则可能来回问。
async function 处理澄清(f) {
  const 存 = 待澄清.get(f.问答id);
  if (!存) {
    // **别静默**：原来这里只写一行日志就 return，人点了按钮群里一个字都没有。
    // 现在票落盘了，走到这儿基本只剩「真过期」或「点了两次」，但也得说一声。
    process.stderr.write(`[澄清] ${f.问答id} 找不到或已过期\n`);
    if (f.聊天) await 发文本(f.聊天, '这个选项已经过期了（或者已经选过一次）。重新问一遍吧。');
    return;
  }
  待澄清.delete(f.问答id);
  process.stderr.write(`[澄清] ${f.谁} 选了「${f.选择}」，重跑：${存.问}\n`);
  记一条({ 类型: '澄清选择', 问答id: f.问答id, sender: f.谁, 选择: f.选择 });
  await 处理({
    chat_id: 存.chat_id,
    sender: f.谁 || 存.sender,
    chat_type: 'group',
    message_id: `澄清${f.问答id}${Date.now().toString(36)}`, // 造一个新 id，别撞去重表
    content: JSON.stringify({ text: `${存.问}（我已经确认：${f.选择}。按这个继续，别再问了。）` }),
    mentions: [],
  });
}

// 人点了「确认写入」或「取消」。**四道校验**：票在不在 / 有没有过期 / 是不是发起人本人 / 用存下来的参数。
// 办术语口令。**冲突不静默覆盖**：同一个词换了意思，要人再说一次「改成」才动。
async function 办口令(令, chat_id, sender) {
  if (令.动作 === '列') {
    const 表 = 列术语();
    if (!表.length) { await 发文本(chat_id, '还没教过我什么术语。教法：「记住：通算就是CPU机」'); return; }
    const 文 = 表.map((x) => `· **${x.词}** = ${x.释义}　（${x.何时}）`).join('\n');
    await 发卡片(chat_id, `我记着这些黑话（${表.length} 条）：\n\n${文}\n\n忘掉某条：「忘掉 通算」`);
    return;
  }
  if (令.动作 === '改') {
    const r = 改术语(令.词, 令.释义, sender);
    process.stderr.write(`[术语] ${sender} 改「${令.词}」=「${令.释义}」→ ${JSON.stringify(r)}\n`);
    记一条({ 类型: '术语', 动作: '改', 词: 令.词, 释义: 令.释义, sender });
    await 发文本(chat_id, r.改了 || r.加了 ? `改好了：${令.词} = ${令.释义}` : '这条没改上（写不进去）。');
    return;
  }
  if (令.动作 === '删') {
    const r = 删术语(令.词);
    process.stderr.write(`[术语] ${sender} 删「${令.词}」→ ${JSON.stringify(r)}\n`);
    记一条({ 类型: '术语', 动作: '删', 词: 令.词, sender });
    await 发文本(chat_id, r.删了 ? `好，忘掉「${令.词}」了。` : `我本来就没记过「${令.词}」。`);
    return;
  }
  // 加：先试加，撞了同名不同义就报冲突让人拍
  const r = 加术语(令.词, 令.释义, sender);
  process.stderr.write(`[术语] ${sender} 记「${令.词}」=「${令.释义}」→ ${JSON.stringify(r)}\n`);
  记一条({ 类型: '术语', 动作: '加', 词: 令.词, 释义: 令.释义, sender, 结果: Object.keys(r)[0] });
  if (r.加了) { await 发文本(chat_id, `记住了：${令.词} = ${令.释义}。以后我按这个理解。`); return; }
  if (r.一样) { await 发文本(chat_id, `这条我早就记着了：${令.词} = ${令.释义}`); return; }
  if (r.冲突 !== undefined) {
    // **不静默覆盖**：把原来的说出来，让人自己决定
    await 发卡片(chat_id, `⚠ 「${令.词}」我原来记的是：**${r.冲突}**\n你现在说的是：**${令.释义}**\n\n要改成新的就再说一句「**改成：${令.词} = ${令.释义}**」；不改就当我没听见。`);
    return;
  }
  await 发文本(chat_id, '这条没记上（写不进去），跟我说一声。');
}

// 人点了「要 SN 明细」。**当成一句追问重跑**，不另存票 ——
// 「刚才那批」靠追问上下文（30 分钟窗）兜住，省一张表也省一处会过期的状态。
// 提示里把口径写死：SN 条数和在库数是两个数，源表 SN 列有空的（inventory 实测 10 根），
// 合成一个数的话人会拿 SN 条数当在库数用。
// 发明细：多张合成一个 xlsx，一张直接发 CSV。**合不成就退回逐个发**——
// 合并是锦上添花，它坏了不该让人一份都拿不到。
async function 发明细(chat_id, 路径们) {
  if (!路径们.length) return;
  if (路径们.length >= 2) {
    let 合 = null;
    try {
      合 = 合CSV(路径们, (路) => readFileSync(路.startsWith('~/') ? homedir() + 路.slice(1) : 路, 'utf8'));
    } catch (e) { process.stderr.write(`[合表] 合不动：${String(e.message).slice(0, 120)}\n`); }
    if (合) {
      const 名 = `明细-${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace(/[-:T]/g, '')}.xlsx`;
      process.stderr.write(`[合表] ${路径们.length} 个 CSV → 一个 xlsx（${合.表数} 张 sheet，各 ${合.行数.join('/')} 行）\n`);
      if (await 发字节(chat_id, 合.buf, 名)) return;
      process.stderr.write('[合表] xlsx 没发成，退回逐个发 CSV\n');
    }
  }
  for (const 路 of 路径们) {
    const ok = await 发文件(chat_id, 路);
    if (!ok) {
      process.stderr.write(`[发文件失败] ${路}\n`);
      await 发文本(chat_id, `（有一份明细我导出了但没发成：${路.split('/').pop()}，再问一次我重发）`);
    }
  }
}

// 人点了「导出到飞书表格」。给文件的话人还得下载、打开、想共享再传一次；给链接是一步。
// **每一步失败都要说清卡在哪** —— 回一句「导不了」等于让人再问一遍我还是不知道为什么。
// 人点了「⏹ 停」或打字喊停。**只有发起人能停自己那条** —— 和写入确认同一条规矩，
// 不然群里谁都能把别人的查询掐了。
// 表单提交回来了。**这一段必须排在别的按钮解析之前** —— 表单回包里没有 action_value，
// 认反馈/认要SN/认导表 那几个全靠 action_value，会一个不落地漏过去，最后掉进「认不出」。
// 人点了「📌 只看某张表」。**把这一轮读过的链接预填进去** ——
// 让他再贴一次是白让他干活，而且贴错的概率比不贴还高。
// 人点了「🔓 解除限定」。和打字「不限表了」走同一段逻辑，别写两份。
// 人对某条答案打了表情。**比按钮还自然** —— 打表情是本能动作，不多一条消息、不占卡片空间。
// 认不出的表情要**把 emoji_type 原样打出来**：飞书没有公开清单，只能照着日志扩表。
async function 处理表情(f) {
  const 记 = 消息到问答.get(f.消息id);
  if (!记) {
    process.stderr.write(`[表情] ${f.表情} 打在一条我不认识的消息上（不是我的答案？），忽略\n`);
    return;
  }
  if (!f.动作) {
    process.stderr.write(`[表情] **没映射的表情 emoji_type=${f.表情}** —— 要接就往 lib/护栏.mjs 的 表情动作 里加\n`);
    return;
  }
  process.stderr.write(`[表情] ${f.谁} 对 ${记.问答id} 打了 ${f.表情} → ${f.动作}\n`);
  if (f.动作 === '好评' || f.动作 === '差评') {
    计数.反馈++;
    记一条({ 类型: '反馈', 问答id: 记.问答id, sender: f.谁, 反馈: f.动作 === '好评' ? '好' : '差', 来源: '表情' });
    return; // 反馈不回话 —— 打个表情还被回一句，反而吵
  }
  if (f.动作 === '要SN') {
    await 处理要SN({ 谁: f.谁, 聊天: 记.chat_id, 问答id: 记.问答id });
  }
}

async function 处理解除范围(f) {
  if (!f.聊天) { process.stderr.write('[范围] 解除按钮里没带聊天 id\n'); return; }
  const key = `${f.聊天}|${f.谁}`;
  const 上 = 上下文.get(key);
  if (!上?.范围们?.length) {
    await 回话(f, '现在没有限定，本来就什么都能查。');
    return;
  }
  上下文.set(key, { ...上, 范围们: undefined, ts: Date.now() });
  process.stderr.write(`[范围] ${f.谁} 点按钮解除限定（原来 ${上.范围们.length} 张）\n`);
  记一条({ chat: f.聊天, sender: f.谁, 类型: '范围解除', 来源: '按钮' });
  // 就地改：那张回执卡变成「已解除」，「🔓 解除限定」按钮跟着消失
  await 回话(f, '🔓 **已解除限定**，恢复成什么都能查。');
}

async function 处理限表(f) {
  if (!f.聊天) { process.stderr.write('[范围] 限表按钮里没带聊天 id\n'); return; }
  process.stderr.write(`[范围] ${f.谁} 点了限表按钮${f.链接 ? '（带链接）' : '（没链接，空表单）'}\n`);
  await 发(f.聊天, 'interactive', 范围表单卡(f.链接 ? { url: f.链接 } : {}));
}

// 帮助正文。**照着「人在什么时候会想要它」写，不是照着功能清单写。**
function 帮助正文() {
  return [
    '**我能干什么**',
    '',
    '· 直接问就行：「闵行光模块还有多少」「这批 SN 是哪些订单的」「通算闲置多少」',
    '· 给我一个飞书表格链接 + 想干的事，我会自己去读',
    '· 也能问你自己以前问过什么：「我之前问过光模块吗」「我上次问闵行是什么时候」',
    '',
    '**给我的消息打表情也算数**（比点按钮还省事）',
    '· 👍 好评 · 🤦 差评 · 👀 要 SN 明细',
    '',
    '**答案下面那排按钮**（不用记，出现的时候点就行）',
    '· 📋 要 SN 明细 —— 默认给的是按型号汇总，要一根根的 SN 点这个',
    '· 📊 导出到飞书表格 —— 建一张在线表回你链接，不用下文件',
    '· 📌 只看某张表 —— **我读错表/读错 sheet 的时候点它**，指定之后我读别的会被自己挡下来',
    '· ⏹ 停 —— 查得太久或者你问错了，点它或者直接打「停」',
    '· 👍 / 👎 —— 答得好不好，我拿这个找哪类问题答不上来',
    '',
    '**例行公事**（都是：我先干跑给你看，你点「确认写入」才落库；不点就什么都不写）',
    ...Object.values(例行们).map((配) => {
      const 点们 = 定时表[配.名] || [];
      return `· 打「**${配.名}**」→ ${配.干跑说明}${配.要内网 ? '（要公司内网）' : ''}`
        + `${点们.length ? `；**${定时说法(点们)}** 我也会自己跑一次` : ''}`;
    }),
    '· 「记住这个决定：QSFP28 能顶 QSFP」这类，我会弹卡片让你点确认 —— **落库那条记的是「你」拍的，不是我**',
    '',
    '**几句能打的话**（记不住就点上面的按钮，效果一样）',
    '· 「限定表」→ 弹一张四个格子的卡片（表链接 / sheet / 表头行 / 只要哪几列）',
    '· 「不限表了」→ 解除限定',
    '· 「记住：小八就是800G光模块」→ 教我一个公司黑话，以后我按这个理解',
    '· 「看术语」→ 我记着哪些黑话；「忘掉 小八」→ 删掉一条',
    '· 「我问过什么」→ 翻你自己最近问过的十条（**只有你自己的**，答错的那几条也会列出来）',
    '· 「停」→ 停掉你正在跑的那条',
  ].join('\n');
}

// 人填完了「这个词是什么」。**走已有的 加术语**（带冲突检查），然后把原问题重跑一遍 ——
// 重跑这一下是这个功能的意义：不重跑的话人得自己再打一遍那句问话。
async function 办教术语(f) {
  const 聊 = f.聊天;
  if (!聊) { process.stderr.write('[问术语] 回包里没有 chat_id\n'); return; }
  const key = `${聊}|${f.谁}`;
  const 票 = 教术语票.get(key);
  const 词 = String(f.字段?.词 || 票?.词 || '').trim();
  const 释义 = String(f.字段?.释义 || '').trim();
  if (!词 || !释义) { await 发文本(聊, '词和释义都要填才记得住。'); return; }

  const r = 加术语(词, 释义, f.谁);
  process.stderr.write(`[问术语] ${f.谁} 教了「${词}」=「${释义}」→ ${JSON.stringify(r)}\n`);
  记一条({ chat: 聊, sender: f.谁, 类型: '教术语', 词, 释义, 结果: Object.keys(r)[0] });
  if (r.冲突 !== undefined) {
    // **同名不同义不静默覆盖** —— 这条是术语表建起来时就定死的，别为了顺手破掉
    await 发卡片(聊, `⚠ 「${词}」我原来记的是：**${r.冲突}**\n你现在说的是：**${释义}**\n\n要改就说一句「**改成：${词} = ${释义}**」；不改我按原来的理解。`);
    return;
  }
  if (!r.加了 && !r.一样) { await 发文本(聊, '这条没记上（写不进去），跟我说一声。'); return; }

  教术语票.delete(key);
  if (!票?.问) { await 发文本(聊, `记住了：${词} = ${释义}。（原来那个问题我没找着，你再问一遍）`); return; }
  await 发文本(聊, `记住了：${词} = ${释义}。这就按新的理解重问一遍「${票.问}」…`);
  await 处理({
    chat_id: 聊, sender: f.谁, chat_type: 'group',
    message_id: `术语${Date.now().toString(36)}`, // 造个新 id，别撞去重表
    content: JSON.stringify({ text: 票.问 }),
    mentions: [],
  });
}

async function 处理表单(f) {
  if (f.按钮名 === 教术语按钮名) { await 办教术语(f); return; }
  if (f.按钮名 !== 设范围按钮名) {
    process.stderr.write(`[表单] 不认识的表单按钮「${f.按钮名}」，字段：${JSON.stringify(f.字段).slice(0, 200)}\n`);
    return;
  }
  const 聊 = f.聊天;
  if (!聊) { process.stderr.write('[表单] 回包里没有 chat_id，回不了话\n'); return; }
  const 一条 = 表单转范围(f.字段);
  if (!一条) {
    process.stderr.write(`[范围] 表单里的链接认不出：${JSON.stringify(f.字段).slice(0, 160)}\n`);
    await 发文本(聊, '这个链接我认不出是飞书表格（要形如 …/sheets/xxx 或 …/wiki/xxx）。再贴一次？');
    return;
  }
  const key = `${聊}|${f.谁}`;
  const 上 = 上下文.get(key) || { 历史: [], 摘要: '' };
  // **追加，不是替换**：对账要两张，让人提交两次比逼他一次填完顺手。
  // 同一张表同一个 sheet 再提交一次算改，不重复堆。
  const 旧们 = (上.范围们 || []).filter((x) => !(x.url === 一条.url && (x.sheet名 || '') === (一条.sheet名 || '')));
  const 范围们 = [...旧们, 一条];
  上下文.set(key, { ...上, 范围们, ts: Date.now() });
  process.stderr.write(`[范围] ${f.谁} 表单设定第 ${范围们.length} 张：${一条.sheet名 || '(未指定sheet)'}\n`);
  记一条({ chat: 聊, sender: f.谁, 类型: '范围限定', 来源: '表单', 张数: 范围们.length });
  await 发卡片(聊, `${范围回执(范围们)}\n\n再限定一张：点上一条答案里的「📌 只看某张表」，或者说一句「限定表」。`, null, { 可解除: true, 聊天: 聊 });
}

async function 处理停(f) {
  const 在 = 跑中.get(f.问答id);
  const 聊 = f.聊天 || 在?.chat_id;
  if (!在) {
    process.stderr.write(`[停] ${f.问答id} 已经不在跑了\n`);
    await 回话({ ...f, 聊天: 聊 }, '这条已经跑完或者已经停了。');
    return;
  }
  if (f.谁 && 在.sender && f.谁 !== 在.sender) {
    process.stderr.write(`[停] ${f.谁} 想停别人(${在.sender})的查询，挡掉\n`);
    await 回话({ ...f, 聊天: 聊 }, '这条是别人问的，只有问的人能停。');
    return;
  }
  process.stderr.write(`[停] ${f.谁} 停掉 ${f.问答id}（已跑 ${Date.now() - 在.起手}ms）\n`);
  记一条({ 问答id: f.问答id, sender: f.谁, 类型: '人工停止', 已跑毫秒: Date.now() - 在.起手 });
  在.停.abort();
  // **就地把那张进度卡改成「已停下」** —— 按钮跟着消失，不会有人对着一张停不掉的卡再点一次
  await 回话(f, `⏹ **已停下**（跑了 ${((Date.now() - 在.起手) / 1000).toFixed(1)} 秒）。重新问一遍吧。`);
}

async function 处理导表(f) {
  const 票 = 导表票.get(f.问答id);
  const 聊 = f.聊天 || 票?.chat_id;
  if (!聊) { process.stderr.write('[导表] 按钮里没带聊天 id、票也没了，回不了话\n'); return; }
  if (!票) {
    process.stderr.write(`[导表] 票 ${f.问答id} 没了（过期或已导过）\n`);
    await 发文本(聊, '这条的明细票过期了（超过 2 小时），重新问一次再导。');
    return;
  }
  process.stderr.write(`[导表] ${f.谁} 要导 ${票.路径们.length} 张表\n`);
  const 提示 = await 发文本(聊, '📊 正在建飞书表格…');
  try {
    const 表们 = [];
    for (const 路 of 票.路径们) {
      const 真路 = 路.startsWith('~/') ? homedir() + 路.slice(1) : 路;
      let 文本; try { 文本 = readFileSync(真路, 'utf8'); } catch { continue; } // 读不到就跳这一张，别整件事失败
      const 行们 = 解CSV(文本);
      if (!行们.length) continue;
      const 基 = String(路).split('/').pop().replace(/\.csv$/i, '');
      表们.push({ 名: 基.replace(/^(明细|分布)-/, '').replace(/-\d{8,}$/, '') || 基, 行们 });
    }
    if (!表们.length) { await 发文本(聊, '那几个明细文件已经不在了（缓存清掉了），重新问一次再导。'); return; }
    const r = await 建在线表({ 标题: `库存明细-${表们.map((t) => t.名).join('+')}`.slice(0, 80), 表们 });
    导表票.delete(f.问答id); // 一次性：导过就作废，防重复建一堆同样的表
    记一条({ 类型: '导表', 问答id: f.问答id, sender: f.谁, 表数: 表们.length, 行数: r.每张写了几行, url: r.url });
    process.stderr.write(`[导表] 建好 ${r.url}（${表们.length} 张，各 ${r.每张写了几行.join('/')} 行，权限：${r.权限}）\n`);
    const 权限话 = r.权限 === '组织内可编辑' ? '' : `\n\n⚠ **链接权限没开成**（${r.权限}）—— 你可能打不开，打不开就跟我说。`;
    const 正文 = `📊 建好了：${r.url}\n\n`
      + 表们.map((t, i) => `· **${t.名}**：${r.每张写了几行[i]} 行`).join('\n')
      + `\n\n组织内拿到链接的人可以直接编辑。${权限话}`;
    if (提示) { const ok = await 改卡片(提示, 正文); if (!ok) await 发卡片(聊, 正文); } else await 发卡片(聊, 正文);
  } catch (e) {
    process.stderr.write(`[导表] 失败：${String(e.message).slice(0, 200)}\n`);
    记一条({ 类型: '导表失败', 问答id: f.问答id, sender: f.谁, 出错: String(e.message).slice(0, 160) });
    await 发文本(聊, `没建成：${String(e.message).slice(0, 120)}。文件我已经发在上面了，先用那个。`);
  }
}

async function 处理要SN(f) {
  if (!f.聊天) { process.stderr.write('[要SN] 按钮里没带聊天 id，回不了话\n'); return; }
  process.stderr.write(`[要SN] ${f.谁} 要上一条的 SN 明细\n`);
  记一条({ 类型: '要SN', 问答id: f.问答id, sender: f.谁 });
  await 处理({
    chat_id: f.聊天,
    sender: f.谁,
    chat_type: 'group',
    message_id: `sn${f.问答id}${Date.now().toString(36)}`, // 造个新 id，别撞去重表
    content: JSON.stringify({ text: '把刚才那批的 SN 明细给我：用「查SN」，一个物料键一段。'
      + '**「有几根」和「其中几根有 SN」是两个数，分开报、别合成一个**（源表 SN 列有空的）。'
      + 'SN 多就导出文件，别整段贴卡片。' }),
    mentions: [],
  });
}

/** 处理「例行确认」按钮：点「是，跑X」→ 真跑；点「不是」→ 不理会。 */
async function 处理例行确认(f) {
  if (!f.聊天) { process.stderr.write('[例行] 确认按钮里没带聊天 id，回不了话\n'); return; }
  if (!f.名) { process.stderr.write(`[例行] ${f.谁} 点了「不是」\n`); return; } // 点「不是」就什么都不做，不用回一句废话
  const 配 = 例行们[f.名];
  if (!配) { process.stderr.write(`[例行] 确认按钮里的名字「${f.名}」认不出（不是三件之一）\n`); return; }
  process.stderr.write(`[例行] ${f.谁} 确认了「${f.名}」\n`);
  await 跑例行(配, { chat_id: f.聊天, sender: f.谁 });
}

/**
 * 跑一件例行公事（日更 / 周更 / 导工单）。**干跑 → 人看 → 人点 → 真写**，
 * 第二步复用已有的写入票，一个新按钮都没造。
 *
 * 为什么不让模型来干：这三件都是固定流程，没有要理解的东西；而且**回执必须原样摆给人看**，
 * 让模型转述必然丢数（它的规矩是「结果多就只给汇总」）。模型只在「疑似改名」那一步出场 ——
 * 那一步是真的需要判断，而且判据是 MCP 自己在回执里写死的。
 *
 * @param 配 例行们 里的一条 @param 定时 true=定时器叫的（没有发起人，卡片措辞不一样）
 */
async function 跑例行(配, { chat_id, sender = '', 定时 = false }) {
  const 客 = (MCP们.find((m) => m.前缀 === 配.前缀) || {}).client;
  if (!客) { await 发文本(chat_id, `内部错误：${配.前缀} 工具没起来，${配.名}跑不了。`); return; }
  process.stderr.write(`[例行] ${配.名}：${定时 ? '定时' : sender} 开始干跑\n`);
  const 提示卡 = await 发卡片(chat_id, `⏳ ${定时 ? '到点了，' : ''}正在跑**${配.名}**的干跑…（${配.干跑说明}，`
    + `要 ${Math.round(配.干跑毫秒 / 1000 / 4)}-${Math.round(配.干跑毫秒 / 1000 / 2)} 秒，这一步一个字都不写）`);
  const 回话 = async (正文, 元素 = null) => {
    if (元素) { await 发(chat_id, 'interactive', { config: { wide_screen_mode: true }, elements: 元素 }); return; }
    if (直连 && 提示卡 && await 改卡片(提示卡, 正文)) return;
    await 发卡片(chat_id, 正文);
  };

  let 干跑回包;
  try {
    // **单独放宽超时**：默认那道 45 秒闸管的是「工具卡住了」，而这几件本来就慢
    // （日更热 29-33 秒、冷 43.6 秒；周更 33.7 秒）。走默认闸的话冷跑只剩 1.4 秒余量，必翻车。
    干跑回包 = await 客.调工具(配.工具, {}, { 超时毫秒: 配.干跑毫秒 });
  } catch (e) {
    process.stderr.write(`[例行] ${配.名} 干跑挂了：${e.message}\n`);
    记一条({ chat: chat_id, sender, 类型: `${配.名}干跑失败`, 出错: String(e.message).slice(0, 120) });
    await 回话(`${配.名}的干跑没跑成：${说人话(e.message)}\n\n**什么都没写。**`
      + `${配.要内网 ? '（这件要公司内网，在外面跑不了）' : ''} 过一会儿再打一次「${配.名}」。`);
    return;
  }
  const 解 = 解干跑(干跑回包);
  if (!解) {
    // **解不开就把原文摆出来**，不许装作没事 —— 这一步认不出，后面的确认票就是空的，
    // 人点了确认会写不成，而那时候已经离现场很远了。
    process.stderr.write(`[例行] ${配.名} **干跑回包解不开**（前 200 字）：${String(干跑回包).replace(/\s+/g, ' ').slice(0, 200)}\n`);
    记一条({ chat: chat_id, sender, 类型: `${配.名}回包解不开` });
    await 回话(`${配.名}干跑回来的东西我认不出来（没有确认票），**什么都没写**。原样贴给你：\n\n\`\`\`\n${截卡(String(干跑回包))}\n\`\`\``);
    return;
  }

  // 疑似改名：**只有这一步用模型**。判错的代价在卡片上写着，人看着数拍。
  let 判断 = [];
  let 认定的改名 = [];
  if (配.判改名 && 解.疑似改名.length) {
    process.stderr.write(`[例行] ${配.名}：${解.疑似改名.length} 组疑似改名，问模型\n`);
    try {
      const msg = await 问模型({ ...模型配置, messages: [{ role: 'user', content: 改名提示(解.疑似改名) }], max_tokens: 2000 });
      const r = 认改名判断(msg.content || '', 解.疑似改名);
      判断 = r.判断; 认定的改名 = r.认定的改名;
      if (r.丢掉的.length) process.stderr.write(`[例行] ${配.名}：模型的判断丢掉了 ${r.丢掉的.length} 条：${r.丢掉的.join('；')}\n`);
      process.stderr.write(`[例行] ${配.名}：判为同款 ${认定的改名.length}/${解.疑似改名.length} 组\n`);
    } catch (e) {
      // 模型挂了不算失败：**一个都不合并**是安全的那一边，照样能往下走。
      process.stderr.write(`[例行] ${配.名}：问模型判改名失败（一个都不合并）：${e.message}\n`);
      判断 = 认改名判断('', 解.疑似改名).判断;
    }
  }

  // 第二步的参数**现在就定死存下来**，人点确认时原样用，不重新算 —— 和写占用同一条规矩。
  // `认定的改名` **只在判改名的那几件里给**：导工单没有这个参数，多塞一个会被 schema 拒。
  const 票id = `${配.名}-${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;
  待写.set(票id, {
    全名: `${配.前缀}_${配.工具}`, 工具名: 配.工具,
    参数: { 确认票: 解.确认票, 用户选择: '真写', ...(配.判改名 ? { 认定的改名 } : {}) },
    chat_id, sender, ts: Date.now(),
    过期毫秒: 例行票过期毫秒, // 比写占用那 15 分钟长：定时推过来的卡片，人可能过一阵才看到
    超时毫秒: 配.真写毫秒,   // 真写比干跑还慢，别用默认那 45 秒闸
  });
  记一条({ chat: chat_id, sender, 类型: `${配.名}干跑`, 票id, 改名组数: 解.疑似改名.length, 判为同款: 认定的改名.length, 定时: !!定时 });
  await 回话(null, 确认卡片元素(回执正文(解, 判断, { 定时, 名: 配.名 }), 票id, chat_id));
}

async function 处理确认(f) {
  const 票 = 待写.get(f.票id);
  if (!票) {
    // **别静默**：这是写入路径，"没反应"和"写好了"在群里长得一模一样。
    // 原来这里只写日志就 return —— 重启一次，所有待确认的卡片就都变成哑巴按钮。
    process.stderr.write(`[待写] 票 ${f.票id} 不存在或已用过\n`);
    if (f.聊天) await 发文本(f.聊天, '**这次没写。** 这张确认票已经用过或过期了（超过 15 分钟）。要写的话重新问一遍、再点一次确认。');
    return;
  }
  // **每张票可以自带过期时间**：写占用那种是模型当场算出来的，15 分钟够了也该短；
  // 日更是定时推过来的，人可能过一阵才看到卡片，用 15 分钟等于推了个必然失效的按钮。
  const 这票过期 = 票.过期毫秒 || 票过期毫秒;
  if (Date.now() - 票.ts > 这票过期) {
    待写.delete(f.票id);
    await 发文本(票.chat_id, `这个写入确认已经超过 ${Math.round(这票过期 / 60000)} 分钟失效了，重新来一次吧。`);
    return;
  }
  // **只有发起人能点**：别人点了不算，防误点也防越权替别人写
  if (f.谁 && 票.sender && f.谁 !== 票.sender) {
    process.stderr.write(`[待写] ${f.谁} 想确认别人(${票.sender})发起的写入，挡掉\n`);
    await 发文本(票.chat_id, '这条写入是别人发起的，只能由发起的人确认。');
    return;
  }
  待写.delete(f.票id); // 一次性：无论写不写，这张票用完就作废（防重复写）
  if (f.决定 !== '写') {
    process.stderr.write(`[待写] ${f.谁} 取消了 ${票.工具名}\n`);
    记一条({ 类型: '写取消', 票id: f.票id, sender: f.谁, 工具: 票.工具名 });
    await 发文本(票.chat_id, `好，没写。（${票.工具名} 已取消）`);
    return;
  }
  const 前缀 = 票.全名.split('_')[0];
  const 客 = (MCP们.find((m) => m.前缀 === 前缀) || {}).client;
  if (!客) { await 发文本(票.chat_id, '内部错误：找不到执行这个写入的工具，没写。'); return; }
  process.stderr.write(`[待写] ${f.谁} 确认写入 ${票.工具名}\n`);
  try {
    // **用存下来的参数**，不重新生成。超时也跟着票走：日更真写是批量写台账+注册表，
    // 比干跑还慢，用默认那 45 秒闸会在写到一半的时候报超时 —— 而那时候它其实还在写。
    let 参数 = 票.参数;
    // **「谁拍的」这类字段一律换成点按钮那个人**，不许用模型填的。
    // `记下决定` 落的那条记录将来要有人认账，而且会影响所有人以后的 `找替代` 结果 ——
    // 模型编一个名字进去，等于让一条没人认账的判断变成全组的依据。
    if (票.人字段) {
      const 人名 = await 查人名(f.谁);
      参数 = { ...参数, [票.人字段]: 人名 };
      process.stderr.write(`[待写] ${票.工具名} 的「${票.人字段}」换成点按钮的人：${人名}（模型原来填的是「${票.参数[票.人字段] ?? '(空)'}」）\n`);
    }
    const 回 = await 客.调工具(票.工具名, 参数, 票.超时毫秒 ? { 超时毫秒: 票.超时毫秒 } : {});
    记一条({ 类型: '写完成', 票id: f.票id, sender: f.谁, 工具: 票.工具名, 答: String(回) });
    await 发卡片(票.chat_id, `✅ 写好了（${票.工具名}）\n\n${截卡(String(回))}`);
  } catch (e) {
    process.stderr.write(`[待写] 执行失败：${e.message}\n`);
    记一条({ 类型: '写失败', 票id: f.票id, sender: f.谁, 工具: 票.工具名, 出错: String(e.message).slice(0, 120) });
    await 发文本(票.chat_id, `没写成：${说人话(e.message)}`);
  }
}

function 处理反馈(e) {
  const f = 认反馈(e);
  if (!f) {
    // **认不出就要把原样打出来**：只说「认不出」而不给形状，等于让下一个人重新猜一遍。
    // 2026-08-22 就栽在这：字段路径是照文档猜的，真回包不长那样，而日志只说了「认不出」。
    // 大字段（card_content 那种）先剔掉再打 —— 不剔的话它能把真正要看的表单值整个挤出 700 字，
    // 于是日志"打了原样"但恰好没有那一段，等于没打。
    const 瘦 = {};
    for (const [k, v] of Object.entries(e || {})) {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      瘦[k] = s && s.length > 300 ? `${s.slice(0, 300)}…（共 ${s.length} 字，截断）` : v;
    }
    process.stderr.write('[反馈] 认不出这个卡片事件，忽略（不瞎猜一个反馈记进去）。\n'
      + `        顶层字段：${Object.keys(e || {}).join(', ')}\n`
      + `        剔掉大字段后的原样：${JSON.stringify(瘦).slice(0, 1600)}\n`);
    return;
  }
  计数.反馈++;
  process.stderr.write(`[反馈] ${f.谁} 对 ${f.问答id} 点了「${f.反馈}」\n`);
  记一条({ 类型: '反馈', 问答id: f.问答id, sender: f.谁, 反馈: f.反馈 });
}
function 起卡片事件() {
  const ev = spawn(LC, ['event', 'consume', 'card.action.trigger', '--as', 'bot'], { env: ENV });
  let buf = '';
  ev.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      // **表单要第一个认**：它的回包没有 action_value，别的解析器会全漏过去
      const 表 = 认表单(e);
      if (表) { 处理表单(表).catch((err) => process.stderr.write('[表单] 处理出错：' + err.message + '\n')); continue; }
      const 解 = 认解除范围(e);
      if (解) { 处理解除范围(解).catch((err) => process.stderr.write('[范围] 解除按钮出错：' + err.message + '\n')); continue; }
      const 限 = 认限表(e);
      if (限) { 处理限表(限).catch((err) => process.stderr.write('[范围] 限表按钮出错：' + err.message + '\n')); continue; }
      const 停了 = 认停(e);
      if (停了) { 处理停(停了).catch((err) => process.stderr.write('[停] 处理出错：' + err.message + '\n')); continue; }
      const 导 = 认导表(e);
      if (导) { 处理导表(导).catch((err) => process.stderr.write('[导表] 处理出错：' + err.message + '\n')); continue; }
      const 要 = 认要SN(e);
      if (要) { 处理要SN(要).catch((err) => process.stderr.write('[要SN] 处理出错：' + err.message + '\n')); continue; }
      const 确 = 认确认(e);
      if (确) { 处理确认(确).catch((err) => process.stderr.write('[待写] 处理出错：' + err.message + '\n')); continue; }
      const 例确 = 认例行确认(e);
      if (例确) { 处理例行确认(例确).catch((err) => process.stderr.write('[例行] 确认按钮出错：' + err.message + '\n')); continue; }
      const 澄 = 认澄清(e);
      if (澄) { 处理澄清(澄).catch((err) => process.stderr.write('[澄清] 处理出错：' + err.message + '\n')); continue; }
      try { 处理反馈(e); } catch (err) { process.stderr.write('[反馈] 处理出错：' + err.message + '\n'); }
    }
  });
  ev.stderr.on('data', (d) => process.stderr.write('[反馈event] ' + d.toString().slice(0, 200)));
  ev.on('close', (c) => process.stderr.write(`[反馈event 退出 code=${c}] 反馈通道停了（不影响查询）\n`));
}
// 卡片事件消费者**总是起**：澄清选项按钮不该被「反馈按钮开关」卡住 —— 它们是两件事，
// 只是走同一个 card.action.trigger 通道。回调没订阅时 lark-cli 报一次错就退，不会刷屏。
起卡片事件();

process.stderr.write(`[bot] 起来了，模型 fallback 顺序=${(模型配置.models || []).join(' → ')}，发消息=${直连 ? '飞书直连' : 'lark-cli兜底'}，令牌提醒=${提醒chat || '只写日志(没配 chat)'}，等群里 @…\n`);
// 没配就喊一嗓子：这是唯一一个「不设=安全提醒静默失效」的参数，不喊出来换台机器就忘。
// 白名单空着 = 群里任何人都能用（每人每小时 30 条）。铺开给同事之前该收紧，不喊一声没人会想起来。
if (!白名单.size) process.stderr.write(`[警告] 白名单是空的 —— 群里谁都能用它查（每人每小时 ${每人每时上限} 条）。要收紧：起 bot 时带 env BOT_ALLOWLIST=ou_xxx,ou_yyy（open_id 逗号分隔），列群成员的命令见 部署.md。\n`);
process.stderr.write(`[写开关] ${可写 ? '**开着**——模型能调写工具，但真写那一步必须人点按钮确认' : '关着（默认）——写工具根本不给模型，要开设 BOT_WRITE=1'}\n`);
// 每张表开机读回了几条。**这一行是「持久化真的在工作」的唯一证据**：
// 不打的话，落盘悄悄坏掉之后表现和从前一模一样（重启就丢），而没人会发现。
// **加了新表必须加进这个数组** —— 2026-08-23 这里只列了最早那三张，后加的
// 导表票/教术语票/消息到问答 写不进去时一个字都不打，正是这个项目一直在抓的那类「坏了却是绿的」。
for (const 表 of [上下文, 待澄清, 待写, 导表票, 教术语票, 消息到问答, 已处理, 见过会话]) {
  const s = 表.状态();
  process.stderr.write(`[持久表] ${s.名}：开机读回 ${s.开机读回} 条`
    + `${s.开机丢弃 ? `（另丢弃 ${s.开机丢弃} 条过期的）` : ''}`
    + `${s.写不进去 ? ` ⚠ **写不进去：${s.写不进去}** —— 退回「重启就丢」` : ''}\n`);
}
if (!提醒chat) process.stderr.write('[警告] 没配令牌提醒 chat —— 内网CMDB令牌过期时只会写进日志，没人会在飞书里被通知。设法：.creds.json 加 "nudge_chat": "oc_..."，或起 bot 时带 env BOT_NUDGE_CHAT。\n');
