'use strict';

// 整库导入校验：SQLite魔数 → 完整性 → 必需表 → 必需列 → 计数与日志水位。
// 独立成模块便于单元测试（构造任意残缺库验证拦截）。

const fs = require('fs');
const os = require('os');
const path = require('path');

const REQUIRED_TABLES = ['entities', 'relations', 'operation_logs'];
const REQUIRED_COLS = {
  entities: ['id', 'name', 'category', 'attributes', 'source', 'created_at'],
  relations: ['id', 'source_id', 'target_id', 'name', 'category', 'source', 'created_at'],
  operation_logs: ['id', 'op_type', 'snapshot', 'source', 'created_at'],
};

function validateImportBuffer(buf) {
  if (!buf || !buf.length) return { ok: false, error: '文件为空' };
  if (buf.length > 200 * 1024 * 1024) return { ok: false, error: '文件超过200MB上限' };
  if (!/^SQLite format 3\x00/.test(buf.toString('latin1', 0, 16))) return { ok: false, error: '该文件不是SQLite数据库' };

  const tmp = path.join(os.tmpdir(), `kg_import_probe_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  fs.writeFileSync(tmp, buf);
  const { DatabaseSync } = require('node:sqlite');
  let probe;
  try {
    probe = new DatabaseSync(tmp);
    const v = Object.values(probe.prepare('PRAGMA integrity_check').get())[0];
    if (v !== 'ok') return { ok: false, error: `数据库完整性校验失败: ${v}` };
    const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const t of REQUIRED_TABLES) {
      if (!tables.includes(t)) return { ok: false, error: `缺少必需的数据表 ${t}，这不是本系统的图谱文件` };
    }
    for (const [t, cols] of Object.entries(REQUIRED_COLS)) {
      const actual = probe.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      const missing = cols.filter((c) => !actual.includes(c));
      if (missing.length) return { ok: false, error: `表 ${t} 缺少必需字段: ${missing.join(', ')}` };
    }
    const importedMaxLog = probe.prepare('SELECT COALESCE(MAX(id),0) AS m FROM operation_logs').get().m;
    const counts = {
      entities: probe.prepare('SELECT COUNT(*) AS c FROM entities').get().c,
      relations: probe.prepare('SELECT COUNT(*) AS c FROM relations').get().c,
      logs: probe.prepare('SELECT COUNT(*) AS c FROM operation_logs').get().c,
    };
    return { ok: true, importedMaxLog, counts };
  } catch (e) {
    return { ok: false, error: '数据库读取失败: ' + e.message };
  } finally {
    try { if (probe) probe.close(); } catch (_) { /* 已关闭 */ }
    try { fs.unlinkSync(tmp); } catch (_) { /* 临时探针文件清理失败可容忍 */ }
  }
}

module.exports = { validateImportBuffer, REQUIRED_TABLES, REQUIRED_COLS };
