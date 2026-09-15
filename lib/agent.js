'use strict';

// OpenCode进程管理：后端默认拉起OpenCode进程，前端自然语言指令直接传递执行。
// OpenCode仅负责理解指令与联网补全，所有写库动作必须经本进程RDF校验后落库，禁止直连数据库。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SESSION_FILE = path.join(DATA_DIR, '.agent_session');
const TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 300000);

function readSession() {
  try { return fs.readFileSync(SESSION_FILE, 'utf8').trim() || null; } catch (_) { return null; }
}

function writeSession(id) {
  if (id) fs.writeFileSync(SESSION_FILE, id);
}

// 构建Agent提示词：注入图谱摘要、RDF规范、输出协议
function buildPrompt(instruction) {
  const database = require('./db');
  const graph = database.getGraph();
  const entLines = graph.entities.map((e) => {
    let attrs = {};
    try { attrs = JSON.parse(e.attributes || '{}'); } catch (_) {}
    const a = Object.keys(attrs).length ? ` 属性:${JSON.stringify(attrs)}` : '';
    return `- id=${e.id} "${e.name}" [${e.category}]${a}`;
  }).join('\n');
  const relLines = graph.relations.map((r) => `- id=${r.id} e${r.source_id} --(${r.category}/${r.name})--> e${r.target_id}`).join('\n');

  return `你是本地知识图谱的管理助手，通过OpenCode进程运行。你可以使用联网搜索补全公开信息，但必须遵守：

【铁律】
1. 本地图谱数据只增不删（除非用户明确要求删除/修改）。
2. 联网补全的信息必须经过你核对（交叉验证可信来源）后才允许写入；无法核实的不要写入，并在说明中告知用户原因。
3. 禁止向任何外部服务上传或泄露本地图谱的私有数据；联网时只查询公开信息。

【当前图谱】
实体 ${graph.entities.length} 个：
${entLines || '（空）'}
关系 ${graph.relations.length} 条：
${relLines || '（空）'}

【RDF规范（必须严格遵守）】
- 实体大类只能是: 物理实体 / 抽象实体 / 数值实体 / 时间实体
- 关系大类只能是: 空间 / 互动 / 归属 / 时间 / 属性
- 实体属性(attributes)必须是扁平JSON对象，值为字符串/数值/布尔，禁止嵌套对象或数组
- 关系的 source/target 只能引用已存在实体id，或用ref占位符引用本次新增的实体
- 建模准则：数值实体/时间实体仅在"数值或时间作为某条关系的端点"时才创建（如"事件—发生于→744年"）；仅作描述说明的年份、日期、数量（如成立年份、测量年份、海拔、人口）一律写入所属实体的attributes，禁止为它们单独建节点

【本地查询工具】
- 需要聚焦某个实体的关联范围（直接或间接关系）时，运行只读命令：node tools/ego.js "<实体名或id>" [层数]
  输出该中心 N 层内的实体（按层级分组）与关系；层数省略表示全部层级。该命令仅本地读库，无需联网。

【输出协议】
第一步：用简洁中文说明你的分析与结论（若涉及联网信息，注明来源可信度）。
第二步：如需修改图谱，输出一个 \`\`\`kg-ops 代码块，内容为JSON数组（仅这一种操作格式），元素形如：
  {"op":"add_entity","ref":"A","name":"实体名","category":"物理实体","attributes":{"键":"值"}}
  {"op":"add_relation","source_ref":"A","target_id":3,"name":"关系名","category":"归属"}
  {"op":"update_entity","id":5,"attributes":{"键":"新值"}}
  {"op":"delete_entity","id":7}
  {"op":"update_relation","id":2,"name":"新名"}
  {"op":"delete_relation","id":4}
  （source_id/target_id用数字id引用已有实体；本次新增的实体用ref占位符，如"ref":"A"供后续关系引用）
第三步：若无任何图谱修改，省略代码块。

【用户指令】
${instruction}`;
}

