'use strict';

// 实体向量库：独立 data/vectors.db，不参与图谱保存点/回溯（向量可随时重建，避免二进制BLOB撑爆git差量）。
// 遵循与主库相同的 KG_DATA_DIR/KG_DB_PATH 环境变量约定，测试可完全隔离。

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const { DATA_DIR } = require('./paths');
const VDB_PATH = process.env.KG_VDB_PATH || path.join(DATA_DIR, 'vectors.db');

let vdb = null;

function open() {
  if (vdb) return vdb;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  vdb = new DatabaseSync(VDB_PATH);
  vdb.exec('PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 4000;');
  vdb.exec(`
    CREATE TABLE IF NOT EXISTS entity_embeddings (
      entity_id INTEGER PRIMARY KEY,
      text TEXT NOT NULL,
      vector BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  return vdb;
}

function close() {
  try { if (vdb) vdb.close(); } catch (_) { /* 已关闭 */ }
  vdb = null;
}

function count() {
  return open().prepare('SELECT COUNT(*) AS c FROM entity_embeddings').get().c;
}

function get(entityId) {
  return open().prepare('SELECT * FROM entity_embeddings WHERE entity_id = ?').get(entityId) || null;
}

function all() {
  return open().prepare('SELECT entity_id, text, vector FROM entity_embeddings').all();
}

function upsert(entityId, text, vec) {
  const f32 = Float32Array.from(vec);
  open().prepare(
    `INSERT INTO entity_embeddings(entity_id, text, vector, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(entity_id) DO UPDATE SET text = excluded.text, vector = excluded.vector, updated_at = excluded.updated_at`
  ).run(entityId, text, Buffer.from(f32.buffer));
}

// 实体已删除的向量行清理（主库删除实体后调用，保持两库引用一致）
function pruneOrphans(liveIds) {
  const live = new Set(liveIds);
  const rows = open().prepare('SELECT entity_id FROM entity_embeddings').all();
  const del = open().prepare('DELETE FROM entity_embeddings WHERE entity_id = ?');
  let pruned = 0;
  for (const r of rows) {
    if (!live.has(r.entity_id)) { del.run(r.entity_id); pruned++; }
  }
  return pruned;
}

module.exports = { open, close, count, get, all, upsert, pruneOrphans, VDB_PATH };
