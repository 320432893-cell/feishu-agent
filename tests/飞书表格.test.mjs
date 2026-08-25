/**
 * 建在线表格测试。**注一个假的「打接口」进去，一个包都不发。**
 * 守的三件事：
 *  ① 第一个 sheet 只能改名、后面的才 addSheet（建表自带一个，再 addSheet 会多出一张空的）
 *  ② **range 用查回来的真 sheet_id，不是 'Sheet1'** —— 实测拿 'Sheet1' 会报 90215，
 *     而那第一眼像缺权限，会把人引到完全错的方向去
 *  ③ 分批写不许静默少写；任何一步失败要抛，不许回一个"看着像成功"的链接
 */
import { 列名, 洗名, 切批, 建在线表 } from '../lib/飞书表格.mjs';

let 挂 = 0, n = 0;
const eq = (得, 期, 说) => { n++; if (JSON.stringify(得) !== JSON.stringify(期)) { 挂++; console.log(`✗ ${说}｜得 ${JSON.stringify(得)} 期 ${JSON.stringify(期)}`); } else console.log(`✓ ${说}`); };
const 真 = (得, 说) => eq(!!得, true, 说);

eq([列名(0), 列名(25), 列名(26), 列名(51)], ['A', 'Z', 'AA', 'AZ'], '列名：A/Z/AA/AZ');
eq(洗名('a/b:c'), 'a_b_c', '洗名：非法字符换掉');
{
  const 用 = new Set();
  eq([洗名('明细', 用), 洗名('明细', 用)], ['明细', '明细~2'], '洗名：重名错开');
}
eq(切批([1, 2, 3, 4, 5], 2).map((b) => [b.起, b.行.length]), [[1, 2], [3, 2], [5, 1]],
  '切批：起始行号是**1 基**的（飞书 range 从 1 开始，0 基会整体错一行）');

// —— 造一个假接口，把每一步都记下来 ——
function 假打(改 = {}) {
  const 记 = [];
  const f = async (method, path, body) => {
    记.push({ method, path, body });
    if (改[path]) return 改[path];
    if (path === '/open-apis/sheets/v3/spreadsheets') {
      return { code: 0, data: { spreadsheet: { spreadsheet_token: 'TOK1', url: 'https://x.feishu.cn/sheets/TOK1' } } };
    }
    if (path.endsWith('/sheets/query')) return { code: 0, data: { sheets: [{ sheet_id: '7dd695' }] } };
    if (path.endsWith('/sheets_batch_update')) {
      const req = body.requests[0];
      if (req.addSheet) return { code: 0, data: { replies: [{ addSheet: { properties: { sheetId: `新${req.addSheet.properties.index}` } } }] } };
      return { code: 0, data: {} };
    }
    if (path.endsWith('/values')) return { code: 0, data: { updatedCells: 1 } };
    if (path.includes('/permissions/')) return { code: 0, data: {} };
    return { code: 0, data: {} };
  };
  f.记 = 记;
  return f;
}

{
  const 打 = 假打();
  const r = await 建在线表({ 标题: '库存明细', 打, 表们: [
    { 名: '光模块-闵行', 行们: [['型号', '在库'], ['QSFP112', '41243']] },
    { 名: '全部', 行们: [['型号', '在库'], ['CX6', '4235'], ['D7', '14450']] },
  ] });
  eq(r.url, 'https://x.feishu.cn/sheets/TOK1', '建表：把链接带回来');
  eq(r.每张写了几行, [2, 3], '建表：**每张写了几行报出来** —— 0 或偏小=没写进去，不是没数据');
  eq(r.权限, '组织内可编辑', '建表：链接权限开了');

  const 改名 = 打.记.filter((x) => x.body?.requests?.[0]?.updateSheet);
  const 加 = 打.记.filter((x) => x.body?.requests?.[0]?.addSheet);
  eq(改名.length, 1, '建表：第一个 sheet **只改名一次**（建表自带一个）');
  eq(改名[0].body.requests[0].updateSheet.properties.title, '光模块-闵行', '建表：改成第一张表的名字');
  eq(加.length, 1, '建表：**只 addSheet 一次**（两张表 = 自带 1 + 新加 1，加两次会多一张空的）');

  const 写 = 打.记.filter((x) => x.path.endsWith('/values'));
  eq(写.length, 2, '建表：两张各写一次');
  真(写[0].body.valueRange.range.startsWith('7dd695!'),
    `写入：**range 用查回来的真 sheet_id**（现在是 ${写[0].body.valueRange.range}）—— 用 'Sheet1' 会报 90215，而那第一眼像缺权限`);
  真(写[1].body.valueRange.range.startsWith('新1!'), '写入：第二张用 addSheet 回的那个 id');
  eq(写[0].body.valueRange.range, '7dd695!A1:B2', '写入：range 的末列末行按真实行列算');
}

