'use strict';
// 大模型 AI 完整对弈冒烟测试
// 用本地 OpenAI 兼容 mock 模型替代真实 API；mock 内部用本地引擎选一步，
// 从而验证「玩家走棋 → 服务端生成合法走法 → 模型选步 → 校验 → AI 落子」完整闭环，
// 并确认玩家与 AI 可以轮流走棋、直至终局。
const http = require('http');
const srv = require('../server.js');

const HUMAN = 'red';
const AI = 'black';

// 与冒烟脚本共享的当前局面（mock 据此选步）
let mockGame = null;

function startMock() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const G = mockGame;
      const mv = G.chooseAIMove(G.turn, 'normal');
      const content = mv
        ? JSON.stringify({ from: { r: mv.fr, c: mv.fc }, to: { r: mv.tr, c: mv.tc }, reason: '冒烟' })
        : JSON.stringify({ from: { r: 0, c: 0 }, to: { r: 0, c: 0 }, reason: '无' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

// 与前端 buildAIView 同口径的脱敏视图
function viewFromEngine(G) {
  const s = JSON.parse(G.saveState());
  const board = s.board.map(row => row.map(p => {
    if (!p) return null;
    if (p.faceUp) return { faceUp: true, color: p.color, type: p.type, darkOwner: p.darkOwner || p.color };
    return { faceUp: false, darkOwner: p.darkOwner, startType: p.startType, startForward: p.startForward };
  }));
  return {
    board, currentTurn: s.currentTurn, gameOver: s.gameOver, winner: s.winner, winReason: s.winReason,
    capturedRed: s.capturedRed, capturedBlack: s.capturedBlack, moveLog: s.moveLog, handNo: s.handNo,
    lastMove: s.lastMove, moveTrail: s.moveTrail,
  };
}

(async () => {
  const mock = await startMock();
  process.env.AI_API_BASE = 'http://127.0.0.1:' + mock.port;
  process.env.AI_API_TOKEN = 'smoke-token';
  process.env.AI_MODEL = 'smoke-model';
  process.env.AI_MAX_ATTEMPTS = '3';

  const addr = await srv.start(0, '127.0.0.1');
  const port = addr.port;
  const G = srv.loadEngine();
  G.setup();
  mockGame = G;

  let plies = 0;
  const MAX = 300;
  try {
    while (!G.gameOver && plies < MAX) {
      const turn = G.turn;
      let mv;
      if (turn === AI) {
        // 走真实服务端接口
        const r = await fetch(`http://127.0.0.1:${port}/api/ai/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(viewFromEngine(G)),
        });
        const j = await r.json();
        if (!j.ok) throw new Error('AI 接口失败：' + JSON.stringify(j));
        mv = { fr: j.from.r, fc: j.from.c, tr: j.to.r, tc: j.to.c };
        // 独立复核服务端返回的走法确实合法
        const legal = G.getLegalMoves(mv.fr, mv.fc);
        if (!legal.some(x => x.r === mv.tr && x.c === mv.tc))
          throw new Error('服务端返回了非法走法：' + JSON.stringify(mv));
      } else {
        // 模拟玩家走一步合法着法
        mv = G.chooseAIMove(turn, 'normal');
        if (!mv) throw new Error('玩家无合法走法但未判负');
      }
      G.makeMove(mv.fr, mv.fc, mv.tr, mv.tc);
      plies++;
    }

    console.log('冒烟结果：plies=' + plies + ' gameOver=' + G.gameOver +
      (G.gameOver ? (' winner=' + G.winner + ' reason=' + G.winReason) : '（达到步数上限）'));
    if (plies < 5) throw new Error('对弈未有效推进');
    if (G.gameOver) {
      console.log('冒烟测试通过：玩家与 AI 轮流走棋，完整对局正常结束。');
    } else {
      console.log('冒烟测试通过：玩家与 AI 轮流走棋闭环正常（步数达上限，未自然终局）。');
    }
  } finally {
    await srv.stop();
    mock.server.close();
    process.exit(0);
  }
})().catch(e => { console.error('冒烟测试失败：', e); process.exit(1); });
