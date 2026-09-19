#!/usr/bin/env node
'use strict';

// kgctl —— local-knowledge-graph 命令行工具集（供人类与外部程序/Agent 调用）
// 直接操作数据目录中的图谱数据库：无需网页服务在运行；服务若在运行会自动感知外部写入并同步页面。
// 完整文档: CLI.md（项目根目录）或运行中的服务 GET /cli
//
// 用法: kgctl <命令> [参数] [选项]   （npm 安装后为全局命令；开发仓库可用 node bin/kgctl.js）
//
// 读取命令: stats get list search cypher ego path paths inference recommend history
// 写入命令: add-entity add-relation update-entity delete-entity add-alias remove-alias ops savepoint undo restore export
//
// 全局选项: --json 机器可读输出 | --data <目录> 指定数据目录 | -h --help
// 退出码: 0成功 / 1未找到或参数错误 / 2名称多义或重名 / 3数据库或IO异常 / 4写入校验失败 / 5缺少确认(补--yes)

// ---- 全局选项须在加载 lib 前解析（--data 影响数据目录解析） ----
const argv = process.argv.slice(2);
const G = { json: false, yes: false, data: null };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') G.json = true;
  else if (a === '--yes') G.yes = true;
  else if (a === '--data') G.data = argv[++i];
  else rest.push(a);
}
if (G.data) process.env.KG_DATA_DIR = G.data;

// 抑制 node:sqlite 实验特性警告，保持 stdout/stderr 干净（便于程序与 Agent 解析输出）
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = (what, ...restArgs) => {
  const msg = typeof what === 'string' ? what : what?.message || '';
  if (/sqlite/i.test(msg)) return;
  return _emitWarning(what, ...restArgs);
};

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const git = require('../lib/git');
const rdf = require('../lib/rdf');
const V = require('../lib/validator');
const inferenceLib = require('../lib/inference');
const recommendLib = require('../lib/recommend');
const embeddings = require('../lib/embeddings');

const CMD = rest.shift();
const HELP = `kgctl —— 本地知识图谱命令行工具集

用法: kgctl <命令> [参数] [选项]
      （npm 安装: kgctl ...；开发仓库: node bin/kgctl.js ...）

读取命令:
  stats                          统计信息（计数/版本/类别枚举/数据目录）
  get <实体id或名称>              实体详情（属性/别名/全部关系）
  list [--category 大类] [--limit N] [--offset N]     实体列表
  search <查询文本> [--top N]    混合检索（语义+关键词，未配向量时仅关键词）
  cypher "<MATCH ... RETURN ...>" 迷你Cypher只读关系查询
  ego <中心实体> [层数]           中心层级子图（层数省略或0=全部）
  path <起点> <终点> [最大跳数]    两实体最短路径
  paths <起点> <终点> [最大跳数]   全部关联路径枚举
  inference [中心实体]            OWL推理隐性关系（传递/对称/逆）
  recommend [中心实体] [--limit N] 关系推荐（共同邻居Adamic-Adar）
  history [条数]                  Git保存点历史

写入命令（全部经RDF校验、记操作日志、自动Git保存点）:
  add-entity <名称> --category <大类> [--attr '<JSON>'] [--alias 别名]...
  add-relation <起点> <终点> --name <关系名> --category <大类>
              [--confidence 确证|推测|存疑] [--evidence 来源引用]
  update-entity <实体> [--name 新名] [--category 新大类] [--attr '<JSON>'](整体替换)
  delete-entity <实体> --yes     删除实体（级联删其关系，需显式确认）
  add-alias <实体> <别名>        add-alias 与 remove-alias <别名行id> 管理别名
  ops '<kg-ops JSON数组>' | ops --file ops.json    批量原子写入（推荐，违规整批回滚）
  savepoint [备注]               手动打保存点
  undo --yes                     撤销最近一次操作（需显式确认）
  restore <hash> --yes           回溯到指定保存点（恢复前自动备份）
  export rdf|html|db <输出文件>   导出 Turtle / 单文件网页 / 整库

实体参数通用规则: 传 数字id 或 精确名称；名称多义时报错列出候选（退出码2）。
全局选项: --json 机读输出 | --data <目录> 指定数据目录（默认与网页服务同一数据）
退出码: 0成功 / 1未找到或参数错误 / 2名称多义或重名 / 3数据库或IO异常 / 4写入校验失败 / 5缺少确认
文档: 项目根目录 CLI.md，或运行中的服务 GET /cli`;

