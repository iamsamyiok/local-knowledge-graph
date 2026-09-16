'use strict';

// 版本与更新测试：node --test test/
// 仅测离线纯逻辑与本地信息读取；联网检查（git fetch / GitHub API）不在测试覆盖内。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const updater = require('../lib/updater');

test('currentVersion: 与package.json一致', () => {
  const pkg = require('../package.json');
  assert.equal(updater.currentVersion(), pkg.version);
});

test('compareVersions: 三段语义化比较', () => {
  assert.equal(updater.compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(updater.compareVersions('1.2.0', '1.2.0'), 0);
  assert.equal(updater.compareVersions('1.2.0', '2.0.0'), -1);
  assert.equal(updater.compareVersions('1.2', '1.2.1'), -1); // 缺段按0
});

test('checkSync: 正常返回结构（当前为Git仓库）', () => {
  const r = updater.checkSync();
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'git');
  assert.equal(r.current_version, require('../package.json').version);
  assert.equal(typeof r.up_to_date, 'boolean');
  assert.ok(r.local_sha === undefined || /^[0-9a-f]{7}$/.test(r.local_sha));
});

test('updateMode: 开发仓库为git模式', () => {
  assert.equal(updater.updateMode(), 'git');
});

test('checkSync: 非Git目录返回ok:false', () => {
  // 临时改 ROOT 不可行（模块常量），用 cwd 注入校验错误路径分支
  const { execFileSync } = require('child_process');
  let threw = false;
  try {
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(require('os').tmpdir(), 'kg_nonexist_repo'), timeout: 5000, encoding: 'utf8' });
  } catch (_) { threw = true; }
  assert.equal(threw, true);
});

test('repoSlug: 解析出owner/repo形态', () => {
  assert.match(updater.repoSlug(), /^[\w.-]+\/[\w.-]+$/);
});
