'use strict';
// 引擎切片契约测试（node --test）
// 背景：server.js:loadEngine() 用 jieqi.html 里的一对注释标记切出「规则 + 搜索」源码，
//       再 new Function 执行。同一套切片逻辑在 jieqi.html 的 Worker 内联里还有一份实现，
//       此前没有任何测试保护。
// 本文件防的事故：
//   1) 标记被误改 / 误挪 / 删掉一行 → 服务端静默拿到残缺引擎（规则错乱）；
//   2) 两份实现里只改了一部分标记 → 页面能跑、服务端却崩；
//   3) 切片边界写错 → 把标记注释本身、甚至 UI 代码带进 new Function；
//   4) 引擎段悄悄引入浏览器 API（document/window/localStorage/alert）或 require →
//      Node 端 loadEngine 直接抛错，联机整体不可用。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const srv = require('../server.js');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'jieqi.html');
const MARK_START = '/*<<ENGINE_SRC_START>>*/';
const MARK_END = '/*<<ENGINE_SRC_END>>*/';

/** 读取页面全文 */
function readPage() {
  return fs.readFileSync(PAGE, 'utf8');
}

/**
 * 定位「独立成行」的标记。
 * 注意：marker 在 jieqi.html 里各出现 2 次 —— 第 309/2252 行是独立成行的真标记注释，
 * 第 2289/2290 行是 Worker 代码里的字符串常量（内容与标记完全相同，只是多了一层引号）。
 * 当前 loadEngine 用 indexOf 取首个，恰好命中真标记；因此这里也必须只按「独立成行」判定，
 * 不能用裸 indexOf 断言唯一性。
 * @returns {{startIdx: number, endIdx: number, startLines: number[], endLines: number[]}} 行号从 1 开始
 */
function locateMarkers() {
  const lines = readPage().split(/\r?\n/);
  const startLines = [];
  const endLines = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t === MARK_START) startLines.push(i + 1);
    if (t === MARK_END) endLines.push(i + 1);
  });
  return {
    startIdx: startLines.length ? startLines[0] : -1,
    endIdx: endLines.length ? endLines[0] : -1,
    startLines,
    endLines,
  };
}

/** 按 loadEngine 的方式（首个标记出现的下标区间）切出引擎源码 */
function sliceEngineSource(html) {
  const a = html.indexOf(MARK_START);
  const b = html.indexOf(MARK_END);
  assert.ok(a >= 0, 'jieqi.html 中未找到 ' + MARK_START + '（应为独立成行的注释标记）');
  assert.ok(b >= 0, 'jieqi.html 中未找到 ' + MARK_END + '（应为独立成行的注释标记）');
  assert.ok(b > a, 'jieqi.html 中引擎结束标记出现在开始标记之前，切片会为空');
  return { src: html.slice(a, b), a, b };
}

/**
 * 剥掉 JS 注释（行注释 + 块注释），字符串字面量内的 // 与 /* 不会被误当作注释。
 * 逐字符状态机：code / line / block / string('"`)，块注释可跨行。
 * @param {string} text 源码
 * @returns {string} 只剩代码骨架（保留换行，便于定位）
 */
