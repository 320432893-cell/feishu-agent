/**
 * 带过期的持久表：用起来和 `Map` 一样，但**进程重启后还在**。
 *
 * 为什么要它：bot 里那几张表（上下文 / 澄清票 / 写入票 / 导表票 / 教术语票 / 消息到问答）原来都是 `new Map()`，重启就没。
 * 后果不是"少点上下文"这么轻——**人对着一张「确认写入」的卡片点下去，群里一个字都不会出现**
 * （`处理确认` 找不到票时只写一行日志就 return）。而重启是常事：改一行代码、守护拉一次、关一次机。
 * 写入是最不该含糊的地方，"没反应"和"写好了"在群里长得一样。
 *
 * **写不进去要能被看见**：落盘失败只是回到"重启就丢"，不该让查询挂掉；但它必须打一行日志、
 * 并在 `状态()` 里挂着，否则这个模块坏掉之后表现和好着的时候一模一样。
 *
 * 存活期在**读的时候**判，不靠定时清理 —— 定时器停了会让过期数据复活，判据留在读那一侧最稳。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const 默认目录 = () => process.env.BOT_STATE_DIR || join(homedir(), '.cache', 'feishu-agent', '状态');

/**
 * @param 名 文件名（不带扩展名），也是日志里的名字
 * @param 存活毫秒 超过这个岁数的条目读不回来、也不落盘
 * @returns 和 Map 同形的对象：get/set/delete/has/size/[Symbol.iterator]，外加 状态()
 */
export function 建持久表(名, { 存活毫秒, 目录 = null } = {}) {
  const 档 = join(目录 || 默认目录(), `${名}.json`);
  const 表 = new Map();
  let 写不进去 = null;      // 最近一次落盘失败的原因；null=一切正常
  let 开机读回 = 0, 开机丢弃 = 0;

  const 还活着 = (v) => v && typeof v.ts === 'number' && Date.now() - v.ts <= 存活毫秒;

  // —— 开机读回 ——
  try {
    const j = JSON.parse(readFileSync(档, 'utf8'));
    for (const [k, v] of Object.entries(j && typeof j === 'object' ? j : {})) {
      if (还活着(v)) { 表.set(k, v); 开机读回++; } else 开机丢弃++;
    }
  } catch { /* 没有文件/坏文件 = 空表，正常情形 */ }

  // 先写临时文件再改名：写到一半断电不会留下半个 JSON（那会让下次开机整张表读不回来）
  function 落盘() {
    try {
      mkdirSync(dirname(档), { recursive: true });
      const 临 = `${档}.tmp`;
      writeFileSync(临, JSON.stringify(Object.fromEntries(表)) + '\n');
      renameSync(临, 档);
      if (写不进去) { process.stderr.write(`[持久表] ${名} 又能写了\n`); 写不进去 = null; }
    } catch (e) {
      const 因 = String(e.message).slice(0, 120);
      if (写不进去 !== 因) { // 同一个原因只吼一次，别刷屏
        写不进去 = 因;
        process.stderr.write(`[持久表] ${名} **写不进去**：${因} —— 退回「重启就丢」，票据会在重启后消失\n`);
      }
    }
  }

  return {
    get(k) { const v = 表.get(k); if (v && !还活着(v)) { 表.delete(k); 落盘(); return undefined; } return v; },
    has(k) { return this.get(k) !== undefined; },
    set(k, v) { 表.set(k, v); 落盘(); return this; },
    delete(k) { const 有 = 表.delete(k); if (有) 落盘(); return 有; },
    get size() { return 表.size; },
    /** 清掉过期的，返回清了几条。原来 bot 里那几处「惰性清过期」的 for 循环就是干这个的。 */
    清过期() {
      let 清了 = 0;
      for (const [k, v] of [...表]) if (!还活着(v)) { 表.delete(k); 清了++; }
      if (清了) 落盘();
      return 清了;
    },
    /** 迭代前先清一遍过期的，免得调用方拿到早该没了的条目。 */
    [Symbol.iterator]() { this.清过期(); return 表[Symbol.iterator](); },
    /** 给启动日志和测试用：这张表开机读回了几条、有没有写不进去。 */
    状态() { return { 名, 档, 现有: 表.size, 开机读回, 开机丢弃, 写不进去 }; },
  };
}
