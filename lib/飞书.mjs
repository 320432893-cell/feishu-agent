/**
 * 飞书 REST 直连（fetch，零依赖）——替代每条消息 shell 出去 lark-cli 的 ~3.5 秒冷启动。
 * 发一条 lark-cli=3.5s（Node 冷启+连线），fetch 直连≈200ms。这是 bot「感觉慢」的最大一块。
 *
 * 凭证来源（按序）：① 环境变量 LARK_APP_ID/LARK_APP_SECRET ② .creds.json 的
 * feishu_app_id/feishu_app_secret。**不从 ~/.lark-cli/config.json 取**——那里 appSecret 是
 * 钥匙串指针（{source:keychain,id}）不是明文，且部署机是 Windows、根本没 macOS 钥匙串。
 * 凭证只在本进程内换 token，不打印、不外传。换不到就抛，bot 据此退回 lark-cli（慢但能用）。
 * app_secret 用 `node 设飞书密钥.mjs <secret>` 写进 .creds.json，别贴进聊天。token 缓存、提前 1 分钟刷。
 */
import { readFileSync } from 'node:fs';
import { 凭证档 } from './资源位置.mjs';

const BASE = 'https://open.feishu.cn';
// 凭证在哪走 资源位置.mjs（唯一一处）。原来这行是 dirname(dirname(import.meta.url))——
// 要数对层数、文件挪一层就错，而且打包之后指向 dist/、必然读不到，还不报错。
const 默认ID = 'cli_aae5ee90f8f85cc5';

/** 取 {id, secret}：先环境变量，再 .creds.json。缺 secret 抛（提示怎么设，不含任何 secret）。 */
function 找凭证() {
  let id = process.env.LARK_APP_ID || '';
  let secret = process.env.LARK_APP_SECRET || '';
  if (!secret) {
    try {
      const c = JSON.parse(readFileSync(凭证档(), 'utf8'));
      id = id || c.feishu_app_id || c.app_id || 默认ID;
      secret = c.feishu_app_secret || c.app_secret || '';
    } catch { /* 没有 .creds.json 就靠环境变量 */ }
  }
  id = id || 默认ID;
  if (!secret) throw new Error('没配飞书 app_secret：跑 `node 设飞书密钥.mjs <secret>` 写进 .creds.json，或设环境变量 LARK_APP_SECRET');
  return { id, secret };
}

let _token = null, _到期 = 0, _app = null;
async function 取token() {
  if (_token && Date.now() < _到期 - 60000) return _token;
  const { id, secret } = 找凭证();
  _app = id;
  const r = await fetch(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: id, app_secret: secret }),
  });
  const j = await r.json();
  if (j.code !== 0 || !j.tenant_access_token) throw new Error(`换 token 失败 code=${j.code}：${j.msg || ''}`);
  _token = j.tenant_access_token;
  _到期 = Date.now() + (j.expire || 7200) * 1000;
  return _token;
}

/** 预热：启动时调一次，成功=直连可用（返回用的 app_id），失败抛（bot 据此退回 lark-cli）。 */
export async function 预热直连() { await 取token(); return _app; }

/**
 * **机器人自己的 open_id。** 群里那道「@ 的是不是我」的闸要拿它去比 mentions ——
 * 只判「有没有人被 @」的话，同事互相 @ 也会把它叫起来（2026-08-24 真踩过）。
 * app_id（`cli_…`）和 open_id（`ou_…`）不是一回事，mentions 里存的是后者。
 * 一次取到就缓存：这个 id 在应用生命周期里不变。
 */
let _我的openid = '';
export async function 我的openid() {
  if (_我的openid) return _我的openid;
  const j = await 打('GET', '/open-apis/bot/v3/info');
  const id = j?.bot?.open_id;
  if (!id) throw new Error(`拿不到机器人自己的 open_id：${JSON.stringify(j).slice(0, 160)}`);
  _我的openid = id;
  return id;
}

async function 打(method, path, body) {
  const tk = await 取token();
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return r.json();
}

/** 给别的模块用同一把 token 打任意接口（建表/写表那些）。**不新开一套凭证逻辑** —— 那会变成两处要维护、两处会过期。 */
export const 打接口 = (method, path, body) => 打(method, path, body);

/**
 * 拉某个会话最近的消息（给补收用）。`从秒` 是 Unix 秒。
 * **按创建时间倒序拉**，只要最近这一小段，不翻页 —— 补收要的是「刚刚漏掉的」，不是历史。
 */
export async function 拉最近消息(chat_id, 从秒, 几条 = 30) {
  const r = await 打('GET', `/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chat_id)}`
    + `&start_time=${从秒}&page_size=${几条}&sort_type=ByCreateTimeDesc`);
  return r?.data?.items || [];
}

/**
 * 机器人在哪些**群**里。**私聊不在这个列表里** —— 所以补收要盯的会话还得把
 * 「见过的私聊」并进来，光靠这个接口会漏掉所有一对一的消息（2026-08-24 丢的那条就是私聊）。
 */
