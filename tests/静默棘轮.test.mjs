/**
 * 「失效时是绿的」棘轮 —— **数量只许降、不许涨**。
 *
 * 为什么要它：2026-08-24 这一天里，同一类错被一个一个撞见了五次
 * （回包截断无痕 / 参数名正则没锚 / 干等 2 秒读旧快照 / 只认一种表格 / workbook-info 读失败当空表）。
 * 每次都是「用起来才发现」，而不是「跑一下就红」。手工找一遍不解决问题 —— 明天还会加新的。
 * 所以把判据固化成一个数：现在有多少处可疑写法，以后**加一处就红**。
 *
 * 扫的四类都是「错了不报错」的形态：
 *   ① 截数据没报总数 —— 人以为拿到的是全部
 *   ② 吞异常        —— catch 体里什么都不做
 *   ③ 把不知道当成 0 —— 「读不到」和「真的是 0」被抹平，还进了求和
 *   ④ 出错后回正常值 —— 空数组/空串，看着像「没有」
 *
 * **这不是「零容忍」**：基线里那些绝大多数是良性的（mkdir 失败、删缓存失败、解析日志文本）。
 * 棘轮管的是**增量**：新写一处就得说清为什么，或者把基线数改小并写明改了什么。
 *
 * 局限说清楚：**今天真正咬人的那几个，这个扫描器一个都抓不到** ——
 * 正则没锚、盲等 2 秒、只认一种表类型，都不是语法形态，是语义。
 * 这个棘轮挡的是「又新加一处已知形态」，挡不住「又发明一种新形态」。后者只能靠评测台和真人用。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const 这儿 = dirname(fileURLToPath(import.meta.url));
// 这三个仓库在开发机上是同级目录。公开版只含其中一个，另两个找不到 ——
// **那种情况下不许降低下限装作通过**，见文件末尾：缺仓库时明说跳过，不并进绿。
const 仓库候选 = [
  join(这儿, '..'),
  join(这儿, '..', '..', 'cmdb-mcp'),
  join(这儿, '..', '..', 'inventory-mcp'),
];
const 仓库 = 仓库候选.filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
const 仓库齐 = 仓库.length === 仓库候选.length;

let 挂 = 0, n = 0;
const 真 = (ok, 说, 详) => { n++; if (ok) console.log(`✓ ${说}`); else { 挂++; console.log(`✗ ${说}${详 ? `\n    ${详}` : ''}`); } };

function 收文件(根) {
  const 出 = [];
  const 走 = (d, 深) => {
    if (深 > 2) return;
    let 项; try { 项 = readdirSync(d); } catch { return; }
    for (const f of 项) {
      if (['node_modules', 'dist', '.git', 'tests', 'eval', 'probes', '.cache'].includes(f)) continue;
      const p = join(d, f);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) 走(p, 深 + 1);
      else if (f.endsWith('.mjs')) 出.push(p);
    }
  };
  走(根, 0);
  return 出;
}

// 这一行是在拼给人/日志看的字符串吗 —— 那种截断不算静默
const 是给人看的 = (l) => /process\.stderr|console\.|throw new Error|`\[/.test(l)
  || /String\([^)]*\)\.slice|JSON\.stringify\([\s\S]*?\)\.slice|\.message\)?\.slice|\.stack\)?\.slice/.test(l);

const 类别 = {
  截数据没报总数: {
    命中: (l) => /(^|[{,(]\s*)[\w一-龥]+:\s*[^,;]*\.slice\(\s*0\s*,|return\s+[^;]*\.slice\(\s*0\s*,/.test(l) && !是给人看的(l),
    放行: (l, 邻) => /总|共|几条|截断|超过|还有更多|剩下|返回行数|返回条数|上限|命中|全部|多少|total|hasMore/.test(l + 邻),
  },
  吞异常: {
    命中: (l) => /catch\s*(\([^)]*\))?\s*\{\s*(\/\*[^*]*\*\/\s*)?\}/.test(l)
      || /\.catch\(\s*\(\s*[^)]*\)\s*=>\s*\{\s*(\/\*[^*]*\*\/\s*)?\}\s*\)/.test(l),
    放行: () => false,
  },
  把不知道当成0: {
    命中: (l) => /(\?\?|\|\|)\s*0\b/.test(l) && !是给人看的(l) && /reduce|\+=|sum|合计|总|计数|count/.test(l),
    放行: (l, 邻) => /不知道|不是 ?0|读不到|缺|未知|null 表示|默认|下标|index|序号|i \+|长度|length/.test(l + 邻),
  },
  出错后回正常值: {
    命中: (l) => /catch\s*(\([^)]*\))?\s*\{\s*(return\s+(\[\]|''|""|null|\{\}|0\b)|[\w一-龥]+\s*=\s*(\[\]|''|""|null|0\b))/.test(l),
    放行: (l) => /process\.stderr|console\./.test(l),
  },
};

/** 2026-08-24 冻的基线。**改这几个数必须同时说清改了哪一处、为什么。** */
const 基线 = { 截数据没报总数: 13, 吞异常: 52, 把不知道当成0: 11, 出错后回正常值: 26 };

