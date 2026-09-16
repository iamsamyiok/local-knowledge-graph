'use strict';

// 证据链测试（别名/消歧/置信度/来源/多路径）：node --test test/evidence.test.js
// 隔离策略：KG_DATA_DIR/KG_DB_PATH 指向临时目录；先用旧版建表语句造"遗留库"验证迁移，再测新功能。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg_evidence_'));
process.env.KG_DATA_DIR = TMP;
process.env.KG_DB_PATH = path.join(TMP, 'kg.db');

// ---- 第一阶段：手工构造旧版 schema（无confidence/source_ref、source枚举无"文档"）并预置数据 ----
const legacy = new DatabaseSync(process.env.KG_DB_PATH);
legacy.exec(`
  CREATE TABLE entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('物理实体','抽象实体','数值实体','时间实体')),
    attributes TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    source TEXT NOT NULL CHECK(source IN ('手工','OpenCode'))
  );
  CREATE TABLE relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('空间','互动','归属','时间','属性')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    source TEXT NOT NULL CHECK(source IN ('手工','OpenCode'))
  );
  CREATE TABLE operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    op_type TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    source TEXT NOT NULL CHECK(source IN ('手工','OpenCode','系统'))
  );
  INSERT INTO entities (id, name, category, attributes, source) VALUES
    (1, '郑和', '物理实体', '{}', '手工'),
    (2, '长安', '物理实体', '{}', '手工'),
    (3, '唐朝', '抽象实体', '{}', '手工');
  INSERT INTO relations (id, source_id, target_id, name, category, source) VALUES
    (100, 2, 3, '属于', '归属', '手工');
  INSERT INTO operation_logs (op_type, snapshot, source) VALUES ('LEGACY_SEED', '{}', '系统');
`);
legacy.close();

// ---- 第二阶段：加载 db 模块触发 open + 迁移 ----
const db = require('../lib/db');
db.open();

test('迁移：旧库补列且source枚举扩展，数据逐行保全', () => {
  const relCols = db.prepare ? null : null; // 占位，实际用导出接口断言
  const rel = db.getRelation(100);
  assert.ok(rel, '遗留关系行保留');
  assert.equal(rel.confidence, '确证', '存量关系默认确证');
  assert.equal(rel.source_ref, '');
  assert.equal(db.getEntity(1).name, '郑和');
  const d = new DatabaseSync(process.env.KG_DB_PATH, { readOnly: true });
  const entSql = d.prepare("SELECT sql FROM sqlite_master WHERE name='entities'").get().sql;
  const relSql = d.prepare("SELECT sql FROM sqlite_master WHERE name='relations'").get().sql;
  assert.ok(entSql.includes("'文档'"), 'entities.source 枚举含文档');
  assert.ok(relSql.includes("'文档'"), 'relations.source 枚举含文档');
  assert.ok(relSql.includes('confidence'), 'relations 含 confidence 列');
  d.close();
});

test('迁移幂等：重复open无副作用', () => {
  db.close();
  db.open();
  assert.equal(db.getEntity(1).name, '郑和');
  assert.equal(db.getRelation(100).confidence, '确证');
});

// ---- 别名 ----
test('别名：新增/查询/删除，操作日志落库', () => {
  const a = db.addAlias(1, '三宝太监', '手工');
  assert.equal(a.alias, '三宝太监');
  assert.deepEqual(db.listAliases(1).map((x) => x.alias), ['三宝太监']);
  assert.deepEqual(db.aliasMap()[1], ['三宝太监']);
  db.removeAlias(a.id, '手工');
  assert.equal(db.listAliases(1).length, 0);
});

test('别名冲突：占用主名/他人别名/自身主名均被拒绝', () => {
  assert.throws(() => db.addAlias(1, '长安', '手工'), (e) => e.status === 409);
  db.addAlias(2, '长安旧称', '手工');
  assert.throws(() => db.addAlias(1, '长安旧称', '手工'), (e) => e.status === 409);
  assert.throws(() => db.addAlias(1, '郑和', '手工'), (e) => e.status === 400);
  assert.throws(() => db.addAlias(1, '  ', '手工'), (e) => e.status === 400);
  assert.throws(() => db.addAlias(999, '不存在', '手工'), (e) => e.status === 404);
});

