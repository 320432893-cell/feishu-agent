/** 读模型配置：base/key + **模型 fallback 列表**（主模型来自 .creds.json 或 env AGENT_MODEL，其余按序兜底）。 */
import { readFileSync } from 'node:fs';
import { 凭证档 } from './lib/资源位置.mjs';
// 只留有工作效率的：GLM-5.2（实测又快又对，当主力）+ Flash（跨厂兜底，GLM 挂了还有个 DeepSeek）。
// 砍掉 Pro / Kimi-K3：2026-08-20 实测两档都最慢（简单 10-11s、多步 45-49s，GLM 才 2.9/15s），进来只拖慢。
const 全部模型 = ['GLM-5.2', 'DeepSeek-V4-Flash-0731'];

/**
 * 令牌过期提醒发到哪个 chat：env `BOT_NUDGE_CHAT` > `.creds.json` 的 `nudge_chat` > 空。
 * 单独拎出来是因为它是唯一「没设=一个安全提醒彻底静默」的参数（并发/限流/白名单/上下文没设都有合理默认）；
 * 能写进 .creds.json 是为了 Windows 任务计划那边不用配环境变量——改一个文件就行，换机器不会忘。
 * @param 根目录 可注入，测试拿临时目录验文件回退这条路
 */
export function 读提醒chat(根目录 = null) {
  if (process.env.BOT_NUDGE_CHAT) return process.env.BOT_NUDGE_CHAT.trim();
  const 档 = 根目录 ? `${根目录}/.creds.json` : 凭证档();
  try { return String(JSON.parse(readFileSync(档, 'utf8')).nudge_chat || '').trim(); }
  catch { return ''; } // 没这个文件/没这个字段都算没设，由 bot 在启动日志里喊出来
}

/**
 * 日更几点跑（`"09:00"` 或 `"09:00,17:30"`；空=不定时，口令那条路照样能用）。
 *
 * **为什么读文件而不是只读 env**：env 只活在起 bot 的那个 shell 里。守护重启一次、
 * 换个终端起一次、开机自启走 launchd —— 任何一次没带上这个变量，定时就**悄悄关掉了**，
 * 而表现和「今天没到点」一模一样：日志没有红、没有异常，只是那张卡片再也不来了。
 * 落进 `.creds.json` 才活得过重启。env 仍然优先，用来临时试。
 */
const 定时字段 = { 日更: 'daily_at', 周更: 'weekly_at', 导工单: 'orders_at' };
export function 读例行定时(名, 根目录 = null) {
  const env = { 日更: 'BOT_DAILY_AT', 周更: 'BOT_WEEKLY_AT', 导工单: 'BOT_ORDERS_AT' }[名];
  if (env && process.env[env]) return process.env[env].trim();
  const 字段 = 定时字段[名];
  if (!字段) return '';
  const 档 = 根目录 ? `${根目录}/.creds.json` : 凭证档();
  try { return String(JSON.parse(readFileSync(档, 'utf8'))[字段] || '').trim(); }
  catch { return ''; }
}

/**
 * 定时日更那张卡推到哪个会话。没单独设就用令牌提醒那个（`nudge_chat`）。
 * **单独一个字段是因为这两件事的收件人可以不一样**：令牌快过期是运维告警、扫一眼就行；
 * 日更那张卡要人点「真写」，得推到人真的会看的地方。
 * 注意：**这张卡是定时推的、没有发起人，所以那个会话里的任何人都能点确认**。
 * 推到多人群之前先想清楚这一点。
 */
export function 读例行chat(根目录 = null) {
  if (process.env.BOT_DAILY_CHAT) return process.env.BOT_DAILY_CHAT.trim();
  const 档 = 根目录 ? `${根目录}/.creds.json` : 凭证档();
  try {
    const j = JSON.parse(readFileSync(档, 'utf8'));
    return String(j.daily_chat || j.nudge_chat || '').trim();
  } catch { return ''; }
}

/**
 * 飞书应用凭证（给子进程用）。inventory-mcp 读占用台账时用它直连多维表 REST，
 * 一次读完 406 条 ~1.5 秒；没有凭证它会退回 lark-cli，每 200 行起一个子进程、约 8.8 秒。
 * **凭证只在本机进程之间传（env），不落盘、不打印。**
 */
export function 读飞书凭证() {
  if (process.env.LARK_APP_ID && process.env.LARK_APP_SECRET) {
    return { id: process.env.LARK_APP_ID, secret: process.env.LARK_APP_SECRET };
  }
  try {
    const c = JSON.parse(readFileSync(凭证档(), 'utf8'));
    if (c.feishu_app_id && c.feishu_app_secret) return { id: c.feishu_app_id, secret: c.feishu_app_secret };
  } catch { /* 没有就没有，子进程自己退回 lark-cli */ }
  return null;
}

export function 读配置() {
  let c = {};
  try { c = JSON.parse(readFileSync(凭证档(), 'utf8')); } catch { /* 用 env */ }
  const base = process.env.AGENT_API_BASE || c.base;
  const key = process.env.AGENT_API_KEY || c.key;
  if (!base || !key) throw new Error('缺 API 配置：在 .creds.json 或 env(AGENT_API_BASE/AGENT_API_KEY) 里给 base+key');
  const 主 = process.env.AGENT_MODEL || c.model || 全部模型[0];
  // 主模型放第一，其余去重按序兜底：某个模型炸了/超时就换下一个
  const models = [主, ...全部模型.filter((m) => m !== 主)];
  return { base, key, models };
}
