'use strict';

// 文档批量入图：上传 md/txt/pdf → 分片 → LLM抽取候选三元组 → 人工审核 → 批量入库
// 任务持久化于 data/ingest_tasks/<id>.json，服务重启后 review 态可继续。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./paths');
const db = require('./db');
const agent = require('./agent');

const TASK_DIR = path.join(DATA_DIR, 'ingest_tasks');
const MAX_SIZE = 10 * 1024 * 1024;
const CHUNK_SIZE = 3000;
const ACCEPT = ['.md', '.markdown', '.txt', '.pdf'];
const CONFIDENCE = ['确证', '推测', '存疑'];

const tasks = new Map(); // id -> task

function ensureDir() { fs.mkdirSync(TASK_DIR, { recursive: true }); }

function persist(task) {
  ensureDir();
  fs.writeFileSync(path.join(TASK_DIR, task.id + '.json'), JSON.stringify(task, null, 2));
}

function loadPersisted() {
  ensureDir();
  for (const f of fs.readdirSync(TASK_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const t = JSON.parse(fs.readFileSync(path.join(TASK_DIR, f), 'utf8'));
      if (t.status === 'extracting' || t.status === 'parsing') t.status = 'interrupted';
      tasks.set(t.id, t);
    } catch (_) { /* 损坏任务文件跳过 */ }
  }
}

function listTasks() {
  return [...tasks.values()]
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .map((t) => ({ id: t.id, filename: t.filename, status: t.status, chunks_total: t.chunks_total, failed_chunks: (t.failed_chunks || []).length, entity_count: t.candidates.entities.length, relation_count: t.candidates.relations.length, created_at: t.created_at, error: t.error || null }));
}

function getTask(id) { return tasks.get(id) || null; }

// ---------- 解析与分片 ----------
async function extractText(filename, buffer) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const r = await pdfParse(buffer);
    return r.text || '';
  }
  return buffer.toString('utf8');
}

