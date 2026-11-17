// 视角翻转验证：执黑时棋盘上下调换，点击命中仍然正确（不改任何规则）
// 用法：node tests/e2e-flip.mjs
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.FLIP_PORT || 3121);
const BASE = `http://127.0.0.1:${PORT}`;
const DBG = 9431;
const OUT = path.join(ROOT, 'tests', 'artifacts');
mkdirSync(OUT, { recursive: true });
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let slog = ''; server.stdout.on('data', d => slog += d); server.stderr.on('data', d => slog += d);
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(200); }

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG}`, '--disable-gpu', '--no-first-run',
  '--hide-scrollbars', '--window-size=1280,900', `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'jieqi-flip-profile')}`, 'about:blank'], { stdio: 'ignore' });
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
    await sleep(900); return this;
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

// 引擎坐标签名：按页面是否翻转把屏幕位置换算回引擎坐标
const engineSig = flip => `(() => {
  const els=[...document.querySelectorAll('#board .piece')].filter(e=>!e.classList.contains('ghost'));
  return els.map(e=>{
    let r=Math.round((parseFloat(e.style.top)-62)/62), c=Math.round((parseFloat(e.style.left)-62)/62);
    ${flip ? 'r=9-r; c=8-c;' : ''}
    const cls=e.className.split(/\\s+/).filter(x=>!['selectable','selected','lastmove','flying','revealed'].includes(x)).join(' ');
    return r+','+c+':'+cls+':'+e.textContent;
  }).sort().join('|');
})()`;

const clickMove = `(async () => {
  const board=document.getElementById('board');
  const fire=(x,y)=>{ for(const t of ['pointerdown','mousedown','pointerup','mouseup','click'])
    board.dispatchEvent(new MouseEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,view:window})); };
  const center=el=>{const r=el.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];};
  for(const p of [...document.querySelectorAll('#board .piece.selectable')]){
    const [x,y]=center(p); fire(x,y); await new Promise(r=>setTimeout(r,80));
    const dot=document.querySelector('.dot')||document.querySelector('.capture-dot');
    if(dot){ const [dx,dy]=center(dot); fire(dx,dy); await new Promise(r=>setTimeout(r,600)); return true; }
    fire(x,y); await new Promise(r=>setTimeout(r,40));
  }
  return false;
})()`;

try {
  const a = await new Page('A').open(BASE + '/');
  await a.eval(`(()=>{const s=document.getElementById('modeSel');s.value='online';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await a.eval(`document.getElementById('createRoomBtn').click()`);
  await sleep(1000);
  const room = await a.eval(`document.getElementById('roomInput').value`);
  const b = await new Page('B').open(BASE + '/?room=' + room);
  await b.eval(`document.getElementById('joinRoomBtn').click()`);
  await sleep(900);

  // 按棋子文字取帅/将：翻开后棋盘上会出现其它明子，不能只按颜色类名找
  const kingTop = (color, ch) => `(() => {
    const el=[...document.querySelectorAll('.piece.bright.${color}')].find(e=>e.textContent==='${ch}');
    return el ? Math.round(parseFloat(el.style.top)) : null;
  })()`;
  // 引擎坐标 (0,4)=黑将、(9,4)=红帅
  const aBlackKing = await a.eval(kingTop('black','将'));
  const aRedKing = await a.eval(kingTop('red','帅'));
  const bBlackKing = await b.eval(kingTop('black','将'));
  const bRedKing = await b.eval(kingTop('red','帅'));

  check('红方视角：黑将在上、红帅在下', aBlackKing === 62 && aRedKing === 620, `黑将 y=${aBlackKing} 红帅 y=${aRedKing}`);
  check('黑方视角：棋盘翻转，黑将在下、红帅在上', bBlackKing === 620 && bRedKing === 62, `黑将 y=${bBlackKing} 红帅 y=${bRedKing}`);

  const sigA = await a.eval(engineSig(false));
  const sigB = await b.eval(engineSig(true));
  check('翻转后双方引擎坐标视图一致', sigA === sigB, `len=${sigA.length} equal=${sigA === sigB}`);

  // 红方走一步
  const redMoved = await a.eval(clickMove);
  check('红方在正常视角下可落子', redMoved === true);
  check('红方走子后双方（翻转视角）仍一致',
    (await a.eval(engineSig(false))) === (await b.eval(engineSig(true))));
  check('黑方状态显示轮到黑方', (await b.eval(`document.getElementById('status').textContent`)).includes('黑方'));

  // 黑方在翻转视角下点自己的棋子（屏幕上半部分是红方，下半部分才是自己）
  const blackMove = await b.eval(clickMove);
  await sleep(400);
  check('黑方在翻转视角下可以落子（点击命中正确）', blackMove === true);
  const afterA = await a.eval(engineSig(false));
  const afterB = await b.eval(engineSig(true));
  check('黑方走子后双方引擎坐标一致', afterA === afterB);
  check('黑方走子后轮到红方', (await a.eval(`document.getElementById('status').textContent`)).includes('红方'));

  // 再点屏幕上方（对方区域）不应选中
  const wrongSide = await b.eval(`(() => {
    const board=document.getElementById('board');
    const fire=(x,y)=>{ for(const t of ['pointerdown','mousedown','pointerup','mouseup','click'])
      board.dispatchEvent(new MouseEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,view:window})); };
    const el=[...document.querySelectorAll('#board .piece')].filter(e=>!e.classList.contains('ghost'))
      .sort((p,q)=>parseFloat(p.style.top)-parseFloat(q.style.top))[0];   // 最上方（红方区域）
    const r=el.getBoundingClientRect(); fire(r.x+r.width/2, r.y+r.height/2);
    return {sel:!!document.querySelector('.piece.selected'), dots:document.querySelectorAll('.dot,.capture-dot').length};
  })()`);
  check('黑方点击上方（对方区域）不会误选', wrongSide.sel === false && wrongSide.dots === 0, JSON.stringify(wrongSide));

  await b.shot('black-view-online');

  // 人机执黑：同样翻转
  const p = await new Page('P').open(BASE + '/');
  await p.eval(`(()=>{const s=document.getElementById('modeSel');s.value='pve';s.dispatchEvent(new Event('change',{bubbles:true}));
    const side=document.getElementById('sideSel'); side.value='black'; side.dispatchEvent(new Event('change',{bubbles:true}));
    // 默认大师档 2800ms 会超过下面 2.2s 的等待；本用例只验证视角翻转，固定用初级让 AI 立即先手
    const lv=document.getElementById('levelSel'); lv.value='easy'; lv.dispatchEvent(new Event('change',{bubbles:true}));
    document.getElementById('newBtn').click();})()`);
  await sleep(2200);   // 等 AI 先手
  const pBlackKing = await p.eval(kingTop('black','将'));
  const pRedKing = await p.eval(kingTop('red','帅'));
  // AI 执红先手可能把帅在九宫内挪一行；帅始终在九宫 3 行内 → 翻转后屏幕 top ∈ [62,186]
  check('人机执黑：黑将在下、红帅在上（九宫 3 行内）',
    pBlackKing === 620 && pRedKing >= 62 && pRedKing <= 186, `黑将 y=${pBlackKing} 红帅 y=${pRedKing}`);
  const pMoved = await p.eval(clickMove);
  check('人机执黑：翻盘后可正常走子', pMoved === true);

  // 提示环也走 coord()，翻转后应仍落在真实棋位上
  await p.eval(`document.getElementById('hintBtn').click()`);
  await sleep(2600);
  const hintCheck = await p.eval(`(() => {
    const ring=document.querySelector('.hint-ring.hint-from');
    if(!ring) return {ok:false, text:document.getElementById('hintInfo').textContent.slice(0,40)};
    const key=ring.style.left+'|'+ring.style.top;
    const piece=[...document.querySelectorAll('#board .piece')].find(e=>e.style.left+'|'+e.style.top===key);
    return {ok:!!piece, cls:piece?piece.className:null, text:document.getElementById('hintInfo').textContent.slice(0,40)};
  })()`);
  check('人机执黑：提示环落在真实棋位上', hintCheck.ok === true, JSON.stringify(hintCheck));
  await p.shot('black-view-pve');

  // 单机双人：不翻转
  const q = await new Page('Q').open(BASE + '/');
  // 显式切到双人并生效：默认已是人机，否则用例名与被测模式不符
  await q.eval(`(()=>{const s=document.getElementById('modeSel');s.value='pvp';s.dispatchEvent(new Event('change',{bubbles:true}));
    document.getElementById('newBtn').click();})()`);
  await sleep(300);
  const qBlackKing = await q.eval(kingTop('black','将'));
  check('本地双人同屏不翻转（黑将仍在上）', qBlackKing === 62, 'y=' + qBlackKing);

  check('无 JS 异常', [a, b, p, q].every(x => x.errors.length === 0), [a, b, p, q].flatMap(x => x.errors).slice(0, 2).join('|'));
} finally {
  console.log(`\n== 翻转验证：${results.filter(r => r.ok).length}/${results.length} 通过 ==`);
  writeFileSync(path.join(OUT, 'flip-result.json'), JSON.stringify(results, null, 2));
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(300);
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
