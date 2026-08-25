/**
 * 最小验证：起 inventory MCP（走飞书、不用公司网）→ agent 跑一句 → 打印回答。
 * 用法：node 试跑.mjs "400G光模块还有多少库存"
 */
import { 起MCP } from './lib/mcp客户端.mjs';
import { 跑一句 } from './lib/agent.mjs';
import { 读配置 } from './config.mjs';

const 模型配置 = 读配置();
const 问 = process.argv.slice(2).join(' ') || '400G光模块还有多少库存';

const inv = 起MCP('node', ['/Users/mumuyuchen/projects/company/inventory-mcp/server.mjs']);
await inv.初始化();

console.log(`模型：${(模型配置.models || []).join(' → ')}\n问：${问}\n（查询中…）`); // 读配置 给的是 models 列表，没有 model 字段——写错就一直印 undefined
const t0 = Date.now();
const { 回答, 用了 } = await 跑一句(问, { 模型配置, MCP们: [{ 前缀: 'inv', client: inv }] });
console.log(`\n用了工具：${用了.join('、') || '(没调工具)'}  耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(`回答：\n${回答}`);
inv.关();
process.exit(0);
