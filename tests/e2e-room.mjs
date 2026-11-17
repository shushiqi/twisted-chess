// 房间管理 E2E：观战加入、观战位设置、玩家↔观战切换、房主确认重开
// 用法：node tests/e2e-room.mjs
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.ROOM_PORT || 3161);
const BASE = `http://127.0.0.1:${PORT}`;
const DBG = 9471;
const OUT = path.join(ROOT, 'tests', 'artifacts');
mkdirSync(OUT, { recursive: true });
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(200); }
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG}`, '--disable-gpu', '--no-first-run',
  '--hide-scrollbars', '--window-size=1280,900', `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'jieqi-room-profile')}`, 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${DBG}/json/version`)).ok) break; } catch {} await sleep(200); }

class Page {
  constructor(n) { this.name = n; this.id = 0; this.pending = new Map(); this.errors = []; }
  async open(url) {
    const t = await (await fetch(`http://127.0.0.1:${DBG}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
    this.targetId = t.id;
    this.ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise(r => this.ws.addEventListener('open', r, { once: true }));
    this.ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.text);
    });
    await this.send('Runtime.enable'); await this.send('Page.enable');
    await sleep(800); return this;
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(this.name + ' CDP 超时:' + method)); }, 8000);
      this.pending.set(id, m => { clearTimeout(timer); res(m); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(x) {
    const r = await this.send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.result?.exceptionDetails) throw new Error(this.name + ': ' + r.result.exceptionDetails.text);
    return r.result?.result?.value;
  }
  async shot(n) { try { const r = await this.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(OUT, n + '.png'), Buffer.from(r.result.data, 'base64')); } catch {} }
}

const infoText = `document.getElementById('onlineInfo').textContent.trim()`;
const statusText = `document.getElementById('status').textContent.trim()`;
const rosterText = `document.getElementById('roomRoster').textContent.replace(/\\s+/g,' ').trim()`;
const visible = id => `(() => { const el=document.getElementById('${id}'); return !!el && getComputedStyle(el).display!=='none'; })()`;
const pieceCount = `document.querySelectorAll('#board .piece').length`;
const logCount = `document.getElementById('logBox').children.length`;
const clickMove = `(async () => {
  const board=document.getElementById('board');
  const fire=(x,y)=>{ for(const t of ['pointerdown','mousedown','pointerup','mouseup','click'])
    board.dispatchEvent(new MouseEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,view:window})); };
  const center=el=>{const r=el.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];};
  for(const p of [...document.querySelectorAll('#board .piece.selectable')]){
    const [x,y]=center(p); fire(x,y); await new Promise(r=>setTimeout(r,70));
    const d=document.querySelector('.dot,.capture-dot');
    if(d){ const [dx,dy]=center(d); fire(dx,dy); await new Promise(r=>setTimeout(r,650)); return true; }
    fire(x,y);
  }
  return false;
})()`;

try {
  const a = await new Page('A').open(BASE + '/');
  await a.eval(`(()=>{const s=document.getElementById('modeSel');s.value='online';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await a.eval(`document.getElementById('createRoomBtn').click()`);
  await sleep(1100);
  const room = await a.eval(`document.getElementById('roomInput').value`);
  check('房主创建房间并显示名册', /玩家位.*红：你.*黑：空位/.test(await a.eval(rosterText)), await a.eval(rosterText));
  check('默认观战容量 3', /观战位\s*0 \/ 3/.test(await a.eval(rosterText)), await a.eval(rosterText));

  const b = await new Page('B').open(BASE + '/?room=' + room);
  await b.eval(`document.getElementById('joinRoomBtn').click()`);
  await sleep(900);
  check('第二名玩家入座黑方', (await b.eval(infoText)).includes('你执黑'), await b.eval(infoText));
  check('房主名册显示对手', /黑：对手/.test(await a.eval(rosterText)), await a.eval(rosterText));

  const c = await new Page('C').open(BASE + '/?room=' + room);
  await c.eval(`document.getElementById('joinRoomBtn').click()`);
  await sleep(900);
  check('第三人以观战身份加入', (await c.eval(infoText)).includes('观战中'), await c.eval(infoText));
  check('观战人数 1/3 且三端一致',
    /观战位\s*1 \/ 3/.test(await a.eval(rosterText)) &&
    /观战位\s*1 \/ 3/.test(await b.eval(rosterText)) &&
    /观战位\s*1 \/ 3/.test(await c.eval(rosterText)),
    await a.eval(rosterText));
  check('满位时观战者看不到「入座」按钮', (await c.eval(visible('sitBtn'))) === false);
  check('观战者的「新对局」按钮被禁用（房主/玩家可用）',
    (await c.eval(`document.getElementById('newBtn').disabled`)) === true &&
    (await a.eval(`document.getElementById('newBtn').disabled`)) === false &&
    (await b.eval(`document.getElementById('newBtn').disabled`)) === false);
  check('玩家可见「转为观战」按钮', (await b.eval(visible('specBtn'))) === true);

  // 房主修改观战位上限 → 三端同步
  await a.eval(`(() => { const s=document.getElementById('specCapSel'); s.value='4'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await sleep(500);
  check('房主把观战位调成 4 后三端同步',
    /观战位\s*1 \/ 4/.test(await a.eval(rosterText)) &&
    /观战位\s*1 \/ 4/.test(await b.eval(rosterText)) &&
    /观战位\s*1 \/ 4/.test(await c.eval(rosterText)),
    await c.eval(rosterText));

  // 走一步，让对局"进行中"
  const moved = await a.eval(clickMove);
  check('红方走一步', moved === true && (await a.eval(logCount)) === 1);

  // 黑方转观战 → 房主收到询问
  await b.eval(`document.getElementById('specBtn').click()`);
  await sleep(700);
  check('转观战后房主看到重开询问', (await a.eval(visible('restartAsk'))) === true);
  check('房主询问文本明确指出场景', (await a.eval(`document.getElementById('restartAskText').textContent`)).includes('退出对局'));
  check('其他玩家看到「等待房主决定」', (await c.eval(statusText)).includes('等待') || (await c.eval(infoText)).includes('等待'),
    await c.eval(statusText) + ' / ' + await c.eval(infoText));
  check('黑方已成观战者（2/4）', /观战位\s*2 \/ 4/.test(await a.eval(rosterText)), await a.eval(rosterText));
  await a.shot('room-restart-ask');

  // 房主批准 → 新局
  await a.eval(`document.getElementById('restartYes').click()`);
  await sleep(900);
  check('房主批准后新局开始（双方日志清空、32 子）',
    (await a.eval(logCount)) === 0 && (await a.eval(pieceCount)) === 32 &&
    (await c.eval(logCount)) === 0 && (await c.eval(pieceCount)) === 32);
  check('询问框已消失', (await a.eval(visible('restartAsk'))) === false);

  // 观战者 C 补位黑方
  check('空位出现后观战者可见「入座」', (await c.eval(visible('sitBtn'))) === true);
  await c.eval(`document.getElementById('sitBtn').click()`);
  await sleep(700);
  check('观战者补位成功（黑方）', (await c.eval(infoText)).includes('你执黑'), await c.eval(infoText));
  check('补位后观战人数回落 1/4', /观战位\s*1 \/ 4/.test(await a.eval(rosterText)), await a.eval(rosterText));
  check('补位者名册显示为玩家', /黑：你/.test(await c.eval(rosterText)), await c.eval(rosterText));
  check('补位后「新对局」按钮恢复可用', (await c.eval(`document.getElementById('newBtn').disabled`)) === false);

  // 观战者 B 不能操作棋盘
  const bSelectable = await b.eval(`document.querySelectorAll('#board .piece.selectable').length`);
  check('观战者棋盘上没有可选棋子', bSelectable === 0, 'selectable=' + bSelectable);

  await a.shot('room-after-seat-change');
  check('无 JS 异常', [a, b, c].every(p => p.errors.length === 0), [a, b, c].flatMap(p => p.errors).slice(0, 2).join('|'));
} finally {
  console.log(`\n== 房间管理 E2E：${results.filter(r => r.ok).length}/${results.length} 通过 ==`);
  writeFileSync(path.join(OUT, 'room-result.json'), JSON.stringify(results, null, 2));
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(200);
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
