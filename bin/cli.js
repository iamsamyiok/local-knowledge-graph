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
  --mcp           以 MCP stdio 服务运行（供 Claude Desktop/Cursor 等客户端接入，不启动网页）
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

if (args.includes('--mcp')) {
  // stdio MCP：数据目录仍由 KG_DATA_DIR / --data 决定
  const d = argValue('--data');
  if (d) process.env.KG_DATA_DIR = d;
  require('../mcp/server.js');
} else {

const { ensureLegacyMigration, isDevRepo } = require('../lib/paths');

const port = argValue('--port');
const host = argValue('--host');
const dataDir = argValue('--data');
if (port) process.env.PORT = port;
if (host) process.env.KG_HOST = host;
if (dataDir) process.env.KG_DATA_DIR = dataDir;

ensureLegacyMigration();

// 浏览器打开统一交给 server.js：端口绑定成功后执行，能感知端口顺延后的真实地址
if (args.includes('--no-open')) process.env.KG_NO_OPEN = '1';

require('../server.js');

// 开发仓库模式提示数据位置（npm模式由 server bootstrap 迁移逻辑打印）
if (isDevRepo()) {
  console.log('[开发模式] 检测到Git仓库，数据目录使用项目内 ./data');
}
}
