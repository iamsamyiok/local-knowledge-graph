'use strict';

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const V = require('./validator');
const { DATA_DIR, DB_PATH } = require('./paths');

let db = null;
let version = 0; // 数据版本号（=最新日志id），用于前端实时同步

function open() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 4000;');
  initSchema();
  const ok = integrityCheck();
  if (!ok.ok) throw new Error('数据库完整性校验失败: ' + ok.detail);
  const row = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM operation_logs').get();
  version = row.m;
  return db;
}

function integrityCheck() {
  try {
    const r = db.prepare('PRAGMA integrity_check').get();
    const v = Object.values(r)[0];
    if (v === 'ok') return { ok: true };
    return { ok: false, detail: String(v) };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('物理实体','抽象实体','数值实体','时间实体')),
      attributes TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      source TEXT NOT NULL CHECK(source IN ('手工','OpenCode','文档'))
    );
    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('空间','互动','归属','时间','属性')),
      confidence TEXT NOT NULL DEFAULT '确证' CHECK(confidence IN ('确证','推测','存疑')),
      source_ref TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      source TEXT NOT NULL CHECK(source IN ('手工','OpenCode','文档'))
    );
    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      op_type TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      source TEXT NOT NULL CHECK(source IN ('手工','OpenCode','系统','文档'))
    );
    CREATE INDEX IF NOT EXISTS idx_rel_source ON relations(source_id);
    CREATE INDEX IF NOT EXISTS idx_rel_target ON relations(target_id);
    CREATE TABLE IF NOT EXISTS entity_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_img_entity ON entity_images(entity_id);
    CREATE TABLE IF NOT EXISTS aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      alias TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alias_entity ON aliases(entity_id);
  `);
  migrateEvidence();
  // 旧库迁移：entity_embeddings 已拆分至独立 vectors.db，主库内残留表直接清除
  const allTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((c) => c.name);
  if (allTables.includes('entity_embeddings')) {
    db.exec('DROP TABLE entity_embeddings');
  }
  // 旧库迁移：补 thumb_path 缩略图列
  const imgCols = db.prepare('PRAGMA table_info(entity_images)').all().map((c) => c.name);
  if (!imgCols.includes('thumb_path')) {
    db.exec("ALTER TABLE entity_images ADD COLUMN thumb_path TEXT NOT NULL DEFAULT ''");
  }
}

// ---- 证据链迁移（幂等）：旧库补 relations.confidence/source_ref 列，source 枚举扩展"文档" ----
function tableSql(name) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  return row ? row.sql : '';
}

function rebuildTableWithEnum(table, createSql, copyCols) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`DROP TABLE IF EXISTS ${table}__rebuild`);
  db.exec(createSql);
  db.exec(`INSERT INTO ${table}__rebuild (${copyCols.join(',')}) SELECT ${copyCols.join(',')} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}__rebuild RENAME TO ${table}`);
  if (table === 'relations') {
    db.exec('CREATE INDEX IF NOT EXISTS idx_rel_source ON relations(source_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_rel_target ON relations(target_id)');
  }
  db.exec('PRAGMA foreign_keys = ON');
}

function migrateEvidence() {
  // 1) relations 补 confidence / source_ref 列（CREATE TABLE 已含新列的全新库会直接跳过）
  const relCols = db.prepare('PRAGMA table_info(relations)').all().map((c) => c.name);
  if (relCols.length && !relCols.includes('confidence')) {
    db.exec("ALTER TABLE relations ADD COLUMN confidence TEXT NOT NULL DEFAULT '确证'");
  }
  if (relCols.length && !relCols.includes('source_ref')) {
    db.exec("ALTER TABLE relations ADD COLUMN source_ref TEXT NOT NULL DEFAULT ''");
  }
  // 2) source 枚举扩展"文档"：检测建表语句，缺失则整表重建
  const ENTITIES_NEW = `CREATE TABLE entities__rebuild (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('物理实体','抽象实体','数值实体','时间实体')),
      attributes TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      source TEXT NOT NULL CHECK(source IN ('手工','OpenCode','文档'))
    )`;
  const RELATIONS_NEW = `CREATE TABLE relations__rebuild (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('空间','互动','归属','时间','属性')),
      confidence TEXT NOT NULL DEFAULT '确证' CHECK(confidence IN ('确证','推测','存疑')),
      source_ref TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      source TEXT NOT NULL CHECK(source IN ('手工','OpenCode','文档'))
    )`;
  if (!tableSql('entities').includes("'文档'")) {
    rebuildTableWithEnum('entities', ENTITIES_NEW, ['id', 'name', 'category', 'attributes', 'created_at', 'source']);
  }
  if (!tableSql('relations').includes("'文档'")) {
    rebuildTableWithEnum('relations', RELATIONS_NEW, ['id', 'source_id', 'target_id', 'name', 'category', 'confidence', 'source_ref', 'created_at', 'source']);
  }
  if (!tableSql('operation_logs').includes("'文档'")) {
    const LOGS_NEW = `CREATE TABLE operation_logs__rebuild (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      op_type TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      source TEXT NOT NULL CHECK(source IN ('手工','OpenCode','系统','文档'))
    )`;
    rebuildTableWithEnum('operation_logs', LOGS_NEW, ['id', 'op_type', 'snapshot', 'created_at', 'source']);
    bumpVersion();
  }
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    bumpVersion();
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 保持上一个合规版本 */ }
    throw e;
  }
}

function bumpVersion() {
  const row = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM operation_logs').get();
  version = row.m;
}

function logOp(opType, snapshot, source) {
  const info = db.prepare('INSERT INTO operation_logs (op_type, snapshot, source) VALUES (?, ?, ?)').run(opType, JSON.stringify(snapshot), source);
  version = Number(info.lastInsertRowid);
  return Number(info.lastInsertRowid);
}

function getEntity(id) {
  return db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
}

function listEntities() {
  return db.prepare('SELECT * FROM entities ORDER BY id').all();
}

function getRelation(id) {
  return db.prepare('SELECT * FROM relations WHERE id = ?').get(id);
}

function listRelations() {
  return db.prepare('SELECT * FROM relations ORDER BY id').all();
}

// ---- 核心写操作（无事务，供单笔API与Agent批量事务复用）----
function writeErr(check) {
  const e = new Error('RDF校验未通过: ' + check.errors.join('; '));
  e.status = 400; e.errors = check.errors;
  return e;
}

function addEntityCore(input, source) {
  const check = V.validateEntityInput(input);
  if (!check.ok) throw writeErr(check);
  const v = check.value;
  const info = db.prepare('INSERT INTO entities (name, category, attributes, source) VALUES (?, ?, ?, ?)')
    .run(v.name, v.category, JSON.stringify(v.attributes), source);
  const id = Number(info.lastInsertRowid);
  const row = getEntity(id);
  logOp('ADD_ENTITY', { entity: row }, source);
  return row;
}

function updateEntityCore(id, patch, source) {
  const existing = getEntity(id);
  if (!existing) { const e = new Error(`实体id=${id} 不存在`); e.status = 404; throw e; }
  const check = V.validateEntityPatch(patch, existing);
  if (!check.ok) throw writeErr(check);
  const v = check.value;
  db.prepare('UPDATE entities SET name = ?, category = ?, attributes = ? WHERE id = ?')
    .run(v.name, v.category, JSON.stringify(v.attributes), id);
  const row = getEntity(id);
  logOp('UPDATE_ENTITY', { before: existing, after: row }, source);
  return row;
}

function deleteEntityCore(id, source) {
  const existing = getEntity(id);
  if (!existing) { const e = new Error(`实体id=${id} 不存在`); e.status = 404; throw e; }
  const rels = db.prepare('SELECT * FROM relations WHERE source_id = ? OR target_id = ?').all(id, id);
  for (const r of rels) {
    db.prepare('DELETE FROM relations WHERE id = ?').run(r.id);
    logOp('DELETE_RELATION', { relation: r, reason: `级联删除(实体id=${id})` }, source);
  }
  const imgRows = listEntityImages(id);
  db.prepare('DELETE FROM entity_images WHERE entity_id = ?').run(id);
  db.prepare('DELETE FROM entities WHERE id = ?').run(id);
  logOp('DELETE_ENTITY', { entity: existing, cascaded_relations: rels.length, cascaded_images: imgRows.length }, source);
  return { deleted: existing, cascaded_relations: rels.length, image_files: imgRows.map((r) => r.stored_path) };
}

function addRelationCore(input, source) {
  const check = V.validateRelationInput(input, db);
  if (!check.ok) throw writeErr(check);
  const v = check.value;
  const info = db.prepare('INSERT INTO relations (source_id, target_id, name, category, confidence, source_ref, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(v.source_id, v.target_id, v.name, v.category, v.confidence, v.source_ref, source);
  const id = Number(info.lastInsertRowid);
  const row = getRelation(id);
  logOp('ADD_RELATION', { relation: row }, source);
  return row;
}

function updateRelationCore(id, patch, source) {
  const existing = getRelation(id);
  if (!existing) { const e = new Error(`关系id=${id} 不存在`); e.status = 404; throw e; }
  const check = V.validateRelationPatch(patch, existing, db);
  if (!check.ok) throw writeErr(check);
  const v = check.value;
  db.prepare('UPDATE relations SET source_id = ?, target_id = ?, name = ?, category = ?, confidence = ?, source_ref = ? WHERE id = ?')
    .run(v.source_id, v.target_id, v.name, v.category, v.confidence, v.source_ref, id);
  const row = getRelation(id);
  logOp('UPDATE_RELATION', { before: existing, after: row }, source);
  return row;
}

function deleteRelationCore(id, source) {
  const existing = getRelation(id);
  if (!existing) { const e = new Error(`关系id=${id} 不存在`); e.status = 404; throw e; }
  db.prepare('DELETE FROM relations WHERE id = ?').run(id);
  logOp('DELETE_RELATION', { relation: existing }, source);
  return { deleted: existing };
}

function addEntity(input, source) {
  return tx(() => addEntityCore(input, source));
}

function updateEntity(id, patch, source) {
  return tx(() => updateEntityCore(id, patch, source));
}

function deleteEntity(id, source) {
  return tx(() => deleteEntityCore(id, source));
}

function addRelation(input, source) {
  return tx(() => addRelationCore(input, source));
}

function updateRelation(id, patch, source) {
  return tx(() => updateRelationCore(id, patch, source));
}

function deleteRelation(id, source) {
  return tx(() => deleteRelationCore(id, source));
}

// 实体键解析（id或精确名称；多候选抛409带candidates，供HTTP端点与ask模块共用）
function resolveKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) { const e = new Error('必须提供实体（id或名称）'); e.status = 400; throw e; }
  if (/^\d+$/.test(trimmed)) {
    const byId = getEntity(Number(trimmed));
    if (byId) return byId.id;
  }
  const hits = listEntities().filter((e) => e.name === trimmed);
  if (hits.length === 0) { const e = new Error(`实体"${trimmed}"不存在`); e.status = 404; throw e; }
  if (hits.length > 1) {
    const e = new Error(`实体名"${trimmed}"存在${hits.length}个候选，请改用id`);
    e.status = 409;
    e.candidates = hits.map((h) => ({ id: h.id, name: h.name, category: h.category }));
    throw e;
  }
  return hits[0].id;
}

// ---- 两实体间最短关系链（双向BFS，无向）----
function findPath(fromId, toId, maxHops = 6) {
  if (fromId === toId) {
    const self = getEntity(fromId);
    return self ? { found: true, hops: 0, entities: [self], relations: [] } : { found: false, hops: null, entities: [], relations: [] };
  }
  const adj = new Map();
  const touch = (id) => { if (!adj.has(id)) adj.set(id, []); };
  for (const r of listRelations()) {
    touch(r.source_id); touch(r.target_id);
    adj.get(r.source_id).push(r);
    adj.get(r.target_id).push(r);
  }
  const prev = new Map([[fromId, null]]); // id -> { from, rel }
  let frontier = [fromId];
  for (let d = 0; d < maxHops && frontier.length; d++) {
    const next = [];
    for (const id of frontier) {
      for (const r of adj.get(id) || []) {
        const other = r.source_id === id ? r.target_id : r.source_id;
        if (prev.has(other)) continue;
        prev.set(other, { from: id, rel: r });
        if (other === toId) {
          const rels = [];
          let cur = toId;
          while (prev.get(cur)) { const p = prev.get(cur); rels.unshift(p.rel); cur = p.from; }
          const entities = [getEntity(fromId)];
          for (const rr of rels) {
            const prevId = entities[entities.length - 1].id;
            entities.push(getEntity(rr.source_id === prevId ? rr.target_id : rr.source_id));
          }
          return { found: true, hops: rels.length, entities, relations: rels };
        }
        next.push(other);
      }
    }
    frontier = next;
  }
  return { found: false, hops: null, entities: [], relations: [] };
}

// 多路径枚举：无向BFS，按跳数升序返回至多 limit 条简单路径
function findPaths(fromId, toId, opts = {}) {
  const maxHops = Math.min(6, Math.max(2, Number.isInteger(opts.maxHops) ? opts.maxHops : 4));
  const limit = Math.min(10, Math.max(1, Number.isInteger(opts.limit) ? opts.limit : 5));
  const from = getEntity(fromId);
  const to = getEntity(toId);
  if (!from || !to) return { found: false, paths: [], hint: '起点或终点实体不存在' };
  if (fromId === toId) return { found: true, paths: [{ hops: 0, entities: [from], relations: [] }] };
  const adj = new Map();
  const touch = (id) => { if (!adj.has(id)) adj.set(id, []); };
  for (const r of listRelations()) {
    touch(r.source_id); touch(r.target_id);
    adj.get(r.source_id).push(r);
    adj.get(r.target_id).push(r);
  }
  const paths = [];
  let frontier = [{ id: fromId, entities: [from], relations: [] }];
  const visitedAtDepth = new Map([[fromId, 0]]);
  for (let d = 0; d < maxHops && frontier.length && paths.length < limit; d++) {
    const next = [];
    for (const node of frontier) {
      for (const r of adj.get(node.id) || []) {
        const other = r.source_id === node.id ? r.target_id : r.source_id;
        if (node.entities.some((e) => e.id === other)) continue; // 简单路径：不重复访问
        const entities = [...node.entities, getEntity(other)];
        const relations = [...node.relations, r];
        if (other === toId) {
          paths.push({ hops: relations.length, entities, relations });
          break; // 同层内到达终点即止，更长的绕行路径不扩展
        }
        next.push({ id: other, entities, relations });
      }
    }
    frontier = next;
  }
  paths.sort((a, b) => a.hops - b.hops);
  return { found: paths.length > 0, paths: paths.slice(0, limit), hint: paths.length ? null : `当前跳数上限${maxHops}内无路径` };
}

// ---- 撤销最近一条操作：按快照生成逆向写入，单事务 + 单条UNDO日志 ----
// DELETE_ENTITY 的级联关系/图片不在快照内，仅恢复实体本身（完整恢复请回溯保存点）
// 连续撤销：向后扫描时跳过UNDO日志与其已撤销的目标日志；候选为RESTORE时拦截
function undoLast(source) {
  const logs = db.prepare('SELECT * FROM operation_logs ORDER BY id DESC LIMIT 100').all();
  const undoneIds = new Set();
  for (const l of logs) {
    if (l.op_type !== 'UNDO') continue;
    try { const s = JSON.parse(l.snapshot); if (s.undone_log) undoneIds.add(s.undone_log); } catch (_) { /* 快照异常忽略 */ }
  }
  const last = logs.find((l) => l.op_type !== 'UNDO' && !undoneIds.has(l.id));
  if (!last) { const e = new Error('暂无可撤销的操作'); e.status = 400; throw e; }
  if (last.op_type === 'RESTORE') { const e = new Error('最近的操作是版本回溯，无法撤销，请回溯到更早的保存点'); e.status = 400; throw e; }
  let snap;
  try { snap = JSON.parse(last.snapshot); } catch (_) { const e = new Error('快照解析失败，无法撤销'); e.status = 500; throw e; }
  return tx(() => {
    const caveats = [];
    let summary = '';
    switch (last.op_type) {
      case 'ADD_ENTITY': {
        if (!getEntity(snap.entity.id)) { summary = `实体「${snap.entity.name}」已被后续操作删除，无需撤销`; break; }
        const refs = db.prepare('SELECT * FROM relations WHERE source_id = ? OR target_id = ?').all(snap.entity.id, snap.entity.id);
        for (const rr of refs) db.prepare('DELETE FROM relations WHERE id = ?').run(rr.id);
        db.prepare('DELETE FROM entities WHERE id = ?').run(snap.entity.id);
        summary = `已撤销新增：删除实体「${snap.entity.name}」`;
        if (refs.length) caveats.push(`同时清理了引用该实体的 ${refs.length} 条关系`);
        break;
      }
      case 'UPDATE_ENTITY': {
        if (!getEntity(snap.before.id)) { const e = new Error('实体已不存在，无法撤销更新'); e.status = 409; throw e; }
        db.prepare('UPDATE entities SET name = ?, category = ?, attributes = ? WHERE id = ?')
          .run(snap.before.name, snap.before.category, snap.before.attributes, snap.before.id);
        summary = `已撤销更新：实体「${snap.before.name}」还原为修改前数据`;
        break;
      }
      case 'DELETE_ENTITY': {
        if (getEntity(snap.entity.id)) { summary = `实体「${snap.entity.name}」已重新存在，无需撤销`; break; }
        V.validateEntityInput({ name: snap.entity.name, category: snap.entity.category, attributes: JSON.parse(snap.entity.attributes || '{}') });
        db.prepare('INSERT INTO entities (id, name, category, attributes, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(snap.entity.id, snap.entity.name, snap.entity.category, snap.entity.attributes, snap.entity.source, snap.entity.created_at);
        summary = `已撤销删除：恢复实体「${snap.entity.name}」`;
        if (snap.cascaded_relations > 0) caveats.push(`级联删除的 ${snap.cascaded_relations} 条关系已随快照遗失，如需完整恢复请回溯保存点`);
        break;
      }
      case 'ADD_RELATION': {
        if (!getRelation(snap.relation.id)) { summary = `关系#${snap.relation.id}已被后续操作删除，无需撤销`; break; }
        db.prepare('DELETE FROM relations WHERE id = ?').run(snap.relation.id);
        summary = `已撤销新增：删除关系「${entNameIn(snap.relation.source_id)} —[${snap.relation.name}]→ ${entNameIn(snap.relation.target_id)}」`;
        break;
      }
      case 'UPDATE_RELATION': {
        if (!getRelation(snap.before.id)) { const e = new Error('关系已不存在，无法撤销更新'); e.status = 409; throw e; }
        V.validateRelationInput({ source_id: snap.before.source_id, target_id: snap.before.target_id, name: snap.before.name, category: snap.before.category }, db);
        db.prepare('UPDATE relations SET source_id = ?, target_id = ?, name = ?, category = ? WHERE id = ?')
          .run(snap.before.source_id, snap.before.target_id, snap.before.name, snap.before.category, snap.before.id);
        summary = `已撤销更新：关系#${snap.before.id} [${snap.before.name}] 还原为修改前数据`;
        break;
      }
      case 'DELETE_RELATION': {
        if (getRelation(snap.relation.id)) { summary = `关系#${snap.relation.id}已重新存在，无需撤销`; break; }
        V.validateRelationInput({ source_id: snap.relation.source_id, target_id: snap.relation.target_id, name: snap.relation.name, category: snap.relation.category }, db);
        db.prepare('INSERT INTO relations (id, source_id, target_id, name, category, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(snap.relation.id, snap.relation.source_id, snap.relation.target_id, snap.relation.name, snap.relation.category, snap.relation.source, snap.relation.created_at);
        summary = `已撤销删除：恢复关系「${entNameIn(snap.relation.source_id)} —[${snap.relation.name}]→ ${entNameIn(snap.relation.target_id)}」`;
        break;
      }
      default: { const e = new Error(`未知操作类型 ${last.op_type}，无法撤销`); e.status = 400; throw e; }
    }
    logOp('UNDO', { undone_log: last.id, undone_type: last.op_type, summary, caveats }, source);
    return { undone: { id: last.id, op_type: last.op_type }, summary, caveats };
  });
}

