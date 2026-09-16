'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const db = require('./lib/db');
const git = require('./lib/git');
const rdf = require('./lib/rdf');
const agent = require('./lib/agent');
const V = require('./lib/validator');
const inference = require('./lib/inference');
const embeddings = require('./lib/embeddings');
const askLib = require('./lib/ask');
const updater = require('./lib/updater');
const importer = require('./lib/importer');

const PORT = Number(process.env.PORT || 3000);
const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(git.DATA_DIR, 'uploads')));

const api = express.Router();

// ---------- 元信息 ----------
api.get('/meta', (req, res) => {
  res.json({
    entity_categories: V.ENTITY_CATEGORIES,
    relation_categories: V.RELATION_CATEGORIES,
    counts: db.counts(),
    version: db.getVersion(),
    agent_available: agentAvailable,
    agent_session: agentSessionInfo(),
  });
});

function agentSessionInfo() {
  try {
    const f = path.join(git.DATA_DIR, '.agent_session');
    return fs.existsSync(f) ? { has_session: true } : { has_session: false };
  } catch (_) { return { has_session: false }; }
}

// ---------- 实体 ----------
api.get('/entities', (req, res) => res.json(db.listEntities()));
api.post('/entities', (req, res) => {
  try {
    const body = req.body || {};
    const name = body.name;
    // 同名消歧：主名或别名占用时，按 merge_into / force 分流
    if (typeof name === 'string' && name.trim()) {
      const conflicts = db.findNameConflicts(name);
      if (conflicts.length) {
        const mergeInto = Number(body.merge_into);
        if (body.merge_into !== undefined && Number.isInteger(mergeInto) && mergeInto > 0) {
          const alias = db.addAlias(mergeInto, name.trim(), '手工');
          return res.json({ merged: true, alias, entity: db.getEntity(mergeInto) });
        }
        if (body.force !== true && body.force !== 1 && body.force !== '1') {
          return res.status(409).json({ error: `名称"${name.trim()}"已被占用，可并入现有实体、改用限定名或强制创建`, conflicts });
        }
      }
    }
    res.json(db.addEntity(body, '手工'));
  } catch (e) { res.status(e.status || 500).json({ error: e.message, conflicts: e.conflicts }); }
});
api.put('/entities/:id', (req, res) => res.json(db.updateEntity(Number(req.params.id), req.body, '手工')));
api.delete('/entities/:id', (req, res) => {
  const r = db.deleteEntity(Number(req.params.id), '手工');
  cleanupImageFiles(r.image_files); // 级联删除图片行后移除文件本体
  res.json(r);
});

// ---------- 中心层级子图（ego） ----------
api.get('/graph/ego', (req, res) => {
  let centerId;
  try { centerId = db.resolveKey(req.query.center); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message, candidates: e.candidates }); }
  const raw = req.query.depth;
  let depth = null;
  if (raw !== undefined && String(raw).trim() !== '') {
    depth = Number(raw);
    if (!Number.isInteger(depth) || depth < 0) return res.status(400).json({ error: 'depth必须为非负整数（省略或0表示全部层级）' });
    if (depth === 0) depth = null; // 0 = 全部层级
  }
  res.json(db.egoSubgraph(centerId, depth));
});

// ---------- 两实体最短路径 ----------
api.get('/graph/path', (req, res) => {
  try {
    const fromId = db.resolveKey(req.query.from);
    const toId = db.resolveKey(req.query.to);
    let maxHops = 6;
    if (req.query.max !== undefined && String(req.query.max).trim() !== '') {
      maxHops = Number(req.query.max);
      if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 12) return res.status(400).json({ error: 'max必须为1-12的整数' });
    }
    res.json(db.findPath(fromId, toId, maxHops));
  } catch (e) { res.status(e.status || 500).json({ error: e.message, candidates: e.candidates }); }
});

// ---------- 撤销最近操作（快照逆向写入） ----------
api.get('/aliases', (req, res) => res.json(db.aliasMap()));

api.get('/aliases/records', (req, res) => res.json(db.aliasRecords()));

api.post('/aliases', (req, res) => {
  try {
    const { entity_id, alias } = req.body || {};
    res.json(db.addAlias(Number(entity_id), alias, '手工'));
  } catch (e) { res.status(e.status || 500).json({ error: e.message, conflicts: e.conflicts }); }
});

