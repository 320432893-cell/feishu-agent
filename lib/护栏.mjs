/**
 * 纯逻辑：去 @占位、每人每小时限流。抽出来给 bot.mjs 用、也给测试用（bot.mjs 本身是守护进程、不可 import 测）。
 */

/** 从消息文本里精确去掉"@<被@人名>"（名字可能带空格，正则 \S+ 会切错——之前的真 bug）+ @_user_N 占位。 */
export function 去at(content, mentions = []) {
  let s = String(content || '');
  for (const m of mentions) if (m && m.name) s = s.split('@' + m.name).join(' ');
  return s.replace(/@_user_\d+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * **群里必须真被 @ 了才理会，私聊不用**。
 *
 * 2026-08-24 真事：群里同事发的一句纯聊天（「帮俺再更新一下资源可视表」「先把变动情况梳理一下，
 * 不急着改数据」）没有任何 @ 标记，照样被当成一次查询处理掉了——飞书把这个 app 的群消息事件
 * 全量推过来，不是只推 @ 了它的那些，而 `处理()` 原来没有任何一道闸去校验"是不是真被 @ 了"，
 * 只是拿 `去at()` 顺手剥掉 @ 标记（有没有标记它不关心）。别人在群里正常聊天，机器人会插进来答一句。
 *
 * **判据是「@ 的是不是它自己」，不是「有没有人被 @」**（2026-08-24 第二次修）。
 * 第一版写的是 `mentions 非空就放行` —— 而群里同事互相 @ 是常事：
 * 真事是「@邓老师，明天纪老师要的 2+80 台…」这句里 @ 的是**人**，
 * 机器人以为在叫它，跑了 5 次 `翻记录`、答了 18.3 秒，插进别人的对话里。
 * **「有人被 @」和「它被 @」差着十万八千里，而前者在群里几乎总是真的。**
 *
 * 所以要拿它自己的 open_id 去比（`/open-apis/bot/v3/info` 给得到，启动时取一次）。
 * **拿不到自己的 id 时宁可不理**：群里多嘴的代价（插进别人对话）比漏答一条大得多 ——
 * 漏了人会再 @ 一次，多嘴没人能撤回。
 *
 * **私聊（p2p）不受这条管**：1:1 会话本来就没有"@ 谁"这个动作，每条消息天然就是发给它的。
 *
 * @param 我的openid 机器人自己的 open_id。**留空 = 群里一律不理**（见上）
 */
export function 该理会吗(chat_type, content, mentions, 我的openid = '') {
  if (chat_type !== 'group') return true;
  if (!我的openid) return false;
  if (!Array.isArray(mentions)) return false;
  return mentions.some((m) => {
    const id = m?.id || {};
    return id.open_id === 我的openid || m?.open_id === 我的openid;
  });
}

/**
 * 答案卡片加一对反馈按钮。**群里现在没有「这个答错了」的通道** —— 人只会私下嘀咕一句，
 * 而我们永远不知道哪类问题答不好。按钮点了会触发 `card.action.trigger`，落进问答留存。
 * @param 问答id 把这次问答的编号带在按钮里，点回来时才知道是在评哪一条
 * @返回 卡片的 elements 数组（不给 问答id 就只有正文，不长按钮）
 */
export function 卡片元素(md, 问答id = null, { 要SN = false, 可导表 = false, 可停 = false, 可限表 = false, 可解除 = false, 限表链接 = "", 聊天 = "", 问答id: 选项问答id = null } = {}) {
  const 元素 = [{ tag: 'markdown', content: md || '' }];
  const 按钮 = [];
  // **动作按钮的 id 和 👍👎 的 id 是两回事，不能共用第二个位置参数。**
  // 第二个参数被 `反馈开关` 门着（关了就是 null，为的是不长 👍👎），而进度卡为了不长 👍👎
  // 也传了 null、把真 id 放在选项里 —— 结果「⏹ 停」按钮的 value 里 `问答id: null`，
  // 点下去 `跑中.get(null)` 必然找不到，回一句「这条已经跑完或者已经停了」。
  // **这个按钮从上线起就 100% 停不掉任何东西，而且不报任何错。**
  const 动作id = 问答id ?? 选项问答id ?? null;
  // **「要 SN 明细」单独一个按钮，不靠模型自己想起来问。**
  // 现在这条链上没有任何地方问过人：工具按行数自己决定导不导 CSV，导了就直接发，
  // 而那张 CSV 是**按型号汇总的**（列：物料键/品牌/型号/库房/在库），一个 SN 都没有。
  // SN 在另一个工具 `查SN` 手里，它的说明里明写着「只在人明确要 SN 时才调」——
  // 所以模型不调它是对的，缺的是**一个让人说「我要」的地方**。
  if (要SN) {
    按钮.push({ tag: 'button', text: { tag: 'plain_text', content: '📋 要 SN 明细' }, type: 'primary', value: { 要SN: '1', 问答id: 动作id, 聊天 } });
  }
  // 「停」：查询最长能跑 180 秒，中途人发现问错了、或者看它在查一个明显不对的东西，
  // **在这之前没有任何办法叫停** —— 只能等它跑完、再重问一遍，而那一轮还占着并发。
  // agent 循环本来就吃 AbortSignal（超时用的就是它），这里只是把那根线接到按钮上。
  if (可停) {
    按钮.push({ tag: 'button', text: { tag: 'plain_text', content: '⏹ 停' }, type: 'danger', value: { 停: '1', 问答id: 动作id, 聊天 } });
  }
  // 「📌 只看某张表」：**人意识到「你读错表了」那一刻，恰好就是答案刚出来的时候** ——
  // 按钮就该出现在那儿。让人回想「限定表」这三个字是把设计的负担推给用户，
  // 而绝大多数人不会去背，于是这个功能等于不存在。
  // 只在**这一轮真读了飞书表**时挂；链接直接塞进按钮值里，点开表单是预填好的。
  if (可限表) {
    按钮.push({ tag: 'button', text: { tag: 'plain_text', content: '📌 只看某张表' }, type: 'default', value: { 限表: '1', 链接: 限表链接 || '', 聊天 } });
  }
  // 「🔓 解除限定」：挂在**设定回执**那张卡上。限定是个会一直生效的状态，
  // 而解除的口令（「不限表了」）同样得背 —— 状态本身就该带着关掉它的开关。
  if (可解除) {
    按钮.push({ tag: 'button', text: { tag: 'plain_text', content: '🔓 解除限定' }, type: 'default', value: { 解除范围: '1', 聊天 } });
  }
  // 「导出到飞书表格」：给文件的话人还得下载、打开、想共享再传一次；给链接是一步。
  // 只在**这一轮真导出了明细**时挂 —— 没数据可导的时候挂着，点了只会得到一句「没有明细」。
  if (可导表) {
    按钮.push({ tag: 'button', text: { tag: 'plain_text', content: '📊 导出到飞书表格' }, type: 'default', value: { 导表: '1', 问答id: 动作id, 聊天 } });
  }
  if (问答id) {
    按钮.push(
      { tag: 'button', text: { tag: 'plain_text', content: '👍 有用' }, type: 'default', value: { 反馈: '好', 问答id } },
      { tag: 'button', text: { tag: 'plain_text', content: '👎 答错了' }, type: 'default', value: { 反馈: '差', 问答id } },
    );
  }
  if (按钮.length) 元素.push({ tag: 'action', actions: 按钮 });
  return 元素;
}


/**
 * 解析卡片按钮回来的事件，抽出「谁、评了哪条、评的什么」。
 *
 * **形状是 2026-08-22 真点了一次抄回来的，不是照文档猜的**（猜的那版两处都错：
 * 以为是 `action.value` 对象、以为操作人在 `operator.open_id`）。真回包长这样：
 *   { type:'card.action.trigger', operator_id:'ou_…', action_tag:'button',
 *     action_value:'{"反馈":"好","问答id":"ceshimile"}',  ← **顶层字段，而且是 JSON 字符串**
 *     message_id, chat_id, token, card_content, … }
 * 另外几种写法（`action.value` 对象 / 嵌在 `event` 里）也一并收着，换 SDK 版本不至于全瞎。
 *
 * **认不出就返回 null，绝不瞎猜一个反馈记进去** —— 记错的反馈比没有反馈更坏。
 * 调用方在认不出时要把原样打出来，否则下一个人还得重新猜一遍。
 */
function 卡片值(e) {
  const v = e?.action_value ?? e?.event?.action_value ?? e?.action?.value ?? e?.event?.action?.value;
  if (v == null) return {};
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
  return typeof v === 'object' ? v : {};
}
const 卡片操作人 = (e) => e?.operator_id || e?.event?.operator_id || e?.operator?.open_id || e?.event?.operator?.open_id || '';
/**
 * 延迟更新用的 token（**30 分钟有效、最多用 2 次**）。有它就能把人刚点的那张卡片**就地改掉**，
 * 而不是另发一条消息 —— 点一次多一条消息，聊天记录很快就糊了。
 */
const 回调token = (e) => e?.token || e?.event?.token || '';

/** 认「要 SN 明细」那个按钮。和 👍/👎、澄清、写入确认走同一个 card.action.trigger 通道。 */
export function 认要SN(e) {
  const v = 卡片值(e);
  if (!v.要SN) return null;
  return { 谁: 卡片操作人(e), 聊天: v.聊天 ? String(v.聊天) : "", 问答id: v.问答id || "", 回调token: 回调token(e) };
}

/**
 * **说得像某件例行公事、但没打准口令**时弹的卡片（「执行下日更」这类）。
 *
 * 不直接跑是因为猜错的代价不对称：多弹一个按钮，人不点就没事；猜着跑起来，
 * 人得等半分钟再看见一张他没要的确认卡。2026-08-24 真事：模型接手这句话之后
 * 只会拿只读工具东拼西凑答一段话，**日更那条链根本没被触发**，人以为问清楚了、其实什么也没跑。
 */
export function 例行确认卡片元素(名, 原话, 聊天) {
  return [
    { tag: 'markdown', content: `你是要我跑**${名}**吗？（听到的是：「${String(原话 || '').slice(0, 60)}」）` },
    {
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: `是，跑${名}` }, type: 'primary', value: { 例行确认: 名, 聊天 } },
        { tag: 'button', text: { tag: 'plain_text', content: '不是' }, type: 'default', value: { 例行确认: '', 聊天 } },
      ],
    },
  ];
}

