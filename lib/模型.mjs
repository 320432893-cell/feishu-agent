/**
 * 公司 OpenAI 规格模型接口（raw fetch，零依赖）+ **模型 fallback**：
 * 按 models 顺序试，某个挂了/超时/炸了就自动换下一个；全挂才抛。30 秒单次超时，别让一次拖死。
 * 上层给了 signal（bot 的整条 60 秒超时）就跟着一起断——上层不等了，这边也必须真停，别留僵尸请求。
 */
const 取消了 = (外) => 外 && 外.aborted;
/**
 * **首字节闸默认关掉 —— 公司这个 API 根本不流式。**
 *
 * 2026-08-21 实测（直连打 GLM-5.2，`stream:true`）：**响应头和 body 第一个字节同时到，
 * 而那个时刻就是生成完成的时刻**——短答案 726ms、1200 token 的答案 10995ms、3000 token 的 23420ms，
 * 「读完」都只比「首字节」晚几十毫秒。网关是把整段生成缓冲完再吐的。
 *
 * 所以「首字节」在这个 API 上**没有任何信息量**：它不是「模型开始干活了」，而是「模型干完了」。
 * 拿它当死活判据 = 把所有需要 5 秒以上生成的正常回答全部误杀（我 2026-08-21 干过这事，
 * 上线后 bot 会几乎每条都判死 GLM、静默退到备用模型，而日志上只显示「模型=备用」）。
 *
 * 留着这个开关是因为**换个真流式的服务它就有用**（`AGENT_FIRST_BYTE_MS=5000` 打开）。
 * 默认 0 = 关。判死活现在靠：总超时 30 秒 + 熔断（挂过的 5 分钟内不再试）。
 */
const 首字节毫秒 = Number(process.env.AGENT_FIRST_BYTE_MS || 0);
/**
 * 模型一次最多吐多少 token。**2026-08-24 从 3000 抬到 6000。**
 *
 * 3000 撞过两次真事故（本地留存里 `截断=answer` 两条，答案砍在半截发给了人）。
 * 而且**思考 token 算在这个额度里**——2026-08-22 实测过：47 个字的答案烧了 649 token，
 * 其中 622 是思考。所以 3000 的实际可写正文远不到 3000。
 *
 * **为什么不是 8000**：耗时 ≈ 出的 token × 6.4 毫秒（实测两次独立测算 6.5/6.4），
 * 8000 就是 51 秒纯生成。桌面应用里人盯着任务面板等一分钟是常态，
 * 飞书群里静默 51 秒不一样。6000 ≈ 38 秒封顶，且覆盖了目前见过的所有截断（最大 3223）。
 */
const 最大出字 = Number(process.env.AGENT_MAX_TOKENS || 6000);
/** 把「本次 30 秒总超时」和「上层取消」合成一个信号；返回 {signal, ac, 收}，收() 清定时器。 */
function 合信号(外) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000); // 唯一的死活判据（这个 API 不流式，见上面首字节闸那段）
  return { signal: 外 ? AbortSignal.any([ac.signal, 外]) : ac.signal, ac, 收: () => clearTimeout(timer) };
}

async function 单次(base, key, model, messages, tools, 外signal, 额外 = null) {
  const { signal, 收 } = 合信号(外signal);
  let r;
  try {
    r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, messages,
        ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
        max_tokens: 最大出字, temperature: 0.1,
        ...(额外 || {}),
      }),
      signal,
    });
  } catch (e) {
    if (取消了(外signal)) throw new Error('已取消（上层不等了）');
    throw new Error(e.name === 'AbortError' ? `${model} 30 秒没响应` : `${model} 请求失败：${e.message}`);
  } finally { 收(); }
  const t = await r.text();
  let b;
  try { b = JSON.parse(t); } catch { const e = new Error(`${model} 返回非 JSON（${r.status}）：${t.slice(0, 150)}`); e.status = r.status; throw e; }
  if (b.error) throw new Error(`${model} 错误：${JSON.stringify(b.error).slice(0, 150)}`);
  const msg = b.choices?.[0]?.message;
  if (!msg) throw new Error(`${model} 无 choices：${JSON.stringify(b).slice(0, 150)}`);
  msg._finish = b.choices[0].finish_reason || null; // 'length' = 被 max_tokens 砍了，上层必须让人看见
  msg._usage = b.usage || null;
  return msg;
}

/**
 * 流式单次：stream:true 读 SSE，把 content / tool_calls 增量拼回一条完整 message。
 * **注意：公司这个网关是缓冲完再吐的**，所以 onDelta 实际上是在生成结束后一次性连着触发几十次，
 * 卡片上看不到「一个字一个字冒出来」的效果（2026-08-21 实测：1200 token 的答案，第一个字节 10995ms
 * 才到、11040ms 就读完了）。真正给用户的进度反馈来自 onStep（工具调用之间那几次刷卡片）。
 * tool_calls 也是分片来的（按 index 归并 id/name/arguments），拼完当普通 message 返回。
 */
