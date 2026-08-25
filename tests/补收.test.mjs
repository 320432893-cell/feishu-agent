/**
 * 补收：长连接断线期间飞书那边收到、bot 没收到的消息，事后补上。
 * 2026-08-24 真事：一天断 33-76 次，11:59 那条「日更」就是这么丢的 —— 飞书有记录，bot 零记录。
 * 只认返回值，不打网，不起真进程。
 */
import { 该补哪些, 建补收 } from '../lib/补收.mjs';

let 挂 = 0, n = 0;
const eq = (得, 期, 说) => { n++; if (JSON.stringify(得) !== JSON.stringify(期)) { 挂++; console.log(`✗ ${说}｜得 ${JSON.stringify(得)} 期 ${JSON.stringify(期)}`); } else console.log(`✓ ${说}`); };
const 真 = (得, 说) => eq(!!得, true, 说);

// **建补收 内部用 Date.now() 算「从多久前开始看」**，所以 create_time 得给「现在」附近的值 ——
// 固定的老时间戳在下面 建补收 那几段整体测试里会被年龄闸滤掉，那是数据该新鲜，不是实现的问题。
const 现在 = Date.now();
// **原始消息上故意带一个 chat_type: 'p2p'**——这是 2026-08-24 真事踩出来的一个坑的回归测试：
// REST 拉回来的消息压根没有这个字段，第一版 该补哪些 却读了 `m.chat_type`，等于给每条消息
// 默认成了 'group'，私聊消息补收时会被误标。现在 chat_type 只能由调用方显式传，
// 这个字段留在这儿就是为了证明「就算原始消息上有这个字段，也不会被读」。
const 造 = (覆盖 = {}) => ({
  message_id: 'om_1', chat_id: 'oc_a', chat_type: 'p2p', msg_type: 'text', create_time: String(现在),
  sender: { id: 'ou_甲', sender_type: 'user' },
  body: { content: JSON.stringify({ text: '日更' }) },
  ...覆盖,
});

// —— 该补哪些：内容形状 ——
{
  const 出 = 该补哪些([造()], { 见过: () => false, 从毫秒: 0 });
  eq(出.length, 1, '一条正常文本消息，补出来');
  // ★ 这是这个模块最容易踩的坑：body.content 是个 JSON 字符串，不是纯文本
  eq(出[0].content, '日更', '**content 是解出来的纯文本「日更」，不是 `{"text":"日更"}` 这坨 JSON 字符串**');
  eq(出[0].sender_id, 'ou_甲', 'sender_id 对得上');
  eq(出[0].sender_type, 'user', 'sender_type 统一成 user（给 处理() 的 e.sender_type 校验用）');
  eq(出[0]._补收, true, '标了 _补收，日志里能看出「这条是补的不是活的」');
}

// —— 该补哪些：chat_type 只能由调用方传，不读原始消息上的字段 ——
// 2026-08-24 真事：REST 没有 chat_type 这个字段，旧版默认成 'group' 会把私聊消息误标，
// 叠加新加的「群里没被 @ 不理」那道闸，私聊补收会被连带误杀。
{
  eq(该补哪些([造()], { 见过: () => false, 从毫秒: 0 }).length, 1, '不传 chat_type 照样补得出来（不是必填）');
  eq(该补哪些([造()], { 见过: () => false, 从毫秒: 0 })[0].chat_type, 'group', '不传 chat_type 时默认 group（和原来的默认行为一致，只是来源变了）');
  eq(该补哪些([造()], { 见过: () => false, 从毫秒: 0, chat_type: 'p2p' })[0].chat_type, 'p2p',
    '**显式传 chat_type:"p2p" 就用这个**——不管原始消息上那个字段写的是什么');
  eq(该补哪些([造({ chat_type: 'group' })], { 见过: () => false, 从毫秒: 0, chat_type: 'p2p' })[0].chat_type, 'p2p',
    '**原始消息上就算写着 chat_type:"group"，也不读它**——只认调用方传的这一个');
}