// 撤销摘要里的实体名（撤销时实体可能刚被删，查不到就回退#id）
function entNameIn(id) {
  const m = getEntity(id);
  return m ? `「${m.name}」` : `#${id}`;
}

// 批量应用OpenCode操作（单事务原子提交，任一违规整体回滚，保持上一个合规版本）
// ref占位符解析：add_entity可带ref，后续关系用ref引用新实体
// add_relation 支持按名称引用（source_name/target_name）：主名或别名精确匹配，事务内可见同批新建实体
function applyAgentOps(ops) {
  const applied = [];
  const refMap = {};
  return tx(() => {
    for (let opIdx = 0; opIdx < ops.length; opIdx++) {
      const op = ops[opIdx];
      try {
        if (!op || typeof op !== 'object') throw badOp('每个操作必须为JSON对象');
      switch (op.op) {
        case 'add_entity': {
          const row = addEntityCore({ name: op.name, category: op.category, attributes: op.attributes }, 'OpenCode');
          if (Array.isArray(op.aliases)) {
            // 同事务内联写别名（addAlias 内部自带事务，嵌套会失败）
            for (const raw of op.aliases) {
              const n = cleanAlias(raw);
              if (!n || n.length > 200 || n === row.name) continue;
              const dup = db.prepare('SELECT id FROM aliases WHERE entity_id = ? AND alias = ?').get(row.id, n);
              if (dup) continue;
              if (aliasConflict(n, row.id)) continue;
              const info = db.prepare('INSERT INTO aliases (entity_id, alias) VALUES (?, ?)').run(row.id, n);
              const arow = db.prepare('SELECT id, entity_id, alias, created_at FROM aliases WHERE id = ?').get(Number(info.lastInsertRowid));
              logOp('ADD_ALIAS', { alias: arow }, 'OpenCode');
            }
          }
          if (op.ref !== undefined) {
            if (typeof op.ref !== 'string' || !op.ref.trim()) throw badOp('ref必须为非空字符串');
            refMap[op.ref.trim()] = row.id;
          }
          applied.push({ op: 'add_entity', id: row.id, name: row.name, aliases_added: Array.isArray(op.aliases) ? op.aliases.length : 0 });
          break;
        }
        case 'add_relation': {
          let sid;
          let tid;
          if (op.source_name !== undefined && op.source_id === undefined && op.source_ref === undefined) sid = resolveEntityName(op.source_name);
          else sid = resolveRef(op.source_id, op.source_ref, refMap);
          if (op.target_name !== undefined && op.target_id === undefined && op.target_ref === undefined) tid = resolveEntityName(op.target_name);
          else tid = resolveRef(op.target_id, op.target_ref, refMap);
          const row = addRelationCore({ source_id: sid, target_id: tid, name: op.name, category: op.category, confidence: op.confidence, source_ref: op.evidence_ref }, 'OpenCode');
          applied.push({ op: 'add_relation', id: row.id, name: row.name });
          break;
        }
        case 'update_entity': {
          const patch = {};
          for (const k of ['name', 'category', 'attributes']) if (op[k] !== undefined) patch[k] = op[k];
          const row = updateEntityCore(Number(op.id), patch, 'OpenCode');
          applied.push({ op: 'update_entity', id: row.id, name: row.name });
          break;
        }
        case 'delete_entity': {
          const r = deleteEntityCore(Number(op.id), 'OpenCode');
          applied.push({ op: 'delete_entity', id: Number(op.id), cascaded_relations: r.cascaded_relations });
          break;
        }
        case 'update_relation': {
          const patch = {};
          for (const k of ['source_id', 'target_id', 'name', 'category', 'confidence', 'source_ref']) if (op[k] !== undefined) patch[k] = op[k];
          const row = updateRelationCore(Number(op.id), patch, 'OpenCode');
          applied.push({ op: 'update_relation', id: row.id, name: row.name });
          break;
        }
        case 'delete_relation': {
          deleteRelationCore(Number(op.id), 'OpenCode');
          applied.push({ op: 'delete_relation', id: Number(op.id) });
          break;
        }
        default:
          throw badOp(`未知操作类型"${op.op}"，仅支持 add_entity/add_relation/update_entity/delete_entity/update_relation/delete_relation`);
      }
      } catch (e) {
        const opKind = (op && op.op) || '未知';
        e.message = `第${opIdx + 1}条操作(${opKind})失败: ${e.message}`;
        throw e;
      }
    }
    return applied;
  });

  function resolveRef(idVal, refVal, map) {
    if (refVal !== undefined && refVal !== null) {
      const key = String(refVal).trim();
      if (!map[key]) throw badOp(`ref占位符"${key}"尚未由任何add_entity定义`);
      return map[key];
    }
    const n = Number(idVal);
    if (!Number.isInteger(n) || n <= 0) throw badOp(`source_id/target_id必须为正整数或使用ref占位符`);
    return n;
  }
  // 按名称解析实体id：主名或别名精确匹配；重名返回候选
  function resolveEntityName(name) {
    const hits = findNameConflicts(String(name).trim());
    if (hits.length === 1) return hits[0].id;
    if (hits.length > 1) {
      const e = badOp(`实体名 "${name}" 存在${hits.length}个候选（${hits.map((h) => `id=${h.id}`).join(', ')}），请改用 source_id/target_id`);
      e.candidates = hits.map((h) => ({ id: h.id, name: h.name, category: h.category, via: h.via }));
      throw e;
    }
    throw badOp(`实体 "${name}" 不存在（本批或库中均未找到）`);
  }
  function badOp(msg) { const e = new Error('OpenCode操作校验未通过: ' + msg); e.status = 400; return e; }
}