async function 单次流(base, key, model, messages, tools, onDelta, 外signal, 额外 = null) {
  const { signal, ac, 收 } = 合信号(外signal);
  // 首字节闸：默认关（这个 API 不流式，见文件开头那段）。换成真流式的服务时用 AGENT_FIRST_BYTE_MS 打开。
  let 见到字节 = false;
  // 首字节毫秒 = 0 → 不装这道闸（见上面那段：这个 API 不流式，装了就是误杀器）
  const 首闸 = 首字节毫秒 > 0 ? setTimeout(() => { if (!见到字节) ac.abort(); }, 首字节毫秒) : null;
  const 收全部 = () => { if (首闸) clearTimeout(首闸); 收(); };
  /**
   * **哪道闸掐的，就说哪道闸** —— 这里原来把「一个字都没吐出来」一律算成首字节闸，
   * 于是首字节闸关着（`首字节毫秒 = 0`）的时候，日志写的是
   * 「GLM-5.2 **0 秒**没吐出第一个字」。真正掐断它的是上面那个 30 秒总超时，
   * 而那句话把人往一道**根本没装**的闸上引（2026-08-24 我自己就照着它去查了半天首字节闸）。
   */
  const 判死因 = (e) => {
    if (取消了(外signal)) return '已取消（上层不等了）';
    if (e.name !== 'AbortError') return `${model} 请求失败：${e.message}`;
    if (首闸 && !见到字节) return `${model} ${首字节毫秒 / 1000} 秒没吐出第一个字（首字节闸掐的，多半挂了，换下一个）`;
    if (!见到字节) return `${model} 30 秒一个字都没回（总超时掐的；首字节闸没装）`;
    return `${model} 吐到一半卡住（30 秒总超时）`;
  };
  let r;
  try {
    r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}), max_tokens: 最大出字, temperature: 0.1, stream: true, ...(额外 || {}) }),
      signal,
    });
  } catch (e) {
    收全部();
    throw new Error(判死因(e));
  }
  // **status 要挂在错误对象上**，不能只拼进 message —— 上层靠它分「限流/暂时/挂了」，
  // 靠正则认文案的话，改一个字那个分类就悄悄失效了。
  if (!r.ok) { 收全部(); const e = new Error(`${model} HTTP ${r.status}：${(await r.text()).slice(0, 150)}`); e.status = r.status; throw e; }

  let content = ''; const 工具 = []; // 工具[index] = {id,type,function:{name,arguments}}
  // finish_reason 和 usage 这个网关在流式里**本来就发**（最后一块带 finish_reason + 顶层 usage，
  // 2026-08-22 实测，不用加 stream_options.include_usage）。生产走的就是这条路，不读=永远看不见截断。
  let finish = null, usage = null;
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  try {
    for (;;) {
      let 读;
      try { 读 = await reader.read(); } catch (e) { throw new Error(判死因(e)); } // 首字节闸掐断也从这里出来
      const { done, value } = 读; if (done) break;
      if (!见到字节) { 见到字节 = true; if (首闸) clearTimeout(首闸); } // 它活着，把首字节闸撤了，剩下交给总超时
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (d === '[DONE]') continue;
        let j; try { j = JSON.parse(d); } catch { continue; }
        if (j.usage) usage = j.usage;
        if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
        const delta = j.choices?.[0]?.delta; if (!delta) continue;
        if (delta.content) { content += delta.content; if (onDelta) { try { onDelta(content); } catch { /* 回调自己的事 */ } } }
        for (const tc of delta.tool_calls || []) {
          const ix = tc.index ?? 0;
          工具[ix] = 工具[ix] || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) 工具[ix].id = tc.id;
          if (tc.function?.name) 工具[ix].function.name = tc.function.name;
          if (tc.function?.arguments) 工具[ix].function.arguments += tc.function.arguments;
        }
      }
    }
  } finally { 收全部(); }
  const msg = { role: 'assistant', content };
  const tcs = 工具.filter(Boolean);
  if (tcs.length) msg.tool_calls = tcs;
  msg._finish = finish;
  msg._usage = usage;
  return msg;
}

/**
 * **熔断**：刚挂过的模型，一段时间内直接跳过，不再每轮重试。
 *
 * 不熔断的代价实测过（2026-08-21）：公司的 GLM-5.2 整个挂掉（直连打它 60 秒不回），
 * 而 fallback 每一轮都老实地重试它一次、每次白等满 30 秒超时 —— 一条两轮的查询里
 * **63 秒在等一个死模型**，真正干活的工具只花了 11 秒。用户端的表现就是「非常慢」，
 * 而日志里只有一行 `模型=DeepSeek-V4-Flash-0731`，没人会去看。
 *
 * 冷却期结束自动再试一次（半开），所以模型活过来不用重启 bot。
 */
const 冷却到 = new Map(); // model → 时间戳
const 冷却毫秒 = Number(process.env.AGENT_MODEL_COOLDOWN_MS || 300000); // 默认 5 分钟
export function _熔断状态() { return 冷却到; } // 给测试用：唯一的注入点，不然「熔断有没有生效」只能靠看耗时猜
const 熔断中 = (m) => (冷却到.get(m) || 0) > Date.now();