function stripComments(text) {
  let out = '';
  let mode = 'code';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const nx = text[i + 1];
    if (mode === 'code') {
      if (ch === '/' && nx === '/') { mode = 'line'; i += 2; continue; }
      if (ch === '/' && nx === '*') { mode = 'block'; i += 2; continue; }
      if (ch === '\'' || ch === '"' || ch === '`') { mode = ch; out += ch; i += 1; continue; }
      out += ch;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (ch === '\n') { mode = 'code'; out += '\n'; }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (ch === '*' && nx === '/') { mode = 'code'; i += 2; continue; }
      if (ch === '\n') out += '\n';
      i += 1;
      continue;
    }
    // 字符串内部：只认转义与配对引号
    if (ch === '\\') { out += ch + (nx || ''); i += 2; continue; }
    if (ch === mode) { mode = 'code'; out += ch; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

test('引擎标记完整且独立成行（防标记被误改 / 误删 / 误挪）', () => {
  const { startIdx, endIdx, startLines, endLines } = locateMarkers();

  assert.equal(startLines.length, 1,
    'jieqi.html 中应有且仅有 1 行独立成行的 ' + MARK_START + '，当前找到 ' + startLines.length + ' 行' +
    (startLines.length ? '（行号 ' + startLines.join(',') + '）' : '，当前未找到：应为独立成行的 /*<<ENGINE_SRC_START>>*/'));
  assert.equal(endLines.length, 1,
    'jieqi.html 中应有且仅有 1 行独立成行的 ' + MARK_END + '，当前找到 ' + endLines.length + ' 行' +
    (endLines.length ? '（行号 ' + endLines.join(',') + '）' : '，当前未找到：应为独立成行的 /*<<ENGINE_SRC_END>>*/'));

  assert.ok(startIdx < endIdx,
    '开始标记（第 ' + startIdx + ' 行）必须早于结束标记（第 ' + endIdx + ' 行）');

  // 引擎段行数：当前实测 1943 行。区间 [1700,2200] 留足算法演进空间，
  // 同时能拦住「标记被误挪到文件头 / 文件尾」这类灾难性改动。
  const bodyLines = endIdx - startIdx;
  assert.ok(bodyLines >= 1700 && bodyLines <= 2200,
    '引擎段行数 ' + bodyLines + ' 超出 [1700,2200]：标记之间可能夹进了 UI 代码，或被误挪到文件头 / 尾');
});

test('各处切片实现共用同一对标记（防改标记时漏改某一份）', () => {
  // 随仓库发布的实现必须存在；仅在开发环境可用的基准脚本存在时才一并校验。
  const required = ['server.js', 'jieqi.html'];
  const optional = ['tests/ai-arena.mjs', 'tests/ai-sampling.mjs']
    .filter(rel => fs.existsSync(path.join(ROOT, rel)));
  const files = required.concat(optional);
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    assert.ok(fs.existsSync(abs), rel + ' 不存在：切片实现文件被改名 / 移走时必须同步本测试');
    const txt = fs.readFileSync(abs, 'utf8');
    assert.ok(txt.includes(MARK_START),
      rel + ' 中缺少 ' + MARK_START + '（改标记时必须各处同步修改）');
    assert.ok(txt.includes(MARK_END),
      rel + ' 中缺少 ' + MARK_END + '（改标记时必须各处同步修改）');
  }
});

test('切片边界正确：取出的源码不含标记本身（防边界写错把标记带进引擎）', () => {
  const html = readPage();
  const { src } = sliceEngineSource(html);

  assert.ok(src.startsWith(MARK_START),
    '切片应以 ' + MARK_START + ' 开头（loadEngine 用 indexOf 起切，首字符必须是标记）');
  assert.ok(!src.includes(MARK_END),
    '切片不应包含 ' + MARK_END + '：说明结束标记被挪到了开始标记之前，或出现了重复标记');

  // 标记行之间不允许再出现「第二个独立成行的标记」——那会让 indexOf 取到错误的位置。
  // 注意：第 310 行的说明性注释里提到 ENGINE_SRC_END 是合法的（只是文字，不是标记）。
  const body = src.slice(MARK_START.length);
  body.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    assert.ok(t !== MARK_START && t !== MARK_END,
      '引擎段内部出现了第二个独立成行的标记（切片内第 ' + (i + 1) + ' 行）：' + t);
  });

  // 剥掉注释后，代码骨架里不应残留标记文本
  const codeOnly = stripComments(src);
  assert.ok(!codeOnly.includes('ENGINE_SRC_START'),
    '引擎段代码（剥注释后）里残留 ENGINE_SRC_START：标记被写进了可执行代码，new Function 会语法错误');
  assert.ok(!codeOnly.includes('ENGINE_SRC_END'),
    '引擎段代码（剥注释后）里残留 ENGINE_SRC_END：标记被写进了可执行代码，new Function 会语法错误');
});

test('loadEngine 覆盖服务端依赖的 10 个符号，且能在 Node 环境真正跑起来', () => {
  const E = srv.loadEngine();

  // 7 个方法：server.js 的走子校验全部依赖它们
  const fns = ['setup', 'saveState', 'loadState', 'makeMove', 'getLegalMoves', 'canControl', 'isSelfCheckMove'];
  for (const name of fns) {
    assert.equal(typeof E[name], 'function',
      '引擎必须导出方法 ' + name + '()，当前类型为 ' + typeof E[name] + '（server.js 依赖它做走子校验）');
  }

  // 3 个 getter。只断言存在与是访问器，**不断言值**——
  // setup() 之前 board 可能还是空数组，断言值会把测试绑死在初始化顺序上。
  for (const name of ['board', 'turn', 'gameOver']) {
    assert.ok(name in E, '引擎必须导出属性 ' + name + '（server.js 用它判断轮次 / 终局 / 棋盘）');
    const desc = Object.getOwnPropertyDescriptor(E, name);
    if (desc) {
      assert.equal(typeof desc.get, 'function',
        name + ' 应为 getter（引擎内部状态是闭包变量，普通字段会读到过期拷贝）');
    }
  }

  // 真跑一次：确认引擎段在 Node（无 DOM）下能完成初始化并给出 10 行 × 9 列棋盘
  E.setup();
  assert.ok(Array.isArray(E.board), 'setup() 之后 board 应为数组');
  assert.equal(E.board.length, 10, '棋盘应为 10 行，实际 ' + E.board.length);
  assert.equal(E.board[0].length, 9, '棋盘每行应为 9 列，实际 ' + E.board[0].length);
  const snapshot = JSON.parse(E.saveState());
  assert.ok(Array.isArray(snapshot.board) && snapshot.board.length === 10,
    'saveState() 应给出可 JSON 序列化的完整快照（服务端持久化依赖它）');
});

test('引擎段零浏览器 / Node 环境依赖（防混入 document/window/require 让 Node 端崩溃）', () => {
  const html = readPage();
  const { src } = sliceEngineSource(html);
  const codeOnly = stripComments(src);

  // 注释里出现这些词是允许的（说明性文字），所以只检查剥掉注释后的代码骨架。
  // module.exports 是引擎导出给 server.js 的唯一通道，**允许**，不在此列。
  const forbidden = [
    [/\bdocument\s*\./, 'document.'],
    [/\bwindow\s*\./, 'window.'],
    [/\blocalStorage\b/, 'localStorage'],
    [/\balert\s*\(/, 'alert('],
    [/\brequire\s*\(/, 'require('],
  ];
  for (const [re, label] of forbidden) {
    const hit = codeOnly.match(re);
    assert.strictEqual(hit, null,
      '引擎段代码里出现了 ' + label + '：该段会被 new Function 在 Node 里执行，' +
      '浏览器 API / require 会让 loadEngine 抛错，联机整体不可用' +
      (hit ? '（命中位置附近：' + JSON.stringify(codeOnly.substr(Math.max(0, hit.index - 40), 80)) + '）' : ''));
  }
});
