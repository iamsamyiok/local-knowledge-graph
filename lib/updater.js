'use strict';

// 版本与更新（双模式）：
//  - 开发模式（程序目录是Git仓库）：git fetch 对比 origin/master，pull --ff-only 更新
//  - npm 模式（全局安装）：npm view 对比注册表版本，npm i -g <pkg>@latest 更新
// 数据目录独立于程序目录，两种模式的升级都不影响用户数据。

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { APP_ROOT, PKG_NAME, isDevRepo } = require('./paths');

const GIT_TIMEOUT = 20000;

function git(args, timeout = GIT_TIMEOUT) {
  return execFileSync('git', args, { cwd: APP_ROOT, timeout, encoding: 'utf8' }).trim();
}

function npm(args, timeout = 30000) {
  const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return execFileSync(bin, args, { cwd: APP_ROOT, timeout, encoding: 'utf8' }).trim();
}

function shortErr(e) {
  return String(e.message || e).split('\n')[0].slice(0, 180);
}

function currentVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version; }
  catch (_) { return 'unknown'; }
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function repoSlug() {
  try {
    const url = git(['remote', 'get-url', 'origin']);
    const m = url.match(/github\.com[:/](.+?)(?:\.git)?\/?$/);
    if (m) return m[1];
  } catch (_) { /* fallback */ }
  return 'iamsamyiok/local-knowledge-graph';
}

// 最新 Release 信息（尽力而为，失败不影响检查结果）
async function fetchLatestRelease() {
  try {
    const res = await fetch(`https://api.github.com/repos/${repoSlug()}/releases/latest`, {
      headers: { 'User-Agent': 'local-knowledge-graph-updater', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return { tag: j.tag_name, name: j.name, url: j.html_url, published_at: j.published_at };
  } catch (_) { return null; }
}

// ---------- npm 模式 ----------
function checkSyncNpm() {
  let registryVersion;
  try { registryVersion = npm(['view', PKG_NAME, 'version'], 30000); }
  catch (e) { return { ok: false, error: '无法连接 npm 注册表：' + shortErr(e) }; }
  const cur = currentVersion();
  const cmp = compareVersions(cur, registryVersion);
  return {
    ok: true,
    mode: 'npm',
    current_version: cur,
    registry_version: registryVersion,
    behind: cmp < 0 ? 1 : 0,
    ahead: cmp > 0 ? 1 : 0,
    up_to_date: cmp >= 0,
  };
}

function applyUpdateNpm() {
  const c = checkSyncNpm();
  if (!c.ok) return c;
  if (c.up_to_date) return { ok: true, up_to_date: true, version: currentVersion() };
  try { npm(['install', '-g', `${PKG_NAME}@${c.registry_version}`], 300000); }
  catch (e) { return { ok: false, error: 'npm 全局更新失败：' + shortErr(e) }; }
  return { ok: true, up_to_date: false, version: c.registry_version, from_version: c.current_version };
}

// ---------- 开发模式（git） ----------
function checkSyncGit() {
  const info = { ok: true, mode: 'git', current_version: currentVersion(), up_to_date: true, behind: 0, ahead: 0 };
  let localSha;
  try { localSha = git(['rev-parse', 'HEAD']); }
  catch (e) { return { ok: false, error: '当前目录不是Git仓库，无法检查更新：' + shortErr(e) }; }
  try { git(['fetch', 'origin', 'master'], 30000); }
  catch (e) { return { ok: false, error: '无法连接 GitHub：' + shortErr(e) }; }
  let remoteSha;
  try { remoteSha = git(['rev-parse', 'FETCH_HEAD']); }
  catch (e) { return { ok: false, error: '读取远端版本失败：' + shortErr(e) }; }
  info.local_sha = localSha.slice(0, 7);
  info.remote_sha = remoteSha.slice(0, 7);
  if (remoteSha !== localSha) {
    try { info.behind = Number(git(['rev-list', '--count', `HEAD..${remoteSha}`])) || 0; } catch (_) { info.behind = 0; }
    try { info.ahead = Number(git(['rev-list', '--count', `${remoteSha}..HEAD`])) || 0; } catch (_) { info.ahead = 0; }
    info.up_to_date = info.behind === 0 && info.ahead === 0;
    if (info.behind === 0 && info.ahead > 0) info.note = `本地领先远端 ${info.ahead} 个提交`;
  }
  return info;
}

function applyUpdateGit() {
  const c = checkSyncGit();
  if (!c.ok) return c;
  if (c.up_to_date) return { ok: true, up_to_date: true, version: currentVersion() };
  if (c.ahead > 0) return { ok: false, error: `本地存在 ${c.ahead} 个未发布提交，无法快进更新；请在项目目录手动处理（git stash 或推送后重试）` };
  try { git(['pull', '--ff-only', 'origin', 'master'], 120000); }
  catch (e) { return { ok: false, error: '更新失败：' + shortErr(e) }; }
  return { ok: true, up_to_date: false, version: currentVersion(), from_sha: c.local_sha, to_sha: c.remote_sha };
}

// ---------- 对外接口 ----------
function updateMode() {
  return isDevRepo() ? 'git' : 'npm';
}

function checkSync() {
  return updateMode() === 'git' ? checkSyncGit() : checkSyncNpm();
}

async function checkUpdate() {
  const info = checkSync();
  if (info.ok) info.latest_release = await fetchLatestRelease();
  return info;
}

function applyUpdate() {
  return updateMode() === 'git' ? applyUpdateGit() : applyUpdateNpm();
}

module.exports = { currentVersion, compareVersions, checkUpdate, applyUpdate, checkSync, updateMode, repoSlug };
