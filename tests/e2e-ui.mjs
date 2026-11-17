// 交互验证：修改顶部设置后「新对局」高亮；按钮常态/禁用态样式正确
// 用法：node tests/e2e-ui.mjs
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.UI_PORT || 3141);
const BASE = `http://127.0.0.1:${PORT}`;
const DBG = 9451;
const OUT = path.join(ROOT, 'tests', 'artifacts');
mkdirSync(OUT, { recursive: true });
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(200); }

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG}`, '--disable-gpu', '--no-first-run',
  '--hide-scrollbars', '--window-size=1280,900', `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'jieqi-ui-profile')}`, 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${DBG}/json/version`)).ok) break; } catch {} await sleep(200); }

const list = await (await fetch(`http://127.0.0.1:${DBG}/json/new?${encodeURIComponent(BASE + '/?e2e=1')}`, { method: 'PUT' })).json();
const ws = new WebSocket(list.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Page.enable');
await sleep(1200);

const state = `(() => {
  const b=document.getElementById('newBtn'), s=getComputedStyle(b);
  return { attention:b.classList.contains('attention'), bg:s.backgroundColor, anim:s.animationName,
           border:s.borderTopColor };
})()`;
const setSel = (id, v) => `(() => { const s=document.getElementById('${id}'); s.value='${v}'; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value; })()`;

try {
  const initialCfg = await ev(`(() => ({
    mode: document.getElementById('modeSel').value,
    level: document.getElementById('levelSel').value,
    side: document.getElementById('sideSel').value,
    status: document.getElementById('status').textContent.trim(),
    pvePanel: document.getElementById('settings').classList.contains('pve')
  }))()`);
  check('初始默认为人机对战', initialCfg.mode === 'pve', JSON.stringify(initialCfg));
  check('初始默认难度为最高（大师）', initialCfg.level === 'master', JSON.stringify(initialCfg));
  check('初始执红且状态按人机模式显示', initialCfg.side === 'red' &&
    /红方（你）走棋/.test(initialCfg.status) && initialCfg.pvePanel === true, JSON.stringify(initialCfg));

  let st = await ev(state);
  check('初始（设置未改动）不显示高亮', st.attention === false, JSON.stringify(st));
  check('「新对局」常态背景（不是禁用样式）', st.bg === 'rgb(253, 250, 244)', st.bg);

  // 从默认人机切换到双人 → 条件变了 → 高亮
  await ev(setSel('modeSel', 'pvp'));
  await sleep(300);                       // 等 background/border 的 .15s 过渡结束
  st = await ev(state);
  check('改为「双人对战」后高亮「新对局」', st.attention === true && st.anim === 'newGamePulse', JSON.stringify(st));
  check('高亮时配色为琥珀色', st.bg === 'rgb(255, 247, 224)', st.bg);

  const hi = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(OUT, 'ui-attention.png'), Buffer.from(hi.result.data, 'base64'));

  // 改回默认人机 → 与当前生效配置一致 → 取消高亮
  await ev(setSel('modeSel', 'pve'));
  await sleep(300);
  st = await ev(state);
  check('改回默认设置后自动取消高亮', st.attention === false, JSON.stringify(st));

  // 人机下改难度 → 高亮；点新对局 → 消失
  await ev(setSel('modeSel', 'pve'));
  await ev(setSel('levelSel', 'hard'));
  await sleep(300);
  st = await ev(state);
  check('改 AI 难度后高亮', st.attention === true);

  await ev(`document.getElementById('newBtn').click()`);
  await sleep(800);
  st = await ev(state);
  check('点「新对局」后高亮消失', st.attention === false, JSON.stringify(st));

  // 禁用态仍应可区分（提示/悔棋依赖）
  const dis = await ev(`(() => {
    const u=document.getElementById('undoBtn');
    return { disabled:u.disabled, bg:getComputedStyle(u).backgroundColor, color:getComputedStyle(u).color };
  })()`);
  check('禁用按钮外观仍为浅灰（未被常态样式覆盖）',
    dis.bg === 'rgb(247, 242, 231)' && dis.color === 'rgb(168, 154, 133)', JSON.stringify(dis));

  // ---- 回归：联机 → 人机/双人 → 新对局（此前 gameMode 仍是 online，点新对局无反应）----
  const pieceCount = `document.querySelectorAll('#board .piece').length`;
  const logCount = `document.getElementById('logBox').children.length`;
  const statusTxt = `document.getElementById('status').textContent.trim()`;
  const onlineDisplay = `getComputedStyle(document.getElementById('onlineCard')).display`;
  const fireMove = `(async () => {
    const board=document.getElementById('board');
    const fire=(x,y)=>{ for(const t of ['pointerdown','mousedown','pointerup','mouseup','click'])
      board.dispatchEvent(new MouseEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,view:window})); };
    const center=el=>{const r=el.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];};
    for(const p of [...document.querySelectorAll('#board .piece.selectable')]){
      const [x,y]=center(p); fire(x,y); await new Promise(r=>setTimeout(r,70));
      const d=document.querySelector('.dot,.capture-dot');
      if(d){ const [dx,dy]=center(d); fire(dx,dy); await new Promise(r=>setTimeout(r,600)); return true; }
      fire(x,y);
    }
    return false;
  })()`;

  await ev(setSel('modeSel', 'online'));
  await sleep(250);
  await ev(setSel('modeSel', 'pve'));
  await sleep(300);
  const att2 = await ev(state);
  check('联机切回人机时「新对局」高亮', att2.attention === true, JSON.stringify(att2));

  await ev(`document.getElementById('newBtn').click()`);
  await sleep(800);
  check('联机→人机：点新对局能开局（32 子）', (await ev(pieceCount)) === 32, await ev(pieceCount));
  check('联机→人机：日志已清空', (await ev(logCount)) === 0);
  check('联机→人机：状态显示人机走棋', /红方（你）走棋/.test(await ev(statusTxt)), await ev(statusTxt));
  check('联机→人机：房间面板已隐藏', (await ev(onlineDisplay)) === 'none');

  const movedPve = await ev(fireMove);
  check('联机→人机：新局可以走子', movedPve === true);
  await sleep(2600);
  check('联机→人机：AI 正常应招', (await ev(logCount)) >= 2, 'log=' + await ev(logCount));

  await ev(setSel('modeSel', 'online'));
  await sleep(200);
  await ev(setSel('modeSel', 'pvp'));
  await sleep(200);
  await ev(`document.getElementById('newBtn').click()`);
  await sleep(700);
  check('联机→双人：点新对局能开局', (await ev(pieceCount)) === 32 && /红方 走棋/.test(await ev(statusTxt)),
    `${await ev(pieceCount)} / ${await ev(statusTxt)}`);
  check('联机→双人：新局可以走子', (await ev(fireMove)) === true);
  const logBefore = await ev(logCount);
  await sleep(1500);
  check('联机→双人：不会自动应招', (await ev(logCount)) === logBefore, 'log=' + await ev(logCount));

  // ---- 房间内切回人机：新对局应离开房间并在本地开局 ----
  await ev(setSel('modeSel', 'online'));
  await sleep(200);
  await ev(`document.getElementById('createRoomBtn').click()`);
  await sleep(1200);
  const roomId = await ev(`document.getElementById('roomInput').value`);
  check('切到联机可创建房间（为下面的离房测试准备）', /^[0-9]{6}$/.test(roomId), roomId);

  await ev(setSel('modeSel', 'pve'));
  await sleep(200);
  await ev(`document.getElementById('newBtn').click()`);
  await sleep(1000);
  check('房间内切人机并新对局：本地正常开局', (await ev(pieceCount)) === 32 && /红方（你）走棋/.test(await ev(statusTxt)),
    `${await ev(pieceCount)} / ${await ev(statusTxt)}`);
  const roomState = await (await fetch(`${BASE}/api/rooms/${roomId}`)).json();
  const roomGone = roomState.ok === false && roomState.error === 'no_room';
  check('房间内切人机并新对局：已离开服务端房间', roomGone || roomState.players === 0, JSON.stringify(roomState));

  // ---- 禁止送将：点"会送将"的落点只弹提示，不落子、保持选中 ----
  await ev(setSel('modeSel', 'pvp'));
  await sleep(200);
  await ev(`document.getElementById('newBtn').click()`);
  await sleep(700);

  const clickCell = (r, c) => ev(`(() => {
    const b=document.getElementById('board');
    const {x,y}=__jieqiE2E.coord(${r},${c});
    const cs=getComputedStyle(b), rect=b.getBoundingClientRect();
    const cx=rect.left+parseFloat(cs.borderLeftWidth)+x, cy=rect.top+parseFloat(cs.borderTopWidth)+y;
    for(const t of ['pointerdown','mousedown','pointerup','mouseup','click'])
      b.dispatchEvent(new MouseEvent(t,{clientX:cx,clientY:cy,bubbles:true,cancelable:true,view:window}));
    return true;
  })()`);

  // 构造：黑车 (5,4) 将红帅 (9,4)；红车 (8,0) 只有垫到 (8,4) 能解将
  await ev(`(() => {
    const s=JSON.parse(__jieqiE2E.snapshot());
    for(let r=0;r<10;r++) for(let c=0;c<9;c++) s.board[r][c]=null;
    s.board[0][4]={color:'black',type:'king',faceUp:true};
    s.board[5][4]={color:'black',type:'rook',faceUp:true};
    s.board[9][4]={color:'red',type:'king',faceUp:true};
    s.board[8][0]={color:'red',type:'rook',faceUp:true};
    s.currentTurn='red'; s.gameOver=false; s.winner=null; s.winReason=null;
    s.capturedRed=[]; s.capturedBlack=[]; s.moveLog=[]; s.handNo=0;
    s.lastMove=null; s.moveTrail=[]; s.historyLength=0;
    __jieqiE2E.restore(JSON.stringify(s));
    return true;
  })()`);
  await sleep(150);

  const toastState = `(() => { const t=document.getElementById('toast'); return { text:t.textContent, show:t.classList.contains('show') }; })()`;
  await clickCell(8, 0);
  await sleep(120);
  check('选中被将军的棋子：只有 1 个合法落点', (await ev(`document.querySelectorAll('#board .dot,#board .capture-dot').length`)) === 1);
  check('会送将的落点显示为「禁止」标记（不是绿点）', (await ev(`document.querySelectorAll('#board .forbid-dot').length`)) >= 10);

  const beforeForbid = await ev(`__jieqiE2E.snapshot()`);
  await clickCell(5, 0);                       // 走到 (5,0) 仍然被将军
  await sleep(150);
  let ts = await ev(toastState);
  check('点"会送将"的落点弹出「禁止送将」', ts.text === '禁止送将' && ts.show === true, JSON.stringify(ts));
  check('该步不执行：棋子仍选中、手数不变', (await ev(`__jieqiE2E.info().handNo`)) === 0 &&
    (await ev(`document.querySelectorAll('#board .piece.selected').length`)) === 1);
  check('该步不执行：棋盘/回合完全不变', (await ev(`__jieqiE2E.snapshot()`)) === beforeForbid);

  await clickCell(8, 8);                       // 再点另一个禁止落点
  await sleep(120);
  ts = await ev(toastState);
  check('可继续点其他落点，提示仍为「禁止送将」且保持选中', ts.text === '禁止送将' &&
    (await ev(`document.querySelectorAll('#board .piece.selected').length`)) === 1);

  await clickCell(8, 4);                       // 合法解将落点
  await sleep(300);
  check('改选合法落点后正常走子', (await ev(`__jieqiE2E.info().handNo`)) === 1 &&
    (await ev(`__jieqiE2E.info().turn`)) === 'black');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(OUT, 'ui-normal.png'), Buffer.from(shot.result.data, 'base64'));
  check('无 JS 异常', errors.length === 0, errors.slice(0, 2).join('|'));
} finally {
  console.log(`\n== UI 交互：${results.filter(r => r.ok).length}/${results.length} 通过 ==`);
  writeFileSync(path.join(OUT, 'ui-result.json'), JSON.stringify(results, null, 2));
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(200);
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
