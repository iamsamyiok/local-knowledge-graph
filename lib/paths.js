'use strict';

// 数据目录统一解析：环境变量 > 开发仓库(./data) > npm安装(~/.local-knowledge-graph)
// 全部数据（kg.db/vectors.db/settings.json/uploads/backups/保存点git仓库）都收敛在数据目录内，
// npm 升级只替换程序文件，数据天然不受影响。

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const PKG_NAME = 'local-knowledge-graph';

function isDevRepo(root = APP_ROOT) {
  return fs.existsSync(path.join(root, '.git'));
}

function resolveDataDir(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const root = opts.root || APP_ROOT;
  if (env.KG_DATA_DIR) return env.KG_DATA_DIR;
  if (isDevRepo(root)) return path.join(root, 'data');
  return path.join(home, '.local-knowledge-graph');
}

const DATA_DIR = resolveDataDir();
const DB_PATH = process.env.KG_DB_PATH || path.join(DATA_DIR, 'kg.db');

// npm 安装模式下，若包目录残留旧版数据（1.4.x 及之前存放在程序目录 data/），自动迁移到数据目录
function ensureLegacyMigration(log = console.log) {
  if (process.env.KG_DATA_DIR || process.env.KG_DB_PATH) return;
  if (isDevRepo()) return;
  const legacy = path.join(APP_ROOT, 'data');
  if (!fs.existsSync(path.join(legacy, 'kg.db'))) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const files = ['kg.db', 'vectors.db', 'settings.json', '.kg_meta.json', '.agent_session'];
  for (const f of files) {
    const src = path.join(legacy, f);
    const dst = path.join(DATA_DIR, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
  }
  for (const dir of ['uploads', 'backups']) {
    const src = path.join(legacy, dir);
    const dst = path.join(DATA_DIR, dir);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.cpSync(src, dst, { recursive: true });
    }
  }
  log(`[迁移] 检测到程序目录内的旧数据，已复制到 ${DATA_DIR}（原 data/ 目录保留未动）`);
}

module.exports = { APP_ROOT, DATA_DIR, DB_PATH, PKG_NAME, isDevRepo, resolveDataDir, ensureLegacyMigration };