// —— 数量要以数字身份写进去，判断和导 xlsx 共用一套 ——
// 2026-08-23 真接口跑出来的：CSV 解出来全是字符串，直接扔过去就是文本，
// 41243 进去变 "41243"，人在表里选中一列底下不显示合计 —— 而这个错不报任何东西。
{
  const 打 = 假打();
  await 建在线表({ 标题: 't', 打, 表们: [{ 名: 'a', 行们: [
    ['型号', '库房', '在库', '订单号'],
    ['QSFP112-400G', '闵行', '41243', '007'],
  ] }] });
  const 值 = 打.记.find((x) => x.path.endsWith('/values')).body.valueRange.values;
  eq(值[1][2], 41243, '写入：**「在库」以数字身份写进去**（不是 "41243" 字符串）');
  eq(值[0][2], '在库', '写入：表头还是文本');
  eq(值[1][0], 'QSFP112-400G', '写入：型号还是文本');
  eq(值[1][3], '007', '写入：**前导零的编号不转数字**（订单号 007 转成 7 就是脏数据）');
}

// —— 分批：不许少写 ——
{
  const 打 = 假打();
  const 行们 = Array.from({ length: 5 }, (_, i) => [`型号${i}`, String(i)]);
  const r = await 建在线表({ 标题: 't', 打, 表们: [{ 名: 'a', 行们 }], });
  eq(r.每张写了几行, [5], '分批：默认每批 800，5 行一次写完');
  const 写 = 打.记.filter((x) => x.path.endsWith('/values'));
  eq(写.length, 1, '分批：没超一批就只发一次');
}

// —— 任何一步失败都要抛，不许回一个"看着像成功"的链接 ——
for (const [坏在哪, 假回] of [
  ['建表', { '/open-apis/sheets/v3/spreadsheets': { code: 1254005, msg: 'no permission' } }],
  ['查sheet', { '/open-apis/sheets/v3/spreadsheets/TOK1/sheets/query': { code: 0, data: { sheets: [] } } }],
  ['写入', { '/open-apis/sheets/v2/spreadsheets/TOK1/values': { code: 90215, msg: 'not found sheetId' } }],
]) {
  let 抛了 = null;
  try {
    await 建在线表({ 标题: 't', 打: 假打(假回), 表们: [{ 名: 'a', 行们: [['x']] }] });
  } catch (e) { 抛了 = e.message; }
  真(抛了, `失败要抛：${坏在哪} 挂了就抛（现在是「${String(抛了).slice(0, 60)}」）`);
}

// —— 权限没开成不许假装开了 ——
{
  const r = await 建在线表({ 标题: 't', 表们: [{ 名: 'a', 行们: [['x']] }],
    打: 假打({ '/open-apis/drive/v2/permissions/TOK1/public?type=sheet': { code: 1254006, msg: 'forbidden' } }) });
  真(r.权限.includes('没开成'), `权限：**没开成要明说**（现在是「${r.权限}」）—— 不说的话人点开是「无权限」，而群里那条看着像成功了`);
  真(r.url, '权限：没开成也照样把链接给出去（能不能看让人自己试）');
}

{
  let 抛了 = false;
  try { await 建在线表({ 标题: 't', 表们: [] }); } catch { 抛了 = true; }
  真(抛了, '空输入：一张表都没有时明着抛，不建一个空表出来');
}

console.log(`\n检查了 ${n} 条判据，失败 ${挂}`);
process.exit(挂 ? 1 : 0);
