#!/usr/bin/env node
'use strict';

// 只读检索工具（供 OpenCode Agent 与命令行使用）
// 用法:
//   node tools/search.js keyword <关键词> [数量上限，默认10]
//   node tools/search.js cypher "<MATCH (a)-[r:类型]->(b) WHERE ... RETURN ... [LIMIT n]>"
// 退出码: 0成功 / 1参数错误 / 2查询被拒（Cypher语法仅支持只读MATCH） / 3数据库异常

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { DB_PATH } = require('../lib/paths');

function fail(msg, code) {
  console.error(msg);
  process.exit(code);
}

function main() {
  const [mode, a1, a2] = process.argv.slice(2);
  if (!mode) fail('用法: node tools/search.js keyword <词> [topK] | cypher "<MATCH...>"', 1);

  let db;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch (e) {
    fail(`无法以只读方式打开数据库 ${DB_PATH}: ${e.message}`, 3);
  }

  const entities = db.prepare('SELECT * FROM entities ORDER BY id').all();
  const relations = db.prepare('SELECT * FROM relations ORDER BY id').all();
  const byId = new Map(entities.map((e) => [e.id, e]));

  if (mode === 'keyword') {
    const q = String(a1 || '').trim();
    if (!q) fail('keyword模式需要关键词', 1);
    const limit = Math.max(1, Math.min(Number(a2) || 10, 50));
    const terms = q.toLowerCase().split(/\s+/);
    const scored = [];
    for (const e of entities) {
      let score = 0;
      const name = e.name.toLowerCase();
      let attrText = '';
      try { attrText = JSON.stringify(JSON.parse(e.attributes || '{}')); } catch (_) { attrText = String(e.attributes || ''); }
      for (const t of terms) {
        if (name === t) score += 10;
        else if (name.includes(t)) score += 5;
        else if (attrText.toLowerCase().includes(t)) score += 1;
      }
      if (score > 0) scored.push({ e, score });
    }
    scored.sort((x, y) => y.score - x.score);
    const out = scored.slice(0, limit).map(({ e }) => ({
      id: e.id, name: e.name, category: e.category, attributes: e.attributes,
      relations: relations.filter((r) => r.source_id === e.id || r.target_id === e.id)
        .map((r) => `${byId.get(r.source_id)?.name || '#' + r.source_id} —[${r.name}]→ ${byId.get(r.target_id)?.name || '#' + r.target_id}`),
    }));
    console.log(JSON.stringify(out, null, 1));
    return;
  }

  if (mode === 'cypher') {
    const q = String(a1 || '').trim();
    if (!q) fail('cypher模式需要查询语句', 1);
    const { execSync } = require('child_process');
    // 复用主库的miniCypher实现：临时以子进程加载lib/db（其内部有自己的打开逻辑），这里直接内联最小实现
    const m = q.match(/MATCH\s*\(\s*(\w+)?\s*\)\s*-\s*\[\s*(\w+)?\s*(?::\s*([^\]]+?))?\s*\]\s*->\s*\(\s*(\w+)?\s*\)\s*(WHERE\s+[\s\S]+?)?\s*RETURN\s+([\s\S]+?)(?:\s+LIMIT\s+(\d+))?\s*$/i);
    if (!m) fail('仅支持形如 MATCH (a)-[r:类型]->(b) WHERE ... RETURN ... LIMIT n 的只读查询', 2);
    const relType = (m[3] || '').trim();
    const where = (m[5] || '').trim();
    const limit = Math.min(Number(m[7]) || 50, 50);
    const conds = where ? where.replace(/^WHERE\s+/i, '').split(/\s+AND\s+/i) : [];
    const hits = [];
    for (const r of relations) {
      if (relType && r.category !== relType && r.name !== relType) continue;
      const s = byId.get(r.source_id), t = byId.get(r.target_id);
      if (!s || !t) continue;
      let ok = true;
      for (const cond of conds) {
        const cm = cond.match(/(\w+)\.(name|category|source_id|target_id)\s*(=|contains)\s*['"]?([^'"]+?)['"]?\s*$/i);
        if (!cm) { ok = false; break; }
        const [, , field, op, rawVal] = cm;
        const map = { a: s, b: t };
        const node = map[cm[1].toLowerCase()];
        if (!node) { ok = false; break; }
        const val = String(node[field] ?? '');
        const target = op.toLowerCase() === '=' ? rawVal.trim() : rawVal.trim().toLowerCase();
        if (op.toLowerCase() === '=' ? val !== target : !val.toLowerCase().includes(target)) { ok = false; break; }
      }
      if (ok) hits.push({ source: s.name, source_id: s.id, relation: r.name, relation_id: r.id, category: r.category, target: t.name, target_id: t.id });
      if (hits.length >= limit) break;
    }
    console.log(JSON.stringify(hits, null, 1));
    return;
  }

  fail(`未知模式"${mode}"，可用: keyword / cypher`, 1);
}

main();
