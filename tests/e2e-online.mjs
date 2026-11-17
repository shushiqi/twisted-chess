// 端到端联机验证（真实浏览器 + 本地服务）
// 用法：node tests/e2e-online.mjs
// 覆盖：创建/加入房间、满房拒绝、双方同步、非回合锁、AI 不误触发、服务端重开、断线提示、单机回归
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = Number(process.env.E2E_PORT || 3111);
const BASE = `http://127.0.0.1:${PORT}`;
const DBG = 9412;
const OUT = path.join(ROOT, 'tests', 'artifacts');
mkdirSync(OUT, { recursive: true });

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const CHROME = CHROME_CANDIDATES.find(p => { try { return require('node:fs').existsSync(p); } catch { return false; } })
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------- 1. 启动服务 ----------
const watchdog = setTimeout(() => {
  console.log('\n!! 测试超时（120s），已执行结果：');
  results.forEach(r => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`));
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  process.exit(1);
}, 120000);
watchdog.unref?.();

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch {}
    await sleep(200);
  }
  throw new Error('服务未启动：' + serverLog);
}
await waitServer();

// ---------- 2. 启动浏览器 ----------
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DBG}`, '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--hide-scrollbars', '--window-size=1280,900',
  `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'jieqi-e2e-profile')}`, 'about:blank',
], { stdio: 'ignore' });

async function waitDebugger() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${DBG}/json/version`); if (r.ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('浏览器调试端口未就绪');
}
await waitDebugger();

class Page {
  constructor(name) { this.name = name; this.id = 0; this.pending = new Map(); this.errors = []; }
  async open(url) {
    const t = await (await fetch(`http://127.0.0.1:${DBG}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
    this.targetId = t.id;
    this.ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.addEventListener('open', res, { once: true }); this.ws.addEventListener('error', rej, { once: true }); });
    this.ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
      }
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await sleep(900);
    return this;
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(this.name + ' CDP 超时: ' + method)); }, 8000);
      this.pending.set(id, m => { clearTimeout(timer); res(m); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.result?.exceptionDetails) throw new Error(this.name + ' eval: ' + JSON.stringify(r.result.exceptionDetails.text));
    return r.result?.result?.value;
  }
  async shot(name) {
    try {
      const r = await this.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
    } catch (e) { console.log('（截图跳过：' + name + ' — ' + e.message + '）'); }
  }
  async close() {
    try { await fetch(`http://127.0.0.1:${DBG}/json/close/${this.targetId}`); } catch {}
    try { this.ws.close(); } catch {}
  }
  /** 模拟"玩家直接关掉页面"：关掉标签页（页面卸载，WS 随之断开） */
  async quit() { await this.close(); }
}

const setMode = id => `(() => { const s=document.getElementById('modeSel'); s.value='${id}'; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value; })()`;
// 引擎坐标签名：执黑的一方棋盘是翻转显示的，比较前先换算回引擎坐标
const boardSig = flip => `(() => {
  const els=[...document.querySelectorAll('#board .piece')].filter(e=>!e.classList.contains('ghost'));
  const parts=els.map(e=>{
    let r=Math.round((parseFloat(e.style.top)-62)/62), c=Math.round((parseFloat(e.style.left)-62)/62);
    ${flip ? 'r=9-r; c=8-c;' : ''}
    const cls=e.className.split(/\\s+/).filter(x=>!['selectable','selected','lastmove','flying','revealed'].includes(x)).join(' ');
    return r+','+c+':'+cls+':'+e.textContent;
  }).sort();
  return parts.join('|');
})()`;
const statusText = `document.getElementById('status').textContent.trim()`;
const infoText = `document.getElementById('onlineInfo').textContent.trim()`;

// 用点击完成一步：找当前回合可点的棋子 → 点它 → 点第一个落点
const clickMove = `(async () => {
  const board=document.getElementById('board');
  const fire=(x,y)=>{ for(const t of ['pointerdown','mousedown','pointerup','mouseup','click'])
    board.dispatchEvent(new MouseEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,view:window})); };
  const center=el=>{const r=el.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];};
  const pieces=[...document.querySelectorAll('#board .piece.selectable')];
  for(const p of pieces){
    const [x,y]=center(p); fire(x,y); await new Promise(r=>setTimeout(r,80));
    const dot=document.querySelector('.dot') || document.querySelector('.capture-dot');
    if(dot){ const [dx,dy]=center(dot); fire(dx,dy); await new Promise(r=>setTimeout(r,600)); return true; }
    fire(x,y); await new Promise(r=>setTimeout(r,40));   // 取消选中
  }
  return false;
})()`;

