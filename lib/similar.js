'use strict';

// 相似实体：优先嵌入向量余弦Top-K，向量不可用时降级为共邻居Jaccard

const db = require('./db');
const embeddings = require('./embeddings');
const vectors = require('./vectors');

function coNeighborScores(targetId, entities, relations) {
  const neighbors = new Map();
  for (const r of relations) {
    if (r.source_id === targetId) neighbors.set(r.target_id, 1);
    if (r.target_id === targetId) neighbors.set(r.source_id, 1);
  }
  if (!neighbors.size) return [];
  const incident = new Map();
  for (const r of relations) {
    for (const [a, b] of [[r.source_id, r.target_id], [r.target_id, r.source_id]]) {
      if (!incident.has(a)) incident.set(a, new Set());
      incident.get(a).add(b);
    }
  }
  const own = incident.get(targetId) || new Set();
  const scores = [];
  for (const e of entities) {
    if (e.id === targetId) continue;
    const other = incident.get(e.id);
    if (!other || !other.size) continue;
    let inter = 0;
    for (const n of other) if (own.has(n)) inter += 1;
    if (inter === 0 && !neighbors.has(e.id)) continue;
    const union = new Set([...own, ...other]).size;
    scores.push({ id: e.id, score: inter / union });
  }
  return scores;
}

async function similarEntities(id, k = 8) {
  const target = db.getEntity(id);
  if (!target) { const e = new Error(`实体id=${id} 不存在`); e.status = 404; throw e; }
  const cap = Math.min(20, Math.max(1, Number.isInteger(k) ? k : 8));
  const graph = db.getGraph();
  const byId = new Map(graph.entities.map((e) => [e.id, e]));

  // 语义路径：目标向量缺失时即时补算
  let semantic = [];
  const s = embeddings.loadSettings();
  if (s.api_key && vectors.count() > 0) {
    try {
      let trow = vectors.get(id);
      if (!trow) {
        const [vec] = await embeddings.embed([embeddings.entityText(target)], s);
        vectors.upsert(id, Float32Array.from(vec));
        trow = { entity_id: id, vector: Float32Array.from(vec) };
      }
      const tvec = Float32Array.from(trow.vector);
      semantic = vectors.all()
        .filter((row) => row.entity_id !== id)
        .map((row) => ({ id: row.entity_id, score: embeddings.cosine(tvec, Float32Array.from(row.vector)) }))
        .filter((x) => x.score > 0.1);
    } catch (_) { semantic = []; }
  }

  if (semantic.length) {
    semantic.sort((a, b) => b.score - a.score);
    return {
      mode: 'semantic',
      results: semantic.slice(0, cap).map((x) => ({ entity: byId.get(x.id), score: Number(x.score.toFixed(4)) })).filter((x) => x.entity),
    };
  }

  // 结构降级：共邻居Jaccard
  const struct = coNeighborScores(id, graph.entities, graph.relations)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((x) => ({ entity: byId.get(x.id), score: Number(x.score.toFixed(4)) }))
    .filter((x) => x.entity);
  return { mode: 'structure', results: struct };
}

module.exports = { similarEntities };
