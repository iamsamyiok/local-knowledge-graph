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

/* ---------- 最短路径 ---------- */
test('findPath: 链式/不连通/层数上限', () => {
  const all = db.listEntities();
  const A = all.find((e) => e.name === 'infA'), C = all.find((e) => e.name === 'infC'), D = all.find((e) => e.name === 'egoD'), egoA = all.find((e) => e.name === 'egoA');
  const direct = db.findPath(A.id, C.id, 6); // infA-师从->infC 直连
  assert.ok(direct.found && direct.hops === 1);
  // egoD-位于->egoC-位于(反向)->egoB-位于(反向)->egoA：3跳无向路径
  const chain = db.findPath(D.id, egoA.id, 6);
  assert.ok(chain.found && chain.hops === 3);
  assert.equal(chain.entities.length, 4);
  assert.equal(chain.relations.length, 3);
  // 链上相邻实体首尾衔接
  for (let i = 0; i < chain.relations.length; i++) {
    const s = chain.relations[i].source_id, t = chain.relations[i].target_id;
    const pair = [chain.entities[i].id, chain.entities[i + 1].id];
    assert.ok((s === pair[0] && t === pair[1]) || (s === pair[1] && t === pair[0]));
  }
  // 层数上限拦截
  assert.equal(db.findPath(D.id, egoA.id, 2).found, false);
  // 孤立实体不连通
  const iso1 = db.addEntity({ name: 'isoX1', category: '抽象实体' }, '手工');
  const iso2 = db.addEntity({ name: 'isoY1', category: '抽象实体' }, '手工');
  assert.equal(db.findPath(iso1.id, iso2.id, 6).found, false);
});

/* ---------- 撤销最近操作 ---------- */
test('undoLast: 各类型逆向还原与连续撤销', () => {
  const e1 = db.addEntity({ name: 'undoA', category: '抽象实体', attributes: { 键: '值' } }, '手工');
  const e2 = db.addEntity({ name: 'undoB', category: '抽象实体' }, '手工');

  // 撤销 ADD_RELATION → 关系消失
  const rel = db.addRelation({ source_id: e1.id, target_id: e2.id, name: '位于', category: '空间' }, '手工');
  let r = db.undoLast('手工');
  assert.equal(r.undone.op_type, 'ADD_RELATION');
  assert.equal(db.getRelation(rel.id), undefined);

  // 连续撤销：撤销 DELETE_RELATION → 恢复原id（先重建一条并删除）
  const rel2 = db.addRelation({ source_id: e1.id, target_id: e2.id, name: '位于', category: '空间' }, '手工');
  db.deleteRelation(rel2.id, '手工');
  r = db.undoLast('手工');
  assert.equal(r.undone.op_type, 'DELETE_RELATION');
  assert.ok(db.getRelation(rel2.id), '关系应以原id恢复');

  // 撤销 UPDATE_ENTITY → 字段还原
  db.updateEntity(e1.id, { name: 'undoA改' }, '手工');
  r = db.undoLast('手工');
  assert.equal(r.undone.op_type, 'UPDATE_ENTITY');
  assert.equal(db.getEntity(e1.id).name, 'undoA');

  // 撤销 DELETE_ENTITY → 实体原id恢复 + 级联遗失提示
  const delInfo = db.deleteEntity(e2.id, '手工');
  assert.ok(delInfo.cascaded_relations >= 1);
  r = db.undoLast('手工');
  assert.equal(r.undone.op_type, 'DELETE_ENTITY');
  assert.ok(db.getEntity(e2.id), '实体应以原id恢复');
  assert.ok(r.caveats.length >= 1, '应提示级联关系需回溯恢复');

  // 顺序撤销沿历史逆放：恢复级联关系 → 撤销其原始新增 → 撤销undoB/undoA的新增
  r = db.undoLast('手工');
  assert.equal(r.undone.op_type, 'DELETE_RELATION');
  assert.ok(db.getRelation(rel2.id), '级联删除的关系应先被恢复');

  r = db.undoLast('手工');
  assert.equal(r.undone.op_type, 'ADD_RELATION');
  assert.equal(db.getRelation(rel2.id), undefined);

  r = db.undoLast('手工');
  assert.equal(r.undone.op_type, 'ADD_ENTITY');
  assert.equal(db.getEntity(e2.id), undefined);

  r = db.undoLast('手工');
  assert.equal(r.undone.op_type, 'ADD_ENTITY');
  assert.equal(db.getEntity(e1.id), undefined);
});

