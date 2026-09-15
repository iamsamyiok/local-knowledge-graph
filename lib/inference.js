'use strict';

// OWL式推理引擎：基于本体属性特征（传递/对称/逆）从显式关系推导隐性关系。
// 推理结果为虚拟三元组（不入库），附带推导规则与关系id路径，供前端展示与API查询。

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ONTOLOGY_PATH = path.join(DATA_DIR, 'ontology.json');

const DEFAULT_ONTOLOGY = {
  transitive: ['位于', '在', '包含', '包括', '属于', '下辖于', '隶属于', '统治', '管辖', '发源于', '流入'],
  symmetric: ['挚友', '夫妻', '同学', '同事', '结为兄弟', '相邻', '同义词'],
  inverse: [['父子', '子父'], ['包含', '属于'], ['创建', '创建者'], ['师从', '学生为']],
};

function loadOntology() {
  try {
    const o = JSON.parse(fs.readFileSync(ONTOLOGY_PATH, 'utf8'));
    return normalizeOntology(o);
  } catch (_) {
    return normalizeOntology(DEFAULT_ONTOLOGY);
  }
}

function normalizeOntology(o) {
  const out = { transitive: [], symmetric: [], inverse: [] };
  if (o && typeof o === 'object') {
    if (Array.isArray(o.transitive)) out.transitive = o.transitive.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    if (Array.isArray(o.symmetric)) out.symmetric = o.symmetric.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    if (Array.isArray(o.inverse)) {
      out.inverse = o.inverse
        .filter((p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'string' && x.trim()))
        .map((p) => [p[0].trim(), p[1].trim()]);
    }
  }
  return out;
}

function saveOntology(o) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ONTOLOGY_PATH, JSON.stringify(normalizeOntology(o), null, 2));
  return loadOntology();
}

// 推理主入口：graph = {entities, relations}
function computeInferred(graph, ontology) {
  const ont = ontology || loadOntology();
  const inferred = [];
  const seen = new Set();
  const explicitKeys = new Set(graph.relations.map((r) => `${r.source_id}|${r.target_id}|${r.name}`));

  // R1 传递性(TransitiveProperty): A -n-> B, B -n-> C ⇒ A -n-> C（闭包，路径取最短）
  for (const name of ont.transitive) {
    const rels = graph.relations.filter((r) => r.name === name);
    if (!rels.length) continue;
    const adj = new Map();
    for (const r of rels) {
      if (!adj.has(r.source_id)) adj.set(r.source_id, []);
      adj.get(r.source_id).push(r);
    }
    for (const [start, outEdges] of adj) {
      const reached = new Map(); // nodeId -> path(rel[])
      const queue = [];
      for (const e of outEdges) queue.push({ node: e.target_id, path: [e] });
      while (queue.length) {
        const { node, path } = queue.shift();
        if (reached.has(node) || node === start) continue;
        reached.set(node, path);
        for (const e of adj.get(node) || []) {
          if (!reached.has(e.target_id)) queue.push({ node: e.target_id, path: [...path, e] });
        }
      }
      for (const [node, path] of reached) {
        const key = `${start}|${node}|${name}`;
        if (explicitKeys.has(key)) continue;
        seen.add(key);
        inferred.push({
          source_id: start, target_id: node, name,
          category: path[0].category,
          rule: `传递性(${name})`,
          via: path.map((e) => e.id),
        });
      }
    }
  }

  // R2 对称性(SymmetricProperty): A -n-> B ⇒ B -n-> A
  for (const name of ont.symmetric) {
    for (const r of graph.relations.filter((x) => x.name === name)) {
      if (r.source_id === r.target_id) continue;
      const key = `${r.target_id}|${r.source_id}|${r.name}`;
      if (explicitKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      inferred.push({
        source_id: r.target_id, target_id: r.source_id, name: r.name,
        category: r.category,
        rule: `对称性(${r.name})`,
        via: [r.id],
      });
    }
  }

  // R3 逆关系(inverseOf): A -p-> B ⇒ B -q-> A（p,q为逆对）
  for (const [p, q] of ont.inverse) {
    for (const r of graph.relations.filter((x) => x.name === p)) {
      const key = `${r.target_id}|${r.source_id}|${q}`;
      if (explicitKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      inferred.push({
        source_id: r.target_id, target_id: r.source_id, name: q,
        category: r.category,
        rule: `逆关系(${p} ↔ ${q})`,
        via: [r.id],
      });
    }
  }

  return inferred;
}

module.exports = { loadOntology, saveOntology, computeInferred };