/** 认「例行确认」那个按钮。 */
export function 认例行确认(e) {
  const v = 卡片值(e);
  if (v.例行确认 === undefined) return null;
  return { 名: String(v.例行确认 || ''), 谁: 卡片操作人(e), 聊天: v.聊天 ? String(v.聊天) : '', 回调token: 回调token(e) };
}

/** 认「导出到飞书表格」那个按钮。 */
export function 认导表(e) {
  const v = 卡片值(e);
  if (!v.导表) return null;
  return { 谁: 卡片操作人(e), 聊天: v.聊天 ? String(v.聊天) : "", 问答id: v.问答id || "", 回调token: 回调token(e) };
}

/**
 * 认**表单提交**（带输入框那种卡片）。形状是 2026-08-23 真点了一次抄回来的：
 *   { type:'card.action.trigger', operator_id, chat_id, action_tag:'button',
 *     action_name:'提交按钮',                ← 按钮的 name
 *     form_value:'{"表链接":"abc"}',         ← **输入框的值，JSON 字符串**
 *     timezone, card_content, … }
 *
 * **两个只有真点过才知道的坑**：
 * ① 输入的值在 `form_value`，不在 `action_value`。
 * ② **表单提交的回包里根本没有 `action_value`** —— 按钮上写的 `value` 一个字都不回来。
 *    所以路由只能靠 `action_name`，不能像别的按钮那样往 value 里塞标记。
 *    好在顶层有 `chat_id`，回话不用另想办法。
 */
