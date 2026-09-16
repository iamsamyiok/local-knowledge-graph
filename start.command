#!/bin/bash
# macOS 双击启动入口（首次使用需在终端执行: chmod +x start.command start.sh）
cd "$(dirname "$0")" || exit 1
exec sh start.sh