// ---- 实体图片绑定（资产元数据；文件本体由 server 层存取于 data/uploads/）----
function addEntityImage(entityId, item) {
  if (!getEntity(entityId)) { const e = new Error(`实体id=${entityId} 不存在`); e.status = 404; throw e; }
  if (typeof item.filename !== 'string' || !item.filename.trim()) { const e = new Error('filename必须为非空字符串'); e.status = 400; throw e; }
  if (typeof item.stored_path !== 'string' || !item.stored_path.trim()) { const e = new Error('stored_path必须为非空字符串'); e.status = 400; throw e; }
  const caption = typeof item.caption === 'string' ? item.caption.trim().slice(0, 300) : '';
  const thumbPath = typeof item.thumb_path === 'string' ? item.thumb_path.trim() : '';
  const info = db.prepare('INSERT INTO entity_images (entity_id, filename, stored_path, caption, thumb_path) VALUES (?, ?, ?, ?, ?)')
    .run(entityId, item.filename.trim().slice(0, 200), item.stored_path.trim(), caption, thumbPath);
  return getEntityImage(Number(info.lastInsertRowid));
}

function getEntityImage(id) {
  return db.prepare('SELECT * FROM entity_images WHERE id = ?').get(id);
}

function listEntityImages(entityId) {
  return db.prepare('SELECT * FROM entity_images WHERE entity_id = ? ORDER BY id').all(entityId);
}