export function 认表单(e) {
  const fv = e?.form_value ?? e?.event?.form_value;
  if (fv == null) return null;
  let 字段 = {};
  if (typeof fv === 'string') { try { 字段 = JSON.parse(fv); } catch { return null; } }
  else if (typeof fv === 'object') 字段 = fv;
  else return null;
  return {
    谁: 卡片操作人(e),
    聊天: e?.chat_id || e?.event?.chat_id || '',
    按钮名: String(e?.action_name || e?.event?.action_name || ''),
    字段,
  };
}

/**
 * **表情回应 → 动作**。比按钮还自然：飞书里打表情是本能动作，而且不占卡片空间、不多一条消息。
 *
 * **表情名是 2026-08-23 一个个试出来的**（飞书没有公开清单，报错也不列合法值）：
 * 试了 55 个，合法的只有 20 个 —— `THUMBSUP OK DONE FINGERHEART SMILE JIAYI APPLAUSE
 * FIREWORKS GLANCE THINKING CRY ANGRY SPEECHLESS FACEPALM SHOCKED DIZZY HEART MUSCLE GIFT MONEY`。
 * **没有 THUMBSDOWN、没有表格类（CHART/TABLE/FILE 全不合法）、没有停止类（STOP/X/CROSS 也没有）。**
 *
 * 所以只映射语义站得住的三个。**导出/停不做表情**：没有对得上的表情，硬凑一个人记不住，
 * 等于没做 —— 那正是「能力靠背就等于不存在」的同一个毛病。
 */