api.delete('/aliases/:id', (req, res) => {
  try { res.json(db.removeAlias(Number(req.params.id), '手工')); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

api.get('/graph/paths', (req, res) => {
  try {
    const fromId = db.resolveKey(req.query.from);
    const toId = db.resolveKey(req.query.to);
    let maxHops = 4;
    if (req.query.max !== undefined && String(req.query.max).trim() !== '') {
      maxHops = Number(req.query.max);
      if (!Number.isInteger(maxHops)) return res.status(400).json({ error: 'max必须为整数' });
    }
    res.json(db.findPaths(fromId, toId, { maxHops }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message, candidates: e.candidates }); }
});

// ---------- 相似实体（语义Top-K，结构降级） ----------
api.get('/similar/:id', async (req, res) => {
  try {
    const k = req.query.k !== undefined ? Number(req.query.k) : 8;
    res.json(await require('./lib/similar').similarEntities(Number(req.params.id), Number.isInteger(k) ? k : 8));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

api.post('/undo', (req, res) => {
  try { res.json({ ok: true, ...db.undoLast('手工'), counts: db.counts(), version: db.getVersion() }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------- 智能检索（LLM编译检索计划，只读执行） ----------
api.post('/ask', async (req, res) => {
  if (agentBusy) return res.status(429).json({ error: '已有AI任务执行中（问答、导入或智能检索），请稍后再试' });
  const question = (req.body || {}).question;
  if (!question || !String(question).trim()) return res.status(400).json({ error: '问题不能为空' });
  agentBusy = true;
  try {
    const s = embeddings.loadSettings();
    const result = await askLib.ask(question, { synthesis: s.ask_synthesis !== false });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    agentBusy = false;
  }
});

api.get('/ask/settings', (req, res) => {
  res.json({ synthesis: embeddings.loadSettings().ask_synthesis !== false });
});

api.put('/ask/settings', (req, res) => {
  embeddings.saveSettings({ ask_synthesis: !!(req.body || {}).synthesis });
  res.json({ ok: true, synthesis: embeddings.loadSettings().ask_synthesis !== false });
});

// ---------- 版本与更新 ----------
api.get('/version', (req, res) => res.json({ version: updater.currentVersion() }));

api.get('/update/check', async (req, res) => {
  try { res.json(await updater.checkUpdate()); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

let updating = false;
api.post('/update/apply', (req, res) => {
  if (updating) return res.status(429).json({ error: '更新正在进行中，请稍候' });
  updating = true;
  try {
    const r = updater.applyUpdate();
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
    if (!r.up_to_date) scheduleRestart();
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    updating = false;
  }
});

// ---------- 实体图片绑定 ----------
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function cleanupImageFiles(storedPaths) {
  for (const p of storedPaths || []) {
    try { fs.unlinkSync(path.join(git.DATA_DIR, p)); } catch (_) { /* 文件已不存在时容忍 */ }
  }
}

api.get('/entities/:id/images', (req, res) => {
  const id = Number(req.params.id);
  if (!db.getEntity(id)) return res.status(404).json({ error: `实体id=${id} 不存在` });
  const rel = (p) => (p ? '/uploads/' + p.replace(/^uploads[\\/]/, '') : null);
  res.json(db.listEntityImages(id).map((r) => ({ ...r, url: rel(r.stored_path), thumb_url: rel(r.thumb_path) || rel(r.stored_path) })));
});

api.post('/entities/:id/images', (req, res) => {
  const id = Number(req.params.id);
  const { filename, content_b64, caption, thumb_b64 } = req.body || {};
  if (!filename || !content_b64) return res.status(400).json({ error: '必须提供文件名与内容(content_b64)' });
  const ext = path.extname(String(filename)).toLowerCase();
  if (!IMAGE_EXTS.includes(ext)) return res.status(400).json({ error: `仅支持图片格式: ${IMAGE_EXTS.join(' ')}` });
  let buf;
  try { buf = Buffer.from(content_b64, 'base64'); } catch (_) { return res.status(400).json({ error: 'content_b64不是合法的base64' }); }
  if (!buf.length) return res.status(400).json({ error: '文件内容为空' });
  if (buf.length > MAX_IMAGE_BYTES) return res.status(400).json({ error: '单张图片不得超过10MB' });

  const dir = path.join(git.DATA_DIR, 'uploads', `e${id}`);
  fs.mkdirSync(dir, { recursive: true });
  const safe = path.basename(String(filename)).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 80) || 'image';
  const storedPath = path.join('uploads', `e${id}`, `${Date.now()}_${safe}`);
  fs.writeFileSync(path.join(git.DATA_DIR, storedPath), buf);
  // 缩略图（前端canvas生成的小图，可选）：列表加载用，原图仅灯箱打开
  let thumbPath = '';
  if (thumb_b64) {
    try {
      const tbuf = Buffer.from(thumb_b64, 'base64');
      if (tbuf.length > 0 && tbuf.length <= 2 * 1024 * 1024) {
        thumbPath = path.join('uploads', `e${id}`, `${Date.now()}_thumb_${safe}`);
        fs.writeFileSync(path.join(git.DATA_DIR, thumbPath), tbuf);
      }
    } catch (_) { thumbPath = ''; }
  }
  try {
    const row = db.addEntityImage(id, { filename, stored_path: storedPath, caption, thumb_path: thumbPath });
    const rel = (p) => (p ? '/uploads/' + p.replace(/^uploads[\\/]/, '') : null);
    res.json({ ...row, url: rel(row.stored_path), thumb_url: rel(row.thumb_path) || rel(row.stored_path) });
  } catch (e) {
    cleanupImageFiles([storedPath, thumbPath]); // 入库失败时回滚文件，避免孤儿文件
    throw e;
  }
});

api.delete('/images/:imgId', (req, res) => {
  const row = db.deleteEntityImage(Number(req.params.imgId));
  cleanupImageFiles([row.stored_path, row.thumb_path].filter(Boolean));
  res.json({ deleted: row });
});

// ---------- 关系 ----------
api.get('/relations', (req, res) => res.json(db.listRelations()));
api.post('/relations', (req, res) => res.json(db.addRelation(req.body, '手工')));
api.put('/relations/:id', (req, res) => res.json(db.updateRelation(Number(req.params.id), req.body, '手工')));
api.delete('/relations/:id', (req, res) => res.json(db.deleteRelation(Number(req.params.id), '手工')));

// ---------- 图谱 / 日志 ----------
api.get('/graph', (req, res) => res.json(db.getGraph()));

// 推理引擎：动态推导隐性关系（传递/对称/逆），可选限定中心实体
api.get('/inference', (req, res) => {
  const g = db.getGraph();
  const inferred = inference.computeInferred(g);
  const center = String(req.query.center || '').trim();
  let result = inferred;
  if (center) {
    const byId = new Map(g.entities.map((e) => [e.id, e]));
    let cid = null;
    if (/^\d+$/.test(center)) {
      if (byId.has(Number(center))) cid = Number(center);
      else return res.status(404).json({ error: `实体"${center}"不存在` });
    } else {
      const cands = g.entities.filter((e) => e.name === center);
      if (cands.length === 0) return res.status(404).json({ error: `实体"${center}"不存在` });
      if (cands.length > 1) return res.status(409).json({ error: `实体名"${center}"存在${cands.length}个候选，请改用id`, candidates: cands.map((h) => ({ id: h.id, name: h.name, category: h.category })) });
      cid = cands[0].id;
    }
    result = inferred.filter((i) => i.source_id === cid || i.target_id === cid);
  }
  const nodes = new Set();
  for (const i of result) { nodes.add(i.source_id); nodes.add(i.target_id); }
  res.json({ inferred: result, entities: g.entities.filter((e) => nodes.has(e.id)), ontology: inference.loadOntology() });
});

api.get('/ontology', (req, res) => res.json(inference.loadOntology()));

// ---------- 向量混合检索 ----------
api.get('/embeddings/status', (req, res) => res.json(embeddings.status()));

api.get('/embeddings/settings', (req, res) => {
  const s = embeddings.loadSettings();
  res.json({ ...s, api_key: s.api_key ? '已配置' : '' }); // 不回传真实密钥
});

api.put('/embeddings/settings', (req, res) => {
  try {
    const patch = req.body || {};
    // 前端传"已配置"占位时保留原密钥
    if (patch.api_key === '已配置') delete patch.api_key;
    const s = embeddings.saveSettings(patch);
    res.json({ ...s, api_key: s.api_key ? '已配置' : '' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

api.post('/embeddings/build', async (req, res) => {
  try {
    const result = await embeddings.build();
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

api.post('/search', async (req, res) => {
  const q = String((req.body || {}).query || '').trim();
  if (!q) return res.status(400).json({ error: 'query不能为空' });
  try {
    res.json(await embeddings.search(q, (req.body || {}).top_k));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

api.post('/cypher', (req, res) => {
  const q = String((req.body || {}).query || '').trim();
  if (!q) return res.status(400).json({ error: 'query不能为空' });
  try { res.json({ rows: db.miniCypher(q) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

api.put('/ontology', (req, res) => {
  try { res.json(inference.saveOntology(req.body || {})); }
  catch (e) { res.status(400).json({ error: '本体规则保存失败: ' + e.message }); }
});
api.get('/logs', (req, res) => res.json(db.getLogs(Number(req.query.limit) || 200)));

// ---------- RDF导出 ----------
api.get('/export/rdf', (req, res) => {
  const ttl = rdf.exportTurtle(db.getGraph());
  res.setHeader('Content-Type', 'text/turtle; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="knowledge_graph.ttl"');
  res.send(ttl);
});

// ---------- 文件：图谱保存/打开/另存 ----------
api.get('/export/db', (req, res) => {
  const raw = String(req.query.name || '').trim().replace(/[\\/:*?"<>|]/g, '_') || 'kg.db';
  const name = /\.(db|sqlite|sqlite3)$/i.test(raw) ? raw : raw.replace(/\.[^.]*$/, '') + '.db';
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(fs.readFileSync(db.DB_PATH)); // 写操作均经事务提交，主库文件始终处于一致状态
});

api.post('/graph/import', (req, res) => {
  const { filename, content_b64 } = req.body || {};
  if (!content_b64) return res.status(400).json({ error: '必须提供图谱数据库文件(content_b64)' });
  let buf;
  try { buf = Buffer.from(content_b64, 'base64'); } catch (_) { return res.status(400).json({ error: 'content_b64不是合法的base64' }); }

  // 临时库校验：完整性 + 必需表 + 必需列（lib/importer.js）
  const os = require('os');
  const check = importer.validateImportBuffer(buf);
  if (!check.ok) return res.status(400).json({ error: check.error });
  const importedMaxLog = check.importedMaxLog;
  const counts = check.counts;
  const tmp = path.join(os.tmpdir(), `kg_import_${Date.now()}.db`);
  fs.writeFileSync(tmp, buf);

  // 当前数据自动备份保存点，再替换主库
  let backup = null;
  try { backup = git.savepoint(`打开图谱前自动备份 ${new Date().toLocaleString('zh-CN')}`, '系统'); } catch (_) { backup = null; }

  fs.copyFileSync(tmp, db.DB_PATH);
  fs.unlinkSync(tmp);
  git.writeMeta({ last_saved_log: importedMaxLog }); // 日志区间绑定基准与导入库对齐
  db.reopen();
  const checkAfter = db.integrityCheck();
  if (!checkAfter.ok) { const e = new Error('导入后完整性校验失败: ' + checkAfter.detail); e.status = 500; throw e; }
  // .db 不携带 uploads/ 资产：剪除指向不存在文件的图片行，避免前端裂图
  const prunedImages = db.pruneMissingImages();

  res.json({ ok: true, counts: db.counts(), imported: { entities: counts.entities, relations: counts.relations }, backup_short: backup && backup.hash ? backup.hash : null, pruned_images: prunedImages.pruned });
});

// ---------- 另存为图谱网页（单文件只读查看器） ----------
api.get('/export/html', (req, res) => {
  const viewer = require('./lib/viewer');
  const html = viewer.buildViewerHtml(db.getGraph());
  const raw = String(req.query.name || '').trim();
  const name = /[\\/:*?"<>|]/.test(raw) || !raw ? 'kg-viewer.html' : raw;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(/\.html?$/i.test(name) ? name : name + '.html')}`);
  res.send(html);
});

// ---------- Git保存点与回溯 ----------
api.get('/git/history', (req, res) => res.json(git.history(Number(req.query.limit) || 100)));
api.post('/git/savepoint', (req, res) => {
  const r = git.savepoint(req.body && req.body.message, '手工');
  res.json(r);
});
api.post('/git/restore', (req, res) => {
  const hash = req.body && req.body.hash;
  if (!hash || typeof hash !== 'string') return res.status(400).json({ error: '必须提供要恢复的保存点hash' });
  const r = git.restore(hash.trim());
  db.logRestore(r.restored, r.backup);
  res.json(r);
});

// ---------- OpenCode自然语言指令 ----------
// AI任务互斥：OpenCode进程最长5分钟，防止并发请求叠加进程互抢SQLite与内存
let agentBusy = false;

api.post('/agent', async (req, res) => {
  if (agentBusy) return res.status(429).json({ error: '已有AI任务执行中（问答或文档导入），请等待完成后再试' });
  const instruction = req.body && req.body.instruction;
  if (!instruction || !String(instruction).trim()) return res.status(400).json({ error: '指令不能为空' });
  agentBusy = true;
  try {
      const result = await agent.runAgent(instruction);
      if (!result.ok) return res.status(502).json({ error: result.error });

    let applied = [];
    let applyError = null;
    if (result.ops && result.ops.length) {
      try {
        applied = db.applyAgentOps(result.ops);
        // Agent批次写入后自动打保存点，与日志双向绑定
        const title = `OpenCode: ${String(instruction).slice(0, 60).replace(/\n/g, ' ')}`;
        let sp = null;
        try { sp = git.savepoint(title, 'OpenCode'); } catch (e) { sp = { committed: false, message: e.message }; }
        result.savepoint = sp;
      } catch (e) {
        applyError = e.message; // 违规操作被拦截，数据库保持上一个合规版本
      }
    }
    res.json({ reply: result.reply, ops_found: (result.ops || []).length, applied, apply_error: applyError, parse_error: result.parse_error, savepoint: result.savepoint || null, retried: result.retried || false, partial_reply: result.partial_reply || null, session: result.session ? { has_session: true } : null });
  } finally { agentBusy = false; }
});

// ---------- 文档导入：文本/文档 → 三元组 → 融合入库 ----------
const TEXT_LIKE_EXT = ['.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm', '.xml'];
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const MAX_CHUNKS = 40;
const CHUNK_SIZE = 1400;

function safeName(name) {
  const base = String(name || 'document').split(/[\\/]/).pop().replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  return base.slice(0, 80) || 'document';
}

function splitChunks(text, size = CHUNK_SIZE) {
  const paras = text.split(/\n{2,}/);
  const chunks = [];
  let cur = '';
  const pushCur = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
  for (const p of paras) {
    if (p.length > size * 1.5) {
      pushCur();
      let s = '';
      for (const sent of p.split(/(?<=[。！？.!?\n])/)) {
        if ((s + sent).length > size && s) { chunks.push(s.trim()); s = ''; }
        s += sent;
      }
      cur = s;
    } else if ((cur + p).length > size && cur) {
      pushCur();
      cur = p;
    } else {
      cur += (cur ? '\n\n' : '') + p;
    }
  }
  pushCur();
  return chunks;
}

function docInstruction(filename, i, n, userInstruction) {
  let s = `【文档导入任务】请使用 kg-triples 技能的完整流程，从文件《${filename}》的第 ${i}/${n} 块文本中抽取三元组（含属性）。`;
  if (i > 1) s += '注意与"当前图谱"中已入库实体对齐：同名实体直接用其id引用，禁止重复创建。';
  if (userInstruction) s += `\n用户补充要求：${userInstruction}`;
  return s;
}

// 文档导入进度（内存态，供前端轮询；docId=本次导入的时间戳标识）
let docProgress = { active: false, stage: 'idle', chunk: 0, chunks: 0, mode: '', filename: '' };

api.get('/agent/doc/progress', (req, res) => res.json(docProgress));

api.post('/agent/doc', async (req, res) => {
  if (agentBusy) return res.status(429).json({ error: '已有AI任务执行中（问答或文档导入），请等待完成后再试' });
  const { filename, content_b64, instruction } = req.body || {};
  if (!filename || !content_b64) return res.status(400).json({ error: '必须提供文件名与内容(content_b64)' });
  let buf;
  try { buf = Buffer.from(content_b64, 'base64'); } catch (_) { return res.status(400).json({ error: 'content_b64不是合法的base64' }); }
  if (!buf.length) return res.status(400).json({ error: '文件内容为空' });
  if (buf.length > MAX_DOC_BYTES) return res.status(400).json({ error: `文件超过${MAX_DOC_BYTES / 1024 / 1024}MB上限，请拆分后导入` });
  agentBusy = true;
  docProgress = { active: true, stage: 'preparing', chunk: 0, chunks: 0, mode: '', filename: safeName(filename) };

  try {
    const name = safeName(filename);
    const ext = path.extname(name).toLowerCase();
    const uploadsDir = path.join(git.DATA_DIR, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    const savedPath = path.join(uploadsDir, `${Date.now()}_${name}`);
    fs.writeFileSync(savedPath, buf);

    const report = { filename: name, mode: '', chunks: 0, chunks_ok: 0, entities_added: 0, relations_added: 0, others: 0, errors: [], reply: '' };
    const tally = (applied) => {
      for (const a of applied || []) {
        if (a.op === 'add_entity') report.entities_added++;
        else if (a.op === 'add_relation') report.relations_added++;
        else report.others++;
      }
    };

    const isTextLike = TEXT_LIKE_EXT.includes(ext);
    const doApply = (r) => {
      if (!r.ok) { report.errors.push(r.error); return r; }
      if (r.ops && r.ops.length) {
        try {
          const applied = db.applyAgentOps(r.ops);
          tally(applied);
          report.chunks_ok++;
        } catch (e) {
          report.errors.push(`第${report.chunks_ok + 1}块操作被RDF校验拦截: ${e.message}`);
        }
      } else {
        report.chunks_ok++;
      }
      if (r.reply) report.reply = r.reply;
      return r;
    };

    try {
      if (isTextLike && buf.length > 1500) {
        // 文本类大文档：后端分块流水线，逐块抽取+融合，图谱摘要随每块刷新实现跨块对齐
        report.mode = 'chunked';
        const chunks = splitChunks(buf.toString('utf8'));
        if (chunks.length > MAX_CHUNKS) {
          docProgress = { ...docProgress, active: false, stage: 'error' };
          return res.status(400).json({ error: `文档分块后达${chunks.length}块（上限${MAX_CHUNKS}），请拆分后导入` });
        }
        report.chunks = chunks.length;
        docProgress = { ...docProgress, mode: 'chunked', chunks: chunks.length, stage: 'importing' };
        for (let i = 0; i < chunks.length; i++) {
          docProgress = { ...docProgress, chunk: i + 1 };
          const inst = `${docInstruction(name, i + 1, chunks.length, instruction)}\n【文本块内容】\n<<<\n${chunks[i]}\n>>>`;
          const r = doApply(await agent.runAgent(inst));
          if (!r.ok) break; // agent层错误（超时/服务错误）时终止后续块
        }
      } else {
        // 小文本或PDF/Word等二进制文档：整体作为附件交给OpenCode（kg-triples技能）
        report.mode = 'attached';
        report.chunks = 1;
        docProgress = { ...docProgress, mode: 'attached', chunks: 1, chunk: 1, stage: 'importing' };
        const inst = docInstruction(name, 1, 1, instruction) + ' 文档已作为附件挂载，请先读取再抽取。';
        doApply(await agent.runAgent(inst, [savedPath]));
      }
      docProgress = { ...docProgress, active: true, stage: 'savepoint' };
    } finally {
      try { fs.unlinkSync(savedPath); } catch (_) { /* 保留亦可 */ }
    }

    // 汇总保存点（含导入统计，与日志双向绑定）
    let savepoint = null;
    try {
      savepoint = git.savepoint(`文档导入: ${name}（实体+${report.entities_added} 关系+${report.relations_added}）`, 'OpenCode');
    } catch (e) { savepoint = { committed: false, message: e.message }; }
    docProgress = { active: false, stage: report.errors.length && !report.chunks_ok ? 'error' : 'done', chunk: docProgress.chunk, chunks: docProgress.chunks, mode: report.mode, filename: name };

    res.json({ report, applied_total: report.entities_added + report.relations_added + report.others, savepoint, retried: false });
  } finally { agentBusy = false; }
});

app.use('/api', api);

// 统一错误处理
app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message, errors: err.errors || undefined });
});

// ---------- 启动流程：异常兜底 + 自动拉起OpenCode ----------
let agentAvailable = false;

function checkAgent() {
  try {
    require('child_process').execFileSync('opencode', ['--version'], { encoding: 'utf8', timeout: 15000 });
    agentAvailable = true;
  } catch (_) {
    agentAvailable = false;
  }
}

function bootstrap() {
  require('./lib/paths').ensureLegacyMigration();
  git.ensureRepo();
  git.backupCopy(true); // 启动时强制留一份滚动副本，目录损坏时仍有外部备份可救
  try {
    db.open();
  } catch (e) {
    console.error('[兜底] 数据库异常:', e.message);
    // 数据库出错自动保留并恢复上一个合规版本
    try {
      const commits = git.history(5);
      const good = commits.find((c) => c.title !== '回滚前自动备份');
      if (good) {
        console.error('[兜底] 正在恢复最近合规版本:', good.short, good.title);
        git.restore(good.hash);
        db.open();
        console.error('[兜底] 已恢复上一个合规版本');
      } else {
        throw e;
      }
    } catch (e2) {
      console.error('[兜底] 恢复失败，请检查 data/ 目录:', e2.message);
      process.exit(1);
    }
  }
  seedIfEmpty();
  checkAgent();
  console.log(agentAvailable ? '[OpenCode] 进程已就绪，可在前端输入自然语言指令' : '[OpenCode] 未检测到 opencode CLI，自然语言补全不可用（其余功能不受影响）');
}

function seedIfEmpty() {
  if (db.counts().entities > 0) return;
  console.log('[初始化] 空库，写入示例数据…');
  const beer = db.addEntity({ name: '长江', category: '物理实体', attributes: { 长度公里: 6397, 类型: '河流' } }, '手工');
  const country = db.addEntity({ name: '中国', category: '物理实体', attributes: { 大洲: '亚洲' } }, '手工');
  const commerce = db.addEntity({ name: '电子商务', category: '抽象实体', attributes: { 兴起年代: '1990年代' } }, '手工');
  const year = db.addEntity({ name: '2026年', category: '时间实体', attributes: { 年份: 2026 } }, '手工');
  const users = db.addEntity({ name: '网民规模', category: '数值实体', attributes: { 数值: 11.7, 单位: '亿' } }, '手工');
  db.addRelation({ source_id: beer.id, target_id: country.id, name: '流经', category: '空间' }, '手工');
  db.addRelation({ source_id: users.id, target_id: commerce.id, name: '推动发展', category: '互动' }, '手工');
  db.addRelation({ source_id: commerce.id, target_id: year.id, name: '成熟于', category: '时间' }, '手工');
  git.savepoint('初始化：数据库与示例数据', '系统');
  console.log('[初始化] 完成，已创建首个Git保存点');
}

bootstrap();

const HOST = process.env.KG_HOST || '127.0.0.1';

// 自动重启（更新后）：派生脱离的新进程接管，当前进程退出
function scheduleRestart() {
  console.log('[更新] 3秒后自动重启服务…');
  setTimeout(() => {
    try {
      const { spawn } = require('child_process');
      const log = fs.openSync(path.join(require('./lib/paths').DATA_DIR, 'restart.log'), 'a');
      const child = spawn(process.execPath, [...process.execArgv, path.join(__dirname, 'server.js')], {
        detached: true, stdio: ['ignore', log, log], env: process.env, cwd: __dirname,
      });
      child.unref();
      console.log(`[更新] 新进程已启动 (pid ${child.pid})，当前进程即将退出`);
      fs.writeSync(log, `\n[${new Date().toISOString()}] 更新重启：新进程 pid ${child.pid}\n`);
      setTimeout(() => process.exit(0), 500);
    } catch (e) {
      console.error('[更新] 自动重启失败，请手动重新运行启动脚本：', e.message);
    }
  }, 3000);
}

// 端口绑定（更新重启衔接时旧进程尚未释放端口，自动重试）
(function bind(attempt) {
  const server = app.listen(PORT, HOST, () => {
    console.log(`本地知识图谱整合器已启动: http://localhost:${PORT} (监听${HOST}${HOST === '127.0.0.1' ? '，如需局域网访问设 KG_HOST=0.0.0.0' : '，已暴露到局域网'})`);
    console.log('数据文件: data/kg.db (本地Git仓库托管，可打保存点/回溯)');
    console.log('全流程本地运行，仅OpenCode可联网补全公开信息');
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 15) {
      console.log(`端口 ${PORT} 被占用（可能为更新重启衔接），1秒后重试 (${attempt + 1}/15)`);
      setTimeout(() => bind(attempt + 1), 1000);
    } else {
      console.error('监听失败:', e.message);
      process.exit(1);
    }
  });
})(0);