/**
 * **限流的冷却要短得多，而且限流根本不该算「模型挂了」。**
 *
 * 429 说的是「你太快了」，不是「这个模型坏了」。按 5 分钟熔断处置的后果是：
 * 一次限流就把主模型下线 5 分钟，这 5 分钟里每个问题都走慢的备用，而日志上只有
 * 一行「模型=备用」—— 和真挂了长得一模一样，没人分得出来。
 */
const 限流冷却毫秒 = Number(process.env.AGENT_RATELIMIT_COOLDOWN_MS || 30000);
/** 原地重试前等多久。短一点就行：限流通常几百毫秒就过去了，等太久不如直接换。 */
const 重试等待毫秒 = Number(process.env.AGENT_RETRY_WAIT_MS || 800);
const 等一下 = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 错误分三档，处置完全不同：
 *   限流  429 —— 等一下重试**同一个**就好，别熔断（模型是好的）
 *   暂时  5xx / 超时 / 网络抖动 —— 重试同一个一次，还不行才换
 *   挂了  其余（400 参数错、鉴权、返回体形状不对）—— 重试没意义，直接换 + 熔断
 *
 * **靠 `e.status` 判，不靠 message 正则** —— 文案改一个字正则就悄悄失效，而失效的表现是
 * 「限流又开始熔断主模型了」，没有任何地方会报错。
 */
export function 认错误(e) {
  const st = e?.status;
  if (st === 429) return '限流';
  if (typeof st === 'number' && st >= 500) return '暂时';
  if (/没响应|卡住|请求失败|fetch failed|ECONN|ETIMEDOUT|socket/i.test(String(e?.message || ''))) return '暂时';
  return '挂了';
}

/**
 * @param models 模型列表（fallback 顺序）；也兼容单个 model。
 * @param onDelta 给了就走流式（每次 content 增长回调累积文本）；不给走一次性（测试用，不打网靠 mock）。
 * @param signal 上层取消（bot 的整条超时）；一旦取消，当前请求断开且**不再试下一个模型**。
 * @返回 message（带 _model=实际用的模型）
 */
export async function 问模型({ base, key, models, model, messages, tools, onDelta, signal, 额外 = null }) {
  const 列表 = (Array.isArray(models) && models.length) ? models : (model ? [model] : []);
  if (!列表.length) throw new Error('没给模型');
  const 错记 = [];
  const 重试过 = new Set();   // 每个模型这一轮只原地重试一次，别把一次提问拖成无限重试
  // 先排掉熔断中的；全都在熔断里就照原顺序硬试（半开），别因为熔断把自己饿死
  const 能用的 = 列表.filter((m) => !熔断中(m));
  const 这轮试 = 能用的.length ? 能用的 : 列表;
  for (const m of 列表.filter((x) => !这轮试.includes(x))) {
    process.stderr.write(`[熔断] 跳过 ${m}（还在冷却，${Math.round(((冷却到.get(m) || 0) - Date.now()) / 1000)} 秒后再试）\n`);
  }
  for (const m of 这轮试) {
    if (取消了(signal)) throw new Error('已取消（上层不等了）'); // 上层不等了就别再换模型硬试
    try {
      const msg = onDelta ? await 单次流(base, key, m, messages, tools, onDelta, signal, 额外) : await 单次(base, key, m, messages, tools, signal, 额外);
      msg._model = m;
      冷却到.delete(m); // 成功=活过来了，撤销熔断
      return msg;
    } catch (e) {
      if (取消了(signal)) throw new Error('已取消（上层不等了）');
      let 错 = e;
      // **限流/暂时要原地重试同一个，不是换模型。** 换模型解决不了「你太快了」——
      // 下一个多半也被限，而且顺手把一个健康的主模型熔断掉。每个模型这一轮只重试一次。
      const 档 = 认错误(错);
      if ((档 === '限流' || 档 === '暂时') && !重试过.has(m)) {
        重试过.add(m);
        process.stderr.write(`[重试] ${m} ${档}（${String(错.message).slice(0, 60)}），${重试等待毫秒}ms 后原地再试一次\n`);
        await 等一下(重试等待毫秒);
        if (取消了(signal)) throw new Error('已取消（上层不等了）');
        try {
          const msg2 = onDelta ? await 单次流(base, key, m, messages, tools, onDelta, signal, 额外) : await 单次(base, key, m, messages, tools, signal, 额外);
          msg2._model = m;
          冷却到.delete(m);
          return msg2;
        } catch (e2) { 错 = e2; }
      }
      // 限流走短冷却：**别用 5 分钟把一个健康模型下线**，它只是被限速了
      const 这次档 = 认错误(错);
      const 冷 = 这次档 === '限流' ? 限流冷却毫秒 : 冷却毫秒;
      冷却到.set(m, Date.now() + 冷);
      process.stderr.write(`[熔断] ${m} ${这次档}（${String(错.message).slice(0, 80)}），${Math.round(冷 / 1000)} 秒内不再试它\n`);
      错记.push(错.message); /* 换下一个 */
    }
  }
  throw new Error(`所有模型都失败：${错记.join(' | ').slice(0, 300)}`);
}
