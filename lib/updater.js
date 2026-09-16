'use strict';

// 版本与更新：读取本地版本 / 联网检查远端 / git 快进更新（数据目录为独立嵌套仓库，不受影响）

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPO_FALLBACK = 'iamsamyiok/local-knowledge-graph';
const GIT_TIMEOUT = 20000;

function git(args, timeout = GIT_TIMEOUT) {
  return execFileSync('git', args, { cwd: ROOT, timeout, encoding: 'utf8' }).trim();
}

function shortErr(e) {
  return String(e.message || e).split('\n')[0].slice(0, 180);
}

function currentVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }
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
  return REPO_FALLBACK;
}

// 同步核心检查（fetch + 提交差数），供 applyUpdate 复用
function checkSync() {
  const info = { ok: true, current_version: currentVersion(), up_to_date: true, behind: 0, ahead: 0 };
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

async function checkUpdate() {
  const info = checkSync();
  if (info.ok) info.latest_release = await fetchLatestRelease();
  return info;
}

// 应用更新：git pull --ff-only。成功后由调用方负责重启服务进程。
function applyUpdate() {
  const c = checkSync();
  if (!c.ok) return c;
  if (c.up_to_date) return { ok: true, up_to_date: true, version: currentVersion() };
  if (c.ahead > 0) return { ok: false, error: `本地存在 ${c.ahead} 个未发布提交，无法快进更新；请在项目目录手动处理（git stash 或推送后重试）` };
  try { git(['pull', '--ff-only', 'origin', 'master'], 120000); }
  catch (e) { return { ok: false, error: '更新失败：' + shortErr(e) }; }
  return { ok: true, up_to_date: false, version: currentVersion(), from_sha: c.local_sha, to_sha: c.remote_sha };
}

module.exports = { currentVersion, compareVersions, checkUpdate, applyUpdate, repoSlug, checkSync };
