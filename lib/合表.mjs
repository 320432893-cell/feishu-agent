/**
 * 把一轮里导出的**好几个 CSV 合成一个 xlsx、一个文件一个 sheet**。
 *
 * 为什么要它：问「闵行的光模块和网卡各多少」会跑两次 `查库存`，各导一个 CSV。
 * 群里收到两个文件，人要下两次、开两次、自己对照 —— 而它们本来就是一件事的两半。
 *
 * **零依赖手写 xlsx**：xlsx 就是一个 zip 装着几个 XML。Node 自带 zlib，剩下的是拼字符串。
 * 引一个 SheetJS 进来要给这个「运行时零依赖」的仓库开个口子，而这里要的功能只占那个库的 2%。
 *
 * **数字写成数字、不写成文本**：在库那一列人要在 Excel 里求和的，写成文本的话选中一列底下不显示合计，
 * 而这种错不报任何东西 —— 人只会觉得"这表怪怪的"。
 */
import { deflateRawSync } from 'node:zlib';

// —— CSV 解析：带引号的字段、字段里的逗号和换行、BOM、CRLF 都要吃得下 ——
// 导出的 CSV 是带 BOM 的（Excel 认中文要它），不去掉的话第一列列名会变成「﻿物料键」。
export function 解CSV(文本) {
  const s = String(文本 || '').replace(/^﻿/, '');
  const 行们 = []; let 行 = []; let 格 = ''; let 引号里 = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (引号里) {
      if (c === '"') {
        if (s[i + 1] === '"') { 格 += '"'; i++; } else 引号里 = false;
      } else 格 += c;
      continue;
    }
    if (c === '"') { 引号里 = true; continue; }
    if (c === ',') { 行.push(格); 格 = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { 行.push(格); 格 = ''; 行们.push(行); 行 = []; continue; }
    格 += c;
  }
  if (格 !== '' || 行.length) { 行.push(格); 行们.push(行); }
  return 行们.filter((r) => r.some((x) => String(x).trim() !== '')); // 末尾空行不算
}

/**
 * sheet 名字：Excel 的硬规矩 —— 最多 31 个字符，不能有 []:*?/\，不能重名，不能为空。
 * 违反了 Excel 直接报「文件已损坏」，而我们这边一点征兆都没有。
 */
export function 洗sheet名(名, 已用 = new Set()) {
  let n = String(名 || '').replace(/[[\]:*?/\\]/g, '_').trim().slice(0, 31) || 'Sheet';
  if (!已用.has(n)) { 已用.add(n); return n; }
  for (let i = 2; ; i++) {
    const 带号 = `${n.slice(0, 31 - String(i).length - 1)}~${i}`;
    if (!已用.has(带号)) { 已用.add(带号); return 带号; }
  }
}

const 转义 = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const 列名 = (n) => { // 0 → A, 25 → Z, 26 → AA
  let s = '';
  for (let x = n; x >= 0; x = Math.floor(x / 26) - 1) s = String.fromCharCode(65 + (x % 26)) + s;
  return s;
};
// 什么算数字：整数/小数/带千分位。**不含前导零的编号**（订单号 007 写成数字会掉零，那是脏数据）
// 两种写法都要认：纯数字串（47823）和带千分位的（47,823）。
// 第一版只写了 `\d{1,3}(,\d{3})*`，结果 47823 这种 5 位纯数字被当成文本 ——
// **我自己的单测查不出来**（它只看 zip 里有没有那几个部件），是 openpyxl 读回来才发现的。
const 是数字 = (v) => {
  const s = String(v).trim();
  return /^-?(\d+|\d{1,3}(,\d{3})+)(\.\d+)?$/.test(s) && !/^-?0\d/.test(s);
};

/**
 * 一行字符串 → 该是数字的转成数字。**导出到 xlsx 和导出到飞书表格必须用同一个判断** ——
 * 各写一套的话，同一份数据导出去两个样，而且没人会发现（两边都"能打开"）。
 * 2026-08-23 实测踩过：飞书那条路忘了转，41243 进去是文本，人在表里选一列底下不显示合计。
 */
export const 转数字行 = (行) => 行.map((v) => (是数字(v) ? Number(String(v).replace(/,/g, '')) : v));

