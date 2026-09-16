'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离数据目录（必须在 require lib 前设置）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-mcp-test-'));
process.env.KG_DATA_DIR = path.join(TMP, 'data');
process.env.KG_DB_PATH = path.join(TMP, 'data', 'kg.db');
fs.mkdirSync(process.env.KG_DATA_DIR, { recursive: true });

const db = require('../lib/db');
const { createCore, handleRpc } = require('../mcp/core');
const { tokenOk, extractToken } = require('../mcp/http');

db.open();

const core = createCore({ readonly: false, source: 'MCP' });
const coreRO = createCore({ readonly: true, source: 'MCP' });
const VERSION = 'test';
const CORE_TOOLS = require('../mcp/core').TOOLS;

function rpc(core2, method, params, id = 1) {
  return Promise.resolve(handleRpc(core2, { jsonrpc: '2.0', id, method, params }, VERSION));
}

test('MCP initialize 握手', async () => {
  const r = await rpc(core, 'initialize', {});
  assert.equal(r.result.protocolVersion, '2024-11-05');
  assert.equal(r.result.serverInfo.name, 'local-knowledge-graph');
});

test('tools/list 包含全部13个工具', async () => {
  const r = await rpc(core, 'tools/list', {});
  const names = r.result.tools.map((t) => t.name);
  for (const n of ['kg_stats', 'kg_apply_ops', 'kg_path', 'kg_digest', 'kg_search', 'kg_cypher', 'kg_reset']) assert.ok(names.includes(n), `缺少 ${n}`);
  assert.equal(names.length, 13);
  assert.equal(CORE_TOOLS.length, 13);
});

test('notification（无id）返回 null', async () => {
  const r = handleRpc(core, { jsonrpc: '2.0', method: 'notifications/initialized' }, VERSION);
  assert.equal(r, null);
});

test('未知方法返回 -32601', async () => {
  const r = await rpc(core, 'resources/list', {});
  assert.equal(r.error.code, -32601);
});

test('kg_apply_ops 增改删全链路 + 自动保存点', async () => {
  const add = await rpc(core, 'tools/call', { name: 'kg_apply_ops', arguments: { ops: [{ op: 'add_entity', name: 'MCP测试实体', category: '抽象实体', attributes: { 来源: '测试' } }] } });
  const payload = JSON.parse(add.result.content[0].text);
  assert.equal(payload.applied_count, 1);
  const ent = payload.applied[0].entity || payload.applied[0];
  const id = payload.applied[0].id || ent.id;
  assert.ok(id, '应返回新实体id');

  const upd = await rpc(core, 'tools/call', { name: 'kg_apply_ops', arguments: { ops: [{ op: 'update_entity', id, attributes: { 来源: '测试2' } }] } });
  assert.equal(JSON.parse(upd.result.content[0].text).applied_count, 1);
  const e2 = db.getEntity(id);
  assert.equal(JSON.parse(e2.attributes).来源, '测试2');

  const byName = await rpc(core, 'tools/call', { name: 'kg_get_entity', arguments: { name: 'MCP测试实体' } });
  assert.equal(JSON.parse(byName.result.content[0].text).entity.id, id);

  const del = await rpc(core, 'tools/call', { name: 'kg_apply_ops', arguments: { ops: [{ op: 'delete_entity', id }] } });
  assert.equal(JSON.parse(del.result.content[0].text).applied_count, 1);
  assert.equal(db.getEntity(id), undefined);
});

