'use strict';

// 标准RDF(Turtle)导出：所有字段严格映射为三元组，禁止冗余结构
const { RDF_TYPE_MAP, RDF_RELATION_TYPE_MAP } = require('./validator');

const HEADER = `@prefix kg: <http://monkeycode.local/kg/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

function esc(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function lit(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? `"${v}"^^xsd:integer` : `"${v}"^^xsd:decimal`;
  if (typeof v === 'boolean') return `"${v}"^^xsd:boolean`;
  if (v === null || v === undefined) return `""^^rdf:nil`;
  return `"${esc(v)}"`;
}

function exportTurtle(graph) {
  const parts = [HEADER];

  for (const e of graph.entities) {
    const cls = RDF_TYPE_MAP[e.category] || 'Entity';
    const lines = [];
    lines.push(`kg:e${e.id} rdf:type kg:${cls} ;`);
    lines.push(`    rdfs:label "${esc(e.name)}"@zh ;`);
    lines.push(`    kg:category "${esc(e.category)}" ;`);
    lines.push(`    kg:createdAt "${esc(e.created_at)}"^^xsd:dateTime ;`);
    lines.push(`    kg:source "${esc(e.source)}"`);
    let attrs = {};
    try { attrs = JSON.parse(e.attributes || '{}'); } catch (_) { attrs = {}; }
    const chunks = [];
    for (const [k, v] of Object.entries(attrs)) {
      chunks.push(`    kg:attribute [ kg:key ${lit(k)} ; kg:value ${lit(v)} ]`);
    }
    parts.push(chunks.length ? lines.join('\n') + ' ;\n' + chunks.join(' ;\n') + ' .\n' : lines.join('\n') + ' .\n');
  }

  for (const r of graph.relations) {
    const cls = RDF_RELATION_TYPE_MAP[r.category] || 'Relation';
    parts.push(
      `kg:r${r.id} rdf:type kg:${cls} ;\n` +
      `    rdfs:label "${esc(r.name)}"@zh ;\n` +
      `    kg:category "${esc(r.category)}" ;\n` +
      `    kg:subject kg:e${r.source_id} ;\n` +
      `    kg:object kg:e${r.target_id} ;\n` +
      `    kg:createdAt "${esc(r.created_at)}"^^xsd:dateTime ;\n` +
      `    kg:source "${esc(r.source)}" .\n`
    );
  }

  return parts.join('\n');
}

module.exports = { exportTurtle };
