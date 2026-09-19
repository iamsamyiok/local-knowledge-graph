@echo off
chcp 65001 >nul
title 本地知识图谱整合器
cd /d "%~dp0"
echo == 本地知识图谱整合器 ==
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js
  echo        请安装 Node.js 22.5 或更高版本: https://nodejs.org/zh-cn/download/
  echo        安装完成后重新双击本文件即可。
  pause
  exit /b 1
)

node -e "require('node:sqlite')" >nul 2>nul
if errorlevel 1 (
  for /f %%i in ('node -v') do set NODEV=%%i
  echo [错误] Node.js 版本过低: 当前 %NODEV%，需要 22.5 及以上（内置 node:sqlite 数据库）
  echo        下载最新 LTS: https://nodejs.org/zh-cn/download/
  pause
  exit /b 1
)

node -e "require('express')" >nul 2>nul
if errorlevel 1 (
  echo 首次运行：安装依赖中，仅 express，约几秒...
  where npm >nul 2>nul
  if errorlevel 1 (
    echo [错误] 未检测到 npm，请重新安装 Node.js LTS 版本
    pause
    exit /b 1
  )
  call npm install --no-audit --no-fund --loglevel=error
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
  )
)

echo 正在启动服务，就绪后将自动打开浏览器...
echo 提示：本窗口即服务本体，关闭窗口（或按 Ctrl+C）即停止服务。
echo       默认端口被占用时会自动顺延，访问地址以窗口内显示的为准。
echo.
node --no-warnings server.js

echo.
echo 服务已退出，按任意键关闭窗口。
pause >nul
