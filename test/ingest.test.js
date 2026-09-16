'use strict';

// 文档入图测试：node --test test/ingest.test.js
// 仅测离线纯逻辑（分片/容错解析/规范化/自动匹配/持久化加载），LLM调用不在覆盖内。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kg_ingest_'));
process.env.KG_DATA_DIR = TMP;
process.env.KG_DB_PATH = path.join(TMP, 'kg.db');

const db = require('../lib/db');
db.open();
const ingest = require('../lib/ingest');

test('chunkText：段落聚合与超长切分，片段不超上限', () => {
  const chunks = ingest.chunkText('段落一。\n\n' + '长'.repeat(3500) + '\n\n尾巴段');
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 3000);
  const empty = ingest.chunkText('   \n\n  ');
  assert.equal(empty.length, 0);
});

test('safeParseJson：容忍代码块/前后缀/尾逗号，垃圾返回null', () => {
  const good = ingest.safeParseJson('前缀```json\n{"entities":[],"relations":[],}\n```后缀');
  assert.ok(good && Array.isArray(good.entities));
  assert.equal(ingest.safeParseJson('完全不是JSON'), null);
  assert.equal(ingest.safeParseJson(''), null);
});

test('normalizeCandidates：类别兜底/置信度三档回退/来源引用生成', () => {
  const raw = {
    entities: [
      { name: ' 长安 ', category: '不存在类', attributes: { 朝代: '唐' }, aliases: [' 京师 ', 123, ''] },
      { name: '', category: '物理实体' },
    ],
    relations: [
      { from: '长安', to: '唐朝', name: '都城', category: '归属', confidence: '谣言' },
      { from: 'x', to: 'y', name: '' },
    ],
  };
  const n = ingest.normalizeCandidates(raw, '古籍.md', 2);
  assert.equal(n.entities.length, 1);
  assert.equal(n.entities[0].name, '长安');
  assert.equal(n.entities[0].category, '抽象实体');
  assert.deepEqual(n.entities[0].aliases, ['京师']);
  assert.equal(n.relations.length, 1);
  assert.equal(n.relations[0].confidence, '推测');
  assert.equal(n.relations[0].source_ref, '《古籍.md》片段3');
});

test('matchEntities：主名/别名/候选间引用三级命中与端点解析', () => {
  const e1 = db.addEntity({ name: '郑和', category: '物理实体', attributes: {} }, '手工');
  db.addAlias(e1.id, '三宝太监', '手工');
  const t = {
    candidates: {
      entities: [
        { name: '郑和', category: '物理实体', attributes: {}, aliases: [], existing_id: null, selected: true },
        { name: '明朝', category: '抽象实体', attributes: {}, aliases: ['大明'], existing_id: null, selected: true },
        { name: '大明', category: '抽象实体', attributes: {}, aliases: [], existing_id: null, selected: true },
      ],
      relations: [
        { from: '郑和', to: '明朝', name: '效力', category: '归属', confidence: '确证', source_ref: 'x', selected: true },
        { from: '三宝太监', to: '大明', name: '效力', category: '归属', confidence: '确证', source_ref: 'x', selected: true },
        { from: '幽灵', to: '郑和', name: '认识', category: '互动', confidence: '确证', source_ref: 'x', selected: true },
      ],
    },
  };
  ingest.matchEntities(t);
  const [zh, ming, daming] = t.candidates.entities;
  assert.equal(zh.existing_id, e1.id, '主名命中现有实体');
  assert.equal(ming.existing_id, null, '新实体无匹配');
  assert.equal(daming.existing_id, 1, '候选别名登记后命中（指向候选下标1）');
  assert.ok(t.candidates.relations[0].from_ref.entity_id && t.candidates.relations[0].to_ref.cand !== undefined);
  assert.ok(t.candidates.relations[1].from_ref.entity_id, '别名命中现有实体');
  assert.ok(t.candidates.relations[2].unresolved, '幽灵端点标记未解析');
});

test('commitTask：全流程（假LLM）勾选过滤/保存点/来源=文档/别名挂接', async () => {
  db.addEntity({ name: '郑和', category: '物理实体', attributes: {} }, '手工');
  const fakeLLM = () => JSON.stringify({
    entities: [
      { name: '刘家港', category: '物理实体', attributes: { 类型: '港口' }, aliases: ['娄江'] },
      { name: '太仓', category: '物理实体', attributes: {}, aliases: [] },
    ],
    relations: [
      { from: '郑和', to: '刘家港', name: '集结于', category: '空间', confidence: '确证' },
      { from: '郑和', to: '太仓', name: '经过', category: '空间', confidence: '推测' },
    ],
  });
  const created = await ingest.createTask('海港笔记.md', Buffer.from('郑和在刘家港集结。'), { runPlain: fakeLLM });
  await new Promise((res) => setTimeout(res, 50)); // run为异步，让出事件循环
  const task = ingest.getTask(created.id);
  assert.equal(task.status, 'review', '假LLM后进入审核态');
  assert.equal(task.candidates.entities.length, 2);

  // 仅勾选 刘家港 + 集结于关系（太仓与"经过"被过滤）
  const r = ingest.commitTask(created.id, {
    entities: ['刘家港'],
    relations: ['郑和|集结于|刘家港'],
  }, '手工');
  assert.equal(r.entities_added, 1, '仅写入勾选的新实体');
  assert.equal(r.entities_linked, 0);
  assert.equal(r.relations_added, 1);
  assert.equal(r.relations_skipped, 1, '未勾选端点的关系跳过');

  const port = db.listEntities().find((e) => e.name === '刘家港');
  assert.ok(port, '新实体入库');
  assert.equal(port.source, '文档', '来源标记文档');
  assert.deepEqual(db.aliasMap()[port.id], ['娄江'], '别名自动挂接');
  const rel = db.listRelations().find((x) => x.name === '集结于');
  assert.ok(rel, '关系入库');
  assert.equal(rel.source, '文档');
  assert.equal(rel.source_ref, '《海港笔记.md》片段1');
  assert.equal(rel.confidence, '确证');
  assert.equal(ingest.getTask(created.id).status, 'committed');
  assert.ok(db.getLogs(5).some((l) => l.op_type.includes('SAVEPOINT') || l.snapshot.includes('海港')), '保存点/操作日志留痕');
});

test('commitTask：审核态校验与任务删除', async () => {
  assert.throws(() => ingest.commitTask('no_such', null, '手工'), (e) => e.status === 404);
  await assert.rejects(() => ingest.createTask('坏.doc', Buffer.from('x')), (e) => e.status === 400);
  const big = Buffer.alloc(11 * 1024 * 1024);
  await assert.rejects(() => ingest.createTask('大.md', big), (e) => e.status === 413);
});
