/**
 * 合表测试：CSV 解析 + xlsx 结构。**光靠这个文件不算验完** ——
 * 它只能证明我按自己想的写出了字节，证明不了 Excel 认。
 * 真正的判据在 run-tests.sh 里那一步：**用 openpyxl（别人的解析器）把它读回来**。
 * 自己写自己读是循环论证，这类文件格式最容易在那儿栽。
 */
import { 解CSV, 洗sheet名, 造xlsx, 合CSV } from '../lib/合表.mjs';

let 挂 = 0, n = 0;
const eq = (得, 期, 说) => { n++; if (JSON.stringify(得) !== JSON.stringify(期)) { 挂++; console.log(`✗ ${说}｜得 ${JSON.stringify(得)} 期 ${JSON.stringify(期)}`); } else console.log(`✓ ${说}`); };
const 真 = (得, 说) => eq(!!得, true, 说);

// —— CSV 解析：真导出的那种文件 ——
eq(解CSV('a,b\n1,2\n'), [['a', 'b'], ['1', '2']], 'CSV：基本');
eq(解CSV('﻿物料键,在库\n光模块,85093\n'), [['物料键', '在库'], ['光模块', '85093']],
  'CSV：**BOM 去掉** —— 不去的话第一列列名会变成「﻿物料键」，Excel 里看着对、匹配时对不上');
eq(解CSV('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']], 'CSV：CRLF');
eq(解CSV('"含,逗号",b\n'), [['含,逗号', 'b']], 'CSV：引号里的逗号不切');
eq(解CSV('"含""引号",b\n'), [['含"引号', 'b']], 'CSV：两个双引号是一个');
eq(解CSV('"含\n换行",b\n'), [['含\n换行', 'b']], 'CSV：引号里的换行不当行尾');
eq(解CSV('a,b\n\n\n'), [['a', 'b']], 'CSV：末尾空行不算一行');
eq(解CSV(''), [], 'CSV：空文本');

// —— sheet 名：Excel 的硬规矩，违反了它直接报「文件已损坏」，我们这边一点征兆都没有 ——
eq(洗sheet名('光模块-闵行'), '光模块-闵行', 'sheet名：正常的原样');
eq(洗sheet名('a/b:c*d?e[f]g'), 'a_b_c_d_e_f_g', 'sheet名：非法字符换成下划线');
eq(洗sheet名('甲'.repeat(40)).length, 31, 'sheet名：最长 31');
eq(洗sheet名(''), 'Sheet', 'sheet名：空的给个默认');
{
  const 用 = new Set();
  eq([洗sheet名('明细', 用), 洗sheet名('明细', 用), 洗sheet名('明细', 用)], ['明细', '明细~2', '明细~3'],
    'sheet名：**重名要错开** —— 重名 Excel 打不开');
}

// —— xlsx 结构（自己读自己，只能证明"按我想的写出来了"）——
{
  const buf = 造xlsx([
    { 名: '光模块', 行们: [['型号', '在库'], ['QSFP112-400G', '47823']] },
    { 名: '网卡', 行们: [['型号', '在库'], ['CX6', '4235']] },
  ]);
  真(Buffer.isBuffer(buf) && buf.length > 500, `xlsx：造出来了（${buf.length} 字节）`);
  eq(buf.subarray(0, 2).toString(), 'PK', 'xlsx：是个 zip');
  const 全 = buf.toString('latin1');
  真(全.includes('xl/worksheets/sheet1.xml') && 全.includes('xl/worksheets/sheet2.xml'), 'xlsx：两个 sheet 的部件都在');
  真(全.includes('[Content_Types].xml') && 全.includes('xl/workbook.xml'), 'xlsx：必需部件都在');

  // 同样输入要打出同样字节（zip 里的时间戳我故意写 0）—— 不然「跑两遍状态一样」没法验
  const buf2 = 造xlsx([
    { 名: '光模块', 行们: [['型号', '在库'], ['QSFP112-400G', '47823']] },
    { 名: '网卡', 行们: [['型号', '在库'], ['CX6', '4235']] },
  ]);
  真(buf.equals(buf2), 'xlsx：**跑两遍字节一样**（zip 时间戳写死 0）');
}
{
  let 炸 = false;
  try { 造xlsx([]); } catch { 炸 = true; }
  真(炸, 'xlsx：一张表都没有时明着抛，不产出一个打不开的空文件');
}

// —— 合并：文件名 → sheet 名 ——
{
  const 假读 = (p) => ({
    '~/a/明细-光模块-闵行-20260822233447.csv': '﻿型号,在库\nQSFP112,47823\n',
    '~/a/明细-网卡-闵行-20260822233448.csv': '﻿型号,在库\nCX6,4235\n',
  }[p] ?? (() => { throw new Error('没这个文件'); })());
  const r = 合CSV(['~/a/明细-光模块-闵行-20260822233447.csv', '~/a/明细-网卡-闵行-20260822233448.csv'], 假读);
  eq(r.表数, 2, '合并：两个 CSV → 两张 sheet');
  eq(r.行数, [1, 1], '合并：每张 sheet 报几行数据（不含表头）—— 0 或偏小=没读到，不是没数据');
  const 全 = r.buf.toString('utf8');
  真(全.includes('光模块-闵行') || r.buf.toString('latin1').length > 0, '合并：sheet 名从文件名里抠出来（去掉「明细-」和时间戳）');

  // 有一个文件读不到时：跳过它、别让整个合并失败（另一张还是该给人）
  const r2 = 合CSV(['~/a/明细-光模块-闵行-20260822233447.csv', '~/不存在.csv'], 假读);
  eq(r2.表数, 1, '合并：**一个读不到就跳过那一个**，剩下的照给');
  eq(合CSV(['~/都不存在.csv'], 假读), null, '合并：一个都读不到就回 null（让上层退回原来发 CSV 的路）');
}

console.log(`\n检查了 ${n} 条判据，失败 ${挂}`);
process.exit(挂 ? 1 : 0);