// —— 该补哪些：该滤掉的 ——
{
  eq(该补哪些([造({ sender: { id: 'cli_x', sender_type: 'app' } })], { 见过: () => false, 从毫秒: 0 }).length, 0,
    '**机器人自己发的一律跳过** —— 不跳的话它会把自己的答案当成新问题，一轮轮自问自答');
  eq(该补哪些([造()], { 见过: () => true, 从毫秒: 0 }).length, 0, '已经处理过的（见过 返回 true）跳过');
  eq(该补哪些([造({ msg_type: 'interactive' })], { 见过: () => false, 从毫秒: 0 }).length, 0, '非文本消息（卡片/图片）跳过');
  eq(该补哪些([造({ deleted: true })], { 见过: () => false, 从毫秒: 0 }).length, 0, '撤回的消息跳过');
  eq(该补哪些([造({ create_time: '100' })], { 见过: () => false, 从毫秒: 5000 }).length, 0, '比回看窗口更早的消息跳过');
  eq(该补哪些([造({ body: { content: '不是合法 JSON' } })], { 见过: () => false, 从毫秒: 0 }).length, 0,
    '**content 解不开就整条跳过**，不塞一坨解析失败的东西进 处理()');
  eq(该补哪些([造({ body: { content: JSON.stringify({ text: '   ' }) } })], { 见过: () => false, 从毫秒: 0 }).length, 0,
    '空白文本跳过（和 处理() 自己那道 `if (!问) return` 一个道理）');
  eq(该补哪些([造({ sender: { id: 'ou_甲', sender_type: 'bot' } })], { 见过: () => false, 从毫秒: 0 }).length, 0,
    'sender_type 不是 user 的（bot/unknown）一律跳过');
  eq(该补哪些([造({ 我的appid: undefined, sender: { id: 'app_自己', sender_type: 'user' } })],
    { 见过: () => false, 从毫秒: 0, 我的appid: 'app_自己' }).length, 0,
    '按 我的appid 精确排掉自己（sender_type 万一被记成 user 时的兜底）');
}

// —— 该补哪些：按时间正序 ——
{
  const 出 = 该补哪些([
    造({ message_id: 'om_2', create_time: '1700000002000' }),
    造({ message_id: 'om_1', create_time: '1700000001000' }),
    造({ message_id: 'om_3', create_time: '1700000003000' }),
  ], { 见过: () => false, 从毫秒: 0 });
  eq(出.map((x) => x.message_id), ['om_1', 'om_2', 'om_3'], '**按时间正序排**，追问的上下文才不会乱');
}

// —— 建补收：跑得起来、办得到 ——
{
  const 办过 = [];
  const 补 = 建补收({
    拉: async (chat) => (chat === 'oc_a' ? [造()] : []),
    见过: () => false,
    记下: () => {},
    办: async (e) => { 办过.push(e.message_id); },
    会话们: () => ['oc_a', 'oc_b'],
  });
  const r = await 补();
  eq(办过, ['om_1'], '真的调了 办()，且只调了这一条');
  eq(r.补了, 1, '返回值报了补了几条');
  真(r.扫了 >= 1, '返回值报了扫了几条（0 或没有=没检查，不是没有）');
}

// —— 建补收：某个会话拉不动不连累别的 ——
{
  const 办过 = [];
  const 补 = 建补收({
    拉: async (chat) => { if (chat === 'oc_挂') throw new Error('网络抖动'); return chat === 'oc_好' ? [造({ chat_id: 'oc_好' })] : []; },
    见过: () => false, 记下: () => {}, 办: async (e) => { 办过.push(e.message_id); },
    会话们: () => ['oc_挂', 'oc_好'],
  });
  const r = await 补();
  eq(办过, ['om_1'], '**一个会话拉不动，别的会话照样补**');
  eq(r.出错, 1, '出错数报出来了');
}

