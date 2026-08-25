/**
 * **补收：把长连接断掉那几秒丢掉的消息捞回来。**
 *
 * 2026-08-24 实测：飞书长连接**每天断 33-76 次**（`feishu-websocket: disconnected` → `reconnecting` →
 * `connected`），断的那一小段时间里发的消息**永久丢失**，而 bot 完全看不见 ——
 * 断在 lark-cli 内部，子进程没死，所以 `起事件()` 的重连计数是 0，心跳一片祥和。
 * 那天 11:59 的一条「日更」就是这么没的：飞书那边有这条消息，我们这边零记录。
 * 重启也一样：每次重启事件流有十几秒空窗，那期间发的消息同样丢。
 *
 * **不靠检测断线**：断线检测要去解析 lark-cli 的 stderr 文本，那是别人的输出格式、随时会变，
 * 而且漏检一次就等于漏一批消息。改成**定期把最近几分钟的消息拉一遍**，多拉的靠去重挡掉 ——
 * 这条路不依赖任何「我有没有发现断线」的判断。
 *
 * **去重必须活过重启**，否则重启后补收会把老消息重新答一遍。所以用持久表，不用内存 Set。
 */

/**
 * 机器人自己发的、非文本的、太老的，都不补。**返回的形状和事件推过来的一致**，好喂进同一个 处理()。
 *
 * **`chat_type` 必须由调用方传进来，不能猜**：2026-08-24 实测 REST 拉回来的消息列表里根本没有
 * `chat_type` 这个字段（不是空字符串，是整个键都不存在）。原来这里 `m.chat_type || 'group'`
 * 默认成群聊——私聊消息被补收时就会被误标成群聊，而 `bot.mjs` 新加的「群里没被 @ 就不理」
 * 那道闸只放行真被 @ 的群消息，私聊消息一旦被误标就会被这道闸连带误杀，补收等于白补。
 * 这一批消息全来自同一个 `chat`（`拉(chat, 从秒)` 一次只拉一个会话的），所以 chat_type 只传一个值就够。
 */
export function 该补哪些(消息们, { 见过, 从毫秒, 我的appid = '', chat_type = 'group' }) {
  const 出 = [];
  for (const m of 消息们 || []) {
    const id = m?.message_id;
    if (!id || 见过(id)) continue;
    // **机器人自己发的一律跳过**：不跳的话它会把自己刚发的答案当成新问题，一轮轮自问自答。
    if (m?.sender?.sender_type === 'app' || (我的appid && m?.sender?.id === 我的appid)) continue;
    if (m?.sender?.sender_type && m.sender.sender_type !== 'user') continue;
    if (m?.msg_type !== 'text') continue;               // 只补文本；图片/文件本来也不处理
    if (m?.deleted) continue;
    const 时 = Number(m.create_time || 0);
    if (!时 || 时 < 从毫秒) continue;
    // **`body.content` 是个 JSON 字符串**（`{"text":"日更"}`），不是纯文本 ——
    // 2026-08-24 第一版这里直接把这个 JSON 字符串塞给了 content，`去at()` 只会 String() 它，
    // 于是 问 会变成字面的 `{"text":"日更"}`，模型收到的就是一句带花括号的乱码。
    // lark-cli 的事件流给的 `content` 是已经解出来的纯文本，这里要对齐同一个形状。
    let 文本 = '';
    try { 文本 = JSON.parse(m.body?.content || '{}').text || ''; } catch { continue; } // 解不开这条就跳过，别塞一坨乱码进 处理()
    if (!文本.trim()) continue;
    出.push({
      chat_id: m.chat_id,
      sender_id: m.sender?.id || '',
      sender_type: 'user',
      chat_type,
      message_id: id,
      content: 文本,
      mentions: m.mentions || [],
      _补收: true,   // 调用方要在日志里标出来，不然「它自己想起来答了一条」看着像见鬼
      _时: 时,
    });
  }
  return 出.sort((a, b) => a._时 - b._时); // 按时间正序补，追问的上下文才不会乱
}

/**
 * 建一个补收器。`拉` 和 `列会话` 注进来（测试里换成假的，不打网）。
 *
 * @param 拉 (chat_id, 从秒) => Promise<消息数组>
 * @param 见过 (message_id) => bool     —— 去重，**必须查持久的那份**
 * @param 记下 (message_id) => void     —— 补完标记，防下一轮再补
 * @param 办 (事件) => Promise<void>    —— 真正处理一条（就是 bot 的 处理()）
 * @param 会话们 () => string[]         —— 要盯哪几个会话
 * @param 会话类型 (chat_id) => 'group'|'p2p'  —— 不给就全当群聊（见 该补哪些 的说明，REST 拉不到这个字段）
 * @param 不早于 时间戳（毫秒）；比它早的消息一律不补。**调用方应该传进程启动时刻**——
 *   补收要救的是「长连接断线那几秒丢的消息」，那些必然发生在进程活着的时候。
 *   进程起来之前的消息要么早被上一个进程答过、要么是它死透了期间的（补了也是过期答案）。
 *   2026-08-24 真踩到：重启后补收把重启前 7 分钟答过的一条重新答了一遍 ——
 *   因为那条的 id 不在去重表里（表是当天才加的）。**靠去重表挡不住这类，靠时刻边界才行。**
 */
export function 建补收({ 拉, 见过, 记下, 办, 会话们, 会话类型 = () => 'group', 回看毫秒 = 10 * 60 * 1000, 我的appid = '', 不早于 = 0 }) {
  let 跑着 = false;
  return async function 补一轮() {
    // **不许叠着跑**：一轮没跑完又起一轮的话，同一条消息会被两轮同时捞到、去重挡不住（都还没记下）。
    if (跑着) return { 跳过: true };
    跑着 = true;
    // **两道下界取更晚的那个**：回看窗口管「往前看多久」，`不早于` 管「进程起来之前一律不看」。
    const 从毫秒 = Math.max(Date.now() - 回看毫秒, 不早于);
    let 补了 = 0, 扫了 = 0, 出错 = 0;
    try {
      for (const chat of 会话们()) {
        let 条们 = [];
        try { 条们 = await 拉(chat, Math.floor(从毫秒 / 1000)); }
        catch { 出错++; continue; } // 某个会话拉不动不影响别的
        扫了 += 条们.length;
        for (const 事件 of 该补哪些(条们, { 见过, 从毫秒, 我的appid, chat_type: 会话类型(chat) })) {
          记下(事件.message_id);
          补了++;
          try { await 办(事件); } catch { /* 一条办砸了不影响后面的 */ }
        }
      }
    } finally { 跑着 = false; }
    return { 补了, 扫了, 出错 };
  };
}