function 造sheetXML(行们) {
  const 行XML = 行们.map((行, ri) => {
    const 格XML = 行.map((值, ci) => {
      const 坐标 = `${列名(ci)}${ri + 1}`;
      const v = String(值 ?? '');
      if (v === '') return '';
      if (是数字(v)) return `<c r="${坐标}"><v>${v.replace(/,/g, '')}</v></c>`;
      return `<c r="${坐标}" t="inlineStr"><is><t xml:space="preserve">${转义(v)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${格XML}</row>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<sheetData>${行XML}</sheetData></worksheet>`;
}

// —— 最小 zip 写入器（xlsx = zip + 几个 XML）——
const crc表 = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crc表[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function 打zip(项们) {
  const 本地 = []; const 目录 = []; let 偏移 = 0;
  for (const { 名, 内容 } of 项们) {
    const 名B = Buffer.from(名, 'utf8');
    const 原 = Buffer.from(内容, 'utf8');
    const 压 = deflateRawSync(原);
    const c = crc32(原);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6);
    h.writeUInt16LE(8, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(0, 12); // 时间戳写 0：**故意的**，
    // 同样的输入要打出同样的字节，不然「跑两遍状态一样」那条测试没法验。
    h.writeUInt32LE(c, 14); h.writeUInt32LE(压.length, 18); h.writeUInt32LE(原.length, 22);
    h.writeUInt16LE(名B.length, 26); h.writeUInt16LE(0, 28);
    本地.push(h, 名B, 压);
    const d = Buffer.alloc(46);
    d.writeUInt32LE(0x02014b50, 0); d.writeUInt16LE(20, 4); d.writeUInt16LE(20, 6);
    d.writeUInt16LE(0, 8); d.writeUInt16LE(8, 10); d.writeUInt16LE(0, 12); d.writeUInt16LE(0, 14);
    d.writeUInt32LE(c, 16); d.writeUInt32LE(压.length, 20); d.writeUInt32LE(原.length, 24);
    d.writeUInt16LE(名B.length, 28); d.writeUInt16LE(0, 30); d.writeUInt16LE(0, 32);
    d.writeUInt16LE(0, 34); d.writeUInt16LE(0, 36); d.writeUInt32LE(0, 38);
    d.writeUInt32LE(偏移, 42);
    目录.push(d, 名B);
    偏移 += h.length + 名B.length + 压.length;
  }
  const 目录B = Buffer.concat(目录);
  const 尾 = Buffer.alloc(22);
  尾.writeUInt32LE(0x06054b50, 0); 尾.writeUInt16LE(0, 4); 尾.writeUInt16LE(0, 6);
  尾.writeUInt16LE(项们.length, 8); 尾.writeUInt16LE(项们.length, 10);
  尾.writeUInt32LE(目录B.length, 12); 尾.writeUInt32LE(偏移, 16); 尾.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(本地), 目录B, 尾]);
}

/**
 * 造一个 xlsx。
 * @param 表们 [{名, 行们: 二维数组}]
 * @returns Buffer
 */
export function 造xlsx(表们) {
  if (!表们?.length) throw new Error('造xlsx：一张表都没有');
  const 用过 = new Set();
  const 表 = 表们.map((t) => ({ 名: 洗sheet名(t.名, 用过), 行们: t.行们 || [] }));
  const 项 = [
    { 名: '[Content_Types].xml',
      内容: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + 表.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
        + '</Types>' },
    { 名: '_rels/.rels',
      内容: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>' },
    { 名: 'xl/workbook.xml',
      内容: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
        + 表.map((t, i) => `<sheet name="${转义(t.名)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
        + '</sheets></workbook>' },
    { 名: 'xl/_rels/workbook.xml.rels',
      内容: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + 表.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
        + '</Relationships>' },
    ...表.map((t, i) => ({ 名: `xl/worksheets/sheet${i + 1}.xml`, 内容: 造sheetXML(t.行们) })),
  ];
  return 打zip(项);
}

/**
 * 一堆 CSV 路径 → 一个 xlsx Buffer。sheet 名取文件名里最有信息的那段。
 * @param 读文件 注进来是为了能离线测（不碰真磁盘）
 */
export function 合CSV(路径们, 读文件) {
  const 表们 = [];
  for (const 路 of 路径们) {
    let 文本; try { 文本 = 读文件(路); } catch { continue; } // 读不到就跳过这一张，别让整个合并失败
    const 行们 = 解CSV(文本);
    if (!行们.length) continue;
    // 文件名形如 明细-光模块-闵行-20260822233447.csv → sheet 名取「光模块-闵行」（去掉「明细-」和时间戳）
    const 基 = String(路).split('/').pop().replace(/\.csv$/i, '');
    const 名 = 基.replace(/^(明细|分布)-/, '').replace(/-\d{8,}$/, '') || 基;
    表们.push({ 名, 行们 });
  }
  return 表们.length ? { buf: 造xlsx(表们), 表数: 表们.length, 行数: 表们.map((t) => t.行们.length - 1) } : null;
}
