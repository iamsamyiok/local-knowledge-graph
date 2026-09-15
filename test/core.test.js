'use strict';

// 核心链路测试：node --test test/
// 隔离策略：KG_DATA_DIR/KG_DB_PATH 指向临时目录，绝不触碰真实 data/kg.db。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg_test_'));
process.env.KG_DATA_DIR = TMP;
process.env.KG_DB_PATH = path.join(TMP, 'kg.db');

const db = require('../lib/db');
const V = require('../lib/validator');
const inference = require('../lib/inference');
const importer = require('../lib/importer');
const rdf = require('../lib/rdf');
const viewer = require('../lib/viewer');

const handle = db.open(); // 原始 DatabaseSync 句柄（validator 需要 .prepare）

/* ---------- 校验器 ---------- */
test('validator: 合法实体通过', () => {
  const r = V.validateEntityInput({ name: '测试实体', category: '抽象实体', attributes: { 键: '值' } });
  assert.equal(r.ok, true);
  assert.equal(r.value.name, '测试实体');
});

test('validator: 非法大类/空名称被拒', () => {
  assert.equal(V.validateEntityInput({ name: 'X', category: '人物' }).ok, false);
  assert.equal(V.validateEntityInput({ name: '', category: '抽象实体' }).ok, false);
  assert.equal(V.validateEntityInput({ name: 'X', category: '抽象实体', attributes: { a: { nested: 1 } } }).ok, false);
});

test('validator: 关系引用必须存在', () => {
  const e1 = db.addEntity({ name: '甲', category: '物理实体' }, '手工');
  assert.equal(V.validateRelationInput({ source_id: e1.id, target_id: 999999, name: '位于', category: '空间' }, handle).ok, false);
  assert.equal(V.validateRelationInput({ source_id: e1.id, target_id: e1.id, name: '位于', category: '错误类' }, handle).ok, false);
});

/* ---------- CRUD 与回滚 ---------- */
test('db: 实体/关系CRUD与日志留痕', () => {
  const e1 = db.addEntity({ name: '长安', category: '物理实体', attributes: { 朝代: '唐' } }, '手工');
  const e2 = db.addEntity({ name: '大雁塔', category: '物理实体' }, '手工');
  const r = db.addRelation({ source_id: e2.id, target_id: e1.id, name: '位于', category: '空间' }, '手工');
  assert.ok(r.id > 0);
  const up = db.updateRelation(r.id, { name: '坐落于' }, '手工');
  assert.equal(up.name, '坐落于');
  assert.ok(db.counts().logs >= 4);
  const logs = db.getLogs(10);
  assert.ok(logs.some((l) => l.op_type === 'ADD_RELATION'));
});

test('db: 违规写入整体回滚，库保持上个合规版本', () => {
  const before = db.getVersion();
  assert.throws(() => db.addEntity({ name: '坏数据', category: '不存在类' }, '手工'));
  assert.equal(db.getVersion(), before);
  assert.equal(db.listEntities().some((e) => e.name === '坏数据'), false);
});

/* ---------- ego 子图 ---------- */
test('db: egoSubgraph 双向BFS与层级', () => {
  const a = db.addEntity({ name: 'egoA', category: '抽象实体' }, '手工');
  const b = db.addEntity({ name: 'egoB', category: '抽象实体' }, '手工');
  const c = db.addEntity({ name: 'egoC', category: '抽象实体' }, '手工');
  const d = db.addEntity({ name: 'egoD', category: '抽象实体' }, '手工');
  db.addRelation({ source_id: b.id, target_id: a.id, name: '位于', category: '空间' }, '手工'); // B->A
  db.addRelation({ source_id: b.id, target_id: c.id, name: '包含', category: '归属' }, '手工'); // B->C
  db.addRelation({ source_id: d.id, target_id: c.id, name: '位于', category: '空间' }, '手工'); // D->C（2跳）
  const ego1 = db.egoSubgraph(b.id, 1);
  assert.deepEqual(ego1.entities.map((e) => e.name).sort(), ['egoA', 'egoB', 'egoC']);
  const egoAll = db.egoSubgraph(b.id, null);
  assert.equal(egoAll.entities.length, 4);
  const cNode = egoAll.entities.find((e) => e.name === 'egoC');
  assert.equal(cNode.level, 1);
  const dNode = egoAll.entities.find((e) => e.name === 'egoD');
  assert.equal(dNode.level, 2);
});