export const 表情动作 = {
  THUMBSUP: '好评',   // 👍
  FACEPALM: '差评',   // 🤦 —— 没有 THUMBSDOWN，这是唯一语义明确的负面
  GLANCE: '要SN',     // 👀「我要细看」
};

/** 认表情事件。lark-cli 有时把 event 拍平到顶层、有时不拍，两种都收。 */
export function 认表情(e) {
  const ev = e?.event || e;
  const 表情 = ev?.reaction_type?.emoji_type;
  const 消息id = ev?.message_id;
  if (!表情 || !消息id) return null;
  return {
    表情: String(表情),
    消息id: String(消息id),
    谁: ev?.user_id?.open_id || ev?.operator_id || '',
    动作: 表情动作[String(表情)] || null, // 认不出动作也返回 —— 调用方要把 emoji_type 原样打出来，好照着扩表
  };
}

/** 认「🔓 解除限定」那个按钮。 */
export function 认解除范围(e) {
  const v = 卡片值(e);
  if (!v.解除范围) return null;
  return { 谁: 卡片操作人(e), 聊天: v.聊天 ? String(v.聊天) : "", 回调token: 回调token(e) };
}

/** 认「📌 只看某张表」那个按钮。带着这一轮读过的链接，点开的表单是预填好的。 */
export function 认限表(e) {
  const v = 卡片值(e);
  if (!v.限表) return null;
  return { 谁: 卡片操作人(e), 聊天: v.聊天 ? String(v.聊天) : "", 链接: v.链接 ? String(v.链接) : "", 回调token: 回调token(e) };
}

/**
 * 认「我问过什么」。记录一直在存（12 个月），但在这之前**只有能 ssh 上机器的人 grep 得到**。
 * 「我的」两个字是刻意的：只翻自己的，一句话就把边界说清楚了。
 */
export function 认历史口令(文) {
  return /^(我问过(什么|啥)?|我的记录|我的历史|历史记录|查我的记录|我都问过啥)[？?。.]?$/.test(String(文 || '').trim())
    ? { 历史: true } : null;
}

