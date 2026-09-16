'use strict';

// 数据目录解析测试：node --test test/
// 纯离线：resolveDataDir 注入 env/home/root，绝不触碰真实数据目录。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../lib/paths');

test('resolveDataDir: KG_DATA_DIR 环境变量优先', () => {
  const r = paths.resolveDataDir({ env: { KG_DATA_DIR: '/tmp/kg_custom' }, home: '/home/u', root: '/app' });
  assert.equal(r, '/tmp/kg_custom');
});

test('resolveDataDir: 开发仓库(.git存在)用项目内data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg_devrepo_'));
  fs.mkdirSync(path.join(root, '.git'));
  const r = paths.resolveDataDir({ env: {}, home: '/home/u', root });
  assert.equal(r, path.join(root, 'data'));
});

test('resolveDataDir: npm安装模式用用户目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg_npmdir_'));
  const r = paths.resolveDataDir({ env: {}, home: '/home/u', root });
  assert.equal(r, path.join('/home/u', '.local-knowledge-graph'));
});

test('isDevRepo: 当前仓库为开发模式', () => {
  assert.equal(paths.isDevRepo(), true);
});

test('当前环境数据目录与库路径一致', () => {
  assert.equal(paths.DB_PATH, path.join(paths.DATA_DIR, 'kg.db'));
});
