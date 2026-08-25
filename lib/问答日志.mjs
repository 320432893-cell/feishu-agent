/**
 * 问答留存：一行一条 JSONL，按月切。**这是「知道下一步该优化什么」的地基。**
 *
 * 为什么要它：纯文本日志能 grep 出「出没出错」，但回答不了「这周同事问了什么、哪类问题答不上来、
 * 平均多久」。2026-08-21 把一条查询从 75 秒压到 4.5 秒，靠的就是耗时被拆成了模型/工具两栏——
 * 没有这份留存，下一轮优化只能靠感觉。形态照抄 inventory-mcp 的 `问答日志`（那边已经跑了几个月）。
 *
 * **不许拖慢查询**：追加写不 await、异常整个吞掉。留存坏了不该让人查不到货。
 * **不记答案全文**：只记长度和前 120 字——答案里有 SN、成本归属这些，留一份全的在缓存目录没必要。
 */
import { mkdirSync, appendFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const 目录 = process.env.BOT_QA_LOG_DIR || join(homedir(), '.cache', 'feishu-agent', '问答日志');
/** 本地月份，不是 UTC —— 和守护日志同一个理由：东八区下午 4 点后 toISOString 会滚进下个月。 */
const 本月 = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 7);
};
const 档 = () => join(目录, `${本月()}.jsonl`);

/** 只留最近 N 个月：按文件名排（`2026-08.jsonl` 字典序=时间序），不按 mtime。 */
function 清旧(留几月 = 12) {
  try {
    const 全 = readdirSync(目录).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
    for (const f of 全.slice(0, -留几月)) rmSync(join(目录, f));
  } catch { /* 清不动不影响 */ }
}

/**
 * 记一条。**同步追加但整个包在 try 里**：一行 JSON 几百字节，写盘比一次网络往返便宜几个数量级，
 * 用异步反而要处理并发写序问题。
 */
export function 记一条(条) {
  try {
    mkdirSync(目录, { recursive: true });
    const d = new Date();
    const 行 = {
      时刻: new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' '),
      ...条,
      // 没有答案的记录（比如反馈、出错）就别硬塞 答:null/答长:0 —— 以后做统计时那是噪音
      ...(条.答 == null ? {} : { 答: String(条.答).replace(/\s+/g, ' ').slice(0, 120), 答长: String(条.答).length }),
    };
    appendFileSync(档(), JSON.stringify(行) + '\n');
  } catch { /* 留存坏了不许影响查询 */ }
}

// 进程起来时清一次旧月份就够：bot 是长驻的，不需要每写一条都去列一遍目录。
清旧();

/** 读某个月（不给就本月）。给测试和以后做统计用。 */
export function 读一月(月 = null) {
  try {
    return readFileSync(月 ? join(目录, `${月}.jsonl`) : 档(), 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * **翻某个人自己问过什么。**
 *
 * 记录一直在存（12 个月），但在这之前**只有能 ssh 上机器的人 grep 得到** ——
 * 群里的同事看不见自己问过什么、更看不见它哪次答错了。
 *
 * **只回这个人自己的**（按 `sender` 过滤，跨月往回翻）。这不是省事，是边界：
 * 所有人的问答在同一个文件里，不按人切的话，一句「老王问过什么」就能把别人的全翻出来。
 *
 * 只留真的问答（有「问」的那些）；反馈/术语/范围限定这些操作记录不算 —— 人要看的是「我问过什么」。
 * **出错的那几条也要留**：它答不出来的那次，恰恰是最该被看见的。
 */
export function 我问过(sender, { 几条 = 10, 往回几月 = 2, 关键词 = '' } = {}) {
  if (!sender) return [];
  const 月们 = [];
  const d = new Date();
  for (let i = 0; i < Math.max(1, 往回几月); i++) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    月们.push(new Date(m.getTime() - m.getTimezoneOffset() * 60000).toISOString().slice(0, 7));
  }
  const 全 = 月们.flatMap((m) => 读一月(m));
  // 关键词只在**问和答**里找。答案只存了前 120 字，所以搜不到不等于当时没答 ——
  // 调用方要把这句话说给人听，不然人会以为「我明明问过」是记错了。
  const 词 = String(关键词 || '').trim().toLowerCase();
  return 全
    .filter((x) => x && x.sender === sender && x.问)
    .filter((x) => !词 || `${x.问}${x.答 || ''}`.toLowerCase().includes(词))
    .slice(-几条)
    .reverse(); // 最近的在最前面 —— 人翻记录都是先看最近的
}