function deleteEntityImage(id) {
  const row = getEntityImage(id);
  if (!row) { const e = new Error(`图片绑定id=${id} 不存在`); e.status = 404; throw e; }
  db.prepare('DELETE FROM entity_images WHERE id = ?').run(id);
  return row;
}

// 剪除悬空图片行：.db 文件可迁移，uploads/ 资产不随库走，导入后行指向的文件可能不存在
function pruneMissingImages() {
  const rows = db.prepare('SELECT id, stored_path FROM entity_images').all();
  const missing = rows.filter((r) => !r.stored_path || !fs.existsSync(path.join(DATA_DIR, r.stored_path)));
  const del = db.prepare('DELETE FROM entity_images WHERE id = ?');
  for (const r of missing) del.run(r.id);
  return { pruned: missing.length, paths: missing.map((m) => m.stored_path) };
}

function imageCounts() {
  return db.prepare('SELECT entity_id, COUNT(*) AS count FROM entity_images GROUP BY entity_id').all();
}

// ---- 中心层级子图：双向BFS，level=到中心的最短跳数 ----
function egoSubgraph(centerId, depth) {
  const center = getEntity(centerId);
  if (!center) { const e = new Error(`中心实体id=${centerId} 不存在`); e.status = 404; throw e; }
  const maxDepth = Number.isInteger(depth) && depth > 0 ? depth : Infinity;
  const adj = new Map();
  const touch = (id) => { if (!adj.has(id)) adj.set(id, []); };
  for (const r of listRelations()) {
    touch(r.source_id); touch(r.target_id);
    adj.get(r.source_id).push(r);
    adj.get(r.target_id).push(r);
  }
  const level = new Map([[centerId, 0]]);
  let frontier = [centerId];
  while (frontier.length && level.size <= adj.size) {
    const next = [];
    for (const id of frontier) {
      const cur = level.get(id);
      if (cur >= maxDepth) continue;
      for (const r of adj.get(id) || []) {
        const other = r.source_id === id ? r.target_id : r.source_id;
        if (!level.has(other)) { level.set(other, cur + 1); next.push(other); }
      }
    }
    frontier = next;
  }
  const entities = listEntities()
    .filter((e) => level.has(e.id))
    .map((e) => ({ ...e, level: level.get(e.id) }))
    .sort((a, b) => a.level - b.level || a.id - b.id);
  const relations = listRelations().filter((r) => level.has(r.source_id) && level.has(r.target_id));
  return { center, depth: Number.isFinite(maxDepth) ? maxDepth : null, entities, relations };
}

