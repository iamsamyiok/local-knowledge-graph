'use strict';

// 智能检索测试：node --test test/
// 隔离策略：KG_DATA_DIR/KG_DB_PATH 指向临时目录；runPlain 注入 mock，绝不真实调用 LLM。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg_ask_test_'));
process.env.KG_DATA_DIR = TMP;
process.env.KG_DB_PATH = path.join(TMP, 'kg.db');

const db = require('../lib/db');
const ask = require('../lib/ask');

db.open(); // 原始句柄初始化（addRelation 等需要）

/* ---------- 种子数据 ----------
  星型：甲—[位于]→枢纽←[位于]—乙  （甲乙共邻居=枢纽）
  三角：丙—[合作]→丁，丙—[合作]→戊，丁—[合作]→戊  （丁戊有直连边+共邻居）
*/
const hub = db.addEntity({ name: '枢纽', category: '物理实体' }, '手工');
const jia = db.addEntity({ name: '甲', category: '物理实体' }, '手工');
const yi = db.addEntity({ name: '乙', category: '物理实体' }, '手工');
db.addRelation({ source_id: jia.id, target_id: hub.id, name: '位于', category: '空间' }, '手工');
db.addRelation({ source_id: yi.id, target_id: hub.id, name: '位于', category: '空间' }, '手工');

const bing = db.addEntity({ name: '丙', category: '物理实体' }, '手工');
const ding = db.addEntity({ name: '丁', category: '物理实体' }, '手工');
const wu = db.addEntity({ name: '戊', category: '物理实体' }, '手工');
db.addRelation({ source_id: bing.id, target_id: ding.id, name: '合作', category: '互动' }, '手工');
db.addRelation({ source_id: bing.id, target_id: wu.id, name: '合作', category: '互动' }, '手工');
db.addRelation({ source_id: ding.id, target_id: wu.id, name: '合作', category: '互动' }, '手工');

/* ---------- validatePlan ---------- */
test('validatePlan: 合法计划通过', () => {
  const r = ask.validatePlan({ steps: [{ tool: 'keyword', q: '枢纽' }] });
  assert.equal(r.ok, true);
});

test('validatePlan: 非法结构/未知工具/超步数被拒', () => {
  assert.equal(ask.validatePlan({ steps: 'nope' }).ok, false);
  assert.equal(ask.validatePlan({ steps: [{ tool: 'shell', q: 'x' }] }).ok, false);
  assert.equal(ask.validatePlan({
    steps: [
      { tool: 'keyword', q: '1' }, { tool: 'keyword', q: '2' },
      { tool: 'keyword', q: '3' }, { tool: 'keyword', q: '4' }, { tool: 'keyword', q: '5' },
    ],
  }).ok, false);
  assert.equal(ask.validatePlan({ steps: [{ tool: 'keyword' }] }).ok, false); // 缺 q
  assert.equal(ask.validatePlan({ steps: [{ tool: 'cypher', query: 'DELETE FROM entities' }] }).ok, false); // 非只读
  assert.equal(ask.validatePlan({ steps: [{ tool: 'cypher', query: '' }] }).ok, false);
  assert.equal(ask.validatePlan({ steps: [{ tool: 'path', from: '甲' }] }).ok, false); // 缺 to
  assert.equal(ask.validatePlan({ steps: [{ tool: 'ego', center: '枢纽', depth: 99 }] }).ok, false); // 深度越界
  assert.equal(ask.validatePlan(null).ok, false);
});

/* ---------- clampCypher ---------- */
test('clampCypher: 行数与LIMIT钳制', () => {
  assert.ok(/LIMIT 50$/i.test(ask.clampCypher('MATCH (a)-[r]->(b) RETURN a LIMIT 999'))); // 硬上限
  assert.ok(/LIMIT 50$/i.test(ask.clampCypher('MATCH (a)-[r]->(b) RETURN a'))); // 无LIMIT则追加
  assert.ok(/LIMIT 3$/i.test(ask.clampCypher('MATCH (a) RETURN a LIMIT 3'))); // 合法值保留
});

/* ---------- executePlan：只读不变式 ---------- */
test('executePlan: 执行前后库版本与计数不变，步骤产出结果', async () => {
  const before = { v: db.getVersion(), c: db.counts() };
  const plan = {
    steps: [
      { tool: 'keyword', q: '甲' },
      { tool: 'cypher', query: 'MATCH (a)-[r:空间]->(b) RETURN a,r,b LIMIT 10' },
      { tool: 'ego', center: '枢纽', depth: 1 },
    ],
  };
  const merged = await ask.executePlan(plan);
  const after = { v: db.getVersion(), c: db.counts() };
  assert.deepEqual(after, before); // 只读
  assert.equal(merged.steps.length, 3);
  assert.ok(merged.steps.every((s) => s.status === 'ok'));
  assert.ok(merged.entities.some((e) => e.name === '甲'));
  assert.ok(merged.entities.some((e) => e.name === '枢纽'));
});

