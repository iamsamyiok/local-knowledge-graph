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
api.post('/entities', (req, res) => res.json(db.addEntity(req.body, '手工')));
api.put('/entities/:id', (req, res) => res.json(db.updateEntity(Number(req.params.id), req.body, '手工')));
api.delete('/entities/:id', (req, res) => {
  const r = db.deleteEntity(Number(req.params.id), '手工');
  cleanupImageFiles(r.image_files); // 级联删除图片行后移除文件本体
  res.json(r);
});

// ---------- 中心层级子图（ego） ----------
api.get('/graph/ego', (req, res) => {
  const centerKey = String(req.query.center || '').trim();
  if (!centerKey) return res.status(400).json({ error: '必须提供中心实体（center=id或名称）' });
  let centerId = null;
  if (/^\d+$/.test(centerKey)) {
    const byId = db.getEntity(Number(centerKey));
    if (byId) centerId = byId.id;
  }
  if (centerId === null) {
    const hits = db.listEntities().filter((e) => e.name === centerKey);
    if (hits.length === 0) return res.status(404).json({ error: `实体"${centerKey}"不存在` });
    if (hits.length > 1) return res.status(409).json({ error: `实体名"${centerKey}"存在${hits.length}个候选，请改用id`, candidates: hits.map((h) => ({ id: h.id, name: h.name, category: h.category })) });
    centerId = hits[0].id;
  }
  const raw = req.query.depth;
  let depth = null;
  if (raw !== undefined && String(raw).trim() !== '') {
    depth = Number(raw);
    if (!Number.isInteger(depth) || depth < 0) return res.status(400).json({ error: 'depth必须为非负整数（省略或0表示全部层级）' });
    if (depth === 0) depth = null; // 0 = 全部层级
  }
  res.json(db.egoSubgraph(centerId, depth));
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
  res.json(db.listEntityImages(id).map((r) => ({ ...r, url: '/uploads/' + r.stored_path.replace(/^uploads[\\/]/, '') })));
});

api.post('/entities/:id/images', (req, res) => {
  const id = Number(req.params.id);
  const { filename, content_b64, caption } = req.body || {};
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
  try {
    const row = db.addEntityImage(id, { filename, stored_path: storedPath, caption });
    res.json({ ...row, url: '/uploads/' + storedPath.replace(/\\/g, '/').replace(/^uploads\//, '') });
  } catch (e) {
    cleanupImageFiles([storedPath]); // 入库失败时回滚文件，避免孤儿文件
    throw e;
  }
});

api.delete('/images/:imgId', (req, res) => {
  const row = db.deleteEntityImage(Number(req.params.imgId));
  cleanupImageFiles([row.stored_path]);
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
  if (!buf.length || buf.length > 200 * 1024 * 1024) return res.status(400).json({ error: '文件为空或超过200MB上限' });
  if (!/^SQLite format 3\x00/.test(buf.toString('latin1', 0, 16))) return res.status(400).json({ error: '该文件不是SQLite数据库' });

  // 临时库校验：完整性 + 必需表结构
  const os = require('os');
  const tmp = path.join(os.tmpdir(), `kg_import_${Date.now()}.db`);
  fs.writeFileSync(tmp, buf);
  const { DatabaseSync } = require('node:sqlite');
  let probe, importedMaxLog = 0, counts;
  try {
    probe = new DatabaseSync(tmp);
    const v = Object.values(probe.prepare('PRAGMA integrity_check').get())[0];
    if (v !== 'ok') return res.status(400).json({ error: `数据库完整性校验失败: ${v}` });
    const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const t of ['entities', 'relations', 'operation_logs']) {
      if (!tables.includes(t)) return res.status(400).json({ error: `缺少必需的数据表 ${t}，这不是本系统的图谱文件` });
    }
    importedMaxLog = probe.prepare('SELECT COALESCE(MAX(id),0) AS m FROM operation_logs').get().m;
    counts = {
      entities: probe.prepare('SELECT COUNT(*) AS c FROM entities').get().c,
      relations: probe.prepare('SELECT COUNT(*) AS c FROM relations').get().c,
    };
  } catch (e) {
    return res.status(400).json({ error: '无法读取图谱数据库: ' + e.message });
  } finally {
    try { if (probe) probe.close(); } catch (_) {}
  }

  // 当前数据自动备份保存点，再替换主库
  let backup = null;
  try { backup = git.savepoint(`打开图谱前自动备份 ${new Date().toLocaleString('zh-CN')}`, '系统'); } catch (_) { backup = null; }

  fs.copyFileSync(tmp, db.DB_PATH);
  fs.unlinkSync(tmp);
  git.writeMeta({ last_saved_log: importedMaxLog }); // 日志区间绑定基准与导入库对齐
  db.reopen();
  const check = db.integrityCheck();
  if (!check.ok) { const e = new Error('导入后完整性校验失败: ' + check.detail); e.status = 500; throw e; }

  res.json({ ok: true, counts: db.counts(), imported: { entities: counts.entities, relations: counts.relations }, backup_short: backup && backup.hash ? backup.hash : null });
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
api.post('/agent', async (req, res) => {
  const instruction = req.body && req.body.instruction;
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

api.post('/agent/doc', async (req, res) => {
  const { filename, content_b64, instruction } = req.body || {};
  if (!filename || !content_b64) return res.status(400).json({ error: '必须提供文件名与内容(content_b64)' });
  let buf;
  try { buf = Buffer.from(content_b64, 'base64'); } catch (_) { return res.status(400).json({ error: 'content_b64不是合法的base64' }); }
  if (!buf.length) return res.status(400).json({ error: '文件内容为空' });
  if (buf.length > MAX_DOC_BYTES) return res.status(400).json({ error: `文件超过${MAX_DOC_BYTES / 1024 / 1024}MB上限，请拆分后导入` });

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
        return res.status(400).json({ error: `文档分块后达${chunks.length}块（上限${MAX_CHUNKS}），请拆分后导入` });
      }
      report.chunks = chunks.length;
      for (let i = 0; i < chunks.length; i++) {
        const inst = `${docInstruction(name, i + 1, chunks.length, instruction)}\n【文本块内容】\n<<<\n${chunks[i]}\n>>>`;
        const r = doApply(await agent.runAgent(inst));
        if (!r.ok) break; // agent层错误（超时/服务错误）时终止后续块
      }
    } else {
      // 小文本或PDF/Word等二进制文档：整体作为附件交给OpenCode（kg-triples技能）
      report.mode = 'attached';
      report.chunks = 1;
      const inst = docInstruction(name, 1, 1, instruction) + ' 文档已作为附件挂载，请先读取再抽取。';
      doApply(await agent.runAgent(inst, [savedPath]));
    }
  } finally {
    try { fs.unlinkSync(savedPath); } catch (_) { /* 保留亦可 */ }
  }

  // 汇总保存点（含导入统计，与日志双向绑定）
  let savepoint = null;
  try {
    savepoint = git.savepoint(`文档导入: ${name}（实体+${report.entities_added} 关系+${report.relations_added}）`, 'OpenCode');
  } catch (e) { savepoint = { committed: false, message: e.message }; }

  res.json({ report, applied_total: report.entities_added + report.relations_added + report.others, savepoint, retried: false });
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
  git.ensureRepo();
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`本地知识图谱整合器已启动: http://localhost:${PORT}`);
  console.log('数据文件: data/kg.db (本地Git仓库托管，可打保存点/回溯)');
  console.log('全流程本地运行，仅OpenCode可联网补全公开信息');
});