export async function 列群会话() {
  const r = await 打('GET', '/open-apis/im/v1/chats?page_size=100');
  return (r?.data?.items || []).map((x) => x.chat_id).filter(Boolean);
}

/**
 * open_id → 人名。**给「谁拍的」这类必须落到具体人身上的字段用**（`记下决定` 的那条记录
 * 将来要有人认账，写个 `ou_1111…` 等于没写）。
 *
 * 查不到就回 `飞书用户 ou_1111…` 这种短形式，**不回空、也不抛** —— 名字查不到不该让写入失败，
 * 但也**绝不能悄悄留空**（那样落库的就是一条没人认账的记录）。2026-08-24 实测这个接口能用
 * （tenant token 就够，不用额外 scope）。查过的记住，同一个人不重复查。
 */
const 人名缓存 = new Map();
export async function 查人名(open_id) {
  const id = String(open_id || '');
  if (!id) return '(不知道是谁)';
  if (人名缓存.has(id)) return 人名缓存.get(id);
  let 名 = `飞书用户 ${id.slice(0, 10)}…`;
  try {
    const r = await 打('GET', `/open-apis/contact/v3/users/${id}?user_id_type=open_id`);
    if (r?.data?.user?.name) 名 = String(r.data.user.name);
    else process.stderr.write(`[人名] ${id.slice(0, 10)}… 接口通了但没有 name 字段，用占位\n`);
  } catch (e) {
    process.stderr.write(`[人名] 查 ${id.slice(0, 10)}… 失败（用占位）：${String(e.message).slice(0, 90)}\n`);
  }
  人名缓存.set(id, 名);
  return 名;
}

/**
 * **把人刚点的那张卡片就地改掉**（延迟更新），而不是另发一条消息。
 * 点一次多一条消息，聊天记录很快就糊了 —— 就地改是「点了有反应」最自然的形态。
 *
 * 契约照 lark-cli 的 `lark-im-card-action-reply.md`，三条硬的：
 * - **要完整的新卡片 JSON**，不支持局部更新（所以调用方得自己把新样子整个拼出来）
 * - token **30 分钟有效、最多用 2 次**，用完了只能另发消息
 * - **卡片 1.0 必须带 `open_ids`**，否则 API 报 `300090 openid empty`；2.0 不用
 *
 * @param 回调token 事件里的 `token` 字段
 * @param 卡 完整的新卡片（v1 是 {config, elements}；v2 是 {schema:'2.0', body:…}）
 * @param 操作人 open_id —— v1 卡片必须给，不给就是 300090
 * @returns 成功 true / 失败 false（**失败不抛**：调用方要退回「另发一条消息」那条老路）
 */
export async function 就地改卡(回调token, 卡, 操作人 = '') {
  if (!回调token || !卡) return false;
  const 是2 = String(卡.schema || '') === '2.0';
  const 带 = 是2 ? 卡 : { ...卡, open_ids: 操作人 ? [操作人] : [] };
  try {
    const j = await 打('POST', '/open-apis/interactive/v1/card/update', { token: 回调token, card: 带 });
    if (j?.code === 0) return true;
    // **失败要说清 code** —— 300090=没给 open_ids、token 用完/过期是另一类，
    // 不打出来的话表现只是「点了还是多一条消息」，没人会去查为什么。
    process.stderr.write(`[就地改卡] 没改成 code=${j?.code} ${String(j?.msg).slice(0, 80)} —— 退回另发一条\n`);
    return false;
  } catch (e) {
    process.stderr.write(`[就地改卡] 请求炸了：${String(e.message).slice(0, 80)} —— 退回另发一条\n`);
    return false;
  }
}

/** 发消息。content 是对象，内部会 JSON.stringify（飞书要求 content 为字符串）。返回 {message_id} 或 null。 */
export async function 发消息(chat_id, msg_type, content) {
  const j = await 打('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id',
    { receive_id: chat_id, msg_type, content: JSON.stringify(content) });
  return j.code === 0 ? j.data?.message_id || null : null;
}

/** 改已发消息的内容（只 interactive 卡片可改）。返回是否成功。 */
export async function 改消息(message_id, content) {
  const j = await 打('PATCH', `/open-apis/im/v1/messages/${message_id}`, { content: JSON.stringify(content) });
  return j.code === 0;
}

/** 上传文件（multipart，Node 全局 FormData/Blob）→ file_key 或 null。 */
export async function 上传文件(buf, 文件名) {
  const tk = await 取token();
  const fd = new FormData();
  fd.append('file_type', 'stream');
  fd.append('file_name', 文件名);
  fd.append('file', new Blob([buf]), 文件名);
  const r = await fetch(`${BASE}/open-apis/im/v1/files`, { method: 'POST', headers: { Authorization: `Bearer ${tk}` }, body: fd });
  const j = await r.json();
  return j.code === 0 ? j.data?.file_key || null : null;
}