test('findNameConflicts：主名与别名双向命中', () => {
  db.addAlias(2, '西京', '手工');
  const byName = db.findNameConflicts('长安');
  assert.equal(byName.length, 1);
  assert.equal(byName[0].via, '主名');
  const byAlias = db.findNameConflicts('西京');
  assert.equal(byAlias.length, 1);
  assert.equal(byAlias[0].id, 2);
  assert.ok(byAlias[0].via.includes('别名'));
  assert.equal(db.findNameConflicts('不存在的名字').length, 0);
});

// ---- 关系置信度与来源 ----
test('关系：置信度三档与来源引用读写，非法值拒绝', () => {
  const r = db.addRelation({ source_id: 1, target_id: 2, name: '到过', category: '空间', confidence: '推测', source_ref: '《明史》卷304' }, '手工');
  assert.equal(r.confidence, '推测');
  assert.equal(r.source_ref, '《明史》卷304');
  const r2 = db.addRelation({ source_id: 1, target_id: 3, name: '生于', category: '时间' }, '手工');
  assert.equal(r2.confidence, '确证', '缺省确证');
  assert.throws(() => db.addRelation({ source_id: 1, target_id: 2, name: 'x', category: '空间', confidence: '谣言' }, '手工'), (e) => e.status === 400);
  const up = db.updateRelation(r2.id, { confidence: '存疑', source_ref: '待核实' }, '手工');
  assert.equal(up.confidence, '存疑');
  assert.equal(up.source_ref, '待核实');
  assert.throws(() => db.updateRelation(r2.id, { confidence: '胡说' }, '手工'), (e) => e.status === 400);
});

test('getGraph：携带aliases映射与关系置信度', () => {
  db.addAlias(1, '三宝太监', '手工');
  const g = db.getGraph();
  assert.deepEqual(g.aliases[1], ['三宝太监']);
  const rel = g.relations.find((x) => x.name === '到过');
  assert.equal(rel.confidence, '推测');
});

// ---- 多路径 ----
test('findPaths：直达/两跳/无解/跳数夹取/简单路径', () => {
  // 直达：郑和(1)-长安(2) 已有"到过"
  const p1 = db.findPaths(1, 2);
  assert.ok(p1.found);
  assert.equal(p1.paths[0].hops, 1);
  // 两跳：郑和(1)-长安(2)-唐朝(3)
  const p2 = db.findPaths(1, 3);
  assert.ok(p2.found);
  assert.ok(p2.paths[0].hops <= 2);
  assert.ok(p2.paths[0].relations.every((r) => typeof r.confidence === 'string'), '每跳带置信度');
  // 无解：孤立起点
  const lonely = db.addEntity({ name: '孤岛', category: '抽象实体', attributes: {} }, '手工');
  const p3 = db.findPaths(lonely.id, 1);
  assert.equal(p3.found, false);
  assert.equal(p3.paths.length, 0);
  assert.ok(p3.hint);
  // 跳数夹取：上限提示含最大值6
  const p4 = db.findPaths(lonely.id, 2, { maxHops: 99 });
  assert.ok(p4.hint.includes('6'));
  // 简单路径：路径中实体不重复
  for (const p of db.findPaths(1, 3, { maxHops: 6 }).paths) {
    const ids = p.entities.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
  }
});

// ---- RDF导出 ----
test('RDF导出：别名与置信度/来源写入Turtle', () => {
  const rdf = require('../lib/rdf');
  const ttl = rdf.exportTurtle(db.getGraph());
  assert.ok(ttl.includes('kg:alias "三宝太监"'));
  assert.ok(ttl.includes('kg:confidence "推测"'));
  assert.ok(ttl.includes('kg:sourceRef "《明史》卷304"'));
});
