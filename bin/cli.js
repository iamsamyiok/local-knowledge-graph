#!/usr/bin/env node
'use strict';

// local-knowledge-graph 命令行入口
// 用法: kg [--port 3000] [--host 127.0.0.1] [--data <目录>] [--no-open] [-v|--version] [-h|--help]

const args = process.argv.slice(2);

function argValue(name, short) {
  const i = args.indexOf(name);
  const j = short ? args.indexOf(short) : -1;
  const idx = i >= 0 ? i : j;
  return idx >= 0 ? args[idx + 1] : undefined;
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`本地知识图谱整合器 (local-knowledge-graph)

用法:
  kg [选项]

选项:
  --port <n>      服务端口（默认 3000，环境变量 PORT 同效）
  --host <addr>   监听地址（默认 127.0.0.1，局域网访问用 0.0.0.0，环境变量 KG_HOST 同效）
  --data <dir>    数据目录（默认 ~/.local-knowledge-graph，环境变量 KG_DATA_DIR 同效）
  --no-open       启动后不自动打开浏览器
  -v, --version   显示版本
  -h, --help      显示本帮助

数据说明: 图谱数据、图片、API Key 全部保存在本地数据目录，升级卸载均不影响。`);
  process.exit(0);
}

if (args.includes('-v') || args.includes('--version')) {
  console.log(require('../package.json').version);
  process.exit(0);
}

const { ensureLegacyMigration, isDevRepo } = require('../lib/paths');

const port = argValue('--port');
const host = argValue('--host');
const dataDir = argValue('--data');
if (port) process.env.PORT = port;
if (host) process.env.KG_HOST = host;
if (dataDir) process.env.KG_DATA_DIR = dataDir;

ensureLegacyMigration();

// 启动后轮询就绪，自动打开浏览器
if (!args.includes('--no-open')) {
  const listenPort = Number(process.env.PORT || 3000);
  const url = `http://localhost:${listenPort}`;
  const started = Date.now();
  const timer = setInterval(() => {
    fetch(`${url}/api/version`, { signal: AbortSignal.timeout(1500) })
      .then((r) => {
        if (r.ok || Date.now() - started > 20000) {
          clearInterval(timer);
          if (r.ok) {
            console.log(`已在浏览器打开 ${url}（如未弹出请手动访问）`);
            openBrowser(url);
          }
        }
      })
      .catch(() => { if (Date.now() - started > 25000) clearInterval(timer); });
  }, 800);
}

function openBrowser(url) {
  const { spawn } = require('child_process');
  const cmds = process.platform === 'win32' ? [['cmd', ['/c', 'start', '', url]]]
    : process.platform === 'darwin' ? [['open', [url]]]
    : [['xdg-open', [url]]];
  try {
    const [cmd, cargs] = cmds[0];
    spawn(cmd, cargs, { detached: true, stdio: 'ignore' }).unref();
  } catch (_) { /* 打不开就让用户手动访问 */ }
}

require('../server.js');

// 开发仓库模式提示数据位置（npm模式由 server bootstrap 迁移逻辑打印）
if (isDevRepo()) {
  console.log('[开发模式] 检测到Git仓库，数据目录使用项目内 ./data');
}
