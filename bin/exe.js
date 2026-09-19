#!/usr/bin/env node
'use strict';

// 单文件可执行入口（@yao-pkg/pkg 打包用，见 package.json "pkg" 配置）
// 用法: kg[.exe] [serve]        启动网页服务并自动打开浏览器（默认）
//       kg[.exe] mcp            以 MCP stdio 服务运行
//       kg[.exe] <kgctl子命令>   其余参数原样交给 CLI 工具集（stats/get/ops/...）

const cmd = process.argv[2] || 'serve';
if (cmd === 'mcp') {
  process.argv.splice(2, 1);
  require('../mcp/server.js');
} else if (cmd === 'serve') {
  process.argv.splice(2, 1);
  require('../server.js');
} else {
  // 其余参数交给 CLI 工具集：require.main 防护会阻止其自执行，这里显式调度
  const { main, die } = require('./kgctl.js');
  main()
    .then(() => { try { require('../lib/db').close(); } catch (_) {} process.exit(0); })
    .catch((e) => { try { require('../lib/db').close(); } catch (_) {} die(e); });
}
