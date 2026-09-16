#!/usr/bin/env node
'use strict';

// 本地知识图谱 MCP Server（stdio, JSON-RPC 2.0, 零外部依赖）
// 配置示例（Claude Desktop / opencode mcp）：
//   { "command": "node", "args": ["/absolute/path/to/local-knowledge-graph/mcp/server.js"],
//     "env": { "KG_MCP_READONLY": "1" } }
// 设置 KG_MCP_READONLY=1 时禁用写入类工具。
// 工具定义与分发逻辑在 mcp/core.js（与 HTTP 端点共享）。

const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'lib', 'db'));
const { createCore, handleRpc } = require(path.join(__dirname, 'core'));

const READONLY = process.env.KG_MCP_READONLY === '1';
db.open();
const core = createCore({ readonly: READONLY, source: 'MCP' });

const SERVER_VERSION = (() => {
  try { return require(path.join(ROOT, 'package.json')).version || '1.0.0'; }
  catch (_) { return '1.0.0'; }
})();

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function rpcError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(req) {
  const { id, method } = req || {};
  try {
    const resp = await Promise.resolve(handleRpc(core, req, SERVER_VERSION));
    if (resp) write(resp);
  } catch (e) {
    if (id !== undefined) rpcError(id, -32603, e.message);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let req;
  try { req = JSON.parse(s); } catch (_) { return; }
  handle(req);
});
rl.on('close', () => process.exit(0));
