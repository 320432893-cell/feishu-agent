/**
 * **锁住"只准看这张表"**。人指定了表链接/sheet/表头行/要哪几列之后，
 * 模型对这几个读表工具的调用**在派发前**被校一遍：指到别的表就拦下来，不执行。
 *
 * 为什么不写在提示词里：提示词是**嘱咐**，这是**闸**。今天已经验过一次同类的事 ——
 * 「给了工具不等于它会用」，反过来「说了别用不等于它不用」。而跑偏的代价在这儿特别实：
 * 它读了别的 sheet、拿别的表的列去匹配，答案照样成句、数字照样有，**没有任何东西会红**，
 * 人拿去对账才发现对的是另一张表。
 *
 * 同一个道理已经用在写工具上（派发前截住、要人点按钮）。这里是只读版本：不是拦"危险动作"，
 * 是拦"看错地方"。
 */

/** 从飞书链接里抠出文档 token。`/sheets/XXX`、`/wiki/XXX`、`/base/XXX` 都认；抠不出返回 ''。 */
export function 取表token(url) {
  const s = String(url || '');
  const m = s.match(/\/(?:sheets|wiki|base|docx|sheet)\/([A-Za-z0-9]{10,})/);
  if (m) return m[1];
  // 有人直接把 token 贴进来（不带链接）也认
  const 裸 = s.trim();
  return /^[A-Za-z0-9]{15,}$/.test(裸) ? 裸 : '';
}

export const 同一张表 = (a, b) => {
  const x = 取表token(a), y = 取表token(b);
  return !!x && x === y;
};


/** 这几个工具会去读飞书表格 —— 只有它们受范围锁管。 */
export const 表格工具 = new Set(['读飞书表', '读表数据', '读所有表头', '认透视字段', '对齐飞书列', '对账列']);

/**
 * 范围可以是**一张也可以是好几张** —— 对账这类活天生就要两张（两个 sheet 互相比、
 * 或者飞书表对飞书表）。只锁一张的话，闸会把正常的活拦死，那比不锁还糟。
 * 单个对象和数组都收，内部一律当数组处理。
 */
const 归一 = (范围) => (Array.isArray(范围) ? 范围 : (范围 ? [范围] : [])).filter((x) => x?.url);
const 一句 = (x) => `${x.url}${x.sheet名 ? `（sheet：${x.sheet名}）` : ''}`;

/**
 * 校一次工具调用。
 * @param 范围 {url, sheet名?, 表头行?, 列?} 或它们的数组；空=一律放行
 * @returns { 放行: true, 参数 } | { 拦: true, 说明 }
 */
