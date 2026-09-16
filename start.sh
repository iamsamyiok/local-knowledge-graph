#!/bin/sh
# 本地知识图谱整合器一键启动（macOS / Linux / 通用）
# 双击或终端运行：自动检查 Node 版本、首次自动装依赖、启动后打开浏览器
cd "$(dirname "$0")" || exit 1
echo "== 本地知识图谱整合器 =="
URL="http://localhost:3000"

# 1. Node.js 与 node:sqlite 检查
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js"
  echo "       请安装 Node.js 22.5 或更高版本: https://nodejs.org/zh-cn/download/"
  read -r _  # 双击打开时保持窗口可见
  exit 1
fi
if ! node -e "require('node:sqlite')" >/dev/null 2>&1; then
  echo "[错误] Node.js 版本过低: 当前 $(node -v)，需要 22.5 及以上（node:sqlite 为内置模块）"
  echo "       下载最新 LTS: https://nodejs.org/zh-cn/download/"
  read -r _
  exit 1
fi

# 2. 首次运行自动安装依赖（仅 express）
if ! node -e "require('express')" >/dev/null 2>&1; then
  echo "首次运行：安装依赖中（仅 express，约几秒）..."
  npm install --no-audit --no-fund --loglevel=error || {
    echo "[错误] 依赖安装失败，请检查网络后重试"
    read -r _
    exit 1
  }
fi

# 3. 启动服务并打开浏览器
echo "启动服务中..."
node --no-warnings server.js &
SERVER_PID=$!
sleep 3
if command -v open >/dev/null 2>&1; then
  open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
fi
echo "服务已启动: $URL （关闭本窗口或按 Ctrl+C 停止服务）"
trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM
wait $SERVER_PID
echo "服务已退出，按回车关闭窗口"
read -r _