function out(data) {
  if (G.json) console.log(JSON.stringify(data, null, 2));
}
function human(line) { if (!G.json) console.log(line); }

// 统一错误出口：返回进程退出码
function die(e, opts = {}) {
  const candidates = e.candidates || e.conflicts || null;
  if (G.json) {
    console.log(JSON.stringify({ error: e.message, status: e.status || null, candidates, errors: e.errors || undefined }, null, 2));
  } else {
    console.error('错误: ' + (e.message || e));
    if (Array.isArray(candidates)) {
      console.error('候选:');
      for (const c of candidates) console.error(`  id=${c.id} "${c.name}" [${c.category || ''}]`);
    }
    if (Array.isArray(e.errors)) for (const m of e.errors) console.error('  - ' + m);
  }
  if (candidates) return process.exit(2);
  if (e.status === 404 || e.status === 400) return process.exit(opts.write ? 4 : 1);
  return process.exit(3);
}

function needYes(action) {
  if (G.yes) return;
  console.error(`该操作影响数据（${action}），必须显式加 --yes 确认执行。`);
  process.exit(5);
}

// 实体参数 → id（支持 数字id / 精确名称 / 别名；多义 → 退出码2）
function resolve(key) {
  const trimmed = String(key || '').trim();
  try {
    return db.resolveKey(trimmed);
  } catch (e) {
    if (e.status === 404) {
      const amap = db.aliasMap();
      const viaAlias = db.listEntities().filter((en) => (amap[en.id] || []).includes(trimmed));
      if (viaAlias.length === 1) return viaAlias[0].id;
      if (viaAlias.length > 1) {
        e.status = 409;
        e.candidates = viaAlias.map((h) => ({ id: h.id, name: h.name, category: h.category }));
      }
    }
    die(e);
  }
}

function parseAttrs(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let v;
  try { v = JSON.parse(raw); } catch (_) { console.error(`--attr 不是合法JSON: ${raw}`); process.exit(1); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) { console.error('--attr 必须为扁平JSON对象'); process.exit(1); }
  return v;
}