function getGraph() {
  return { entities: listEntities(), relations: listRelations(), image_counts: imageCounts(), aliases: aliasMap() };
}

// ---- 别名与同名消歧 ----
function cleanAlias(alias) {
  return String(alias === undefined || alias === null ? '' : alias).trim();
}

function listAliases(entityId) {
  return db.prepare('SELECT id, entity_id, alias, created_at FROM aliases WHERE entity_id = ? ORDER BY id').all(entityId);
}

function aliasMap() {
  const map = {};
  for (const row of db.prepare('SELECT entity_id, alias FROM aliases ORDER BY id').all()) {
    (map[row.entity_id] = map[row.entity_id] || []).push(row.alias);
  }
  return map;
}

function aliasRecords() {
  return db.prepare('SELECT id, entity_id, alias, created_at FROM aliases ORDER BY id').all();
}

// 名称占用检测：与任何实体主名或别名一致（trim后精确匹配）
function findNameConflicts(name) {
  const n = cleanAlias(name);
  if (!n) return [];
  const conflicts = [];
  for (const e of db.prepare('SELECT id, name, category FROM entities WHERE name = ?').all(n)) {
    conflicts.push({ id: e.id, name: e.name, category: e.category, via: '主名' });
  }
  for (const row of db.prepare('SELECT a.entity_id, a.alias, e.name, e.category FROM aliases a JOIN entities e ON e.id = a.entity_id WHERE a.alias = ?').all(n)) {
    conflicts.push({ id: row.entity_id, name: row.name, category: row.category, via: `别名(${row.alias})` });
  }
  return conflicts;
}