/**
 * 把一个人的问答记录排成给人看的一段。
 * **答错/出错的那几条也要列出来** —— 它答不出来的那次恰恰是最该被看见的。
 */
export function 历史正文(条们) {
  if (!条们?.length) return '你最近（两个月内）没在这儿问过什么。';
  const 行 = 条们.map((x) => {
    const 时 = String(x.时刻 || '').slice(5, 16); // 只要「月-日 时:分」
    const 问 = String(x.问 || '').replace(/\s+/g, ' ').slice(0, 40);
    if (x.出错) return `· \`${时}\` **${问}**\n  ⚠ 那次出错了：${String(x.出错).slice(0, 50)}`;
    const 答 = String(x.答 || '').replace(/\s+/g, ' ').slice(0, 60);
    const 尾 = [];
    if (x.用了?.length) 尾.push(x.用了.join('/'));
    if (x.总毫秒) 尾.push(`${(x.总毫秒 / 1000).toFixed(1)}s`);
    return `· \`${时}\` **${问}**\n  ${答 || '(没答案)'}${尾.length ? `\n  〔${尾.join(' · ')}〕` : ''}`;
  }).join('\n');
  return `**你最近问过的 ${条们.length} 条**（只有你自己的）：\n\n${行}\n\n答案只留了前 120 字，要完整的重问一遍。`;
}

/**
 * 认「帮助」。**这些能力现在全靠背，背不住就等于不存在** ——
 * 按钮能解决「答案出来那一刻」的入口，解决不了「我还能干嘛」。
 */
export function 认帮助口令(文) {
  return /^(帮助|help|\?|？|你会啥|你会什么|怎么用|说明|菜单)$/i.test(String(文 || '').trim()) ? { 帮助: true } : null;
}

/** 认「⏹ 停」那个按钮。 */
export function 认停(e) {
  const v = 卡片值(e);
  if (!v.停) return null;
  return { 谁: 卡片操作人(e), 聊天: v.聊天 ? String(v.聊天) : "", 问答id: v.问答id || "", 回调token: 回调token(e) };
}

/**
 * 认「停」的口令。按钮之外再给一条打字的路 —— 手机上点按钮不方便的时候，
 * 一句「停」比找那张卡片快。**只认单独说的**：一句话里带个「停」字（如「停机时间是多久」）不算。
 */
export function 认停口令(文) {
  return /^(停|停下|停止|别查了|别查了吧|取消|算了|stop)[。.！!]?$/i.test(String(文 || '').trim()) ? { 停: true } : null;
}

export function 认反馈(e) {
  const v = 卡片值(e);
  const 反馈 = v.反馈 || v.feedback;
  const 问答id = v.问答id || v.qaId;
  if (!反馈 || !问答id) return null;
  return { 反馈, 问答id, 谁: 卡片操作人(e) };
}

/**
 * 写入确认卡片：**把要写什么原样摆出来** + 确认/取消两个按钮。
 * 摘要必须是人能看懂的（"给工单 31796 占 3 种配件、另有 2 种要采购"），不是一坨 JSON ——
 * 人看不懂就只会无脑点确认，那这道闸就白设了。
 */
/**
 * @param 聊天 chat_id，**塞进按钮自己的值里**。为什么不从回调事件里取：
 * 票找不到的时候（过期/点两次/落盘失败后重启）要能回一句话，而那时候没有票、也就没有 chat_id。
 * 从事件里取要赌飞书回调的字段名，那个我 2026-08-21 已经猜错过一次；按钮的值是我自己写进去的，
 * 形状由我定、离线就能验。
 */
export function 确认卡片元素(摘要, 票id, 聊天 = '') {
  return [
    { tag: 'markdown', content: `✍️ **要写入了，先确认一下**\n\n${摘要}` },
    {
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '✅ 确认写入' }, type: 'primary', value: { 确认: '写', 票id, 聊天 } },
        { tag: 'button', text: { tag: 'plain_text', content: '取消' }, type: 'default', value: { 确认: '取消', 票id, 聊天 } },
      ],
    },
  ];
}