function savepointOrIgnore(title) {
  try { git.savepoint(title, 'CLI'); } catch (_) { /* 数据目录无git时忽略 */ }
}

  // ---------- 命令实现 ----------
  // 重名防护：与 REST /api/entities 行为一致（applyAgentOps 内部不做重名检查）
  function guardDuplicate(name, excludeId) {
    const dup = db.findNameConflicts(name).filter((h) => h.id !== excludeId);
    if (dup.length) {
      const e = new Error(`实体名"${name}"已存在${dup.length}个同名/同名别名实体，请改用其他名称或用 update-entity 复用`);
      e.status = 409;
      e.candidates = dup;
      die(e, { write: true });
    }
  }

  const commands = {
  stats() {
    const c = db.counts();
    const data = {
      ...c,
      version: db.getVersion(),
      entity_categories: V.ENTITY_CATEGORIES,
      relation_categories: V.RELATION_CATEGORIES,
      data_dir: db.DATA_DIR,
      db_path: db.DB_PATH,
    };
    out(data);
    if (!G.json) {
      console.log(`实体 ${c.entities} / 关系 ${c.relations} / 日志 ${c.logs} | 版本 ${data.version}`);
      console.log(`实体大类: ${V.ENTITY_CATEGORIES.join('/')}`);
      console.log(`关系大类: ${V.RELATION_CATEGORIES.join('/')}`);
      console.log(`数据目录: ${db.DATA_DIR}`);
    }
  },

  get(key) {
    if (!key) { console.error('用法: kgctl get <实体id或名称>'); process.exit(1); }
    const id = resolve(key);
    const e = db.getEntity(id);
    const amap = db.aliasMap();
    const relations = db.listRelations().filter((r) => r.source_id === id || r.target_id === id);
    out({ entity: { ...e, aliases: amap[id] || [] }, relations });
    if (!G.json) {
      let attrs = {};
      try { attrs = JSON.parse(e.attributes || '{}'); } catch (_) {}
      console.log(`id=${e.id} "${e.name}" [${e.category}] 来源:${e.source}`);
      console.log(`别名: ${(amap[id] || []).join('、') || '（无）'}`);
      for (const [k, v] of Object.entries(attrs)) console.log(`  ${k}: ${v}`);
      console.log(`关系 ${relations.length} 条:`);
      const nameById = new Map(db.listEntities().map((x) => [x.id, x.name]));
      for (const r of relations) {
        const dir = r.source_id === id ? '→' : '←';
        const other = r.source_id === id ? r.target_id : r.source_id;
        console.log(`  ${dir} (${r.category}/${r.name}${r.confidence && r.confidence !== '确证' ? '/' + r.confidence : ''}) id=${other}"${nameById.get(other)}"`);
      }
    }
  },

  list(pos, o) {
    let ents = db.listEntities();
    if (o.category) ents = ents.filter((e) => e.category === o.category);
    const total = ents.length;
    if (o.offset) ents = ents.slice(Number(o.offset));
    if (o.limit) ents = ents.slice(0, Number(o.limit));
    const amap = db.aliasMap();
    out({ total, count: ents.length, entities: ents.map((e) => ({ ...e, aliases: amap[e.id] || [] })) });
    if (!G.json) for (const e of ents) console.log(`- id=${e.id} "${e.name}" [${e.category}]`);
  },

  async search(pos, o) {
    const q = pos.join(' ');
    if (!q) { console.error('用法: kgctl search <查询文本> [--top N]'); process.exit(1); }
    const r = await embeddings.search(q, Number(o.top) || 10);
    out(r);
    if (!G.json) {
      console.log(`模式: ${r.mode === 'hybrid' ? '语义+关键词融合' : '仅关键词（未配置向量）'}`);
      for (const x of r.results) console.log(`- id=${x.entity.id} "${x.entity.name}" [${x.entity.category}] RRF=${x.rrf_score}`);
    }
  },

  cypher(pos) {
    const q = pos.join(' ');
    if (!q) { console.error('用法: kgctl cypher "MATCH (a)-[r:互动]->(b) WHERE a.name contains 郑和 RETURN a.name, b.name LIMIT 10"'); process.exit(1); }
    const rows = db.miniCypher(q);
    out({ rows });
    if (!G.json) {
      console.log(`命中 ${rows.length} 行:`);
      for (const row of rows) console.log('  ' + JSON.stringify(row));
    }
  },

  ego(pos, o) {
    if (!pos[0]) { console.error('用法: kgctl ego <中心实体> [层数]'); process.exit(1); }
    const id = resolve(pos[0]);
    let depth = null;
    if (pos[1] !== undefined) {
      depth = Number(pos[1]);
      if (!Number.isInteger(depth) || depth < 0) { console.error('层数必须为非负整数'); process.exit(1); }
      if (depth === 0) depth = null;
    }
    const sub = db.egoSubgraph(id, depth);
    out(sub);
    if (!G.json) {
      const nameById = new Map(sub.entities.map((e) => [e.id, e.name]));
      console.log(`中心: "${nameById.get(id)}" | 子图 ${sub.entities.length} 实体 / ${sub.relations.length} 关系`);
      for (const r of sub.relations) console.log(`- e${r.source_id}"${nameById.get(r.source_id)}" --(${r.category}/${r.name})--> e${r.target_id}"${nameById.get(r.target_id)}"`);
    }
  },

  path(pos, o) {
    if (!pos[0] || !pos[1]) { console.error('用法: kgctl path <起点> <终点> [最大跳数]'); process.exit(1); }
    const from = resolve(pos[0]);
    const to = resolve(pos[1]);
    const max = o.max ? Number(o.max) : (pos[2] ? Number(pos[2]) : 6);
    const p = db.findPath(from, to, max);
    out(p);
    if (!G.json) {
      if (!p.found) { console.log('两实体间未找到路径'); return; }
      const nameById = new Map(db.listEntities().map((x) => [x.id, x.name]));
      for (const chain of p.paths || []) {
        const parts = [];
        chain.entities?.forEach((e, idx) => {
          parts.push(`"${e.name || nameById.get(e.id) || e.id}"`);
          const rel = chain.relations?.[idx];
          if (rel) parts.push(`--(${rel.name})-->`);
        });
        console.log('  ' + parts.join(' '));
      }
    }
  },

  paths(pos, o) {
    if (!pos[0] || !pos[1]) { console.error('用法: kgctl paths <起点> <终点> [最大跳数]'); process.exit(1); }
    const from = resolve(pos[0]);
    const to = resolve(pos[1]);
    const max = o.max ? Number(o.max) : (pos[2] ? Number(pos[2]) : 4);
    out(db.findPaths(from, to, { maxHops: max }));
    if (!G.json) {
      const r = db.findPaths(from, to, { maxHops: max });
      console.log(`找到 ${r.paths.length} 条路径`);
    }
  },

  inference(pos, o) {
    const g = db.getGraph();
    let result = inferenceLib.computeInferred(g);
    if (pos[0]) {
      const id = resolve(pos[0]);
      result = result.filter((i) => i.source_id === id || i.target_id === id);
    }
    const byId = new Map(g.entities.map((e) => [e.id, e]));
    const data = { count: result.length, inferred: result.map((i) => ({ ...i, source: byId.get(i.source_id)?.name, target: byId.get(i.target_id)?.name })) };
    out(data);
    if (!G.json) {
      console.log(`推理出 ${data.count} 条隐性关系:`);
      for (const i of data.inferred) console.log(`- "${i.source}" --(${i.name})--> "${i.target}"  规则: ${i.rule}`);
    }
  },

  recommend(pos, o) {
    const g = db.getGraph();
    const opts = { limit: Number(o.limit) || 20 };
    if (pos[0]) opts.centerId = resolve(pos[0]);
    const recs = recommendLib.computeCoNeighborRecs(g, opts);
    out({ recommendations: recs });
    if (!G.json) {
      console.log(`推荐 ${recs.length} 组候选关系:`);
      for (const r of recs) console.log(`- "${r.source_name}" + "${r.target_name}"  共同邻居 ${r.common_count}（${r.common_names.join('、')}） 评分 ${r.score}`);
    }
  },

  history(pos) {
    const list = git.history(Number(pos[0]) || 20);
    out({ commits: list });
    if (!G.json) for (const c of list) console.log(`- ${c.short} ${c.title}`);
  },

  // ---- 写入命令 ----
  'add-entity'(pos, o) {
    const name = pos[0];
    if (!name || !o.category) { console.error('用法: kgctl add-entity <名称> --category <物理实体|抽象实体|数值实体|时间实体> [--attr \'{...}\'] [--alias 别名]...'); process.exit(1); }
    guardDuplicate(name);
    try {
      const applied = db.applyAgentOps([{
        op: 'add_entity', name, category: o.category,
        attributes: parseAttrs(o.attr) || {}, aliases: o.alias || [],
      }]);
      savepointOrIgnore(`CLI写入: 新增实体「${name}」`);
      const row = applied[0];
      out({ id: row.id, name });
      if (!G.json) console.log(`已创建实体 id=${row.id} "${name}" [${o.category}]`);
    } catch (e) { die(e, { write: true }); }
  },

  'add-relation'(pos, o) {
    if (!pos[0] || !pos[1] || !o.name || !o.category) {
      console.error('用法: kgctl add-relation <起点> <终点> --name <关系名> --category <空间|互动|归属|时间|属性> [--confidence 确证|推测|存疑] [--evidence 来源]');
      process.exit(1);
    }
    try {
      const applied = db.applyAgentOps([{
        op: 'add_relation', source_id: resolve(pos[0]), target_id: resolve(pos[1]),
        name: o.name, category: o.category,
        confidence: o.confidence || '确证', evidence_ref: o.evidence || '',
      }]);
      savepointOrIgnore(`CLI写入: 关系「${o.name}」`);
      out({ id: applied[0].id, name: applied[0].name });
      if (!G.json) console.log(`已创建关系 id=${applied[0].id}: ${pos[0]} --(${o.name})--> ${pos[1]}`);
    } catch (e) { die(e, { write: true }); }
  },

  'update-entity'(pos, o) {
    if (!pos[0] || (o.name === undefined && o.category === undefined && o.attr === undefined)) {
      console.error('用法: kgctl update-entity <实体> [--name 新名] [--category 新大类] [--attr \'{...}\']（attributes整体替换）');
      process.exit(1);
    }
    try {
      const id = resolve(pos[0]);
      if (o.name !== undefined) guardDuplicate(o.name, id);
      const op = { op: 'update_entity', id };
      if (o.name !== undefined) op.name = o.name;
      if (o.category !== undefined) op.category = o.category;
      if (o.attr !== undefined) op.attributes = parseAttrs(o.attr);
      const applied = db.applyAgentOps([op]);
      savepointOrIgnore(`CLI写入: 更新实体「${applied[0].name}」`);
      out({ id: applied[0].id, name: applied[0].name });
      if (!G.json) console.log(`已更新实体 id=${applied[0].id} "${applied[0].name}"`);
    } catch (e) { die(e, { write: true }); }
  },

  'delete-entity'(pos) {
    if (!pos[0]) { console.error('用法: kgctl delete-entity <实体> --yes'); process.exit(1); }
    needYes('删除实体并级联删除其关系');
    try {
      const applied = db.applyAgentOps([{ op: 'delete_entity', id: resolve(pos[0]) }]);
      savepointOrIgnore(`CLI写入: 删除实体「${pos[0]}」`);
      out({ deleted: applied[0], cascaded_relations: applied[0].cascaded_relations });
      if (!G.json) console.log(`已删除实体 id=${applied[0].id}（级联关系 ${applied[0].cascaded_relations} 条）`);
    } catch (e) { die(e, { write: true }); }
  },

  'add-alias'(pos) {
    if (!pos[0] || !pos[1]) { console.error('用法: kgctl add-alias <实体> <别名>'); process.exit(1); }
    try {
      const id = resolve(pos[0]);
      const row = db.addAlias(id, pos[1], 'OpenCode');
      savepointOrIgnore(`CLI写入: 别名「${pos[1]}」`);
      out({ alias_id: row.id, entity_id: id, alias: row.alias });
      if (!G.json) console.log(`已添加别名 id=${row.id}: "${pos[1]}" → id=${id}`);
    } catch (e) { die(e, { write: true }); }
  },

  'remove-alias'(pos) {
    if (!pos[0]) { console.error('用法: kgctl remove-alias <别名行id>（用 get 查看别名的行id）'); process.exit(1); }
    try {
      const row = db.removeAlias(Number(pos[0]), 'OpenCode');
      savepointOrIgnore('CLI写入: 移除别名');
      out({ removed: row });
      if (!G.json) console.log(`已移除别名 id=${pos[0]}`);
    } catch (e) { die(e, { write: true }); }
  },

  async ops(pos, o) {
    let raw = o.file ? fs.readFileSync(o.file, 'utf8') : pos.join(' ');
    let ops;
    try { ops = JSON.parse(raw); } catch (e) { console.error('ops 不是合法JSON: ' + e.message); process.exit(1); }
    if (!Array.isArray(ops) || !ops.length) { console.error('ops 必须为非空JSON数组'); process.exit(1); }
    try {
      const applied = db.applyAgentOps(ops);
      savepointOrIgnore(`CLI写入: ${applied.length} 项操作`);
      out({ applied_count: applied.length, applied });
      if (!G.json) {
        console.log(`已应用 ${applied.length} 项操作:`);
        for (const a of applied) console.log(`  - ${a.op}${a.id != null ? ' id=' + a.id : ''}${a.name ? ' "' + a.name + '"' : ''}`);
      }
    } catch (e) { die(e, { write: true }); }
  },

  savepoint(pos) {
    const r = git.savepoint(pos.join(' ') || '', 'CLI');
    out(r);
    if (!G.json) console.log(r.committed === false ? r.message : `保存点已创建: ${r.short || r.hash}`);
  },

  undo() {
    needYes('撤销最近一次操作');
    const r = db.undoLast('系统');
    out({ ok: true, result: r, counts: db.counts() });
    if (!G.json) console.log('已撤销最近一次操作');
  },

  restore(pos) {
    if (!pos[0]) { console.error('用法: kgctl restore <保存点hash> --yes'); process.exit(1); }
    needYes('回溯图谱到历史版本（当前状态自动备份）');
    const r = git.restore(pos[0].trim());
    db.logRestore(r.restored, r.backup);
    out(r);
    if (!G.json) console.log(`已回溯到保存点 ${r.restored}（备份: ${r.backup}）`);
  },

  export(pos) {
    const kind = pos[0];
    const file = pos[1];
    if (!['rdf', 'html', 'db'].includes(kind) || !file) {
      console.error('用法: kgctl export rdf|html|db <输出文件>');
      process.exit(1);
    }
    try {
      let size;
      if (kind === 'rdf') { const t = rdf.exportTurtle(db.getGraph()); fs.writeFileSync(file, t, 'utf8'); size = Buffer.byteLength(t); }
      else if (kind === 'html') { const h = require('../lib/viewer').buildViewerHtml(db.getGraph()); fs.writeFileSync(file, h, 'utf8'); size = Buffer.byteLength(h); }
      else { fs.copyFileSync(db.DB_PATH, file); size = fs.statSync(file).size; }
      out({ file: path.resolve(file), kind, bytes: size });
      if (!G.json) console.log(`已导出 ${kind} → ${path.resolve(file)}（${size} 字节）`);
    } catch (e) { die(e); }
  },
};

