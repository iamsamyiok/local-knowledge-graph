'use strict';

// 智能关系检索：LLM编译检索计划(受限JSON) → 本地只读执行 → 关联发现 → 可选综述
// 设计约束：LLM永不触碰写通道；执行器仅调用白名单只读工具；runPlain可注入以便测试。

const db = require('./db');
const embeddings = require('./embeddings');

const STEP_LIMIT = 4;
const CYPHER_MAX_ROWS = 50;
const KEYWORD_TOPK = 10;
const EGO_MAX_NODES = 100;
const STEP_TIMEOUT_MS = 5000;

// ---------- 图谱目录（发给LLM的摘要，≤2KB） ----------
function buildDigest() {
  const entities = db.listEntities();
  const relations = db.listRelations();
  const cat = (rows, key) => [...new Set(rows.map((r) => r[key]))].join('/');
  const relNameCount = new Map();
  const degree = new Map();
  const touch = (id) => degree.set(id, (degree.get(id) || 0) + 1);
  for (const r of relations) {
    relNameCount.set(r.name, (relNameCount.get(r.name) || 0) + 1);
    touch(r.source_id); touch(r.target_id);
  }
  const topRels = [...relNameCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([n, c]) => `${n}(${c})`).join(', ');
  const byId = new Map(entities.map((e) => [e.id, e]));
  const highDegree = entities.filter((e) => (degree.get(e.id) || 0) >= 2)
    .sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0)).slice(0, 8);
  const spread = entities.filter((_, i) => i % Math.max(1, Math.floor(entities.length / 8)) === 0).slice(0, 7);
  const samples = [...new Map([...highDegree, ...spread].map((e) => [e.id, e])).values()].slice(0, 15)
    .map((e) => `${e.name}(id${e.id})`).join(', ');
  const digest = [
    `实体大类: ${cat(entities, 'category')}`,
    `关系大类: ${cat(relations, 'category')}`,
    `高频关系名: ${topRels || '（暂无）'}`,
    `样例实体: ${samples || '（暂无）'}`,
    `规模: 实体${entities.length} 关系${relations.length}`,
  ].join('\n');
  return { digest: digest.slice(0, 2048), stats: { entities: entities.length, relations: relations.length } };
}

// ---------- 检索计划schema校验 ----------
const TOOLS = ['keyword', 'cypher', 'path', 'ego'];
function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, errors: ['计划必须是JSON对象'] };
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return { ok: false, errors: ['steps必须为非空数组'] };
  if (plan.steps.length > STEP_LIMIT) errors.push(`步骤数不得超过${STEP_LIMIT}`);
  plan.steps.forEach((s, i) => {
    if (!s || typeof s !== 'object') { errors.push(`步骤${i + 1}必须是对象`); return; }
    if (!TOOLS.includes(s.tool)) { errors.push(`步骤${i + 1}工具"${s.tool}"不在白名单: ${TOOLS.join('/')}`); return; }
    const need = (cond, msg) => { if (!cond) errors.push(`步骤${i + 1}: ${msg}`); };
    if (s.tool === 'keyword') need(typeof s.q === 'string' && s.q.trim(), 'keyword需要非空q(字符串)');
    if (s.tool === 'cypher') {
      need(typeof s.query === 'string' && /^\s*MATCH/i.test(s.query) && /RETURN/i.test(s.query), 'cypher需要形如 MATCH (a)-[r]->(b) RETURN ... 的query');
    }
    if (s.tool === 'path') {
      need(typeof s.from === 'string' && s.from.trim() && typeof s.to === 'string' && s.to.trim(), 'path需要非空from与to');
      if (s.max !== undefined) need(Number.isInteger(s.max) && s.max >= 1 && s.max <= 12, 'path.max须为1-12整数');
    }
    if (s.tool === 'ego') {
      need(typeof s.center === 'string' && s.center.trim(), 'ego需要非空center');
      if (s.depth !== undefined) need(Number.isInteger(s.depth) && s.depth >= 1 && s.depth <= 6, 'ego.depth须为1-6整数');
    }
  });
  return { ok: errors.length === 0, errors };
}

