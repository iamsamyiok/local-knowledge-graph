'use strict';

// 关系推荐：共同邻居图算法（Adamic-Adar打分）+ LLM候选关系判断
// 设计约束：推荐纯本地只读计算；LLM判断只输出建议JSON，入库须经前端确认（走人工接口，来源'手工'）。

const REL_CATS = ['空间', '互动', '归属', '时间', '属性'];
const CONF_LEVELS = ['确证', '推测', '存疑'];
const MAX_LLM_TIMEOUT = 60000; // opencode CLI 实测冷启动+推理可达30-50s，与综述超时一致

// ---------- 共同邻居推荐 ----------
// 对每对无直接边的实体统计共同邻居并按 Adamic-Adar 打分（邻居越稀有分越高）。
// opts.centerId 限定只返回与该实体相关的候选；opts.minCommon 最小共同邻居数（默认2，center模式1）；opts.limit 返回上限（默认20）。
function computeCoNeighborRecs(graph, opts = {}) {
  const centerId = opts.centerId || null;
  const limit = Math.min(Math.max(1, Number(opts.limit) || 20), 100);
  const minCommon = Math.max(1, Number(opts.minCommon) || (centerId ? 1 : 2));

  const byId = new Map(graph.entities.map((e) => [e.id, e]));
  const neighbors = new Map(); // id -> Map(邻居id -> 经该邻居相连的关系数)
  const touch = (id) => { if (!neighbors.has(id)) neighbors.set(id, new Map()); };
  const direct = new Set(); // 'a|b' 双向规范化键
  const dkey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const r of graph.relations) {
    if (!byId.has(r.source_id) || !byId.has(r.target_id)) continue;
    touch(r.source_id); touch(r.target_id);
    neighbors.get(r.source_id).set(r.target_id, (neighbors.get(r.source_id).get(r.target_id) || 0) + 1);
    neighbors.get(r.target_id).set(r.source_id, (neighbors.get(r.target_id).get(r.source_id) || 0) + 1);
    direct.add(dkey(r.source_id, r.target_id));
  }

  // 每节点收集2跳计数：O(V * deg^2)，大图时节点按度截断保护
  const DEG_CAP = 300;
  const nodes = [...byId.keys()].filter((id) => neighbors.has(id));
  const counter = new Map(); // 'a|b' -> Map(commonId -> true)
  for (const a of nodes) {
    const nbs = [...neighbors.get(a).keys()];
    if (nbs.length > DEG_CAP) continue; // 度数过高的枢纽节点跳过全对展开，防爆炸
    for (const m of nbs) {
      const mn = neighbors.get(m);
      if (!mn) continue;
      for (const b of mn.keys()) {
        if (b === a || neighbors.get(a).has(b)) continue; // 自身或已有直接边
        const k = dkey(a, b);
        if (!counter.has(k)) counter.set(k, new Map());
        counter.get(k).set(m, true);
      }
    }
  }

  const nameOf = (id) => (byId.get(id) ? byId.get(id).name : `#${id}`);
  const recs = [];
  for (const [k, commons] of counter) {
    if (commons.size < minCommon) continue;
    const [a, b] = k.split('|').map(Number);
    if (centerId && a !== centerId && b !== centerId) continue;
    // Adamic-Adar：sum(1/log(deg(共同邻居)))
    let score = 0;
    for (const c of commons.keys()) {
      const deg = (neighbors.get(c) || new Map()).size || 1;
      score += 1 / Math.log(deg + 1);
    }
    recs.push({
      source_id: a, target_id: b,
      source_name: nameOf(a), target_name: nameOf(b),
      common_count: commons.size,
      common_names: [...commons.keys()].slice(0, 6).map(nameOf),
      score: Number(score.toFixed(4)),
    });
  }
  recs.sort((x, y) => y.score - x.score || y.common_count - x.common_count);
  return recs.slice(0, limit);
}

// ---------- LLM 候选关系判断 ----------
function buildJudgePrompt(a, b, commonNames) {
  const ent = (e) => {
    let s = `- ${e.name}（${e.category}）`;
    let attrs = '';
    try { attrs = JSON.stringify(JSON.parse(e.attributes || '{}')); } catch (_) { attrs = String(e.attributes || '{}'); }
    if (attrs && attrs !== '{}') s += ` 属性:${attrs.slice(0, 300)}`;
    return s;
  };
  return [
    '你是知识图谱专家。判断以下两个实体之间是否存在值得录入图谱的明确关系（基于常识与给出的事实，不要编造）。',
    `实体A: ${ent(a)}`,
    `实体B: ${ent(b)}`,
    commonNames && commonNames.length ? `它们在图谱中拥有共同关联: ${commonNames.join('、')}` : '',
    '',
    '只输出JSON（不要其他文字），格式：',
    '{"has_relation": true/false, "name": "关系名(2-4字，如 师从/位于/效力于)", "category": "空间|互动|归属|时间|属性 之一", "confidence": "确证|推测|存疑 之一", "evidence": "一句话依据"}',
    'has_relation 为 false 时其余字段留空字符串。',
  ].filter(Boolean).join('\n');
}

// 校验LLM输出；非法字段回退默认或拒绝
function validateJudge(j) {
  if (!j || typeof j !== 'object') return { ok: false, error: '输出不是JSON对象' };
  const out = {
    has_relation: Boolean(j.has_relation),
    name: String(j.name || '').trim().slice(0, 30),
    category: REL_CATS.includes(j.category) ? j.category : '',
    confidence: CONF_LEVELS.includes(j.confidence) ? j.confidence : '推测',
    evidence: String(j.evidence || '').trim().slice(0, 300),
  };
  if (!out.has_relation) return { ok: true, judge: { has_relation: false } };
  if (!out.name) return { ok: false, error: 'has_relation为true时关系名不能为空' };
  if (!out.category) return { ok: false, error: `关系大类必须是: ${REL_CATS.join('/')}` };
  return { ok: true, judge: out };
}

function extractJson(text) {
  let t = String(text || '').trim().replace(/```(?:json)?/gi, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('输出中未找到JSON对象');
  return JSON.parse(t.slice(start, end + 1));
}

// runPlain 可注入（测试mock）；graph 关系用于取两实体邻域摘要
async function aiJudgeRelation(payload, runPlain) {
  const { a, b, common_names } = payload || {};
  if (!a || !b) { const e = new Error('必须提供待判断的两个实体'); e.status = 400; throw e; }
  const rp = runPlain || require('./agent').runPlain;
  const r = await rp(buildJudgePrompt(a, b, common_names || []), MAX_LLM_TIMEOUT);
  if (!r.ok) { const e = new Error(`LLM判断失败: ${r.error}`); e.status = 502; throw e; }
  let raw;
  try { raw = extractJson(r.text); } catch (e) { const err = new Error(`LLM输出无法解析: ${e.message}`); err.status = 502; throw err; }
  const v = validateJudge(raw);
  if (!v.ok) { const err = new Error(`LLM输出校验未通过: ${v.error}`); err.status = 502; throw err; }
  return { ...v.judge, source_id: a.id, target_id: b.id, source_name: a.name, target_name: b.name };
}

module.exports = { computeCoNeighborRecs, buildJudgePrompt, validateJudge, aiJudgeRelation, REL_CATS, CONF_LEVELS };