export function 卡范围(工具名, 参数, 范围) {
  const 单们 = 归一(范围);
  if (!单们.length || !表格工具.has(工具名)) return { 放行: true, 参数 };
  const 参 = { ...(参数 || {}) };
  const 清单 = 单们.map((x, i) => `${i + 1}. ${一句(x)}`).join('\n');

  // ① 没给 url。**只有一张时才补；有好几张时不许替它选** ——
  // 替它挑一张，挑错了答案照样成句，而人根本看不出它对的是哪张。
  if (!参.url) {
    if (单们.length === 1) 参.url = 单们[0].url;
    else {
      return { 拦: true, 说明: `人这次指定了 ${单们.length} 张表，你没说读哪一张。**明确带上 url 重调**：\n${清单}` };
    }
  }
  // ② 给了范围外的表：拦。这是「发散到别的表」唯一真正危险的形态。
  const 同表的 = 单们.filter((x) => 同一张表(参.url, x.url));
  if (!同表的.length) {
    return { 拦: true, 说明: `你被限定在人指定的${单们.length > 1 ? `这 ${单们.length} 张表` : '那张表'}里，不许读别的表。\n${清单}\n`
      + `你刚才想读的是范围外的一张（${String(参.url).slice(0, 80)}）——**别换表**，`
      + `要么用指定的继续，要么如实告诉用户"这些表里没有你要的东西"。` };
  }

  // ③ 锁 sheet。同一张表可能被指定了好几个 sheet（两个 sheet 互相对账就是这形态），
  // 所以先按 url 收候选，再按 sheet 名挑出唯一那条。
  const 指了sheet的 = 同表的.filter((x) => x.sheet名);
  let 命中 = 同表的[0];
  if (指了sheet的.length) {
    if (参.sheet序号 !== undefined && 参.sheet名 === undefined) {
      return { 拦: true, 说明: `人指定了 sheet（${指了sheet的.map((x) => x.sheet名).join('、')}），别用序号另挑一张。带 sheet名 重调。` };
    }
    if (参.sheet名 === undefined) {
      if (指了sheet的.length === 1) { 参.sheet名 = 指了sheet的[0].sheet名; 命中 = 指了sheet的[0]; }
      else {
        return { 拦: true, 说明: `这张表人指定了 ${指了sheet的.length} 个 sheet：${指了sheet的.map((x) => x.sheet名).join('、')}。`
          + `**明确带上 sheet名 重调**，别让我替你挑。` };
      }
    } else {
      const 配 = 指了sheet的.find((x) => String(参.sheet名).includes(x.sheet名) || x.sheet名.includes(String(参.sheet名)));
      if (!配) {
        return { 拦: true, 说明: `人指定的 sheet 是「${指了sheet的.map((x) => x.sheet名).join('、')}」，你想读的是「${参.sheet名}」。`
          + '**别换 sheet**，用指定的那个。' };
      }
      命中 = 配;
    }
  }

  // ④ 表头行：人给了就把 range 起点顶到那一行。**这是四个字段里最值钱的一个** ——
  // 一张 sheet 上下叠几块表时，表头不在第 1 行，而模型只看得到前几行样本，基本必猜错。
  // 按**命中的那一条**取，不是取第一条：两个 sheet 的表头行往往不一样。
  if (命中.表头行 > 1 && !参.range) 参.range = `A${命中.表头行}:BZ${命中.表头行 + 400}`;
  // ⑤ 只要那几列：省 token 也少一层看错列的机会
  if (命中.列?.length && !参.列) 参.列 = 命中.列;

  return { 放行: true, 参数: 参 };
}

/**
 * 认「限定表格范围」的口令。**在 bot 层直接认，不进模型** —— 和术语表那几条口令同构。
 *
 * 为什么先做这条而不是等输入框：卡片输入框那条路今天验下来两处都卡（v1 压根不渲染输入框、
 * v2 表单提交报错且事件到不了我这儿），而**发一条消息是百分之百通的**。
 * 而且它天然支持多张 —— 一行一张，对账那种两张表的活直接就能写。
 *
 * 认这几种写法（一行一张表，`|` 或空格分段都行）：
 *   表 <链接> sheet 转固清单 表头 51 列 型号,数量
 *   <链接> sheet=转固清单 表头行=51
 *   只看这张：<链接>
 * 清除：「不限表了」「清除范围」「取消限定」
 *
 * **认不出就返回 null**（当普通问话），绝不半懂不懂地猜一个范围出来 ——
 * 猜错的范围比没有范围坏得多：它会把答案安安静静地对到别的表上。
 */