function aliasConflict(alias, excludeEntityId) {
  const n = cleanAlias(alias);
  if (!n) return null;
  const byName = db.prepare('SELECT id, name, category FROM entities WHERE name = ?').get(n);
  if (byName && byName.id !== excludeEntityId) return { id: byName.id, name: byName.name, category: byName.category, via: '主名' };
  const byAlias = db.prepare('SELECT entity_id, alias FROM aliases WHERE alias = ?').get(n);
  if (byAlias && byAlias.entity_id !== excludeEntityId) {
    const e = getEntity(byAlias.entity_id);
    return { id: e.id, name: e.name, category: e.category, via: `别名(${byAlias.alias})` };
  }
  return null;
}

function addAlias(entityId, alias, source) {
  const e = getEntity(entityId);
  if (!e) { const err = new Error(`实体id=${entityId} 不存在`); err.status = 404; throw err; }
  const n = cleanAlias(alias);
  if (!n) { const err = new Error('别名必须为非空字符串'); err.status = 400; throw err; }
  if (n.length > 200) { const err = new Error('别名长度不得超过200字符'); err.status = 400; throw err; }
  if (n === e.name) { const err = new Error('别名与实体主名相同'); err.status = 400; throw err; }
  const dup = db.prepare('SELECT id, entity_id, alias, created_at FROM aliases WHERE entity_id = ? AND alias = ?').get(entityId, n);
  if (dup) return dup; // 幂等：同一实体同名别名已存在则直接返回
  const conflict = aliasConflict(n, entityId);
  if (conflict) { const err = new Error(`别名"${n}"已被占用`); err.status = 409; err.conflicts = [conflict]; throw err; }
  return tx(() => {
    const info = db.prepare('INSERT INTO aliases (entity_id, alias) VALUES (?, ?)').run(entityId, n);
    const row = db.prepare('SELECT id, entity_id, alias, created_at FROM aliases WHERE id = ?').get(Number(info.lastInsertRowid));
    logOp('ADD_ALIAS', { alias: row }, source);
    return row;
  });
}