// 从输出中提取全部 kg-ops 代码块（文档分块抽取时一次回复可含多个块）
function parseOps(output) {
  const re = /```kg-ops\s*([\s\S]*?)```/g;
  const ops = [];
  let parse_error = null;
  let m;
  while ((m = re.exec(output))) {
    try {
      const arr = JSON.parse(m[1].trim());
      if (Array.isArray(arr)) ops.push(...arr);
      else parse_error = 'kg-ops块必须是JSON数组';
    } catch (e) {
      parse_error = `kg-ops块JSON解析失败: ${e.message}`;
    }
  }
  const reply = output.replace(/```kg-ops\s*[\s\S]*?```/g, '').trim();
  return { ops, reply, parse_error };
}

// 解析OpenCode JSON事件流：提取文本回复、错误事件与会话id
function parseEventStream(stdout) {
  const texts = [];
  const errors = [];
  let sessionIdFound = null;
  for (const line of String(stdout).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t);
      if (j.sessionID && !sessionIdFound) sessionIdFound = j.sessionID;
      if (j.type === 'text' && j.part && j.part.text) texts.push(j.part.text);
      const parts = j.parts || (j.message && j.message.parts) || [];
      for (const p of parts) if (p.type === 'text' && p.text) texts.push(p.text);
      if (j.type === 'error') {
        const msg = (j.error && ((j.error.data && j.error.data.message) || j.error.message)) || '未知错误';
        errors.push(`${msg}${j.error && j.error.data && j.error.data.ref ? `（ref:${j.error.data.ref}）` : ''}`);
      }
    } catch (_) { /* 非JSON行，忽略 */ }
  }
  return { texts: texts.join('\n'), errors, sessionId: sessionIdFound };
}

// 拉起OpenCode进程执行指令；服务端错误时自动清除会话并用全新会话重试一次
// files: 附件路径数组（经 opencode run -f 挂载）
async function runAgent(instruction, files = []) {
  if (!instruction || !String(instruction).trim()) {
    return { ok: false, error: '指令不能为空' };
  }
  let result = await attempt(readSession(), String(instruction), files);
  if (!result.ok && result.retriable && readSession()) {
    // 会话可能已失效或服务端状态异常，清除后用全新会话重试
    clearSession();
    const retry = await attempt(null, String(instruction), files);
    if (retry.ok) return { ...retry, retried: true };
    return { ...retry, retried: true, error: `重试仍失败: ${retry.error}` };
  }
  return result;
}

function attempt(sessionId, instruction, files) {
  return new Promise((resolve) => {
    const prompt = buildPrompt(instruction);
    const args = ['run', '--format', 'json', '--auto'];
    if (sessionId) args.push('--session', sessionId);
    // prompt必须位于-f之前：-f是数组选项，会贪婪吞并其后的位置参数
    args.push(prompt);
    for (const f of files || []) {
      if (f && fs.existsSync(f)) args.push('-f', f);
    }

    let stdout = '', stderr = '', done = false;
    let child;
    try {
      child = spawn('opencode', args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, error: '无法启动OpenCode进程: ' + e.message });
    }

    const timer = setTimeout(() => {
      if (!done) { done = true; try { child.kill('SIGKILL'); } catch (_) {} resolve({ ok: false, error: `OpenCode执行超时(${TIMEOUT_MS / 1000}s)，已终止` }); }
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: false, error: `OpenCode进程启动失败: ${e.message}（请确认 opencode CLI 已安装）` });
    });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);

      if (code !== 0 && !stdout.trim()) {
        return resolve({ ok: false, error: `OpenCode进程退出码${code}: ${(stderr || '无输出').slice(0, 500)}` });
      }
      const ev = parseEventStream(stdout);
      // 出现error事件：服务端执行失败；保留已产生的部分回复供参考
      if (ev.errors.length) {
        return resolve({
          ok: false,
          retriable: true,
          error: `OpenCode执行出错: ${ev.errors[0]}`,
          partial_reply: ev.texts || null,
        });
      }
      if (ev.sessionId) writeSession(ev.sessionId);
      const replyText = ev.texts || stdout.trim();
      const parsed = parseOps(replyText);
      resolve({ ok: true, reply: parsed.reply || replyText, ops: parsed.ops, parse_error: parsed.parse_error || null, session: readSession() });
    });
  });
}

function clearSession() {
  try { fs.unlinkSync(SESSION_FILE); } catch (_) { /* 文件不存在则忽略 */ }
}

module.exports = { buildPrompt, runAgent, parseOps, parseEventStream };
