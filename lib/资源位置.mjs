/**
 * 凭证和同伴文件在哪 —— **全仓唯一一处，别处不许再算路径**。
 *
 * **为什么不用 `import.meta.url`**：它问的是「这段代码的源文件在哪」。打包成单文件之后
 * 它指向 `dist/`、不再是源码目录，于是 `.creds.json` 找不到 → 换不到飞书 token → 静默退回
 * 慢的那条 lark-cli 路（3.5s/条），或者模型 key 读不到直接起不来。**打包时不报、运行时才炸。**
 * 原来这个仓库有四处各算各的，`lib/飞书.mjs` 那处还得 `dirname(dirname(...))` 数层数——
 * 文件挪一层就错，而且错了不报。
 *
 * 位置一律显式，顺序：
 *   1 `AGENT_HOME/`      —— 换机器只设这一个
 *   2 入口/产物旁边       —— 「凭证放在程序旁边」，源码跑和打包跑都成立
 *   3 `~/.config/feishu-agent/` —— 用户级默认
 *
 * 凭证本身**优先走环境变量**（`AGENT_API_BASE`/`AGENT_API_KEY`/`LARK_APP_ID`/`LARK_APP_SECRET`），
 * `.creds.json` 是没设环境变量时的回退——部署机是 Windows、没有 macOS 钥匙串，只能落文件。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, isAbsolute, resolve } from 'node:path';

/** 正在跑的那个入口所在目录（`process.argv[1]`），不是某个模块的位置。 */
export function 入口目录() {
  const a = process.argv[1];
  if (!a) return process.cwd();
  return dirname(isAbsolute(a) ? a : resolve(process.cwd(), a));
}

/** 按优先级排出候选。顺序即优先级。 */
export function 候选(文件名) {
  return [
    process.env.AGENT_HOME ? join(process.env.AGENT_HOME, 文件名) : null,
    join(入口目录(), 文件名),
    join(homedir(), '.config', 'feishu-agent', 文件名),
  ].filter(Boolean);
}

/**
 * 凭证文件路径。**读的时候挑已存在的**（别让人昨天写的 secret 今天读不到）；
 * 一个都不存在时给第一顺位，让写入方在那儿新建。
 */
export function 凭证档({ 要存在 = true } = {}) {
  const c = 候选('.creds.json');
  return (要存在 ? c.find((p) => existsSync(p)) : null) || c[0];
}

/** 同伴脚本（守护要起 bot）。打包后两个产物放一块，这条同样成立。 */
export const 同伴 = (文件名) => join(入口目录(), 文件名);
