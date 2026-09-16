@echo off
chcp 65001 >nul
title 本地知识图谱整合器
cd /d "%~dp0"
echo == 本地知识图谱整合器 ==

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js
  echo        请安装 Node.js 22.5 或更高版本: https://nodejs.org/zh-cn/download/
  pause
  exit /b 1
)

node -e "require('node:sqlite')" >nul 2>nul
if errorlevel 1 (
  for /f %%i in ('node -v') do set NODEV=%%i
  echo [错误] Node.js 版本过低: 当前 %NODEV%，需要 22.5 及以上
  echo        下载最新 LTS: https://nodejs.org/zh-cn/download/
  pause
  exit /b 1
)

node -e "require('express')" >nul 2>nul
if errorlevel 1 (
  echo 首次运行：安装依赖中，仅 express，约几秒...
  call npm install --no-audit --no-fund --loglevel=error
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
  )
)

echo 启动服务中...
start "KG-Server" /min cmd /c "node --no-warnings server.js"
timeout /t 3 /nobreak >nul
start "" http://localhost:3000
echo 服务已启动: http://localhost:3000
echo 关闭最小化的 KG-Server 窗口即可停止服务；本窗口几秒后自动关闭。
timeout /t 6 /nobreak >nul
