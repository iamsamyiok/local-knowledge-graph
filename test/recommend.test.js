'use strict';

const test = require('node:test');
const assert = require('node:assert');
const rec = require('../lib/recommend');

// 测试图：A-B、B-C、C-D、B-D、A-E、E-C（A与C共同邻居B/E两条；A与D共同邻居B；全连通小图）
function makeGraph() {
  const ents = ['A', 'B', 'C', 'D', 'E'].map((n, i) => ({ id: i + 1, name: n, category: '抽象实体', attributes: '{}' }));
  const pairs = [[1, 2], [2, 3], [3, 4], [2, 4], [1, 5], [5, 3]];
  const rels = pairs.map(([s, t], i) => ({ id: i + 1, source_id: s, target_id: t, name: `r${i + 1}`, category: '互动', confidence: '确证', source_ref: '' }));
  return { entities: ents, relations: rels };
}

test('recommend: 共同邻居候选排除直接边并按AA排序', () => {
  const g = makeGraph();
  const out = rec.computeCoNeighborRecs(g, { minCommon: 1 });
  const keys = out.map((r) => `${r.source_name}|${r.target_name}`).sort();
  // 直接边对全部排除：A-B/B-C/C-D/B-D/A-E/E-C 均不出现
  for (const banned of ['A|B', 'B|A', 'B|C', 'C|B', 'C|D', 'D|C', 'B|D', 'D|B', 'A|E', 'E|A', 'E|C', 'C|E']) {
    assert.equal(keys.includes(banned), false, `直接边对 ${banned} 不应出现`);
  }
  // A-C 有两个共同邻居(B,E)，必然在列且排最前（AA分最高）
  const ac = out.find((r) => (r.source_name === 'A' && r.target_name === 'C') || (r.source_name === 'C' && r.target_name === 'A'));
  assert.ok(ac, 'A-C 应为候选');
  assert.equal(ac.common_count, 2);
  assert.deepEqual([...ac.common_names].sort(), ['B', 'E']);
  assert.equal(out[0].source_name + out[0].target_name, ac.source_name + ac.target_name);
});

test('recommend: minCommon与center过滤与limit', () => {
  const g = makeGraph();
  // minCommon=2：A-C（经B,E）与 B-E（经A,C）入选
  const out = rec.computeCoNeighborRecs(g, { minCommon: 2 });
  assert.equal(out.length, 2);
  for (const r of out) assert.equal(r.common_count, 2);
  const pairNames = out.map((r) => [r.source_name, r.target_name].sort().join('-')).sort();
  assert.deepEqual(pairNames, ['A-C', 'B-E']);
  // center=D：只返回与D相关的候选（D-A 经B、D-E 经C）
  const out2 = rec.computeCoNeighborRecs(g, { centerId: 4, minCommon: 1 });
  assert.ok(out2.length >= 1);
  for (const r of out2) assert.ok(r.source_id === 4 || r.target_id === 4, 'center过滤后候选必含D');
  // limit 生效
  assert.equal(rec.computeCoNeighborRecs(g, { minCommon: 1, limit: 1 }).length, 1);
});

test('recommend: 空图与孤立实体安全', () => {
  assert.deepEqual(rec.computeCoNeighborRecs({ entities: [], relations: [] }), []);
  const g = { entities: [{ id: 1, name: '孤', category: '抽象实体', attributes: '{}' }], relations: [] };
  assert.deepEqual(rec.computeCoNeighborRecs(g), []);
});

test('recommend: validateJudge 白名单校验', () => {
  // 合法
  let v = rec.validateJudge({ has_relation: true, name: '师从', category: '互动', confidence: '推测', evidence: '共同师承' });
  assert.equal(v.ok, true);
  assert.equal(v.judge.name, '师从');
  // 非法大类拒绝
  v = rec.validateJudge({ has_relation: true, name: 'x', category: '人物', confidence: '确证' });
  assert.equal(v.ok, false);
  // has_relation=false 只要求布尔
  v = rec.validateJudge({ has_relation: false });
  assert.equal(v.ok, true);
  assert.equal(v.judge.has_relation, false);
  // 非对象拒绝
  assert.equal(rec.validateJudge(null).ok, false);
  // true但无名字拒绝
  assert.equal(rec.validateJudge({ has_relation: true, name: '', category: '空间' }).ok, false);
});

test('recommend: aiJudgeRelation 解析mock输出', async () => {
  const a = { id: 1, name: '刘备', category: '物理实体', attributes: '{"身份":"君主"}' };
  const b = { id: 2, name: '公孙瓒', category: '物理实体', attributes: '{}' };
  // 合法JSON（带markdown围栏）
  const ok = await rec.aiJudgeRelation({ a, b, common_names: ['卢植'] }, async () => ({
    ok: true, text: '```json\n{"has_relation": true, "name": "同门", "category": "互动", "confidence": "推测", "evidence": "均师从卢植"}\n```',
  }));
  assert.equal(ok.has_relation, true);
  assert.equal(ok.name, '同门');
  assert.equal(ok.confidence, '推测');
  assert.equal(ok.source_id, 1);
  // has_relation=false 短路
  const no = await rec.aiJudgeRelation({ a, b }, async () => ({ ok: true, text: '{"has_relation": false}' }));
  assert.equal(no.has_relation, false);
  // runPlain失败 → 502
  await assert.rejects(
    () => rec.aiJudgeRelation({ a, b }, async () => ({ ok: false, error: '超时' })),
    /502|LLM判断失败/
  );
  // 输出非JSON → 502
  await assert.rejects(
    () => rec.aiJudgeRelation({ a, b }, async () => ({ ok: true, text: '我觉得有关系' })),
    /无法解析/
  );
  // 非法大类 → 502
  await assert.rejects(
    () => rec.aiJudgeRelation({ a, b }, async () => ({ ok: true, text: '{"has_relation":true,"name":"同乡","category":"血缘"}' })),
    /校验未通过/
  );
});

test('recommend: buildJudgePrompt 含实体与共同邻居', () => {
  const p = rec.buildJudgePrompt(
    { name: 'A', category: '物理实体', attributes: '{"k":"v"}' },
    { name: 'B', category: '抽象实体', attributes: '{}' },
    ['M1', 'M2']
  );
  assert.ok(p.includes('A（物理实体）'));
  assert.ok(p.includes('{"k":"v"}'));
  assert.ok(p.includes('M1、M2'));
  assert.ok(p.includes('has_relation'));
});