function removeAlias(aliasId, source) {
  const row = db.prepare('SELECT id, entity_id, alias FROM aliases WHERE id = ?').get(aliasId);
  if (!row) { const err = new Error(`别名id=${aliasId} 不存在`); err.status = 404; throw err; }
  return tx(() => {
    db.prepare('DELETE FROM aliases WHERE id = ?').run(aliasId);
    logOp('DELETE_ALIAS', { alias: row }, source);
    return { deleted: row };
  });
}

function getLogs(limit = 200) {
  return db.prepare('SELECT * FROM operation_logs ORDER BY id DESC LIMIT ?').all(limit);
}

function maxLogId() {
  return db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM operation_logs').get().m;
}

// 回溯完成后的系统级日志（用于日志与Git提交记录互溯）
function logRestore(hash, backupHash) {
  return tx(() => logOp('RESTORE', { action: '版本回溯', restored_to: hash, backup_savepoint: backupHash || null, counts: counts() }, '系统'));
}

function counts() {
  return {
    entities: db.prepare('SELECT COUNT(*) AS c FROM entities').get().c,
    relations: db.prepare('SELECT COUNT(*) AS c FROM relations').get().c,
    logs: db.prepare('SELECT COUNT(*) AS c FROM operation_logs').get().c,
  };
}