/** 认「写入确认」那种按钮。 */
export function 认确认(e) {
  const v = 卡片值(e);
  const 决定 = v.确认;
  const 票id = v.票id;
  if (!决定 || !票id) return null;
  return { 决定: String(决定), 票id: String(票id), 谁: 卡片操作人(e), 聊天: v.聊天 ? String(v.聊天) : '' };
}

/** 认「澄清选项」那种按钮：人点了哪个选项，接着把那一轮续跑下去。 */
export function 认澄清(e) {
  const v = 卡片值(e);
  const 选择 = v.澄清;
  const 问答id = v.问答id || v.qaId;
  if (!选择 || !问答id) return null;
  return { 选择: String(选择), 问答id, 谁: 卡片操作人(e), 聊天: v.聊天 ? String(v.聊天) : '' };
}

/**
 * 澄清卡片：问题 + 一排选项按钮。人点一下 → `card.action.trigger` → 从半截会话续跑。
 * 按钮文字直接就是选项本身（人只看得到这几个字，所以模型那边被要求「每个选项要能独立看懂」）。
 */
export function 澄清卡片元素(问题, 选项, 问答id, 聊天 = '') {
  return [
    { tag: 'markdown', content: `❓ ${问题}` },
    {
      tag: 'action',
      actions: (选项 || []).slice(0, 4).map((x) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: String(x).slice(0, 30) },
        type: 'default',
        value: { 澄清: String(x), 问答id, 聊天 }, // 聊天：票找不到时也要能回一句话，见 确认卡片元素
      })),
    },
  ];
}

/**
 * 把内部错误翻成给群里同事看的话。**报错分两路**：给人的说大白话 + 怎么办，给开发的原文进日志。
 * 不翻的话卡片上会出现「这条没查成：MCP tools/call 超过 45 秒没回」—— 业务同事不知道 MCP 是什么，
 * 只知道它坏了、而且不知道自己能做什么。
 * 兜底那条**绝不带原文**：原文里全是 MCP/fetch/tool_calls 这类词，贴出去等于没说。
 */
const 错误对照 = [
  [/超过 \d+ 秒没回|MCP .*超时/, '这一步查得太久了（超过 45 秒）。多半是一次问的范围太大——缩小点再问，比如只问一两个型号或一张订单。'],
  [/连不上内网CMDB|内网断|fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/, '连不上内网CMDB（公司内网断了？）——查资产、透视、工单这些现在用不了。连上内网或 VPN 再问。查库存那些走飞书的不受影响。'],
  [/所有模型都失败/, 'AI 这会儿不可用（两个模型都没响应）。过几分钟再问一次。'],
  [/MCP 子进程退出|管道断|起不来/, '后台查询程序刚重启过，这条没赶上。再问一次就行。'],
  [/没吐出第一个字|吐到一半卡住|一个字都没回/, 'AI 回到一半卡住了。再问一次；还是不行就说一声。'],
];
export function 说人话(原文) {
  const s = String(原文 || '');
  for (const [模式, 话] of 错误对照) if (模式.test(s)) return 话;
  return '这条没查成。换个说法或者拆细一点再问；一直不行就找我看看日志。';
}

/**
 * 看门狗：**空闲超时 + 硬顶**，取代一刀切的总时长。
 * 为什么换：实测「对账列」54.3 秒、「对齐飞书列」44.8 秒，离原来的 60 秒总超时只剩 5.7 秒余量，
 * 飞书表多几十行就翻。而真正该杀的是「卡住不动」，不是「干得久」——干得久还在吐字/还在调工具的，该让它干完。
 * @param 空闲毫秒 多久没有任何进展就判死（要大于单个工具的超时，否则工具正常执行期间会被误杀）
 * @param 硬顶毫秒 就算一直有进展，最多也只给这么久
 * @param 到期 (原因)=>void 判死时回调一次，只回调一次
 * @返回 { 喂(), 停() } —— 有进展就 喂()，结束了 停()
 */