export function 认范围口令(文) {
  const s = String(文 || '').trim();
  if (!s) return null;
  if (/^(不限表了?|清除范围|取消限定|不限定表了?|范围清空)$/.test(s)) return { 清: true };
  // 要那张带输入框的卡片。**不用记格式** —— 打字那条路留着给会记的人和粘贴党。
  if (/^(限定表|设范围|指定表格?|限定表格?|锁表)$/.test(s)) return { 要卡片: true };

  const 单们 = [];
  const 剩下们 = [];
  for (const 行 of s.split('\n')) {
    const t = 行.trim();
    if (!t) continue;
    const 链 = t.match(/https?:\/\/[^\s|，,]+/);
    if (!链) continue;
    const url = 链[0];
    if (!取表token(url)) continue; // 不是飞书表格链接就跳过（别把随便一个网址当表）
    const 余 = t.replace(url, ' ');
    /**
     * **参数名前面必须是分隔边界**（行首 / 空白 / `|`），不能紧贴在别的字后面。
     *
     * 2026-08-24 实测的既有 bug：`<链接> 帮我把型号列跟内网CMDB对一下，看多少对得上`
     * 里的「型号**列**」被当成了参数名 `列`，解析出 `列: ["跟内网CMDB对一下","看多少对得上"]` ——
     * 于是 `读表数据` 只去读这两个根本不存在的列，**回空、还不报错**。
     * 加边界之后「号」后面那个「列」不再算参数名，而 `列 型号,数量` / `列=型号,数量` 照旧认。
     */
    const 边 = '(?:^|[\\s|])';
    const 拿 = (关键词们) => {
      for (const k of 关键词们) {
        const m = 余.match(new RegExp(`${边}${k}\\s*[:=＝]?\\s*([^\\s|，,、]+)`));
        if (m) return m[1];
      }
      return null;
    };
    const sheet名 = 拿(['sheet名', 'sheet', '工作表', '页签']);
    const 表头 = 拿(['表头行', '表头', '标题行']);
    const 列正则 = new RegExp(`${边}列\\s*[:=＝]?\\s*([^|]+)`);
    const 列串 = (() => {
      const m = 余.match(列正则);
      return m ? m[1].trim() : null;
    })();
    const 一条 = { url };
    if (sheet名) 一条.sheet名 = sheet名;
    const n = Number(表头);
    if (Number.isFinite(n) && n > 0) 一条.表头行 = n;
    if (列串) {
      const 列 = 列串.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
      if (列.length) 一条.列 = 列;
    }
    单们.push(一条);
    /**
     * **把链接和参数都抠掉之后还剩什么。** 剩得多 = 这不是「设范围」，是**带着一张表来问问题**。
     *
     * 2026-08-24 真事：「SP4交换机 10 TD3-10G 交换机 1 … 匹配下交换机 <链接>」——
     * 整句被当成范围口令，设完范围回一张「已限定到这张表」的卡片就 `return` 了，
     * **那句要匹配的话一个字都没进模型**。人看到的是答非所问，然后点「解除」、重发、又被吃掉一次。
     * 调用方拿这个 `剩下` 判：有实质内容就设完范围**接着答**，别把问题吞了。
     */
    // 抠除**必须和上面解析用的是同一套边界**，两处各写各的就会漂：
    // 解析认得出的参数这儿没抠干净 → 纯口令被当成问题；反过来抠多了 → 真问题被当成纯口令。
    剩下们.push(余
      .replace(new RegExp(`${边}(?:sheet名|sheet|工作表|页签)\\s*[:=＝]?\\s*[^\\s|，,、]+`, 'gi'), ' ')
      .replace(new RegExp(`${边}(?:表头行|表头|标题行)\\s*[:=＝]?\\s*[^\\s|，,、]+`, 'g'), ' ')
      .replace(new RegExp(`${边}列\\s*[:=＝]?\\s*[^|]+`, 'g'), ' ')
      .replace(/只看这张表?|只看|就看|这张表?|这个表|下面这张|去找个表|如下/g, ' ')
      .replace(/[\s|，,、:：。.]+/g, ' ')
      .trim());
  }
  return 单们.length ? { 设: 单们, 剩下: 剩下们.join(' ').trim() } : null;
}

/** 表单提交按钮的名字。**路由只能靠它** —— 表单回包里没有 action_value（2026-08-23 实测）。 */
export const 设范围按钮名 = '设范围提交';

/**
 * 「限定表格范围」的表单卡片（飞书卡片 2.0）。
 *
 * 形状是 2026-08-23 一条条试出来的，别照文档改：
 * - **必须 `schema:'2.0'` + `body.elements`**，v1 卡片里的 `input` 压根不渲染
 * - 输入框要**套在 `form` 容器里**，按钮带 `form_action_type:'submit'`
 * - 按钮用 **`value`**，不是 `behaviors` —— 用 behaviors 那版提交直接报错、事件都到不了
 * - 按钮的 `name` 就是路由依据（回包里只有 action_name，没有 value）
 */
export function 范围表单卡(预填 = {}) {
  // **预填**：这张卡多半是从「刚才那条答案」上点出来的，那一轮读的是哪张表我们知道 ——
  // 让人再贴一次链接是白让他干活，而且贴错的概率比不贴还高。
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
          content: '**限定这轮只看哪张表**\n只有「表链接」是必填的，其余留空我自己探。'
            + '\n填了的部分我**不会再自己挑**，也不会去读别的表。' },
        {
          tag: 'form',
          name: '范围表单',
          elements: [
            框('表链接', '表链接（必填）', '把飞书表格链接贴这儿', 预填.url),
            框('sheet', 'sheet 名（留空=我列出来给你挑）', '如：转固清单', 预填.sheet名),
            框('表头行', '表头在第几行（留空=第 1 行）', '如：51', 预填.表头行),
            框('列', '只要哪几列（留空=全部）', '如：型号,数量', 预填.列?.join?.(',') || 预填.列),
            { tag: 'button', text: { tag: 'plain_text', content: '设定' }, type: 'primary',
              form_action_type: 'submit', name: 设范围按钮名 },
          ],
        },
      ],
    },
  };
}