function close() {
  try { if (db) db.close(); } catch (_) { /* ignore */ }
  db = null;
}

function reopen() {
  close();
  return open();
}

// 迷你Cypher子集：MATCH (a)-[r:类型]->(b) [WHERE ...] RETURN ... LIMIT n
// 支持WHERE: a.name含/等值、b.name含、r.name含；RETURN默认边列表。只读实现，供检索页与MCP使用。
function miniCypher(q) {
  const m = q.match(/MATCH\s*\(\s*(\w+)?\s*\)\s*-\s*\[\s*(\w+)?\s*(?::\s*([^\]]+?))?\s*\]\s*->\s*\(\s*(\w+)?\s*\)\s*(WHERE\s+[\s\S]+?)?\s*RETURN\s+([\s\S]+?)(?:\s+LIMIT\s+(\d+))?\s*$/i);
  if (!m) throw new Error('仅支持形如 MATCH (a)-[r:类型]->(b) WHERE ... RETURN ... LIMIT n 的只读查询');
  const [, aVar, , relType, bVar, whereRaw, returnRaw, limitRaw] = m;
  const limit = Math.min(Number(limitRaw) || 100, 500);
  const ents = listEntities();
  const byId = new Map(ents.map((e) => [e.id, e]));
  const nameOf = (id) => (byId.get(id) ? byId.get(id).name : '#' + id);

  const evalCond = (cond, bind) => {
    const c = cond.trim().replace(/^WHERE\s+/i, '');
    const mm = c.match(/^(\w+)\.(name|category|source)\s*(=|~|contains)\s*(.+)$/i) || c.match(/^(\w+)\.(name|category|source)\s+(contains|~|=)\s+(.+)$/i);
    if (!mm) throw new Error(`不支持的WHERE条件: ${c}`);
    const [, varName, field, opRaw, valRaw] = mm;
    const op = opRaw.toLowerCase();
    const node = bind[varName.toLowerCase()];
    if (!node) return false;
    const val = String(valRaw).trim().replace(/^['"]|['"]$/g, '');
    const actual = String(node[field] || '');
    if (op === '=' || op === '==') return actual === val;
    return actual.includes(val); // contains / ~
  };

  let rows = listRelations();
  if (relType && relType.trim()) {
    const types = relType.split('|').map((s) => s.trim().toLowerCase());
    rows = rows.filter((r) => types.includes(String(r.category).toLowerCase()) || types.includes(String(r.name).toLowerCase()));
  }
  const bindVars = {};
  if (aVar) bindVars[aVar.toLowerCase()] = 'source';
  if (bVar) bindVars[bVar.toLowerCase()] = 'target';

  const whereConds = whereRaw ? whereRaw.split(/\s+AND\s+/i) : [];
  const out = [];
  for (const r of rows) {
    const bind = { source: byId.get(r.source_id), target: byId.get(r.target_id), r };
    const getNode = (v) => (bindVars[v] === 'source' ? bind.source : bindVars[v] === 'target' ? bind.target : null);
    let ok = true;
    for (const cond of whereConds) {
      const varName = cond.trim().split('.')[0].replace(/^WHERE\s+/i, '').toLowerCase();
      const sub = { [varName]: getNode(varName), r: bind.r };
      if (!evalCond(cond, sub)) { ok = false; break; }
    }
    if (!ok) continue;
    const retRaw = returnRaw.trim().toLowerCase();
    if (retRaw === 'count(*)' || retRaw.includes('count')) out.push({ count: 1 });
    else out.push({ source: nameOf(r.source_id), relation: r.name, category: r.category, target: nameOf(r.target_id), source_id: r.source_id, target_id: r.target_id, relation_id: r.id });
    if (out.length >= limit) break;
  }
  if (returnRaw.trim().toLowerCase().includes('count')) return [{ count: out.reduce((s, x) => s + (x.count || 1), 0) }];
  return out;
}

module.exports = {
  DATA_DIR, DB_PATH,
  open, close, reopen, integrityCheck,
  getEntity, listEntities, getRelation, listRelations,
  addEntity, updateEntity, deleteEntity,
  addRelation, updateRelation, deleteRelation,
  addEntityImage, getEntityImage, listEntityImages, deleteEntityImage, imageCounts, pruneMissingImages,
  egoSubgraph, findPath, findPaths, resolveKey,
  listAliases, addAlias, removeAlias, aliasMap, aliasRecords, findNameConflicts,
  undoLast,
  miniCypher,
  applyAgentOps, getGraph, getLogs, maxLogId, counts, logRestore,
  getVersion: () => version,
};
