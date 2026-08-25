/**
 * 把几张表建成一个**飞书在线电子表格**，一张一个 sheet，回一个链接。
 *
 * 为什么要它：现在给的是文件，人还得下载、打开、想共享还得再传一次。同事本来就在飞书里，
 * 给个链接是一步；给个文件是三步，而且第二个人要看还得重来。
 *
 * **2026-08-23 实测这条链全通，而且不用给应用加任何新权限**（用的就是 bot 发消息那把
 * tenant_access_token）：建表 ✓ / 加第二个 sheet ✓ / 写入 ✓ / 读回来数字还是数字 ✓ /
 * 开组织内链接权限 ✓ / 删除 ✓。
 *
 * 探的时候踩的两个坑，都写在这儿免得再踩：
 * ① **新建的表里没有叫 `Sheet1` 的 sheet** —— sheet id 是生成的（实测 `7dd695`），
 *    拿 'Sheet1' 当 range 前缀会报 `90215 not found sheetId`，而那**不是权限问题**，
 *    第一眼很容易误判成缺 scope。必须先 `sheets/query` 查真实 id。
 * ② lark-cli 成功回 `{ok:true}`、REST 成功回 `{code:0}` —— **两套口径**，
 *    拿一套判另一套会把成功读成失败（我把删成功了的报成了"没删掉"）。这个文件只走 REST，只认 code。
 */
import { 打接口 } from './飞书.mjs';
import { 转数字行 } from './合表.mjs';

/** 0 → A，25 → Z，26 → AA。写 range 要用。 */
export function 列名(n) {
  let s = '';
  for (let x = n; x >= 0; x = Math.floor(x / 26) - 1) s = String.fromCharCode(65 + (x % 26)) + s;
  return s;
}

/**
 * sheet 名：飞书和 Excel 一个规矩 —— 最多 31 字、不能有 []:*?/\、不能重名、不能空。
 * 和 合表.mjs 里那个是同一套判据，但**故意各留一份**：一个管本地 xlsx、一个管在线表格，
 * 合成一处的话，将来其中一边的限制变了会连带改坏另一边。
 */
export function 洗名(名, 已用 = new Set()) {
  let n = String(名 || '').replace(/[[\]:*?/\\]/g, '_').trim().slice(0, 31) || 'Sheet';
  if (!已用.has(n)) { 已用.add(n); return n; }
  for (let i = 2; ; i++) {
    const 带号 = `${n.slice(0, 31 - String(i).length - 1)}~${i}`;
    if (!已用.has(带号)) { 已用.add(带号); return 带号; }
  }
}

/**
 * 一次写不下就分批。**分批数写进日志、不许静默截断** ——
 * 少写了一半的表和写全的表长得一模一样，人拿去用才发现。
 */
const 每批行 = Number(process.env.FEISHU_SHEET_BATCH || 800);
export function 切批(行们, 每批 = 每批行) {
  const 批 = [];
  for (let i = 0; i < 行们.length; i += 每批) 批.push({ 起: i + 1, 行: 行们.slice(i, i + 每批) });
  return 批;
}

/**
 * 建一个多 sheet 的在线表格并写进去。
 * @param 表们 [{名, 行们}]（行们是二维数组，第一行当表头）
 * @param 打 注进来是为了能离线测；默认走真接口
 * @returns { url, token, 每张写了几行, 权限 } 或抛
 */
export async function 建在线表({ 标题, 表们, 打 = 打接口 }) {
  if (!表们?.length) throw new Error('建在线表：一张表都没有');
  const 用过 = new Set();
  const 表 = 表们.map((t) => ({ 名: 洗名(t.名, 用过), 行们: (t.行们 || []).filter((r) => r?.length) }));

  const a = await 打('POST', '/open-apis/sheets/v3/spreadsheets', { title: 标题 });
  if (a?.code !== 0) throw new Error(`建表失败 code=${a?.code} ${a?.msg || ''}`);
  const token = a.data.spreadsheet.spreadsheet_token;
  const url = a.data.spreadsheet.url;

  // 第一个 sheet 是建表时自带的，只能改名不能新建；后面的才 addSheet
  const q = await 打('GET', `/open-apis/sheets/v3/spreadsheets/${token}/sheets/query`);
  const 首id = q?.data?.sheets?.[0]?.sheet_id;
  if (!首id) throw new Error(`查不到第一个 sheet：${JSON.stringify(q).slice(0, 160)}`);

  const sid们 = [首id];
  await 打('POST', `/open-apis/sheets/v2/spreadsheets/${token}/sheets_batch_update`,
    { requests: [{ updateSheet: { properties: { sheetId: 首id, title: 表[0].名 } } }] });
  for (let i = 1; i < 表.length; i++) {
    const r = await 打('POST', `/open-apis/sheets/v2/spreadsheets/${token}/sheets_batch_update`,
      { requests: [{ addSheet: { properties: { title: 表[i].名, index: i } } }] });
    const sid = r?.data?.replies?.[0]?.addSheet?.properties?.sheetId;
    if (!sid) throw new Error(`加第 ${i + 1} 个 sheet 失败：${JSON.stringify(r).slice(0, 160)}`);
    sid们.push(sid);
  }

  const 每张写了几行 = [];
  for (let i = 0; i < 表.length; i++) {
    const 行们 = 表[i].行们;
    const 列数 = Math.max(1, ...行们.map((r) => r.length));
    let 写了 = 0;
    for (const { 起, 行 } of 切批(行们)) {
      // **数量列要以数字身份写进去**。CSV 解出来全是字符串，直接扔过去就是文本 ——
      // 2026-08-23 实测：41243 进去变 "41243"，人在表里选中一列，底下不显示合计，
      // 而这个错不报任何东西。判断和导 xlsx 用的是同一个 `转数字行`，两条路不许有两套口径。
      const w = await 打('PUT', `/open-apis/sheets/v2/spreadsheets/${token}/values`,
        { valueRange: { range: `${sid们[i]}!A${起}:${列名(列数 - 1)}${起 + 行.length - 1}`, values: 行.map(转数字行) } });
      if (w?.code !== 0) throw new Error(`写「${表[i].名}」第 ${起} 行起失败 code=${w?.code} ${w?.msg || ''}`);
      写了 += 行.length;
    }
    每张写了几行.push(写了);
  }

  // 开组织内链接权限。**失败了要说**：不说的话人点开是「无权限」，
  // 而群里那条消息看着像成功了 —— 又一个「坏了但看起来是绿的」。
  const p = await 打('PATCH', `/open-apis/drive/v2/permissions/${token}/public?type=sheet`,
    { link_share_entity: 'tenant_editable' });
  return { url, token, 每张写了几行, 权限: p?.code === 0 ? '组织内可编辑' : `没开成（code=${p?.code} ${p?.msg || ''}）` };
}