function chunkText(text) {
  const paras = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if (p.length > CHUNK_SIZE) {
      if (cur) { chunks.push(cur); cur = ''; }
      for (let i = 0; i < p.length; i += CHUNK_SIZE) chunks.push(p.slice(i, i + CHUNK_SIZE));
      continue;
    }
    if ((cur + '\n\n' + p).length > CHUNK_SIZE) { chunks.push(cur); cur = p; }
    else cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ---------- LLM 抽取 ----------
function extractPrompt(chunk) {
  return `你是三元组抽取器。禁止调用任何工具、禁止写入图谱、禁止执行操作，只阅读文本并直接输出JSON。
严格输出JSON（禁止多余文字/代码块标记/解释），结构：
{"entities":[{"name":"实体名","category":"物理实体|抽象实体|数值实体|时间实体","attributes":{"扁平键":"原子值"},"aliases":["别名"]}],"relations":[{"from":"起点实体名","to":"终点实体名","name":"关系名","category":"空间|互动|归属|时间|属性","confidence":"确证|推测|存疑"}]}
要求：实体类别从4类中选最贴切的一种；关系类别从5类中选；confidence按文本依据强度标注，无把握用"推测"；属性值只能是字符串/数值/布尔；只依据文本内容，禁止编造；没有可抽取内容时输出 {"entities":[],"relations":[]}。

文本：
${chunk}`;
}

function safeParseJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) t = m[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch (_) {
    try { return JSON.parse(t.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1')); } catch (_) { return null; }
  }
}

function normalizeCandidates(raw, filename, chunkIdx) {
  const srcRef = `《${filename}》片段${chunkIdx + 1}`;
  const entities = [];
  const relations = [];
  if (raw && Array.isArray(raw.entities)) {
    for (const e of raw.entities) {
      if (!e || typeof e.name !== 'string' || !e.name.trim()) continue;
      entities.push({
        name: e.name.trim(),
        category: ['物理实体', '抽象实体', '数值实体', '时间实体'].includes(e.category) ? e.category : '抽象实体',
        attributes: (e.attributes && typeof e.attributes === 'object' && !Array.isArray(e.attributes)) ? e.attributes : {},
        aliases: Array.isArray(e.aliases) ? e.aliases.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()).slice(0, 10) : [],
        existing_id: null,
        selected: true,
      });
    }
  }
  if (raw && Array.isArray(raw.relations)) {
    for (const r of raw.relations) {
      if (!r || typeof r.from !== 'string' || typeof r.to !== 'string' || typeof r.name !== 'string') continue;
      if (!r.from.trim() || !r.to.trim() || !r.name.trim()) continue;
      relations.push({
        from: r.from.trim(),
        to: r.to.trim(),
        name: r.name.trim(),
        category: ['空间', '互动', '归属', '时间', '属性'].includes(r.category) ? r.category : '属性',
        confidence: CONFIDENCE.includes(r.confidence) ? r.confidence : '推测',
        source_ref: srcRef,
        existing_relation: null,
        selected: true,
      });
    }
  }
  return { entities, relations };
}

// 实体自动匹配：主名→别名（同时检测候选之间重复）
// 索引值区分两种命中：{entity_id} 指向现有实体；{cand} 指向候选下标
function matchEntities(task) {
  const nameIndex = new Map();
  for (const e of db.listEntities()) {
    nameIndex.set(e.name, { entity_id: e.id });
    for (const a of db.listAliases(e.id)) if (!nameIndex.has(a.alias)) nameIndex.set(a.alias, { entity_id: e.id });
  }
  task.candidates.entities.forEach((c, i) => {
    if (nameIndex.has(c.name)) {
      const v = nameIndex.get(c.name);
      if (v.entity_id !== undefined) { c.existing_id = v.entity_id; return; }
      c.existing_id = v.cand;
      c.dupe_of_candidate = true;
      return;
    }
    nameIndex.set(c.name, { cand: i });
    for (const a of c.aliases) if (!nameIndex.has(a)) nameIndex.set(a, { cand: i });
  });
  const resolve = (name) => {
    const v = nameIndex.get(name);
    return v ? { ...v } : null;
  };
  for (const r of task.candidates.relations) {
    r.from_ref = resolve(r.from);
    r.to_ref = resolve(r.to);
    r.unresolved = !r.from_ref || !r.to_ref;
  }
}

// ---------- 任务流程 ----------
async function createTask(filename, buffer, opts = {}) {
  const { runPlain, autoCommit = false } = opts;
  const ext = path.extname(filename || '').toLowerCase();
  if (!ACCEPT.includes(ext)) { const e = new Error(`仅支持 ${ACCEPT.join(' / ')} 格式`); e.status = 400; throw e; }
  if (!buffer || buffer.length > MAX_SIZE) { const e = new Error('文件超过10MB上限'); e.status = 413; throw e; }

  const dupCount = [...tasks.values()].filter((t) => t.filename === filename).length;
  const task = {
    id: crypto.randomBytes(6).toString('hex'),
    filename,
    display_name: dupCount ? `${filename}（第${dupCount + 1}次导入）` : filename,
    status: 'parsing',
    chunks_total: 0,
    failed_chunks: [],
    candidates: { entities: [], relations: [] },
    auto_commit: !!autoCommit,
    created_at: new Date().toISOString(),
    committed_at: null,
    error: null,
  };
  tasks.set(task.id, task);
  storeUpload(task.id, filename, buffer);
  persist(task);

  // 异步执行，接口立即返回任务id；抽取走只读模式，杜绝Agent写库
  run(task, buffer, runPlain || ((p, t) => agent.runPlain(p, t || 180000, { KG_MCP_READONLY: '1' })))
    .catch((e) => {
      task.status = 'failed';
      task.error = e.message;
      persist(task);
    })
    .finally(() => { if (typeof opts.onSettled === 'function') { try { opts.onSettled(); } catch (_) {} } });
  return { id: task.id, status: task.status };
}

async function run(task, buffer, runPlain) {
  // 1) 解析
  let text;
  try {
    text = await extractText(task.filename, buffer);
  } catch (e) {
    task.status = 'failed';
    task.error = '文档解析失败: ' + e.message;
    persist(task);
    return;
  }
  if (!text.trim()) {
    task.status = 'failed';
    task.error = '文档无可提取文本';
    persist(task);
    return;
  }
  const chunks = chunkText(text);
  task.chunks_total = chunks.length;
  task.status = 'extracting';
  persist(task);

  // 2) 逐片抽取
  const raws = [];
  task.chunk_errors = task.chunk_errors || [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const out = await runPlain(extractPrompt(chunks[i]));
      const outText = typeof out === 'string' ? out : (out && out.ok === false ? null : String((out && out.text) || ''));
      if (outText === null) { task.chunk_errors.push({ chunk: i, error: (out && out.error) || '空结果' }); task.failed_chunks.push(i); continue; }
      const parsed = safeParseJson(outText);
      if (!parsed) { task.chunk_errors.push({ chunk: i, error: 'LLM输出无法解析为JSON：' + outText.slice(0, 120) }); task.failed_chunks.push(i); continue; }
      raws.push(normalizeCandidates(parsed, task.filename, i));
    } catch (e) {
      task.chunk_errors.push({ chunk: i, error: e.message });
      task.failed_chunks.push(i);
      if (i === chunks.length - 1 && !raws.length && e.message && /超时|timeout/i.test(e.message)) {
        task.error = 'LLM调用超时: ' + e.message;
      }
    }
  }
  // 3) 合并候选（同名实体去重合并别名）
  for (const r of raws) {
    for (const e of r.entities) {
      const exist = task.candidates.entities.find((x) => x.name === e.name);
      if (exist) { for (const a of e.aliases) if (!exist.aliases.includes(a)) exist.aliases.push(a); for (const [k, v] of Object.entries(e.attributes)) if (!(k in exist.attributes)) exist.attributes[k] = v; }
      else task.candidates.entities.push(e);
    }
    task.candidates.relations.push(...r.relations);
  }
  // 关系去重（from+name+to）
  const seen = new Set();
  task.candidates.relations = task.candidates.relations.filter((r) => {
    const key = `${r.from}|${r.name}|${r.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  matchEntities(task);

  if (!task.candidates.entities.length && !task.candidates.relations.length) {
    task.status = 'failed';
    task.error = task.failed_chunks.length
      ? (task.error || `全部${task.chunks_total}个片段抽取失败` + (task.chunk_errors.length ? `（首个错误: ${task.chunk_errors[0].error}）` : ''))
      : '未抽取到候选三元组';
    persist(task);
    return;
  }
  task.status = 'review';
  persist(task);

  // 4) 跳过审核直通
  if (task.auto_commit) commitTask(task.id, null, '系统');
}

function commitTask(id, selected, source) {
  const task = tasks.get(id);
  if (!task) { const e = new Error(`任务${id}不存在`); e.status = 404; throw e; }
  if (task.status !== 'review') { const e = new Error(`任务状态为${task.status}，无法提交`); e.status = 400; throw e; }
  const ents = task.candidates.entities.filter((c) => c.selected && (!c.dupe_of_candidate));
  const rels = task.candidates.relations.filter((r) => r.selected && !r.unresolved);
  if (selected) {
    const entNames = new Set((selected.entities || []).map((s) => String(s)));
    const relKeys = new Set(selected.relations || []);
    for (const c of ents) c._want = entNames.has(c.name);
    for (const r of rels) r._want = relKeys.has(`${r.from}|${r.name}|${r.to}`);
  } else {
    for (const c of ents) c._want = true;
    for (const r of rels) r._want = true;
  }

  const applied = null;
  void applied;
  // 先打保存点再写入
  const git = require('./git');
  git.savepoint(`文档入图: ${task.display_name}`, source === '系统' ? '系统' : '手工');

  const nameToId = new Map();
  let entAdded = 0, entLinked = 0, relAdded = 0, relSkipped = 0;
  const opsLog = [];
  for (const c of ents) {
    if (!c._want) continue;
    if (c.existing_id !== null && c.existing_id !== undefined && typeof c.existing_id === 'number') {
      nameToId.set(c.name, c.existing_id);
      entLinked += 1;
      for (const a of c.aliases) {
        try { db.addAlias(c.existing_id, a, source === '系统' ? '系统' : '手工'); } catch (_) { /* 别名冲突忽略 */ }
      }
      continue;
    }
    const created = db.addEntity({ name: c.name, category: c.category, attributes: c.attributes }, '文档');
    nameToId.set(c.name, created.id);
    entAdded += 1;
    for (const a of c.aliases) {
      try { db.addAlias(created.id, a, source === '系统' ? '系统' : '手工'); } catch (_) {}
    }
    opsLog.push({ type: 'ADD_ENTITY', name: c.name, id: created.id });
  }
  for (const r of rels) {
    if (!r._want) { relSkipped += 1; continue; }
    const fromId = r.from_ref && r.from_ref.entity_id ? r.from_ref.entity_id : nameToId.get(r.from);
    const toId = r.to_ref && r.to_ref.entity_id ? r.to_ref.entity_id : nameToId.get(r.to);
    if (!fromId || !toId || fromId === toId) { relSkipped += 1; continue; }
    try {
      const created = db.addRelation({ source_id: fromId, target_id: toId, name: r.name, category: r.category, confidence: r.confidence, source_ref: r.source_ref }, '文档');
      relAdded += 1;
      opsLog.push({ type: 'ADD_RELATION', id: created.id, name: r.name, from: fromId, to: toId });
    } catch (_) { relSkipped += 1; }
  }
  task.status = 'committed';
  task.committed_at = new Date().toISOString();
  task.result = { entities_added: entAdded, entities_linked: entLinked, relations_added: relAdded, relations_skipped: relSkipped };
  persist(task);
  return { ok: true, ...task.result, savepoint: task.display_name };
}

function deleteTask(id) {
  const task = tasks.get(id);
  if (!task) { const e = new Error(`任务${id}不存在`); e.status = 404; throw e; }
  if (task.status === 'extracting' || task.status === 'parsing') { const e = new Error('任务执行中，请稍后再删除'); e.status = 400; throw e; }
  tasks.delete(id);
  try { fs.unlinkSync(path.join(TASK_DIR, id + '.json')); } catch (_) {}
  return { deleted: id };
}

// 上传文件暂存（供审核期间重试/溯源）
function storeUpload(id, filename, buffer) {
  ensureDir();
  const dir = path.join(DATA_DIR, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '_' + filename), buffer);
}

module.exports = { createTask, listTasks, getTask, commitTask, deleteTask, storeUpload, loadPersisted, chunkText, safeParseJson, normalizeCandidates, matchEntities, extractText, extractPrompt, ACCEPT };
