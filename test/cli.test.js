'use strict';

// kgctl CLI 冒烟测试：node --test test/cli.test.js
// 在临时数据目录（KG_DATA_DIR 隔离）中运行 bin/kgctl.js，验证命令、退出码与 --json 输出。

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KGCTL = path.join(__dirname, '..', 'bin', 'kgctl.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kgctl-test-'));
const env = { ...process.env, KG_DATA_DIR: tmp };

function run(args, expect = 0) {
  const r = spawnSync(process.execPath, [KGCTL, ...args], { env, encoding: 'utf8' });
  assert.equal(
    r.status, expect,
    `kgctl ${args.join(' ')} → 退出码 ${r.status}（期望 ${expect}）\nstdout: ${r.stdout}\nstderr: ${r.stderr}`
  );
  return r;
}

test('stats: 空库统计与类别枚举', () => {
  const d = JSON.parse(run(['stats', '--json']).stdout);
  assert.equal(d.entities, 0);
  assert.deepEqual(d.entity_categories, ['物理实体', '抽象实体', '数值实体', '时间实体']);
  assert.deepEqual(d.relation_categories, ['空间', '互动', '归属', '时间', '属性']);
});

test('add-entity/get: 创建、别名解析、重名拒绝（退出码2 + 候选）', () => {
  const r = JSON.parse(run(['add-entity', '测试甲', '--category', '物理实体', '--attr', '{"颜色":"红"}', '--alias', '甲别', '--json']).stdout);
  assert.equal(r.id, 1);

  const got = JSON.parse(run(['get', '甲别', '--json']).stdout); // 别名可定位
  assert.equal(got.entity.name, '测试甲');
  assert.deepEqual(got.entity.aliases, ['甲别']);

  run(['add-entity', '测试甲', '--category', '物理实体'], 2);                    // 重名 → 2
  const dupJson = JSON.parse(run(['add-entity', '测试甲', '--category', '物理实体', '--json'], 2).stdout);
  assert.equal(dupJson.status, 409);
  assert.ok(Array.isArray(dupJson.candidates) && dupJson.candidates.length === 1);
});

test('delete-entity: 缺 --yes 拒绝（退出码5），确认后级联删除', () => {
  run(['delete-entity', '测试甲'], 5); // 缺确认 → 5
  run(['add-entity', '测试乙', '--category', '抽象实体']);
  run(['add-relation', '测试乙', '甲别', '--name', '关联', '--category', '互动', '--confidence', '推测', '--evidence', '测试依据']);
  const del = JSON.parse(run(['delete-entity', '测试乙', '--yes', '--json']).stdout);
  assert.equal(del.cascaded_relations, 1);
  run(['get', '测试乙'], 1); // 已删除 → 未找到 1
});

test('ops: 批量原子写入，违规整批回滚（退出码4）', () => {
  const opsFile = path.join(tmp, 'ops.json');
  fs.writeFileSync(opsFile, JSON.stringify([
    { op: 'add_entity', ref: 'X', name: '批量实体', category: '数值实体', attributes: { 值: 42 } },
    { op: 'add_relation', source_ref: 'X', target_name: '测试甲', name: '指向', category: '互动' },
  ]));
  const r = JSON.parse(run(['ops', '--file', opsFile, '--json']).stdout);
  assert.equal(r.applied_count, 2);

  const badFile = path.join(tmp, 'bad-ops.json');
  fs.writeFileSync(badFile, JSON.stringify([
    { op: 'add_entity', name: '不应存在', category: '物理实体' },
    { op: 'add_entity', name: '坏大类', category: '不存在的大类' },
  ]));
  run(['ops', '--file', badFile], 4); // 第2条违规 → 4
  const list = JSON.parse(run(['list', '--json']).stdout);
  assert.ok(!list.entities.some((e) => e.name === '不应存在'), '违规批次不得残留部分写入');
});

test('cypher/savepoint/history/export/undo/查询族', () => {
  const cy = JSON.parse(run(['cypher', 'MATCH (a)-[r:互动]->(b) WHERE a.name contains 批量 RETURN a.name, b.name LIMIT 5', '--json']).stdout);
  assert.equal(cy.rows.length, 1);

  run(['ego', '批量实体', '1']);
  run(['paths', '批量实体', '测试甲', '3']);
  run(['inference']);
  run(['recommend', '批量实体']);

  // undo 改库但不自动保存点 → 随后的 savepoint 产生带标题的新提交
  run(['undo', '--yes']);
  run(['savepoint', 'cli-test']);
  const hist = JSON.parse(run(['history', '5', '--json']).stdout);
  assert.ok(hist.commits.some((c) => c.title.includes('cli-test')));

  const ttl = path.join(tmp, 'out.ttl');
  run(['export', 'rdf', ttl]);
  assert.ok(fs.statSync(ttl).size > 0);
});
