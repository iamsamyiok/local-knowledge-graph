#!/usr/bin/env node
'use strict';

// 只读中心层级子图查询工具（供 OpenCode Agent 与命令行使用）
// 用法: node tools/ego.js <中心实体id或名称> [层数] [--json]
//   层数省略 = 全部层级；名称多义时列出候选并以退出码2结束
// 退出码: 0成功 / 1实体不存在或参数错误 / 2名称多义 / 3数据库异常

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { DB_PATH } = require('../lib/paths');

function parseArgs(argv) {
  const args = { center: null, depth: null, json: false };
  for (const a of argv) {
    if (a === '--json') { args.json = true; continue; }
    if (args.center === null) args.center = a;
    else if (args.depth === null) args.depth = a;
  }
  return args;
}

function fail(msg, code) {
  console.error(msg);
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.center) fail('用法: node tools/ego.js <中心实体id或名称> [层数] [--json]', 1);

  let db;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch (e) {
    fail(`无法以只读方式打开数据库 ${DB_PATH}: ${e.message}`, 3);
  }

  let depth = null;
  if (args.depth !== null) {
    depth = Number(args.depth);
    if (!Number.isInteger(depth) || depth < 0) fail('层数必须为非负整数（省略或0表示全部层级）', 1);
    if (depth === 0) depth = null; // 0 = 全部层级
  }

  const centerKey = String(args.center).trim();
  let center = null;
  if (/^\d+$/.test(centerKey)) {
    center = db.prepare('SELECT id, name, category FROM entities WHERE id = ?').get(Number(centerKey)) || null;
  }
  if (!center) {
    const hits = db.prepare('SELECT id, name, category FROM entities WHERE name = ? ORDER BY id').all(centerKey);
    if (hits.length === 0) fail(`实体"${centerKey}"不存在`, 1);
    if (hits.length > 1) {
      console.error(`实体名"${centerKey}"存在${hits.length}个候选，请改用id：`);
      for (const h of hits) console.error(`  id=${h.id} "${h.name}" [${h.category}]`);
      process.exit(2);
    }
    center = hits[0];
  }

  // 双向BFS：level = 到中心的最短跳数
  const maxDepth = depth === null ? Infinity : depth;
  const relations = db.prepare('SELECT id, source_id, target_id, name, category FROM relations ORDER BY id').all();
  const adj = new Map();
  const touch = (id) => { if (!adj.has(id)) adj.set(id, []); };
  for (const r of relations) {
    touch(r.source_id); touch(r.target_id);
    adj.get(r.source_id).push(r);
    adj.get(r.target_id).push(r);
  }
  const level = new Map([[center.id, 0]]);
  let frontier = [center.id];
  while (frontier.length) {
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

  const entities = db.prepare('SELECT id, name, category, attributes, source FROM entities ORDER BY id').all()
    .filter((e) => level.has(e.id))
    .map((e) => ({ ...e, level: level.get(e.id) }));
  const subRels = relations.filter((r) => level.has(r.source_id) && level.has(r.target_id));
  db.close();

  if (args.json) {
    console.log(JSON.stringify({ center: { ...center, level: 0 }, depth: depth === null ? null : depth, entities, relations: subRels }, null, 2));
    return;
  }

  const nameById = new Map(entities.map((e) => [e.id, e.name]));
  console.log(`中心实体: id=${center.id} "${center.name}" [${center.category}]`);
  console.log(`层级范围: ${depth === null ? '全部' : depth} 层 | 子图规模: ${entities.length} 实体 / ${subRels.length} 关系`);
  const byLevel = new Map();
  for (const e of entities) {
    if (!byLevel.has(e.level)) byLevel.set(e.level, []);
    byLevel.get(e.level).push(e);
  }
  for (const lv of [...byLevel.keys()].sort((a, b) => a - b)) {
    console.log(`\n── 第 ${lv} 层（${lv === 0 ? '中心' : `经${lv}跳关联`}）──`);
    for (const e of byLevel.get(lv)) {
      let attrs = {};
      try { attrs = JSON.parse(e.attributes || '{}'); } catch (_) {}
      const a = Object.keys(attrs).length ? ` 属性:${JSON.stringify(attrs)}` : '';
      console.log(`- id=${e.id} "${e.name}" [${e.category}]${a}`);
    }
  }
  console.log('\n── 子图内关系 ──');
  for (const r of subRels) {
    console.log(`- id=${r.id} e${r.source_id}"${nameById.get(r.source_id)}" --(${r.category}/${r.name})--> e${r.target_id}"${nameById.get(r.target_id)}"`);
  }
}

main();
