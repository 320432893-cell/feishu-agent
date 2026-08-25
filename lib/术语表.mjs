/**
 * 术语表：把「通算=CPU机」「b300 就是算300」这类**本公司的黑话**从提示词里挪出来，变成能积累的东西。
 *
 * 为什么要它：这些映射现在硬编码在 `lib/agent.mjs` 的系统提示里，而它们会不断增加 ——
 * 人每纠正一次（「我说的位置是位置信息不是分割」），下次还得再纠正一遍，因为每次都是白板。
 *
 * **谁能改：只有人，通过群里的口令。** 模型只读、不写 —— 术语表影响所有人的查询结果，
 * 让模型自己偷偷记，出错时没人知道是什么时候记错的。每条都记**谁加的、什么时候**。
 *
 * **冲突不静默覆盖**：同一个词再教一次会报「原来是 X，要改成 Y 吗」，让人自己拍。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const 档 = process.env.BOT_GLOSSARY || join(homedir(), '.cache', 'feishu-agent', '术语表.json');

function 读全部() {
  try { const j = JSON.parse(readFileSync(档, 'utf8')); return Array.isArray(j) ? j : []; }
  catch { return []; }
}
/**
 * **先写 `.tmp` 再改名**，和 `lib/持久表.mjs` 同一个道理：`writeFileSync` 是「先截断再写」，
 * 写到一半断电/被 kill，留下的是半个 JSON —— 下次 `读全部()` 那个 `JSON.parse` 直接抛、
 * 被 catch 吞成 `[]`，**表现是「全组的黑话一条不剩地消失了」，而且不报任何错**。
 * `rename` 在同一分区上是原子的：读者要么看到旧的完整文件、要么看到新的完整文件。
 *
 * 2026-08-24 补：这个文件存的东西和持久表一样重要（人一条条教出来的），
 * 却一直没享受同一份保护 —— 持久表那边 2026-08-23 就改成先 tmp 后 rename 了。
 */
function 写全部(表) {
  try {
    mkdirSync(dirname(档), { recursive: true });
    const 临 = `${档}.tmp`;
    writeFileSync(临, JSON.stringify(表, null, 2) + '\n');
    renameSync(临, 档);
    return true;
  } catch { return false; }
}
const 现在 = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

/** 列出全部（给人看、也给提示词用）。 */
export function 列术语() { return 读全部(); }

/**
 * 加一条。**同名已存在且释义不同 → 不覆盖，返回 {冲突}**，让人决定。
 * @返回 { 加了 } | { 冲突: 原释义 } | { 一样: true } | { 写不进去: true }
 */
export function 加术语(词, 释义, 谁 = '') {
  const w = String(词 || '').trim();
  const m = String(释义 || '').trim();
  if (!w || !m) return { 写不进去: true };
  const 表 = 读全部();
  const 旧 = 表.find((x) => x.词 === w);
  if (旧 && 旧.释义 === m) return { 一样: true };
  if (旧) return { 冲突: 旧.释义 };
  表.push({ 词: w, 释义: m, 谁, 何时: 现在() });
  return 写全部(表) ? { 加了: true } : { 写不进去: true };
}

/** 改一条（人确认过冲突之后才走这条）。 */
export function 改术语(词, 释义, 谁 = '') {
  const w = String(词 || '').trim();
  const 表 = 读全部();
  const i = 表.findIndex((x) => x.词 === w);
  if (i < 0) return 加术语(词, 释义, 谁);
  表[i] = { 词: w, 释义: String(释义).trim(), 谁, 何时: 现在() };
  return 写全部(表) ? { 改了: true } : { 写不进去: true };
}

/** 删一条。 */
export function 删术语(词) {
  const w = String(词 || '').trim();
  const 表 = 读全部();
  const 剩 = 表.filter((x) => x.词 !== w);
  if (剩.length === 表.length) return { 没这条: true };
  return 写全部(剩) ? { 删了: true } : { 写不进去: true };
}

/**
 * 拼成给模型看的一段。**空表就返回空串**——别塞一句「（暂无术语）」进提示词，那是纯噪音。
 * 实测输入 token 几乎不花钱（15KB 工具 schema 带不带都是 1.3 秒），所以几十条随便拼。
 */
export function 术语段() {
  const 表 = 读全部();
  if (!表.length) return '';
  const 行 = 表.map((x) => `· ${x.词} = ${x.释义}`).join('\n');
  return `**这个公司的黑话（人教给你的，按这个理解，别自己另行猜测）**：\n${行}\n`;
}

/** 教术语表单的提交按钮名。**路由只能靠它** —— 表单回包里没有 action_value（2026-08-23 实测）。 */
export const 教术语按钮名 = '教术语提交';

/**
 * 「教我这个词」的表单卡片。**模型提议、人一键确认** —— 和写闸完全同构：
 * 模型能猜、能提，落库那一下必须人按下去。它自己偷偷记的话，出错时没人知道什么时候记歪的。
 *
 * 卡片形状照 `表格范围.mjs` 那张，是一条条试出来的：必须 schema 2.0、输入框套 form、
 * 按钮 form_action_type:'submit' 且用 value 不用 behaviors。
 */
export function 教术语卡(词, 猜 = '') {
  const 框 = (name, label, placeholder, 值) => ({
    tag: 'input', name, placeholder: { tag: 'plain_text', content: placeholder },
    label: { tag: 'plain_text', content: label }, label_position: 'top',
    ...(值 ? { default_value: String(值) } : {}),
  });
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [
        { tag: 'markdown',
          content: `**「${词}」是什么？**\n我查了一圈没查到这个词，猜它是你们的黑话。`
            + `${猜 ? `\n我猜是：**${猜}**（不对就改）` : '\n我猜不出来，你填一下'}`
            + '\n\n填完我会记住，**然后把你刚才那个问题自动重问一遍**。' },
        {
          tag: 'form',
          name: '教术语表单',
          elements: [
            框('词', '这个词', '', 词),
            框('释义', '它其实是指什么', '如：800G 光模块', 猜),
            { tag: 'button', text: { tag: 'plain_text', content: '记住，并重问一遍' }, type: 'primary',
              form_action_type: 'submit', name: 教术语按钮名 },
          ],
        },
      ],
    },
  };
}

/**
 * 认口令。**在 bot 层直接认，不经过模型** —— 快、可靠、不烧一轮模型，
 * 而且「谁改的术语表」永远清楚（模型不参与写）。
 * 认得出返回 {动作,…}，认不出返回 null（那就是一句普通的问话）。
 */
export function 认口令(文) {
  const s = String(文 || '').trim();
  let m;
  // 「改成」单独一条：**同名冲突时不静默覆盖**，人得再明说一次才动。放在「记住」前面匹配。
  if ((m = s.match(/^(?:改成|改为)[:：]?\s*(.+?)\s*(?:=|＝|就是|是指)\s*(.+)$/))) {
    return { 动作: '改', 词: m[1].trim(), 释义: m[2].trim() };
  }
  if ((m = s.match(/^(?:记住|记下)[:：]?\s*(.+?)\s*(?:=|＝|就是|是指)\s*(.+)$/))) {
    return { 动作: '加', 词: m[1].trim(), 释义: m[2].trim() };
  }
  if ((m = s.match(/^(?:忘掉|忘记|删掉|删除)[:：]?\s*(.+?)\s*(?:这条|这个)?$/))) {
    return { 动作: '删', 词: m[1].trim() };
  }
  if (/^(?:看术语|术语表|有哪些术语|查术语)$/.test(s)) return { 动作: '列' };
  return null;
}