// —— 建补收：会话类型按会话分别传，群聊和私聊别混 ——
// 这就是修 2026-08-24 那次「群里没被 @ 不理」误杀私聊补收 的关键——bot.mjs 靠「在不在群列表里」
// 反推每个会话是群还是私聊，这里验的是那份映射真的传到了每条消息上。
{
  const 办过 = [];
  const 补 = 建补收({
    拉: async (chat) => [造({ chat_id: chat, message_id: `om_${chat}` })],
    见过: () => false, 记下: () => {},
    办: async (e) => { 办过.push({ chat: e.chat_id, 类型: e.chat_type }); },
    会话们: () => ['oc_群', 'oc_私聊'],
    会话类型: (chat) => (chat === 'oc_群' ? 'group' : 'p2p'),
  });
  await 补();
  eq(办过.find((x) => x.chat === 'oc_群')?.类型, 'group', '群会话拿到的事件 chat_type 是 group');
  eq(办过.find((x) => x.chat === 'oc_私聊')?.类型, 'p2p', '**私聊会话拿到的事件 chat_type 是 p2p，不会被误标成 group**');
}

// —— 建补收：不给 会话类型 时全当群聊（和原来的默认行为一致） ——
{
  const 办过 = [];
  const 补 = 建补收({
    拉: async () => [造()], 见过: () => false, 记下: () => {},
    办: async (e) => { 办过.push(e.chat_type); },
    会话们: () => ['oc_a'],
    // 故意不传 会话类型
  });
  await 补();
  eq(办过, ['group'], '不传 会话类型 时默认当群聊（这道闸更保守——错标成群聊顶多多弹一次「没被@」，不会误答）');
}

// —— 建补收：进程起来之前的消息一律不补 ——
// 2026-08-24 真事：重启后补收把重启前 7 分钟答过的一条重新答了一遍（33 秒、没调任何工具、
// 凭上下文复述了上一次的答案）。那条的 id 不在去重表里（表是当天才加的）——
// **靠去重表挡不住这类，靠时刻边界才行**，而且每次重启都可能重犯。
{
  const 办过 = [];
  const 补 = 建补收({
    拉: async () => [
      造({ message_id: 'om_重启前', create_time: String(现在 - 5 * 60000) }),
      造({ message_id: 'om_重启后', create_time: String(现在 + 1000) }),
    ],
    见过: () => false, 记下: () => {},
    办: async (e) => { 办过.push(e.message_id); },
    会话们: () => ['oc_a'],
    不早于: 现在, // 假装进程是「现在」启动的
  });
  await 补();
  eq(办过, ['om_重启后'], '**只补启动之后的**，启动前那条一个字都不碰（哪怕它不在去重表里）');
}
{
  // 不传 不早于 时行为不变（老调用方不该被这个改动影响）
  const 办过 = [];
  const 补 = 建补收({
    拉: async () => [造({ message_id: 'om_老的', create_time: String(现在 - 5 * 60000) })],
    见过: () => false, 记下: () => {},
    办: async (e) => { 办过.push(e.message_id); },
    会话们: () => ['oc_a'],
  });
  await 补();
  eq(办过, ['om_老的'], '不传 不早于 时照旧按回看窗口来（默认 0，不改变原行为）');
}

// —— 建补收：某一条办砸了不连累别的 ——
{
  const 办过 = [];
  const 补 = 建补收({
    拉: async () => [造({ message_id: 'om_坏' }), 造({ message_id: 'om_好' })],
    见过: () => false, 记下: () => {},
    办: async (e) => { if (e.message_id === 'om_坏') throw new Error('处理炸了'); 办过.push(e.message_id); },
    会话们: () => ['oc_a'],
  });
  const r = await 补();
  eq(办过, ['om_好'], '**一条办砸了，另一条照样办**');
  eq(r.补了, 2, '补了数是「派发了几条」不是「成功了几条」——都派发了，只是其中一条办的时候炸了');
}

// —— 建补收：不许叠着跑（同一轮没跑完又起一轮） ——
{
  let 正在跑 = 0, 撞过 = false;
  const 补 = 建补收({
    拉: async () => { 正在跑++; if (正在跑 > 1) 撞过 = true; await new Promise((r) => setTimeout(r, 30)); 正在跑--; return []; },
    见过: () => false, 记下: () => {}, 办: async () => {},
    会话们: () => ['oc_a'],
  });
  const [a, b] = await Promise.all([补(), 补()]);
  真(!撞过, '**两轮真的没有同时在跑**（第二轮该被跳过，不是排队）');
  真(a.跳过 || b.跳过, '其中一轮报了 跳过:true');
}

console.log(`\n检查了 ${n} 条判据，失败 ${挂}`);
process.exit(挂 ? 1 : 0);