// ---------- 从LLM文本中提取计划JSON ----------
function extractJson(text) {
  let t = String(text || '').trim().replace(/```(?:json)?/gi, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('输出中未找到JSON对象');
  return JSON.parse(t.slice(start, end + 1));
}

// ---------- 编译（失败携带错误重试1次） ----------
async function compilePlan(question, runPlain) {
  const { digest } = buildDigest();
  const rules = [
    '你是知识图谱检索规划器。把用户问题编译为检索计划JSON，仅输出JSON对象，禁止任何解释或代码块外文本。',
    '可用工具(只读): keyword{q:关键词} / cypher{query:MATCH (a)-[r:类型]->(b) WHERE a.name contains 词 RETURN a,r,b LIMIT n} / path{from:实体名或id,to:实体名或id,max:层数} / ego{center:实体名或id,depth:层数}',
    `规则: steps数组1-${STEP_LIMIT}步；关系名必须来自"高频关系名"列表（或其近义词）；引用实体优先用样例中出现的名称；不确定就拆成keyword步；输出形如 {"steps":[{"tool":"cypher","query":"..."}]}`,
  ].join('\n');
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0
      ? `${rules}\n\n【图谱目录】\n${digest}\n\n【用户问题】\n${question}`
      : `${rules}\n\n【图谱目录】\n${digest}\n\n【用户问题】\n${question}\n\n【上次输出不合法】\n${lastErr}\n请修正后重新仅输出JSON。`;
    const r = await runPlain(prompt, 45000);
    if (!r.ok) { lastErr = r.error; continue; }
    try {
      const plan = extractJson(r.text);
      const v = validatePlan(plan);
      if (v.ok) return { plan, degraded: false };
      lastErr = v.errors.join('; ');
    } catch (e) {
      lastErr = `JSON解析失败: ${e.message}`;
    }
  }
  return { plan: null, degraded: true, error: lastErr || '编译两次失败' };
}

// ---------- 单步执行（白名单只读 + 5s竞速超时） ----------
function clampCypher(query) {
  let q = String(query).trim().replace(/\s+LIMIT\s+(\d+)\s*$/i, (_, n) => ` LIMIT ${Math.min(Number(n), CYPHER_MAX_ROWS)}`);
  if (!/\s+LIMIT\s+\d+\s*$/i.test(q)) q += ` LIMIT ${CYPHER_MAX_ROWS}`;
  return q;
}

async function runStep(step) {
  const t0 = Date.now();
  const work = (async () => {
    switch (step.tool) {
      case 'keyword': {
        const r = await embeddings.search(step.q.trim(), KEYWORD_TOPK);
        const ents = r.results.map((x) => x.entity);
        const rels = r.results.flatMap((x) => (x.hit_relations || []));
        return { entities: ents, relations: rels };
      }
      case 'cypher': {
        const rows = db.miniCypher(clampCypher(step.query));
        const entities = [];
        const relations = [];
        const seenE = new Set();
        const seenR = new Set();
        for (const row of rows) {
          for (const id of [row.source_id, row.target_id]) {
            if (id && !seenE.has(id)) { seenE.add(id); const e = db.getEntity(id); if (e) entities.push(e); }
          }
          if (row.relation_id && !seenR.has(row.relation_id)) { seenR.add(row.relation_id); const rel = db.getRelation(row.relation_id); if (rel) relations.push(rel); }
        }
        return { entities, relations };
      }
      case 'path': {
        const fromId = db.resolveKey(step.from);
        const toId = db.resolveKey(step.to);
        const r = db.findPath(fromId, toId, Number.isInteger(step.max) ? step.max : 6);
        return r.found ? { entities: r.entities, relations: r.relations } : { entities: [], relations: [], note: '两实体间无连通路径' };
      }
      case 'ego': {
        const centerId = db.resolveKey(step.center);
        const g = db.egoSubgraph(centerId, Number.isInteger(step.depth) ? step.depth : null);
        const keep = g.entities.slice(0, EGO_MAX_NODES).map((e) => e.id);
        const keepSet = new Set(keep);
        return { entities: g.entities.filter((e) => keepSet.has(e.id)), relations: g.relations.filter((r) => keepSet.has(r.source_id) && keepSet.has(r.target_id)) };
      }
      default:
        throw new Error('未知工具');
    }
  })();
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), STEP_TIMEOUT_MS));
  try {
    const r = await Promise.race([work, timeout]);
    if (r && r.timeout) return { tool: step.tool, args: step, status: 'timeout', count: 0, ms: Date.now() - t0 };
    return { tool: step.tool, args: step, status: 'ok', count: r.entities.length, ms: Date.now() - t0, note: r.note, entities: r.entities, relations: r.relations };
  } catch (e) {
    return { tool: step.tool, args: step, status: 'error', count: 0, ms: Date.now() - t0, error: e.message };
  }
}

async function executePlan(plan) {
  const entities = new Map();
  const relations = new Map();
  const steps = [];
  for (const step of plan.steps.slice(0, STEP_LIMIT)) {
    const r = await runStep(step);
    for (const e of r.entities || []) if (!entities.has(e.id)) entities.set(e.id, e);
    for (const rel of r.relations || []) if (!relations.has(rel.id)) relations.set(rel.id, rel);
    steps.push(r);
  }
  return { steps, entities: [...entities.values()], relations: [...relations.values()] };
}

// ---------- 图结构关联发现：公共邻居共现 + 桥接节点 ----------
function findCoNeighbors(entityIds, topN = 5) {
  if (entityIds.length < 2) return { pairs: [], bridges: [] };
  const idSet = new Set(entityIds);
  const neighbors = new Map(); // entityId -> Set(邻居id)
  const touch = (id) => { if (!neighbors.has(id)) neighbors.set(id, new Set()); };
  for (const r of db.listRelations()) {
    touch(r.source_id); touch(r.target_id);
    neighbors.get(r.source_id).add(r.target_id);
    neighbors.get(r.target_id).add(r.source_id);
  }
  const pairs = [];
  for (let i = 0; i < entityIds.length; i++) {
    for (let j = i + 1; j < entityIds.length; j++) {
      const a = entityIds[i], b = entityIds[j];
      const na = neighbors.get(a) || new Set();
      const shared = [...(neighbors.get(b) || new Set())].filter((x) => na.has(x) && x !== a && x !== b);
      if (shared.length > 0) pairs.push({ a, b, shared: shared.sort((x, y) => x - y) });
    }
  }
  pairs.sort((x, y) => y.shared.length - x.shared.length);
  const bridgeCount = new Map();
  for (const id of entityIds) {
    for (const nb of neighbors.get(id) || []) {
      if (idSet.has(nb)) continue;
      bridgeCount.set(nb, (bridgeCount.get(nb) || 0) + 1);
    }
  }
  const bridges = [...bridgeCount.entries()].filter(([, c]) => c >= 2)
    .sort((x, y) => y[1] - x[1]).slice(0, topN)
    .map(([id, links]) => { const e = db.getEntity(id); return e ? { id, name: e.name, links } : null; })
    .filter(Boolean);
  return { pairs: pairs.slice(0, topN), bridges };
}

// ---------- 综述 ----------
async function synthesize(question, merged, runPlain) {
  const ents = merged.entities.slice(0, 30).map((e) => `${e.name}#${e.id}`).join('、');
  const rels = merged.relations.slice(0, 40).map((r) => {
    const s = merged.entities.find((e) => e.id === r.source_id);
    const t = merged.entities.find((e) => e.id === r.target_id);
    return `${s ? s.name : '#' + r.source_id}#id${r.source_id} —[${r.name}]→ ${t ? t.name : '#' + r.target_id}`;
  }).join('；');
  const prompt = [
    '基于以下知识图谱检索结果，用简洁中文（不超过250字）回答用户问题。',
    '规则: 提到的实体必须来自检索结果并以「名称#id」格式标注；禁止编造结果之外的实体或关系；结构化陈述，不加寒暄。',
    `【用户问题】${question}`,
    `【实体】${ents || '（无）'}`,
    `【关系】${rels || '（无）'}`,
  ].join('\n');
  const r = await runPlain(prompt, 60000);
  if (!r.ok) return { synthesis: null, error: r.error };
  return { synthesis: r.text.trim() };
}

// ---------- 降级补充：问题文本中的实体名回扫（确定性，无LLM） ----------
function scanByName(question, cap = 10) {
  const q = String(question || '');
  const hits = db.listEntities().filter((e) => e.name && e.name.length >= 2 && q.includes(e.name)).slice(0, cap);
  if (!hits.length) return { entities: [], relations: [] };
  const ids = new Set(hits.map((e) => e.id));
  const relations = db.listRelations().filter((r) => ids.has(r.source_id) || ids.has(r.target_id));
  return { entities: hits, relations };
}

// ---------- 编排入口 ----------
async function ask(question, opts = {}) {
  const q = String(question || '').trim();
  if (!q) { const e = new Error('问题不能为空'); e.status = 400; throw e; }
  if (q.length > 500) { const e = new Error('问题过长（上限500字）'); e.status = 400; throw e; }
  const runPlain = opts.runPlain || require('./agent').runPlain;
  const t0 = Date.now();

  const c = await compilePlan(q, runPlain);
  const compileMs = Date.now() - t0;

  let merged;
  let degraded = c.degraded;
  if (c.plan) {
    merged = await executePlan(c.plan);
  } else {
    merged = await executePlan({ steps: [{ tool: 'keyword', q }] });
    merged.steps[0].note = '智能编译失败，已降级关键词检索';
    const scan = scanByName(q); // 整句关键词可能匹配不到，回扫问题中出现的实体名
    for (const e of scan.entities) if (!merged.entities.some((x) => x.id === e.id)) merged.entities.push(e);
    for (const r of scan.relations) if (!merged.relations.some((x) => x.id === r.id)) merged.relations.push(r);
  }
  const executeMs = Date.now() - t0 - compileMs;

  const co = findCoNeighbors(merged.entities.map((e) => e.id));
  const result = {
    ok: true,
    degraded,
    question: q,    steps: merged.steps.map(({ entities, relations, ...rest }) => rest),
    entities: merged.entities,
    relations: merged.relations,
    co_neighbors: co.pairs,
    bridges: co.bridges,
    timings: { compile_ms: compileMs, execute_ms: executeMs, total_ms: Date.now() - t0 },
  };
  if (degraded && c.error) result.compile_error = c.error;

  if (opts.synthesis !== false && merged.entities.length > 0) {
    const s = await synthesize(q, merged, runPlain);
    result.synthesis = s.synthesis;
    if (s.error) result.synth_error = s.error;
    result.timings.total_ms = Date.now() - t0;
  }
  return result;
}

module.exports = { buildDigest, validatePlan, compilePlan, executePlan, findCoNeighbors, synthesize, ask, extractJson, clampCypher };
