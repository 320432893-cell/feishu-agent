/**
 * 把飞书 app_secret 写进 .creds.json（600 权限），不经过聊天。
 * 用法（在你自己的终端跑，别用会把输出回传的方式）：
 *   node 设飞书密钥.mjs <你的app_secret> [app_id]
 * app_id 不填默认 cli_aae5ee90f8f85cc5。secret 从飞书开放平台后台「凭证与基础信息 → App Secret」复制。
 */
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { 凭证档 } from './lib/资源位置.mjs';

const secret = process.argv[2];
const appId = process.argv[3] || 'cli_aae5ee90f8f85cc5';
if (!secret) { console.error('用法: node 设飞书密钥.mjs <app_secret> [app_id]'); process.exit(1); }

// 写入目标：`凭证档()` 已经是「有就改那份、没有才在第一顺位新建」。
// 不能写死成第一顺位——那样人明明有一份 .creds.json 在别的候选位置，改完却不生效，而且不报错。
const 路 = 凭证档();
let j = {};
try { j = JSON.parse(readFileSync(路, 'utf8')); } catch { /* 没有就新建 */ }
j.feishu_app_id = appId;
j.feishu_app_secret = secret;
writeFileSync(路, JSON.stringify(j, null, 2));
chmodSync(路, 0o600);
console.log(`已写入 ${路}（feishu_app_id=${appId}，secret 长度 ${secret.length}，权限 600）。重启 bot 生效。`);