/**
 * 表单交回来的四个字段 → 一条范围。**表链接认不出就返回 null**（不许拿个空 url 建个假范围）。
 * 表单里的空格/全角逗号都当没填，别让「  」变成一个叫空格的 sheet。
 */
export function 表单转范围(字段) {
  const 净 = (v) => String(v ?? '').trim();
  const url = 净(字段?.表链接 || 字段?.url);
  if (!取表token(url)) return null;
  const 一条 = { url };
  const sheet名 = 净(字段?.sheet || 字段?.sheet名);
  if (sheet名) 一条.sheet名 = sheet名;
  const n = Number(净(字段?.表头行));
  if (Number.isFinite(n) && n > 1) 一条.表头行 = n;
  const 列 = 净(字段?.列).split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
  if (列.length) 一条.列 = 列;
  return 一条;
}

/** 人看的回执：把认出来的范围复述一遍。**必须复述** —— 认岔了要让人当场看见，而不是等答案错了才发现。 */
export function 范围回执(单们) {
  const 行 = 归一(单们).map((x, i) => {
    const 片 = [`${i + 1}. ${x.url}`];
    片.push(x.sheet名 ? `sheet：${x.sheet名}` : 'sheet：**没指定**（我会先列出所有 sheet 让你挑）');
    片.push(x.表头行 > 1 ? `表头第 ${x.表头行} 行` : '表头：默认第 1 行');
    if (x.列?.length) 片.push(`只要列：${x.列.join('、')}`);
    return 片.join('　｜　');
  }).join('\n');
  return `好，这轮只看这 ${归一(单们).length} 张：\n${行}\n\n`
    + '**我读别的表会被自己挡下来。** 换回不限：说一句「不限表了」。';
}

/** 拼给模型看的一段。**结构上已经挡住了，这段只是让它别白费一轮去试。** */
export function 范围段(范围) {
  const 单们 = 归一(范围);
  if (!单们.length) return '';
  const 行 = 单们.map((x, i) => {
    const 片 = [`${单们.length > 1 ? `${i + 1}. ` : ''}${x.url}`];
    if (x.sheet名) 片.push(`sheet「${x.sheet名}」`);
    if (x.表头行 > 1) 片.push(`表头在第 ${x.表头行} 行（不是第 1 行，别从头读）`);
    if (x.列?.length) 片.push(`只要这几列：${x.列.join('、')}`);
    return 片.join('；');
  }).join('\n');
  return `**这次只准看${单们.length > 1 ? `下面这 ${单们.length} 张表/sheet` : '这一张表'}**：\n${行}\n`
    + `**别去读别的表、别换 sheet**——读别的会被直接拦下来。${单们.length > 1 ? '每次调用都要明确带上是哪一张。' : ''}`
    + '这些表里没有的东西，如实说没有。\n'
    /**
     * **这一句管的是「别的数据源」，不是「别的表」。**
     *
     * 上面那两句只说了别读别的表，而结构上的 `卡范围` 也只拦得住 6 个读表工具 ——
     * 拦不住 `透视`/`查资产`。2026-08-25 实测：人把一张多维表格给它、问「这张表里的
     * 交换机够不够」，它**看都没看那张表**，直接 `验令牌 → 透视 ×3` 去查内网CMDB，
     * 内网CMDB正好断着，交了一句「连不上内网CMDB」白卷 —— 而答案就在手上那张表里。
     *
     * 不能一刀切禁掉内网CMDB/台账：对账那类活本来就要两边都查。所以给判据不给禁令。
     */
    + '**答案先从这几张表里找。** 要不要再去查内网CMDB/库存台账，看人问的是什么：'
    + '问「这张表里有多少 / 这张表里够不够」→ **只看表**，表就是答案；'
    + '问「这张表和内网CMDB对得上吗 / 表里这批在库存里还有没有」→ 才两边都查。'
    + '**别默认往外查** —— 表已经在你手上了，跑去查别的数据源多半是答错了地方。\n';
}
