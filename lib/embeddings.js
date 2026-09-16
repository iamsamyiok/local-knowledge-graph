'use strict';

// 向量混合检索：实体名称+属性文本 → embedding（默认硅基流动 BAAI/bge-m3），
// 与关键词检索做 RRF 融合排序。配置存于 data/settings.json（gitignored，密钥不入库）。

const fs = require('fs');
const path = require('path');
const vectors = require('./vectors');
const db = require('./db');

const { DATA_DIR } = require('./paths');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  provider: 'siliconflow',
  base_url: 'https://api.siliconflow.cn/v1',
  model: 'BAAI/bge-m3',
  dim: 1024,
  api_key: '',
  rrf_k: 60,
};

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) }; }
  catch (_) { return { ...DEFAULTS }; }
}

function saveSettings(patch) {
  const merged = { ...loadSettings(), ...(patch || {}) };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

function entityText(e) {
  let attrs = '';
  try {
    const o = JSON.parse(e.attributes || '{}');
    attrs = Object.entries(o).map(([k, v]) => `${k}:${v}`).join('；');
  } catch (_) { /* 属性非法时忽略 */ }
  return `${e.name}（${e.category}）${attrs ? ' ' + attrs : ''}`;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

async function embed(texts, settings) {
  const s = settings || loadSettings();
  if (!s.api_key) throw new Error('未配置embedding API key，请打开"检索"页签填写');
  const url = s.base_url.replace(/\/+$/, '') + '/embeddings';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.api_key}` },
    body: JSON.stringify({ model: s.model, input: texts }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`embedding接口错误 ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  const vectors = data.data.map((d) => d.embedding);
  if (vectors.length !== texts.length) throw new Error('embedding返回数量与请求不一致');
  return vectors;
}

function status() {
  const s = loadSettings();
  return {
    configured: Boolean(s.api_key),
    provider: s.provider, model: s.model, dim: s.dim,
    indexed: vectors.count(),
    total_entities: db.listEntities().length,
  };
}

// 构建全部实体向量（增量：仅未入库或文本变化的实体），并清理已删实体的孤儿向量
async function build(progress) {
  const s = loadSettings();
  const ents = db.listEntities();
  vectors.pruneOrphans(ents.map((e) => e.id));
  const pending = ents.filter((e) => {
    const row = vectors.get(e.id);
    return !row || row.text !== entityText(e);
  });
  const done = ents.length - pending.length;
  if (progress) progress(done, ents.length);
  const BATCH = 32;
  for (let i = 0; i < pending.length; i += BATCH) {
    const chunk = pending.slice(i, i + BATCH);
    const texts = chunk.map(entityText);
    const vecs = await embed(texts, s);
    chunk.forEach((e, k) => vectors.upsert(e.id, texts[k], vecs[k]));
    if (progress) progress(done + Math.min(i + BATCH, pending.length), ents.length);
  }
  return { indexed: vectors.count(), total: ents.length };
}

// 关键词检索：名称/别名/属性包含，粗略打分（命中名称权重高，别名次之）
function keywordSearch(graph, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  const aliasMap = graph.aliases || {};
  const scored = [];
  for (const e of graph.entities) {
    let score = 0;
    const name = e.name.toLowerCase();
    const aliases = (aliasMap[e.id] || []).map((a) => a.toLowerCase());
    for (const t of terms) {
      if (name === t) score += 10;
      else if (name.includes(t)) score += 5;
      else if (aliases.some((a) => a === t)) score += 6;
      else if (aliases.some((a) => a.includes(t))) score += 3;
      else if (entityText(e).toLowerCase().includes(t)) score += 1;
    }
    if (score > 0) scored.push({ id: e.id, score });
  }
  return scored;
}

// 混合检索：语义(余弦) + 关键词 RRF 融合，k=60
async function search(query, topK) {
  const s = loadSettings();
  const k = Number(s.rrf_k) || 60;
  const limit = Math.max(1, Math.min(Number(topK) || 10, 50));
  const graph = db.getGraph();
  const byId = new Map(graph.entities.map((e) => [e.id, e]));

  const kw = keywordSearch(graph, query);

  let sem = [];
  if (s.api_key && vectors.count() > 0) {
    const [qvec] = await embed([query], s);
    sem = vectors.all()
      .map((row) => ({ id: row.entity_id, score: cosine(qvec, Float32Array.from(row.vector)) }))
      .filter((x) => x.score > 0.15);
  }

  const rrf = new Map();
  const addRanking = (arr) => {
    arr.sort((a, b) => b.score - a.score).slice(0, limit * 3).forEach((x, rank) => {
      rrf.set(x.id, (rrf.get(x.id) || 0) + 1 / (k + rank + 1));
    });
  };
  addRanking(kw);
  if (sem.length) addRanking(sem);

  const results = [...rrf.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, rrfScore]) => {
      const e = byId.get(id);
      const semRow = sem.find((x) => x.id === id);
      const kwRow = kw.find((x) => x.id === id);
      return {
        entity: e,
        rrf_score: Number(rrfScore.toFixed(5)),
        semantic_score: semRow ? Number(semRow.score.toFixed(4)) : null,
        keyword_score: kwRow ? kwRow.score : null,
        hit_relations: graph.relations.filter((r) => r.source_id === id || r.target_id === id).length,
      };
    });
  return { results, mode: s.api_key && vectors.count() > 0 ? 'hybrid' : 'keyword_only' };
}

module.exports = { loadSettings, saveSettings, status, build, search, embed, entityText };
