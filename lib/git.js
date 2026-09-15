'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = 'kg.db';
const META_FILE = '.kg_meta.json'; // 记录最近一次保存点覆盖到的日志id（随版本一起入库，回滚后自动一致）

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: DATA_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: gitEnv(opts),
  });
}

// 读取二进制对象（如SQLite文件）必须用Buffer，避免UTF-8转换损坏数据
function gitBuffer(args) {
  return execFileSync('git', args, {
    cwd: DATA_DIR,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
    env: gitEnv({}),
  });
}

function gitEnv(opts) {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: opts.name || 'KG-Local', GIT_AUTHOR_EMAIL: 'kg@localhost',
    GIT_COMMITTER_NAME: opts.name || 'KG-Local', GIT_COMMITTER_EMAIL: 'kg@localhost',
  };
}

function ensureRepo() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(path.join(DATA_DIR, '.git'))) {
    git(['init', '-b', 'main']);
  }
  git(['config', 'user.name', 'KG-Local']);
  git(['config', 'user.email', 'kg@localhost']);
}

function hasCommits() {
  try { git(['rev-parse', '--verify', 'HEAD']); return true; } catch (_) { return false; }
}

function readMeta() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, META_FILE), 'utf8')); } catch (_) { return { last_saved_log: 0 }; }
}

function writeMeta(meta) {
  fs.writeFileSync(path.join(DATA_DIR, META_FILE), JSON.stringify(meta, null, 2));
}

// 打保存点：提交当前合规数据。git仅存差异对象，不冗余占用空间。
// 提交信息内嵌日志id区间，实现操作日志与Git提交记录双向绑定。
function savepoint(title, source = '系统') {
  ensureRepo();
  const meta = readMeta();
  const currentMax = dbMaxLogId();
  const from = meta.last_saved_log + 1;
  const to = currentMax;
  const finalTitle = (title && String(title).trim()) || `保存点 ${new Date().toLocaleString('zh-CN')}`;
  const msg = `${finalTitle}｜来源:${source}｜日志ID:${from}-${to}`;

  git(['add', '-A', '--', DB_FILE]);
  const staged = git(['diff', '--cached', '--name-only']);
  if (!staged.trim()) return { committed: false, message: '当前数据与最近保存点一致，无差异需要提交' };
  // 元数据与数据在同一个提交内，回滚后自动一致
  writeMeta({ last_saved_log: to });
  git(['add', '-A', '--', META_FILE]);
  git(['commit', '-m', msg]);
  const hash = git(['rev-parse', '--short', 'HEAD']).trim();
  return { committed: true, hash, message: msg, log_range: [from, to] };
}

function dbMaxLogId() {
  try {
    const database = require('./db');
    return database.maxLogId();
  } catch (_) { return readMeta().last_saved_log; }
}

// 提交历史（含日志绑定信息）
function history(limit = 100) {
  ensureRepo();
  if (!hasCommits()) return [];
  const raw = git(['log', '-n', String(limit), '--date=iso-local', '--pretty=format:%H%x01%h%x01%aI%x01%s%x01%an']).trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => {
    const [hash, short, date, subject, author] = line.split('\x01');
    let title = subject, logRange = null, src = '';
    const m = subject.match(/^(.*)｜来源:(.*)｜日志ID:(\d+)-(\d+)$/);
    if (m) { title = m[1]; src = m[2]; logRange = [Number(m[3]), Number(m[4])]; }
    return { hash, short, date, author, title, source: src, log_range: logRange };
  });
}

// 回溯：切到任意保存点。先自动备份当前状态，再恢复目标版本并校验完整性。
function restore(hash) {
  ensureRepo();
  if (!hasCommits()) { const e = new Error('仓库中还没有任何保存点'); e.status = 400; throw e; }
  try { git(['cat-file', '-e', `${hash}^{commit}`]); } catch (_) {
    const e = new Error(`保存点 ${hash} 不存在`); e.status = 404; throw e;
  }
  let backup = null;
  try { backup = savepoint(`回滚前自动备份 ${new Date().toLocaleString('zh-CN')}`, '系统'); } catch (_) { backup = null; }

  // 先在临时文件上校验目标版本完整性，通过后才替换主库，确保任何情况下不损坏现有数据
  const target = gitBuffer(['show', `${hash}:${DB_FILE}`]);
  const tmp = path.join(os.tmpdir(), `kg_restore_${Date.now()}.db`);
  fs.writeFileSync(tmp, target);
  const { DatabaseSync } = require('node:sqlite');
  let probe;
  try {
    probe = new DatabaseSync(tmp);
    const r = probe.prepare('PRAGMA integrity_check').get();
    const v = Object.values(r)[0];
    if (v !== 'ok') { const e = new Error(`目标保存点数据异常: ${v}`); e.status = 500; throw e; }
  } finally {
    try { if (probe) probe.close(); } catch (_) {}
  }
  fs.copyFileSync(tmp, path.join(DATA_DIR, DB_FILE));
  fs.unlinkSync(tmp);
  // 同步恢复日志绑定元数据，保证保存点区间与日志双向绑定始终一致
  try {
    const metaBuf = gitBuffer(['show', `${hash}:${META_FILE}`]);
    fs.writeFileSync(path.join(DATA_DIR, META_FILE), metaBuf);
  } catch (_) {
    writeMeta({ last_saved_log: 0 });
  }
  const database = require('./db');
  database.reopen();
  const check = database.integrityCheck();
  if (!check.ok) {
    const e = new Error('恢复后的数据库完整性校验失败: ' + check.detail);
    e.status = 500; throw e;
  }
  // 记录回溯操作（source=系统），保证日志与版本可互溯
  const counts = database.counts();
  return { restored: hash, backup: backup && backup.hash ? backup.hash : null, counts };
}

module.exports = { ensureRepo, savepoint, history, restore, readMeta, DATA_DIR };