const 说时长 = (ms) => (ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${ms} 毫秒`); // 别把 80ms 印成「0 秒」
export function 建看门狗({ 空闲毫秒 = 60000, 硬顶毫秒 = 180000, 到期 }) {
  const 开始 = Date.now();
  let 最后进展 = 开始, 结束了 = false, 句柄 = null;
  const 收 = (因) => { if (结束了) return; 结束了 = true; clearTimeout(句柄); 到期(因); };
  function 查() {
    if (结束了) return;
    const 现在 = Date.now();
    if (现在 - 开始 >= 硬顶毫秒) return 收(`跑过了 ${说时长(硬顶毫秒)}硬顶`);
    if (现在 - 最后进展 >= 空闲毫秒) return 收(`${说时长(空闲毫秒)}没有任何进展`);
    排();
  }
  function 排() {
    const 现在 = Date.now();
    句柄 = setTimeout(查, Math.max(10, Math.min(空闲毫秒 - (现在 - 最后进展), 硬顶毫秒 - (现在 - 开始))));
  }
  排();
  return {
    喂: () => { if (!结束了) 最后进展 = Date.now(); },
    停: () => { 结束了 = true; clearTimeout(句柄); },
  };
}

/**
 * 建卡片刷新器：节流 + **作废闸** + **收尾闸**。bot 边生成边刷那张卡片用。
 *
 * 作废闸守的洞：整条查询超时后，还在跑的那半会继续回调、把刚写好的超时提示盖回半截答案。
 *
 * **收尾闸守的是一个更隐蔽的竞态**（2026-08-24 真事，用户截图：卡片上只剩「匹配」两个字，
 * 而日志里那条答案是完整的）：中途刷新调 `改(md)` 是**发出去就不管的异步请求**，
 * 没人等它回。等答案写完、最终那次 `await 改卡片(…)` 落地之后，**早先那个还在飞的请求
 * 才姗姗到达，把完整答案盖回半截**。谁先落地不确定，所以是「经常」卡住、不是每次——
 * 这种间歇性正是竞态的指纹。
 *
 * 修法：`收尾()` 之后一律不再刷。bot 在发最终答案**之前**调它，把还没发出的中途刷新掐掉。
 * 已经在飞的那些管不了（HTTP 发出去就收不回），但**最终答案是在收尾之后才写的**，
 * 所以顺序变成「所有中途刷新 → 收尾 → 最终答案」，最终答案永远是最后一个写的。
 *
 * @param 改 (md)=>void 真正去改卡片
 * @param signal 作废信号，abort 之后一律不刷
 * @param 现在 取当前毫秒（测试注假时钟用）
 * @返回 刷(md) → 这次到底刷没刷（true=刷了）；刷.收尾() → 之后一律不刷
 */
export function 建刷(改, { 节流毫秒 = 600, signal = null, 现在 = () => Date.now() } = {}) {
  let 上次 = -Infinity;
  let 收了 = false;
  function 刷(md) {
    if (收了 || signal?.aborted) return false;
    const t = 现在();
    if (t - 上次 < 节流毫秒) return false; // 飞书卡片改太频会被限流；丢掉的中间态没关系，定稿为准
    上次 = t;
    改(md);
    return true;
  }
  刷.收尾 = () => { 收了 = true; };
  return 刷;
}

/** 建每人每小时限流器。@返回 超限(sender)=true 表示这一小时已超上限。 */
export function 建限流(每时上限) {
  const 表 = new Map(); // sender → [时间戳]
  return function 超限(sender) {
    const 现 = Date.now();
    const arr = (表.get(sender) || []).filter((t) => 现 - t < 3600000);
    表.set(sender, arr);
    if (arr.length >= 每时上限) return true;
    arr.push(现);
    return false;
  };
}
