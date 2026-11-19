'use strict';
/**
 * 揭棋 AI 本地知识库模块。
 *
 * 职责：
 *  - 读取 ai-knowledge/ 下的 Markdown 知识文件与 index.json 索引（启动时缓存，避免每次请求读盘）。
 *  - 根据当前棋局特征（手数、剩余棋子、是否可吃子、是否被将军、是否存在暗子）动态匹配 Skills。
 *  - 读取棋风策略（默认 balanced）。
 *  - 将 Core + Strategy + 命中 Skills 组合成 System Prompt。
 *
 * 约束：
 *  - 知识内容只影响提示词，绝不改变服务端合法走法校验与落子流程。
 *  - 知识内容不得包含暗子真实身份等 AI 不可见信息。
 *  - 无外部依赖，纯本地文件读取。
 */
const fs = require('fs');
const path = require('path');

const KNOWLEDGE_DIR = path.join(__dirname, 'ai-knowledge');
const INDEX_FILE = path.join(KNOWLEDGE_DIR, 'index.json');

const ROWS = 10, COLS = 9;

let cache = null;

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

function loadIndex() {
  const raw = safeRead(INDEX_FILE);
  if (!raw) return { core: [], skills: [], strategies: [], defaultStrategy: 'balanced' };
  try {
    const o = JSON.parse(raw);
    return {
      core: Array.isArray(o.core) ? o.core : [],
      skills: Array.isArray(o.skills) ? o.skills : [],
      strategies: Array.isArray(o.strategies) ? o.strategies : [],
      defaultStrategy: o.defaultStrategy || 'balanced',
    };
  } catch (e) {
    return { core: [], skills: [], strategies: [], defaultStrategy: 'balanced' };
  }
}

// 按 id 建立 { id: 内容 } 映射，文件缺失时内容为 null（降级跳过）
function loadModuleFiles(dir, entries) {
  const out = {};
  for (const e of entries) {
    if (!e || !e.id || !e.file) continue;
    out[e.id] = safeRead(path.join(dir, e.file));
  }
  return out;
}

function loadAll() {
  const index = loadIndex();
  return {
    index,
    core: loadModuleFiles(path.join(KNOWLEDGE_DIR, 'core'), index.core),
    skills: loadModuleFiles(path.join(KNOWLEDGE_DIR, 'skills'), index.skills),
    strategies: loadModuleFiles(path.join(KNOWLEDGE_DIR, 'strategies'), index.strategies),
  };
}

function getKnowledge() {
  if (!cache) cache = loadAll();
  return cache;
}

function reload() {
  cache = loadAll();
  return cache;
}

// ---------- 棋局特征 ----------

// 依据引擎当前局面与客户端上报视图，计算可可靠判断的特征。
// engine 需已 loadState 为当前脱敏局面（与 aiMoveFromView 中的 engineAI 一致）。
function computeState(engine, input) {
  const o = input || {};
  const turn = engine.turn;
  const handNo = Number(o.handNo) || 0;
  const board = engine.board;
  let remainingPieces = 0, hiddenCount = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const p = board[r] && board[r][c];
    if (p) {
      remainingPieces++;
      if (!p.faceUp) hiddenCount++;
    }
  }
  const legal = engine.collectMoves(turn);
  const hasCapture = legal.some(m => board[m.tr] && board[m.tr][m.tc]);
  const inCheck = !!engine.isKingAttacked(turn);
  return {
    turn,
    handNo,
    remainingPieces,
    hiddenCount,
    hasHiddenPieces: hiddenCount > 0,
    hasCapture,
    inCheck,
  };
}

// ---------- 触发条件匹配 ----------

function matchTrigger(trigger, state) {
  if (!trigger) return true;
  if (trigger.always) return true;
  if (trigger.handNoLte != null && !(state.handNo <= trigger.handNoLte)) return false;
  if (trigger.handNoGte != null && !(state.handNo >= trigger.handNoGte)) return false;
  if (trigger.remainingPiecesLte != null && !(state.remainingPieces <= trigger.remainingPiecesLte)) return false;
  if (trigger.hasCapture != null && state.hasCapture !== !!trigger.hasCapture) return false;
  if (trigger.inCheck != null && state.inCheck !== !!trigger.inCheck) return false;
  if (trigger.hasHiddenPieces != null && state.hasHiddenPieces !== !!trigger.hasHiddenPieces) return false;
  return true;
}

function selectSkills(state) {
  const k = getKnowledge();
  const out = [];
  for (const s of k.index.skills) {
    if (matchTrigger(s.trigger, state)) {
      const content = k.skills[s.id];
      if (content) out.push({ id: s.id, name: s.name, description: s.description, content });
    }
  }
  return out;
}

// ---------- 棋风 ----------

function resolveStrategyName(input) {
  const k = getKnowledge();
  const fromInput = input && input.strategy;
  const fromEnv = process.env.AI_STRATEGY;
  const name = fromInput || fromEnv || k.index.defaultStrategy || 'balanced';
  return (k.strategies[name] != null) ? name : (k.index.defaultStrategy || 'balanced');
}

function getStrategy(name) {
  const k = getKnowledge();
  const useName = (name && k.strategies[name] != null) ? name : (k.index.defaultStrategy || 'balanced');
  const entry = k.index.strategies.find(s => s.id === useName);
  return { id: useName, name: entry ? entry.name : useName, content: k.strategies[useName] || '' };
}

// ---------- System Prompt 组合 ----------

function buildSystemPrompt(strategyName) {
  const k = getKnowledge();
  const parts = [];
  for (const c of k.index.core) {
    const content = k.core[c.id];
    if (content) parts.push('## ' + c.name + '\n' + content.trim());
  }
  const strat = getStrategy(strategyName);
  if (strat.content) parts.push('## 棋风策略：' + strat.name + '\n' + strat.content.trim());
  return parts.join('\n\n');
}

// 根据棋局状态组合完整 System Prompt，并返回命中信息（便于测试与诊断）
function buildSystemPromptForState(engine, input, strategyName) {
  const state = computeState(engine, input);
  const skills = selectSkills(state);
  const prompt = buildSystemPrompt(strategyName);
  const skillText = skills.map(s => '## ' + s.name + '\n' + s.content.trim()).join('\n\n');
  const full = skillText ? (prompt + '\n\n' + skillText) : prompt;
  return { prompt: full, state, skills, strategy: getStrategy(strategyName) };
}

module.exports = {
  KNOWLEDGE_DIR,
  INDEX_FILE,
  loadAll,
  getKnowledge,
  reload,
  computeState,
  matchTrigger,
  selectSkills,
  resolveStrategyName,
  getStrategy,
  buildSystemPrompt,
  buildSystemPromptForState,
};
