#!/bin/bash
# 本地知识图谱整合器 一键启动（兼容 Windows/macOS/Linux，Windows 下用 Git Bash / WSL 执行）
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js >= 22.5（内置 node:sqlite），请先安装"; exit 1
fi

if [ ! -d node_modules ]; then
  echo "首次运行，安装依赖…"
  npm install --no-audit --no-fund
fi

echo "启动后端（含默认拉起 OpenCode 进程）…"
exec node --no-warnings server.js