/* ---------- compilePlan：编译失败降级 keyword ---------- */
test('compilePlan: JSON坏输出重试后仍失败→降级', async () => {
  const bad = async () => ({ ok: true, text: '这不是JSON' });
  const r = await ask.compilePlan('测试问题', bad);
  assert.equal(r.plan, null);
  assert.equal(r.degraded, true);
  assert.ok(r.error.length > 0);
});

test('compilePlan: 合法JSON输出→解析为计划', async () => {
  let calls = 0;
  const good = async () => { calls++; return { ok: true, text: '```json\n{"steps":[{"tool":"keyword","q":"甲"}]}\n```' }; };
  const r = await ask.compilePlan('测试问题', good);
  assert.equal(r.degraded, false);
  assert.equal(calls, 1);
  assert.equal(r.plan.steps[0].q, '甲');
});

/* ---------- findCoNeighbors ---------- */
test('findCoNeighbors: 星型与三角均能发现', () => {
  const ids = [jia.id, yi.id, hub.id, bing.id, ding.id, wu.id];
  const { pairs, bridges } = ask.findCoNeighbors(ids);
  const found = pairs.map((p) => `${p.a}-${p.b}`).sort();
  assert.ok(found.includes(`${jia.id}-${yi.id}`)); // 星型共邻居
  assert.ok(found.includes(`${Math.min(ding.id, wu.id)}-${Math.max(ding.id, wu.id)}`)); // 三角（直连+共邻居）
  // 甲与丙无公共邻居，不应出现
  assert.equal(found.includes(`${Math.min(jia.id, bing.id)}-${Math.max(jia.id, bing.id)}`), false);
  // 子集查询：仅取丁戊时，丙是其桥接节点
  const sub = ask.findCoNeighbors([ding.id, wu.id]);
  assert.ok(sub.bridges.some((b) => b.id === bing.id));
});

/* ---------- buildDigest ---------- */
test('buildDigest: ≤2048字节且含规模与样例', () => {
  const { digest, stats } = ask.buildDigest();
  const bytes = Buffer.byteLength(digest, 'utf8');
  assert.ok(bytes <= 2048, `digest ${bytes} 字节超限`);
  assert.ok(digest.includes(`规模: 实体${stats.entities}`));
  assert.ok(digest.includes('高频关系名'));
  assert.equal(typeof stats.entities, 'number');
  assert.equal(typeof stats.relations, 'number');
});

/* ---------- extractJson ---------- */
test('extractJson: 围栏/纯文本/带前缀三种形态', () => {
  assert.deepEqual(ask.extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(ask.extractJson('{"a":2}'), { a: 2 });
  assert.deepEqual(ask.extractJson('好的，计划如下：{"a":3} 请查收'), { a: 3 });
  assert.throws(() => ask.extractJson('完全没有JSON'));
});

/* ---------- ask 端到端（mock runPlain） ---------- */
test('ask: 全链路（编译→执行→共现→综述）', async () => {
  const planJson = JSON.stringify({ steps: [{ tool: 'keyword', q: '甲' }, { tool: 'ego', center: '乙', depth: 1 }] });
  const mock = async (prompt) => {
    if (prompt.includes('规划器')) return { ok: true, text: planJson };
    return { ok: true, text: '「甲」位于「枢纽」#1。' }; // 综述
  };
  const r = await ask.ask('甲和谁有关系', { synthesis: true, runPlain: mock });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.ok(r.entities.some((e) => e.name === '甲'));
  assert.ok(r.synthesis.includes('甲'));
  assert.ok(r.co_neighbors.length >= 1);
  assert.ok(typeof r.timings.compile_ms === 'number');
});

test('ask: 关闭综述则无synthesis字段', async () => {
  const mock = async () => ({ ok: true, text: '{"steps":[{"tool":"keyword","q":"甲"}]}' });
  const r = await ask.ask('测试', { synthesis: false, runPlain: mock });
  assert.equal(r.ok, true);
  assert.equal(r.synthesis, undefined);
});

test('ask: 编译器不可用（ok:false）→降级仍可执行', async () => {
  const mock = async () => ({ ok: false, error: '网络不可用', retriable: true });
  const r = await ask.ask('测试', { synthesis: false, runPlain: mock });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
  assert.ok(r.steps.length >= 1);
});

test('ask: 降级时实体名回扫兜底', async () => {
  const mock = async () => ({ ok: false, error: 'LLM不可用' });
  const r = await ask.ask('请找出郑和下西洋的相关实体', { synthesis: false, runPlain: mock });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
  assert.ok(r.compile_error);
});