// ---------- 参数切分：位置参数 与 命令级选项 ----------
function splitFlags(items) {
  const VALUE_FLAGS = ['--category', '--limit', '--offset', '--top', '--max', '--attr', '--name', '--confidence', '--evidence', '--file'];
  const pos = [];
  const o = {};
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a === '--alias') { (o.alias = o.alias || []).push(items[++i]); continue; }
    if (VALUE_FLAGS.includes(a)) { o[a.slice(2)] = items[++i]; continue; }
    if (a === '--yes' || a === '--json') continue;
    pos.push(a);
  }
  return { pos, o };
}

// ---------- 入口 ----------
async function main() {
  if (!CMD || CMD === '-h' || CMD === '--help' || CMD === 'help') { console.log(HELP); process.exit(0); }
  const fn = commands[CMD];
  if (!fn) { console.error(`未知命令: ${CMD}\n\n${HELP}`); process.exit(1); }
  try {
    db.open(); // 建表/迁移幂等；空库不写示例数据（与服务端行为一致）
  } catch (e) { die(e); }
  const { pos, o } = splitFlags(rest);
  await fn(pos, o);
}

// 直接执行时运行；被单文件可执行入口（bin/exe.js）require 时由其调度
if (require.main === module) {
  main()
    .then(() => { try { db.close(); } catch (_) {} process.exit(0); })
    .catch((e) => { try { db.close(); } catch (_) {} die(e); });
}
module.exports = { main, die };
