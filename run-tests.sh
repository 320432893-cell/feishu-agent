#!/usr/bin/env bash
# feishu-agent 离线测试（不打网/不打真 MCP）。只认退出码。
set -u
fail=0
echo "== 语法预检"
for f in lib/*.mjs *.mjs; do node --check "$f" || fail=1; done
echo "== 护栏（去@名字带空格 / 每人每时限流，红绿）"
node tests/护栏.test.mjs || fail=1
echo "== agent（模型 fallback / 白名单挡写工具 / 坏参数不空跑 / CSV 检测 / 历史上下文 / 取消 / config，mock 不打网）"
node tests/agent.test.mjs || fail=1
echo "== MCP 客户端（子进程死了必须立刻红、不许干等超时，起真子进程不打网）"
node tests/mcp客户端.test.mjs || fail=1
echo "== 资源位置（不依赖文件位置，带 import.meta.url 棘轮）"
node tests/资源位置.test.mjs || fail=1
echo "== 问答留存（写得进/读得回/坏了不许把查询带崩，不打网）"
node tests/问答日志.test.mjs || fail=1
echo "== 术语表（口令认得准/冲突不静默覆盖/普通问话不误认，不打网）"
node tests/术语表.test.mjs || fail=1
echo "== 清单（多项任务的进度：合并不覆盖/越界必报/超时交半份，不打网）"
node tests/清单.test.mjs || fail=1
echo "== 静默棘轮（三个仓库扫「失效时是绿的」四类写法，数量只许降不许涨）"
node tests/静默棘轮.test.mjs || fail=1
printf "== 范围锁（人指定了就看这张表，读别的要在派发前拦掉）\n"
node tests/表格范围.test.mjs || fail=1
printf "== 合表（几个 CSV → 一个 xlsx，一个 sheet 一张）\n"
node tests/合表.test.mjs || fail=1
printf "== 飞书在线表格（建表/加 sheet/写入/权限，假接口不打网）\n"
node tests/飞书表格.test.mjs || fail=1
# **自己写自己读是循环论证**：上面那档只能证明"我按自己想的写出了字节"，
# 证明不了 Excel 认。真判据是拿别人的解析器读回来 —— 而且它真逮到过一个错
# （在库那列写成了文本不是数字，我自己的单测查不出来）。
printf "== xlsx 真能开（openpyxl 读回来）"
if python3 -c "import openpyxl" 2>/dev/null; then
  printf "\n"
  python3 tests/xlsx真能开.py || fail=1
else
  printf " ⏭ **没装 openpyxl，这一档没验**（pip3 install openpyxl）——「没检查」不等于「通过」\n"
fi
printf "== 持久表（重启后票还在；写不进去要能看见）\n"
node tests/持久表.test.mjs || fail=1
printf "== 对话压缩（压失败要退回原样，不许冲掉旧摘要）\n"
node tests/对话摘要.test.mjs || fail=1
echo "== 流式（SSE content/tool_calls 增量重组 / 跨块边界缓冲，mock 不打网）"
node tests/流式.test.mjs || fail=1
printf "== 只准跑一个 bot（活着必须拒 / 死锁必须放行 / 接线在起 MCP 之前）\n"
node tests/独占.test.mjs || fail=1
printf "== 例行更新 日更/周更/导工单（模型编出来的物料键一律丢掉 / 漏判按不合并 / 问话不许认成命令）\n"
node tests/例行更新.test.mjs || fail=1
printf "== 补收（长连接断线丢的消息事后补上；body.content 是 JSON 字符串不是纯文本）\n"
node tests/补收.test.mjs || fail=1

# **这个脚本是一个个列文件名的** —— 加了 tests/X.test.mjs 却忘了在上面加一行，
# 它就永远不会跑，而套件照样打勾。2026-08-24 一次逮到两个（独占、限流重试）。
# 进了 git 的没登记 = 挂；还没进 git 的（别的会话在做）只报出来不挂，但**不许不吭声**。
printf '== 测试登记（每个 tests/*.test.mjs 都得在这个脚本里出现）'
missing=""
untracked=""
found=0
for f in tests/*.test.mjs; do
  found=$((found + 1))
  base=$(basename "${f}")
  if grep -q "${base}" "$0"; then continue; fi
  if git ls-files --error-unmatch "${f}" >/dev/null 2>&1; then
    missing="${missing} ${base}"
  else
    untracked="${untracked} ${base}"
  fi
done
if [ "${found}" -lt 5 ]; then
  echo " ✗ 只找到 ${found} 个测试文件 —— 明显偏小，多半是 glob 没展开，不是真只有这么几个"; fail=1
elif [ -n "${missing}" ]; then
  echo " ✗ **这些测试进了库却没人跑**：${missing}"; fail=1
elif [ -n "${untracked}" ]; then
  echo " ⏭ ${found} 个都登记了；另有还没进 git 的没跑：${untracked}（别的会话在做，提交时记得一起登记）"
else
  echo " ✓ ${found} 个测试文件都登记了"
fi

# JS 交给 ESLint（no-undef + no-unused-vars）：抓引用不存在的名字 + 删函数留下的孤儿 import。
printf '== JS（eslint）'
if ! command -v eslint >/dev/null 2>&1; then
  echo " ✗ 没装 eslint —— npm i -g eslint；不装这条永远'通过'"; fail=1
else
  es_out=$(eslint --config eslint.config.mjs . 2>&1); es_code=$?
  es_files=$(find . -name '*.mjs' -not -path './node_modules/*' | wc -l | tr -d ' ')
  es_scanned=$(eslint --config eslint.config.mjs --format json . 2>/dev/null | tr ',' '\n' | grep -c '"filePath"')
  if [ "$es_scanned" -lt "$es_files" ]; then
    echo " ✗ eslint 只扫了 $es_scanned/$es_files 个 .mjs —— 少扫的没检查"; fail=1
  elif [ "$es_code" -ne 0 ]; then
    echo " ✗ eslint 报了问题："; echo "$es_out" | grep -E 'error|warning' | head -5; fail=1
  else
    echo " ✓ $es_scanned 个 .mjs 全扫过，一条没有"
  fi
fi

# —— 「全」档：真模型 + 真工具 + 真数据，验「答得对不对」，不是「代码有没有写错」。
# 单元测试保证不了机器人变笨：2026-08-21 改了三次提示词、换了模型熔断、动了透视快路径，
# 单元测试一路全绿，而「它还会不会调对工具」没有任何证据。
if [ "${1:-}" = "全" ]; then
  echo "== 回归评测（真模型/真工具/真数据，cmdb 那几条内网断了会自动跳）"
  node eval/跑评测.mjs || fail=1
else
  echo
  echo "⚠ 这轮**没验「答得对不对」** —— 上面全是离线单元测试，只能保证代码没写错。"
  echo "  改了提示词/模型/工具之后，提交前跑一次：./run-tests.sh 全"
fi

if [ "$fail" = 0 ]; then echo "✅ 全过"; else echo "❌ 有挂"; fi
exit $fail