/* ---------- 向量独立库 ---------- */
test('vectors: 独立于主库读写与孤儿清理', () => {
  const vectors = require('../lib/vectors');
  const expectedPath = process.env.KG_VDB_PATH || path.join(TMP, 'vectors.db');
  vectors.open();
  vectors.upsert(101, '文本甲', [0.1, 0.2]);
  vectors.upsert(102, '文本乙', [0.3]);
  vectors.upsert(102, '文本乙改', [0.4, 0.5]); // upsert覆盖
  assert.equal(vectors.count(), 2);
  assert.equal(vectors.get(102).text, '文本乙改');
  assert.equal(vectors.all().length, 2);
  assert.equal(vectors.pruneOrphans([102]), 1); // 101成孤儿
  assert.equal(vectors.count(), 1);
  vectors.close();
  assert.ok(fs.existsSync(expectedPath), '向量库应独立存放于 ' + expectedPath);
  // 主库中不应再有entity_embeddings表
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(process.env.KG_DB_PATH, { readOnly: true });
  const names = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  d.close();
  assert.equal(names.includes('entity_embeddings'), false);
});

/* ---------- 悬空图片行剪除 ---------- */
test('db: pruneMissingImages剔除文件缺失的图片行', () => {
  const e = db.addEntity({ name: '图测实体', category: '抽象实体' }, '手工');
  const realFile = path.join(TMP, 'uploads');
  fs.mkdirSync(realFile, { recursive: true });
  fs.writeFileSync(path.join(realFile, 'real.png'), 'x');
  db.addEntityImage(e.id, { filename: 'real.png', stored_path: 'uploads/real.png' });
  db.addEntityImage(e.id, { filename: 'ghost.png', stored_path: 'uploads/ghost.png' });
  const r = db.pruneMissingImages();
  assert.equal(r.pruned, 1);
  assert.deepEqual(r.paths, ['uploads/ghost.png']);
  const left = db.listEntityImages(e.id);
  assert.equal(left.length, 1);
  assert.equal(left[0].stored_path, 'uploads/real.png');
});

/* ---------- 关系图片绑定 ---------- */
test('db: 关系图片增删查与404校验', () => {
  const e1 = db.addEntity({ name: '关图源', category: '抽象实体' }, '手工');
  const e2 = db.addEntity({ name: '关图标', category: '抽象实体' }, '手工');
  const rel = db.addRelation({ source_id: e1.id, target_id: e2.id, name: '关图关系', category: '互动' }, '手工');
  assert.equal(db.listRelationImages(rel.id).length, 0);
  const img = db.addRelationImage(rel.id, { filename: 'chart.png', stored_path: 'uploads/r1/chart.png', caption: '示意图', thumb_path: 'uploads/r1/t.png' });
  assert.equal(img.relation_id, rel.id);
  assert.equal(img.caption, '示意图');
  assert.equal(db.getRelationImage(img.id).stored_path, 'uploads/r1/chart.png');
  assert.equal(db.listRelationImages(rel.id).length, 1);
  // 不存在的关系/图片行 → 404
  assert.throws(() => db.addRelationImage(99999, { filename: 'x.png', stored_path: 'uploads/x.png' }), /404|不存在/);
  assert.throws(() => db.deleteRelationImage(99999), /404|不存在/);
  const del = db.deleteRelationImage(img.id);
  assert.equal(del.id, img.id);
  assert.equal(db.listRelationImages(rel.id).length, 0);
});

test('db: 删除关系时relation_images行级联清除', () => {
  const e1 = db.addEntity({ name: '级联源', category: '抽象实体' }, '手工');
  const e2 = db.addEntity({ name: '级联标', category: '抽象实体' }, '手工');
  const rel = db.addRelation({ source_id: e1.id, target_id: e2.id, name: '级联关系', category: '互动' }, '手工');
  db.addRelationImage(rel.id, { filename: 'a.png', stored_path: 'uploads/ra.png' });
  db.addRelationImage(rel.id, { filename: 'b.png', stored_path: 'uploads/rb.png' });
  db.deleteRelation(rel.id, '手工');
  assert.equal(db.listRelationImages(rel.id).length, 0);
});