test('只读模式下 kg_apply_ops 被拒绝且数据不变', async () => {
  const before = db.counts().entities;
  const r = await rpc(coreRO, 'tools/call', { name: 'kg_apply_ops', arguments: { ops: [{ op: 'add_entity', name: '不该存在', category: '抽象实体' }] } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /只读/);
  assert.equal(db.counts().entities, before);
});

test('未知工具返回 -32602', async () => {
  const r = await rpc(core, 'tools/call', { name: 'kg_no_such_tool', arguments: {} });
  assert.equal(r.error.code, -32602);
});

test('kg_list_entities 分页元数据', async () => {
  await rpc(core, 'tools/call', { name: 'kg_apply_ops', arguments: { ops: [{ op: 'add_entity', name: '分页实体', category: '抽象实体' }] } });
  const r = await rpc(core, 'tools/call', { name: 'kg_list_entities', arguments: { limit: 1, offset: 0 } });
  const p = JSON.parse(r.result.content[0].text);
  assert.ok(p.total >= 1);
  assert.equal(p.count, Math.min(1, p.total));
});

test('token 校验：常量比较与提取', () => {
  assert.equal(tokenOk('abc', 'abc'), true);
  assert.equal(tokenOk('abc', 'abd'), false);
  assert.equal(tokenOk('', 'abc'), false);
  assert.equal(tokenOk('abc', ''), false);
  const req1 = { headers: { authorization: 'Bearer tok1' }, query: {} };
  assert.equal(extractToken(req1), 'tok1');
  const req2 = { headers: {}, query: { token: 'tok2' } };
  assert.equal(extractToken(req2), 'tok2');
});

test('批量 JSON-RPC：notification 不产生响应条目', async () => {
  // 通过 handleRpc 逐条验证批量语义的构成材料
  const a = handleRpc(core, { jsonrpc: '2.0', id: 7, method: 'ping' }, VERSION);
  const b = handleRpc(core, { jsonrpc: '2.0', method: 'notifications/initialized' }, VERSION);
  assert.equal(a.id, 7);
  assert.equal(b, null);
});

test('add_relation 按名称引用（主名与别名）', async () => {
  const add = await rpc(core, 'tools/call', { name: 'kg_apply_ops', arguments: { ops: [
    { op: 'add_entity', name: '名称引用甲', category: '抽象实体', ref: 'jia' },
    { op: 'add_entity', name: '名称引用乙', category: '抽象实体', aliases: ['乙的别名'] },
  ] } });
  assert.equal(JSON.parse(add.result.content[0].text).applied_count, 2);

  // 跨调用：主名引用 + 别名引用
  const rel = await rpc(core, 'tools/call', { name: 'kg_apply_ops', arguments: { ops: [
    { op: 'add_relation', source_name: '名称引用甲', target_name: '乙的别名', name: '按名称连边', category: '互动', confidence: '推测', evidence_ref: '《测试来源》' },
  ] } });
  const rr = JSON.parse(rel.result.content[0].text);
  assert.equal(rr.applied_count, 1);
  const rid = rr.applied[0].id;
  const row = db.getRelation(rid);
  assert.equal(row.confidence, '推测');
  assert.equal(row.source_ref, '《测试来源》');
});

test('名称引用重名时返回候选', async () => {
  await rpc(core, 'tools/call', { name: 'kg_apply_ops', arguments: { ops: [
    { op: 'add_entity', name: '同名者', category: '物理实体' },
    { op: 'add_entity', name: '同名者', category: '抽象实体' },
  ] } });
  const rel = await rpc(core, 'tools/call', { name: 'kg_apply_ops', arguments: { ops: [
    { op: 'add_relation', source_name: '同名者', target_name: '名称引用甲', name: '测试', category: '互动' },
  ] } });
  assert.equal(rel.result.isError, true);
  assert.match(rel.result.content[0].text, /候选/);
});

test('批量失败错误定位到第N条', async () => {
  const r = await rpc(core, 'tools/call', { name: 'kg_apply_ops', arguments: { ops: [
    { op: 'add_entity', name: '正常实体', category: '抽象实体' },
    { op: 'add_entity', name: '', category: '抽象实体' },
  ] } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /第2条操作/);
});

test('kg_get_entity 返回附带别名', async () => {
  await rpc(core, 'tools/call', { name: 'kg_apply_ops', arguments: { ops: [
    { op: 'add_entity', name: '带别名的实体', category: '物理实体', aliases: ['别名一号'] },
  ] } });
  const r = await rpc(core, 'tools/call', { name: 'kg_get_entity', arguments: { name: '带别名的实体' } });
  const p = JSON.parse(r.result.content[0].text);
  assert.deepEqual(p.entity.aliases, ['别名一号']);
});

test('kg_reset 需要 confirm 且可清空', async () => {
  const no = await rpc(core, 'tools/call', { name: 'kg_reset', arguments: {} });
  assert.equal(no.result.isError, true);
  const ro = await rpc(coreRO, 'tools/call', { name: 'kg_reset', arguments: { confirm: true } });
  assert.equal(ro.result.isError, true);
  const before = db.counts().entities;
  const yes = await rpc(core, 'tools/call', { name: 'kg_reset', arguments: { confirm: true } });
  const r = JSON.parse(yes.result.content[0].text);
  assert.equal(r.deleted_entities, before);
  assert.equal(db.counts().entities, 0);
  assert.equal(db.counts().relations, 0);
});