try {
  // ---------- 3. 创建房间 ----------
  const a = await new Page('A').open(BASE + '/');
  await a.eval(setMode('online'));
  const onlinePanelVisible = await a.eval(`getComputedStyle(document.getElementById('onlineCard')).display`);
  check('联机模式显示房间面板', onlinePanelVisible === 'flex', 'display=' + onlinePanelVisible);

  await a.eval(`document.getElementById('createRoomBtn').click()`);
  await sleep(1200);
  const roomId = await a.eval(`document.getElementById('roomInput').value`);
  check('创建房间并拿到房间号', /^[A-Za-z0-9]{1,10}$/.test(roomId), 'room=' + roomId);
  check('创建者执红', (await a.eval(infoText)).includes('你执红'), await a.eval(infoText));
  check('未对手时状态为等待', (await a.eval(statusText)).includes('等待'), await a.eval(statusText));

  // ---------- 4. 第二人加入 ----------
  const b = await new Page('B').open(BASE + '/?room=' + roomId);
  check('分享链接自动切到联机模式', (await b.eval(`document.getElementById('modeSel').value`)) === 'online');
  check('分享链接自动填入房间号', (await b.eval(`document.getElementById('roomInput').value`)) === roomId);
  await b.eval(`document.getElementById('joinRoomBtn').click()`);
  await sleep(1000);
  check('第二人执黑', (await b.eval(infoText)).includes('你执黑'), await b.eval(infoText));
  check('A 侧显示两人已就绪', (await a.eval(infoText)).includes('轮到红方'), await a.eval(infoText));

  const sigA0 = await a.eval(boardSig(false)), sigB0 = await b.eval(boardSig(true));
  check('开局双方棋盘一致', sigA0 === sigB0 && sigA0.length > 100, `len=${sigA0.length}`);

  // ---------- 5. 红方走一步，双方同步 ----------
  const moved = await a.eval(clickMove);
  await sleep(500);
  check('红方可以落子', moved === true);
  const s1a = await a.eval(boardSig(false)), s1b = await b.eval(boardSig(true));
  check('走子后双方棋盘一致', s1a === s1b, `A==B:${s1a === s1b}`);
  const logA = await a.eval(`document.getElementById('logBox').children.length`);
  const logB = await b.eval(`document.getElementById('logBox').children.length`);
  check('双方日志同步（1 手）', logA === 1 && logB === 1, `A=${logA} B=${logB}`);
  check('轮到黑方', (await a.eval(statusText)).includes('黑方'), await a.eval(statusText));

  // ---------- 6. 非当前回合不能走棋 ----------
  const sigBefore = await a.eval(boardSig(false));
  const redTried = await a.eval(`(() => {
    const board=document.getElementById('board');
    const fire=(x,y)=>{ for(const t of ['pointerdown','mousedown','pointerup','mouseup','click'])
      board.dispatchEvent(new MouseEvent(t,{clientX:x,clientY:y,bubbles:true,cancelable:true,view:window})); };
    const ps=[...document.querySelectorAll('#board .piece')];
    // 点一枚红方明子（帅），理应无法选中/不能移动
    const king=[...document.querySelectorAll('#board .piece.bright.red')][0];
    if(!king) return {selected:false};
    const r=king.getBoundingClientRect();
    fire(r.x+r.width/2, r.y+r.height/2);
    return {selected: !!document.querySelector('.piece.selected'), dots: document.querySelectorAll('.dot,.capture-dot').length};
  })()`);
  await sleep(400);
  check('非当前回合玩家无法选中/走子', redTried.selected === false && redTried.dots === 0, JSON.stringify(redTried));
  check('非回合操作未改变棋盘', (await a.eval(boardSig(false))) === sigBefore);

  // ---------- 7. 联机不触发 AI ----------
  await sleep(1600);
  check('联机模式不自动应招（1.6s 内无新走子）',
    (await a.eval(`document.getElementById('logBox').children.length`)) === 1 &&
    (await b.eval(`document.getElementById('logBox').children.length`)) === 1);
  check('联机模式不显示 AI 搜索信息', (await a.eval(`document.getElementById('aiInfo').textContent`)).trim() === '');

  // ---------- 8. 第三人满房 ----------
  const c = await new Page('C').open(BASE + '/?room=' + roomId);
  await c.eval(`document.getElementById('joinRoomBtn').click()`);
  await sleep(900);
  const cInfo = await c.eval(infoText);
  const cRoster = await c.eval(`document.getElementById('roomRoster').textContent`);
  check('第三人以观战者身份加入（玩家位已满）', cInfo.includes('观战中'), cInfo);
  check('第三人看到观战人数 1/3', /观战位\s*1 \/ 3/.test(cRoster), cRoster);

  // ---------- 9. 黑方走一步 → 同步 ----------
  const bMoved = await b.eval(clickMove);
  await sleep(500);
  check('黑方可以落子', bMoved === true);
  check('两步后双方棋盘仍一致', (await a.eval(boardSig(false))) === (await b.eval(boardSig(true))));
  check('两步后轮到红方', (await b.eval(statusText)).includes('红方'), await b.eval(statusText));

  // ---------- 10. 服务端统一重开 ----------
  await b.eval(`document.getElementById('newBtn').click()`);
  await sleep(900);
  const resetA = await a.eval(boardSig(false)), resetB = await b.eval(boardSig(true));
  check('重开后双方棋盘一致', resetA === resetB);
  check('重开后回到红方先行', (await a.eval(statusText)).includes('红方'), await a.eval(statusText));
  check('重开后日志清空', (await a.eval(`document.getElementById('logBox').children.length`)) === 0);
  check('重开后 32 枚棋子', (await a.eval(`document.querySelectorAll('#board .piece').length`)) === 32);
  check('重开后 30 枚仍为暗子', (await a.eval(`document.querySelectorAll('#board .piece.dark').length`)) === 30);

  // ---------- 11. 断线提示 ----------
  console.log('… 关闭黑方页面');
  await b.quit();                    // 关掉黑方页面（WS 随之断开）
  await c.close();
  await sleep(1200);
  const afterLeave = await a.eval(statusText);
  const afterLeaveInfo = await a.eval(infoText);
  check('对手关闭后红方收到提示', afterLeave.includes('暂停') || afterLeaveInfo.includes('离开'),
    `status=${afterLeave} info=${afterLeaveInfo}`);
  const stillMoved = await a.eval(clickMove);
  await sleep(400);
  check('对手离开后无法继续提交走子', stillMoved === false, 'clickMove=' + stillMoved);

  await a.shot('A-opponent-left');

  // ---------- 12. 单机回归 ----------
  const p = await new Page('P').open(BASE + '/');
  const initial = await p.eval(`(() => ({ mode: document.getElementById('modeSel').value,
    level: document.getElementById('levelSel').value }))()`);
  check('新页面默认人机 + 大师', initial.mode === 'pve' && initial.level === 'master', JSON.stringify(initial));
  // 行为级验证：默认配置真的可用 —— 玩家先手走子后，大师档 AI 接管并完成应招
  check('默认人机：玩家可先手走子', (await p.eval(clickMove)) === true);
  await sleep(150);
  check('默认人机：走子后轮到 AI', /（AI）思考中/.test(await p.eval(statusText)), await p.eval(statusText));
  let defaultAiReplied = false;
  for (let i = 0; i < 30 && !defaultAiReplied; i++) {
    await sleep(300);
    defaultAiReplied = Number(await p.eval(`document.getElementById('logBox').children.length`)) >= 2;
  }
  check('默认大师档：AI 完成应招（日志 ≥2）', defaultAiReplied === true);
  // 双人回归必须显式生效：默认已是人机，否则「无 AI 应招」会变成假通过
  await p.eval(setMode('pvp'));
  await p.eval(`document.getElementById('newBtn').click()`);
  await sleep(300);
  const pvpMove = await p.eval(clickMove);
  check('单机双人模式仍可走子', pvpMove === true);
  check('单机双人无 AI 自动应招',
    (await p.eval(`document.getElementById('logBox').children.length`)) === 1);
  await p.eval(setMode('pve'));
  // 大师档 2800ms 会拖慢回归；此处只验证「AI 会自动应招」，固定用普通档（600ms）
  await p.eval(`(()=>{const s=document.getElementById('levelSel');s.value='normal';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await p.eval(`document.getElementById('newBtn').click()`);
  await sleep(300);
  await p.eval(clickMove);
  await sleep(2500);
  const pveLog = await p.eval(`document.getElementById('logBox').children.length`);
  check('人机模式 AI 仍会自动应招', pveLog >= 2, 'log=' + pveLog);

  await a.shot('A-final');
  await p.shot('P-pve');

  const errs = [...a.errors, ...p.errors];
  check('页面无 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));
} finally {
  const okCount = results.filter(r => r.ok).length;
  console.log(`\n== E2E 结果：${okCount}/${results.length} 通过 ==`);
  writeFileSync(path.join(OUT, 'e2e-result.json'), JSON.stringify(results, null, 2));
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(300);
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
