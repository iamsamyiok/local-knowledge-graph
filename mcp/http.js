'use strict';

// MCP Streamable HTTP 传输层（Express 中间件）
// - 无状态：不签发 Session-Id，每请求独立 JSON 响应
// - 鉴权：Authorization: Bearer <token> 或 ?token=<token>
// - CORS：支持浏览器侧客户端（预检放行，无论开关状态）
// - 支持 JSON-RPC 单条与数组批量；notification 无响应条目

const { createCore, handleRpc } = require('./core');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, X-Requested-With',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

function tokenOk(provided, expected) {
  if (!expected || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}

function extractToken(req) {
  const h = req.headers['authorization'] || '';
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  if (req.query && req.query.token) return String(req.query.token);
  return '';
}

function createMcpHandler({ isEnabled, getToken, isReadonly, serverVersion }) {
  // 每请求按当前只读状态构建核心（settings 可被随时切换）
  return async function mcpHandler(req, res) {
    const cors = { ...CORS_HEADERS };
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

    if (req.method === 'OPTIONS') return res.status(204).end();

    if (!isEnabled()) return res.status(404).json({ jsonrpc: '2.0', error: { code: -32000, message: 'MCP 服务未启用（请在应用设置中开启）' } });

    if (req.method === 'GET') {
      res.setHeader('Allow', 'POST, OPTIONS');
      return res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: '本端点仅接受 POST（Streamable HTTP, JSON 响应）' } });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      return res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: '方法不允许' } });
    }

    if (!tokenOk(extractToken(req), getToken())) {
      return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: '访问令牌缺失或不正确（请在应用 MCP 设置中获取）' } });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '请求体不是合法JSON' } }); }
    }
    if (!body || (Array.isArray(body) && !body.length)) {
      return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '无效请求' } });
    }

    const core = createCore({ readonly: !!isReadonly(), source: 'MCP' });
    const items = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const item of items) {
      try {
        const r = await Promise.resolve(handleRpc(core, item, serverVersion));
        if (r) responses.push(r);
      } catch (e) {
        if (item && item.id !== undefined) responses.push({ jsonrpc: '2.0', id: item.id, error: { code: -32603, message: e.message } });
      }
    }

    if (Array.isArray(body)) return res.json(responses);
    if (!responses.length) return res.status(202).end(); // 纯 notification
    return res.json(responses[0]);
  };
}

module.exports = { createMcpHandler, tokenOk, extractToken };