const 数 = Object.fromEntries(Object.keys(类别).map((k) => [k, 0]));
const 明细 = Object.fromEntries(Object.keys(类别).map((k) => [k, []]));
let 文件数 = 0, 行数 = 0;

for (const 根 of 仓库) {
  for (const p of 收文件(根)) {
    文件数++;
    const 行们 = readFileSync(p, 'utf8').split('\n');
    行数 += 行们.length;
    行们.forEach((l, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;
      const 邻 = [行们[i - 2], 行们[i - 1], 行们[i + 1], 行们[i + 2], 行们[i + 3]].filter(Boolean).join(' ');
      for (const [名, 规] of Object.entries(类别)) {
        if (!规.命中(l) || 规.放行(l, 邻)) continue;
        数[名]++;
        明细[名].push(`${p.replace(/^.*company\//, '')}:${i + 1}`);
      }
    });
  }
}

// **扫到的量要报出来**：文件数是 0 或明显偏小 = 没检查，不是没问题
console.log(`扫了 ${文件数} 个文件、${行数.toLocaleString('en-US')} 行，来自 ${仓库.length}/${仓库候选.length} 个仓库（不含 tests/eval/probes/dist）`);
if (仓库齐) {
  真(文件数 >= 60, `扫到的文件数看着对（${文件数} 个）—— 明显偏小说明路径不对，那时候「全绿」是假的`);
  真(行数 >= 10000, `扫到的行数看着对（${行数.toLocaleString('en-US')} 行）`);
} else {
  // **跳过和通过分开印**：只找到一个仓库时，跨仓库规模判据本来就不成立，
  // 但不能因此当它通过 —— 明说跳过，并且仍然验本仓库自己真的扫到了东西。
  console.log(`⏭ 跳过跨仓库规模判据：同级只找到 ${仓库.length}/${仓库候选.length} 个仓库（公开版只含其一，另两个不在同级目录）`);
  真(文件数 >= 15, `本仓库自己扫到的文件数（${文件数} 个）不为 0 —— 这一条在单仓库下仍然守得住`);
}

for (const [名, 上限] of Object.entries(基线)) {
  const 得 = 数[名];
  if (得 > 上限) {
    真(false, `${名}：${得} 处，比基线 ${上限} **多了 ${得 - 上限} 处**`,
      `新增的在这些位置里：${明细[名].join(' ')}\n    要么改掉（报出量/写日志/抛出来），要么把基线改成 ${得} 并在提交里说清为什么这处可以静默`);
  } else if (得 < 上限) {
    真(true, `${名}：${得} 处，**比基线少了 ${上限 - 得} 处**（修了就把基线改成 ${得}，棘轮才咬得住）`);
  } else {
    真(true, `${名}：${得} 处，和基线一致`);
  }
}

console.log(`\n检查了 ${n} 条判据，失败 ${挂}`);
process.exit(挂 ? 1 : 0);