/* ---------- 推理引擎 ---------- */
test('inference: 传递/对称/逆规则与via路径', () => {
  const a = db.addEntity({ name: 'infA', category: '抽象实体' }, '手工');
  const b = db.addEntity({ name: 'infB', category: '抽象实体' }, '手工');
  const c = db.addEntity({ name: 'infC', category: '抽象实体' }, '手工');
  db.addRelation({ source_id: a.id, target_id: b.id, name: '位于', category: '空间' }, '手工');
  db.addRelation({ source_id: b.id, target_id: c.id, name: '位于', category: '空间' }, '手工');
  db.addRelation({ source_id: a.id, target_id: b.id, name: '挚友', category: '互动' }, '手工');
  db.addRelation({ source_id: a.id, target_id: c.id, name: '师从', category: '互动' }, '手工');

  const graph = db.getGraph();
  const inferred = inference.computeInferred(graph);
  const key = (i) => `${i.source_id}|${i.target_id}|${i.name}`;
  const map = new Map(inferred.map((i) => [key(i), i]));

  // 传递：infA -位于-> infC（via两段且连续）
  const trans = map.get(`${a.id}|${c.id}|位于`);
  assert.ok(trans, '应推出传递关系');
  const relById = new Map(graph.relations.map((r) => [r.id, r]));
  const chain = trans.via.map((id) => relById.get(id));
  assert.equal(chain.length, 2);
  assert.equal(chain[0].target_id, chain[1].source_id);
  assert.equal(chain[1].target_id, c.id);

  // 对称：infB -挚友-> infA
  assert.ok(map.has(`${b.id}|${a.id}|挚友`), '应推出对称关系');

  // 逆：infC -学生为-> infA（师从↔学生为）
  const inv = map.get(`${c.id}|${a.id}|学生为`);
  assert.ok(inv, '应推出逆关系');
  assert.ok(inv.rule.includes('师从'));

  // 显式关系不重复输出
  const explicitKeys = new Set(graph.relations.map((r) => `${r.source_id}|${r.target_id}|${r.name}`));
  for (const i of inferred) assert.equal(explicitKeys.has(key(i)), false);
});

/* ---------- 迷你Cypher ---------- */
test('miniCypher: 类型过滤/WHERE/limit/拦截', () => {
  const rows = db.miniCypher('MATCH (a)-[r:空间]->(b) RETURN a, r, b LIMIT 5');
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((x) => x.category === '空间'));
  const named = db.miniCypher('MATCH (a)-[r]->(b) WHERE a.name contains infA RETURN a.name, r.name');
  assert.ok(named.length >= 1);
  assert.throws(() => db.miniCypher('DELETE FROM entities'));
  assert.throws(() => db.miniCypher('随便一句话'));
});

/* ---------- 导入校验 ---------- */
test('importer: 残缺库各层级拦截', () => {
  const { DatabaseSync } = require('node:sqlite');
  assert.equal(importer.validateImportBuffer(Buffer.from('not a db')).ok, false);
  assert.equal(importer.validateImportBuffer(Buffer.alloc(0)).ok, false);

  // 缺表
  const p1 = path.join(TMP, 'no_tables.db');
  const d1 = new DatabaseSync(p1);
  d1.exec('CREATE TABLE other (x INTEGER)');
  d1.close();
  assert.match(importer.validateImportBuffer(fs.readFileSync(p1)).error, /缺少必需的数据表/);

  // 缺列（表存在但字段残缺）
  const p2 = path.join(TMP, 'no_cols.db');
  const d2 = new DatabaseSync(p2);
  d2.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY, name TEXT)');
  d2.exec('CREATE TABLE relations (id INTEGER PRIMARY KEY)');
  d2.exec('CREATE TABLE operation_logs (id INTEGER PRIMARY KEY)');
  d2.close();
  const r2 = importer.validateImportBuffer(fs.readFileSync(p2));
  assert.equal(r2.ok, false);
  assert.match(r2.error, /缺少必需字段/);
});

test('importer: 合法空库通过校验', () => {
  const { DatabaseSync } = require('node:sqlite');
  const p = path.join(TMP, 'ok.db');
  const d = new DatabaseSync(p);
  d.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, category TEXT, attributes TEXT, source TEXT, created_at TEXT);
    CREATE TABLE relations (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER, target_id INTEGER, name TEXT, category TEXT, source TEXT, created_at TEXT);
    CREATE TABLE operation_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, op_type TEXT, snapshot TEXT, source TEXT, created_at TEXT);`);
  d.close();
  const r = importer.validateImportBuffer(fs.readFileSync(p));
  assert.equal(r.ok, true);
  assert.deepEqual(r.counts, { entities: 0, relations: 0, logs: 0 });
});

/* ---------- RDF 与查看器 ---------- */
test('rdf/viewer: 导出包含实体与转义', () => {
  const g = db.getGraph();
  const ttl = rdf.exportTurtle(g);
  assert.ok(ttl.includes('infA'));
  const html = viewer.buildViewerHtml(g);
  assert.ok(html.includes('const GRAPH ='));
  assert.ok(html.includes('THREE'), 'three.js应被内联');
});
