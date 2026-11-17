// 部署适配冒烟测试：/healthz、页面可达、建房对弈、服务重启后房间丢失提示
// 用法：node tests/e2e-deploy.mjs
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.DEPLOY_PORT || 3131);
const BASE = `http://127.0.0.1:${PORT}`;
const DBG = 9441;
const OUT = path.join(ROOT, 'tests', 'artifacts');
mkdirSync(OUT, { recursive: true });
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

let server = null;
function startServer() {
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  return server;
}
async function waitHealth(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.ok) return await r.json(); } catch {}
    await sleep(200);
  }
  throw new Error('服务未就绪');
}
async function stopServer() {
  if (!server) return;
  const p = server; server = null;
  p.kill();
  await new Promise(r => { p.once('exit', r); setTimeout(r, 3000); });
}

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG}`, '--disable-gpu', '--no-first-run',
  '--hide-scrollbars', '--window-size=1280,900', `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'jieqi-deploy-profile')}`, 'about:blank'], { stdio: 'ignore' });
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
async function waitFor(page, expr, pred, ms = 15000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await page.eval(expr);
    if (pred(last)) return last;
    await sleep(300);
  }
  return last;
}

try {
  startServer();
  const health = await waitHealth();
  check('/healthz 返回 200 且含 ok', health.ok === true, JSON.stringify(health));

  const a = await new Page('A').open(BASE + '/');
  check('页面包含"房间与棋局只保存在服务器内存"提示',
    (await a.eval(`document.body.textContent.includes('只保存在服务器内存')`)) === true);
  await a.eval(`(()=>{const s=document.getElementById('modeSel');s.value='online';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await a.eval(`document.getElementById('createRoomBtn').click()`);
  await sleep(1000);
  const room = await a.eval(`document.getElementById('roomInput').value`);
  check('创建房间成功', /^[0-9]{6}$/.test(room), room);

  const b = await new Page('B').open(BASE + '/?room=' + room);
  await b.eval(`document.getElementById('joinRoomBtn').click()`);
  await sleep(900);
  check('第二人加入成功', (await b.eval(infoText)).includes('你执黑'), await b.eval(infoText));

  // 走一步，确认联机仍正常
  const moved = await a.eval(`(async () => {
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
  })()`);
  check('联机走子正常', moved === true);

  // 模拟免费实例休眠/重启：杀掉服务
  await stopServer();
  const afterKill = await waitFor(a, statusText, t => t.includes('重连') || t.includes('断开'), 12000);
  check('服务停止后前端给出连接中断提示', /重连|断开/.test(afterKill), afterKill);
  await a.shot('deploy-server-down');

  // 同端口重启：内存房间已丢失
  startServer();
  await waitHealth();
  await a.eval(`document.getElementById('joinRoomBtn').click()`);
  const afterRestart = await waitFor(a, infoText, t => t.includes('失效') || t.includes('不存在'), 12000);
  check('服务重启后加入旧房间给出"房间不存在或已失效"', /失效|不存在/.test(afterRestart), afterRestart);

  // 重新建房应可用
  await a.eval(`document.getElementById('createRoomBtn').click()`);
  await sleep(1200);
  const newRoom = await a.eval(`document.getElementById('roomInput').value`);
  check('重启后可以重新创建房间', /^[0-9]{6}$/.test(newRoom) && newRoom !== room, `${room} → ${newRoom}`);
  await a.shot('deploy-after-restart');

  check('无 JS 异常', a.errors.length === 0 && b.errors.length === 0, a.errors.concat(b.errors).slice(0, 2).join('|'));
} finally {
  console.log(`\n== 部署冒烟：${results.filter(r => r.ok).length}/${results.length} 通过 ==`);
  writeFileSync(path.join(OUT, 'deploy-result.json'), JSON.stringify(results, null, 2));
  try { chrome.kill(); } catch {}
  await stopServer();
  await sleep(200);
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
