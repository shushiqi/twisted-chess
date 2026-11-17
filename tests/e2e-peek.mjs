// 房主透视 E2E：按钮仅房主可见、只在联机生效、只改本人棋盘、对手零变化
// 用法：node tests/e2e-peek.mjs
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PEEK_PORT || 3151);
const BASE = `http://127.0.0.1:${PORT}`;
const DBG = 9461;
const OUT = path.join(ROOT, 'tests', 'artifacts');
mkdirSync(OUT, { recursive: true });
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(200); }
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG}`, '--disable-gpu', '--no-first-run',
  '--hide-scrollbars', '--window-size=1280,900', `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'jieqi-peek-profile')}`, 'about:blank'], { stdio: 'ignore' });
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

const boardInfo = `(() => {
  const pieces=[...document.querySelectorAll('#board .piece')].filter(e=>!e.classList.contains('ghost'));
  return {
    total: pieces.length,
    peek: pieces.filter(e=>e.classList.contains('peek')).length,
    dark: pieces.filter(e=>e.classList.contains('dark')).length,
    darkWithText: pieces.filter(e=>e.classList.contains('dark') && e.textContent.trim()!=='').length,
    withText: pieces.filter(e=>e.textContent.trim()!=='').length,
    peekBtn: (() => { const r=document.getElementById('peekRow'); return r ? getComputedStyle(r).display : 'missing'; })(),
    peekLabel: (document.getElementById('peekBtn')||{}).textContent || ''
  };
})()`;
const engineSig = flip => `(() => {
  const els=[...document.querySelectorAll('#board .piece')].filter(e=>!e.classList.contains('ghost'));
  return els.map(e=>{
    let r=Math.round((parseFloat(e.style.top)-62)/62), c=Math.round((parseFloat(e.style.left)-62)/62);
    ${flip ? 'r=9-r; c=8-c;' : ''}
    const cls=e.className.split(/\\s+/).filter(x=>!['selectable','selected','lastmove','flying','revealed','peek'].includes(x) && !x.startsWith('peek-')).join(' ');
    return r+','+c+':'+cls;
  }).sort().join('|');
})()`;

try {
  const a = await new Page('owner').open(BASE + '/');
  await a.eval(`(()=>{const s=document.getElementById('modeSel');s.value='online';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await a.eval(`document.getElementById('createRoomBtn').click()`);
  await sleep(1100);
  const room = await a.eval(`document.getElementById('roomInput').value`);

  const b = await new Page('guest').open(BASE + '/?room=' + room);
  await b.eval(`document.getElementById('joinRoomBtn').click()`);
  await sleep(900);
  check('两人已就座', (await a.eval(`document.getElementById('onlineInfo').textContent`)).includes('轮到红方'));

  const infoA0 = await a.eval(boardInfo), infoB0 = await b.eval(boardInfo);
  check('房主可见「透视」按钮', infoA0.peekBtn === 'flex', 'display=' + infoA0.peekBtn);
  check('非房主看不到「透视」按钮', infoB0.peekBtn === 'none', 'display=' + infoB0.peekBtn);
  check('开启前双方都看不到暗子文字', infoA0.darkWithText === 0 && infoB0.darkWithText === 0,
    `A=${infoA0.darkWithText} B=${infoB0.darkWithText}`);

  await a.eval(`document.getElementById('peekBtn').click()`);
  await sleep(500);
  const infoA1 = await a.eval(boardInfo), infoB1 = await b.eval(boardInfo);
  check('房主开启透視：30 枚暗子全部揭示', infoA1.peek === 30 && infoA1.darkWithText === 30,
    `peek=${infoA1.peek} 有字=${infoA1.darkWithText}`);
  check('透视按钮切换为「关闭透视」', infoA1.peekLabel.includes('关闭'), infoA1.peekLabel);
  check('对手视图完全不变（无 peek 类、暗子无字）',
    infoB1.peek === 0 && infoB1.darkWithText === 0 && infoB1.withText === 2,
    `peek=${infoB1.peek} 暗子有字=${infoB1.darkWithText} 总字数=${infoB1.withText}`);
  await a.shot('peek-owner-on');
  await b.shot('peek-guest-view');

  // 走一步：验证游戏流程不受影响、双方仍同步
  const moved = await a.eval(`(async () => {
    const board=document.getElementById('board');
    const fire=(x,y)=>{ for(const t of ['pointerdown','mousedown','pointerup','mouseup','click'])
      board.dispatchEvent(new MouseEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,view:window})); };
    const center=el=>{const r=el.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];};
    for(const p of [...document.querySelectorAll('#board .piece.selectable')]){
      const [x,y]=center(p); fire(x,y); await new Promise(r=>setTimeout(r,80));
      const d=document.querySelector('.dot,.capture-dot');
      if(d){ const [dx,dy]=center(d); fire(dx,dy); await new Promise(r=>setTimeout(r,700)); return true; }
      fire(x,y);
    }
    return false;
  })()`);
  await sleep(500);
  check('开启透视后房主仍可正常走子', moved === true);
  check('双方棋盘仍一致（引擎坐标，翻转侧已还原）',
    (await a.eval(engineSig(false))) === (await b.eval(engineSig(true))));
  const infoA2 = await a.eval(boardInfo), infoB2 = await b.eval(boardInfo);
  check('走子后透视数据同步更新（剩 29 枚暗子）', infoA2.peek === 29 && infoA2.darkWithText === 29,
    `peek=${infoA2.peek}`);
  check('对手仍未获得任何透视信息', infoB2.peek === 0 && infoB2.darkWithText === 0,
    `peek=${infoB2.peek} 暗子有字=${infoB2.darkWithText}`);

  await a.eval(`document.getElementById('peekBtn').click()`);
  await sleep(500);
  const infoA3 = await a.eval(boardInfo);
  check('关闭透视后暗子恢复无字', infoA3.peek === 0 && infoA3.darkWithText === 0, `peek=${infoA3.peek}`);
  check('关闭后按钮文案复原', infoA3.peekLabel.includes('房主透视'), infoA3.peekLabel);

  await a.shot('peek-owner-off');

  // 退出房间后按钮隐藏、数据清空
  await a.eval(`document.getElementById('leaveRoomBtn').click()`);
  await sleep(500);
  const infoA4 = await a.eval(boardInfo);
  check('离开房间后透视按钮隐藏', infoA4.peekBtn === 'none', 'display=' + infoA4.peekBtn);

  check('无 JS 异常', a.errors.length === 0 && b.errors.length === 0, a.errors.concat(b.errors).slice(0, 2).join('|'));
} finally {
  console.log(`\n== 房主透视：${results.filter(r => r.ok).length}/${results.length} 通过 ==`);
  writeFileSync(path.join(OUT, 'peek-result.json'), JSON.stringify(results, null, 2));
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(200);
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
