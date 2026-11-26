// 疯狂水世界 · 控制台 后端
// 纯 Node http，无额外依赖（只用到已装的 ws/protobuf/lz4js）
// 启动: node server.js  →  http://127.0.0.1:8791
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { snapshot, runRound } = require('./farm_core');
const { isYieldError } = require('./client');
const radar = require('./radar_core');
const wreck = require('./wreck_core');
const auth = require('./auth');
const guard = require('./guard');
const update = require('./update');

const PORT = Number(process.env.PORT || 8791);
// 本机用 127.0.0.1；挂到云服务器公网时设 HOST=0.0.0.0
const HOST = process.env.HOST || '127.0.0.1';
const PUB = path.join(__dirname, 'web');

// ---------- 日志落盘 ----------
// 内存只留 400 条给前端，同时按天追加写入 logs/server-YYYY-MM-DD.log，
// 这样进程崩溃/被杀以后还能翻日志（原来只在内存里，一死就全没了）。
const LOG_DIR = process.env.FARMBOT_LOG_DIR || path.join(__dirname, 'logs');
const LOG_KEEP_DAYS = Number(process.env.FARMBOT_LOG_KEEP_DAYS || 14);
let logDirReady = false;

function pad2(n) { return String(n).padStart(2, '0'); }
function dayKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function stamp(d) {
  return `${dayKey(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.` +
    String(d.getMilliseconds()).padStart(3, '0');
}
function logFile(d = new Date()) {
  return path.join(LOG_DIR, `server-${dayKey(d)}.log`);
}
function fileLog(level, text, extra) {
  try {
    if (!logDirReady) { fs.mkdirSync(LOG_DIR, { recursive: true }); logDirReady = true; }
    const line = `${stamp(new Date())} [${level}] ${text}` +
      (extra ? ' ' + JSON.stringify(extra) : '') + '\n';
    fs.appendFileSync(logFile(), line, 'utf8');
  } catch (e) {
    // 落盘失败不能让业务挂掉
    console.error('[log-file] 写入失败:', e.message);
  }
}
// 清理过期日志
function pruneLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR).filter((f) => /^server-\d{4}-\d{2}-\d{2}\.log$/.test(f));
    const cutoff = Date.now() - LOG_KEEP_DAYS * 86400 * 1000;
    for (const f of files) {
      const m = f.match(/^server-(\d{4})-(\d{2})-(\d{2})\.log$/);
      const t = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).getTime();
      if (t < cutoff) { try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch (e) {} }
    }
  } catch (e) {}
}


// 登录开关：默认开启。本地调试想跳过就 set FARMBOT_NO_AUTH=1
const AUTH = process.env.FARMBOT_NO_AUTH !== '1';
const COOKIE_SECURE = process.env.FARMBOT_COOKIE_SECURE === '1';
const TRUST_PROXY = process.env.FARMBOT_TRUST_PROXY === '1';

// ---------- 运行状态（内存态，重启即重置） ----------
const state = {
  auto: false,           // 是否开启自动循环
  dry: false,            // 只报告不动手
  crop: '',              // 指定作物，空 = 自动挑
  doHarvest: true,
  doPlant: true,
  avoidWindow: false,    // 检测到游戏窗口就跳过本轮
  minGap: 30,            // 最短间隔秒
  timer: null,
  nextWake: null,        // 下次执行的时间戳（秒）
  running: false,        // 当前是否正在执行一次请求
  last: null,            // 上一轮结果摘要
  stats: { rounds: 0, harvest: 0, plant: 0, errors: 0 },
  log: [],               // 环形日志
  conns: new Set(),      // SSE 连接

  // ---- 联盟情报（世界 → 雷达）----
  // 情报每 8 小时才刷新一批，玩家只在需要时手动点一次，因此这里没有常驻循环。
  radar: {
    dry: false,
    doClaim: true,
    doDispatch: true,
    types: [],           // 只打这些类型，空 = 全部
    fleets: [],          // 每个舰队的策略 [{enabled:true, types:[]}]
    stats: { rounds: 0, claimed: 0, dispatched: 0, errors: 0 },
    last: null,
    snap: null,          // 最近一次快照（给前端展示）
  },

  // ---- 搁浅的货轮（世界宝藏）----
  // 点一次「循环出兵」后由本进程自己循环：修复 → 派出 → 等修复完成 → 再派出，
  // 直到万吨货轮消失或今日奖励次数用完为止。
  wreck: {
    dry: false,
    colors: [5, 4, 3],   // 只打这些品质：5=万吨 4=中型 3=小型
    minDuraRatio: 1,     // 派出的舰队耐久至少要达到最大值的这个比例
    doRepair: true,
    doDispatch: true,
    maxPerWreck: 3,      // 每条货轮最多派几艘自己的船
    auto: false,         // 自动循环开关（用户点「循环出兵」后为 true）
    minGap: 45,          // 两轮之间最短间隔（秒）
    timer: null,
    nextWake: null,
    stopReason: '',      // 循环为什么停的：gone / no-reward / manual
    stats: { rounds: 0, repaired: 0, dispatched: 0, errors: 0 },
    last: null,
    snap: null,
  },
};

// 同一个账号只允许一个 WS 会话，两个循环必须串行
let lockChain = Promise.resolve();
function withLock(fn) {
  const run = lockChain.then(fn, fn);
  lockChain = run.catch(() => {});
  return run;
}

function pushLog(text, level = 'info') {
  const item = { t: Date.now(), text, level };
  state.log.push(item);
  if (state.log.length > 400) state.log.shift();
  fileLog(level, text);
  const payload = `data: ${JSON.stringify(item)}\n\n`;
  for (const res of state.conns) {
    try { res.write(payload); } catch (e) {}
  }
}

function broadcast(evt, data) {
  const payload = `event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of state.conns) {
    try { res.write(payload); } catch (e) {}
  }
}

// 统一的异常处理：被顶下线时记一次退避并给出提示文案
function handleOpError(e, prefix = '') {
  if (isYieldError(e)) {
    const k = guard.noteKick();
    const msg = `${prefix}被顶下线（同账号在别处登录），主动退避 ${guard.fmtLeft(k.backoffMs / 1000)}`;
    pushLog(msg, 'warn');
    broadcast('state', publicState());
    return { yield: true, backoffMs: k.backoffMs, error: msg };
  }
  pushLog(`${prefix}本轮异常: ${e.message}`, 'error');
  return { yield: false, error: e.message };
}

function gameWindowOpen() {
  // gamecheck.py 用的是 Win32 API，非 Windows 平台直接返回 false（只在 Linux 上部署时触发）
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('python', [path.join(__dirname, 'gamecheck.py')], { encoding: 'utf8', timeout: 8000 });
    return out.trim() === '1';
  } catch (e) { return false; }
}

// ---------- 自动循环 ----------
function schedule(seconds) {
  if (state.timer) clearTimeout(state.timer);
  state.nextWake = Math.floor(Date.now() / 1000) + seconds;
  state.timer = setTimeout(loopOnce, seconds * 1000);
  broadcast('state', publicState());
}

async function loopOnce() {
  state.timer = null;
  if (!state.auto) { state.nextWake = null; broadcast('state', publicState()); return; }

  // 运行闸门：全局停止 / 不在时段 / 被顶退避中都直接跳过
  const g = guard.canRun();
  if (!g.ok) {
    if (g.reason === 'stopped') {
      pushLog('全局已停止，自动循环关闭', 'warn');
      state.auto = false;
      state.nextWake = null;
      broadcast('state', publicState());
      return;
    }
    if (g.reason === 'backoff') {
      pushLog(`${g.text}（检测到有人正在玩，主动让位）`, 'warn');
      return schedule(Math.max(60, Math.min(g.left || 300, 900)));
    }
    // outside window
    const left = g.until ? Math.max(30, Math.round((g.until - Date.now()) / 1000)) : 600;
    pushLog(`${g.text}，休眠等待`, 'info');
    return schedule(Math.min(left, 3600));
  }

  if (state.avoidWindow && gameWindowOpen()) {
    pushLog('检测到游戏窗口开着，本轮让路（避免顶号）', 'warn');
    return schedule(600);
  }

  state.running = true;
  broadcast('state', publicState());
  let next = state.minGap;
  guard.noteRun();
  try {
    const r = await withLock(() => runRound({
      forceCrop: state.crop || null,
      dry: state.dry,
      doHarvest: state.doHarvest,
      doPlant: state.doPlant,
    }));
    for (const line of r.lines) pushLog(line, /失败/.test(line) ? 'error' : 'info');
    state.stats.rounds++;
    state.stats.harvest += r.harvested.length;
    state.stats.plant += r.planted.length;
    state.last = { at: Date.now(), ...r };
    guard.noteOk();
    next = Math.max(state.minGap, Math.min(1800, r.nextWake || 300));
  } catch (e) {
    state.stats.errors++;
    if (isYieldError(e)) {
      const k = guard.noteKick();
      pushLog(`被顶下线（同账号在别处登录），主动退避 ${guard.fmtLeft(k.backoffMs / 1000)} 不再打扰`, 'warn');
      next = Math.max(state.minGap, Math.round(k.backoffMs / 1000) + 60);
    } else {
      pushLog(`本轮异常: ${e.message}`, 'error');
      next = state.minGap;
    }
  } finally {
    state.running = false;
  }
  broadcast('state', publicState());
  if (state.auto) schedule(next);
  else { state.nextWake = null; broadcast('state', publicState()); }
}

function startAuto() {
  if (state.auto) return;
  state.auto = true;
  pushLog('自动循环开启', 'ok');
  loopOnce();
}

function stopAuto() {
  state.auto = false;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  state.nextWake = null;
  pushLog('自动循环停止', 'warn');
  broadcast('state', publicState());
}

// ---------- 搁浅的货轮：自动循环（点一次「循环出兵」自己跑到底） ----------
function wreckSchedule(seconds) {
  const W = state.wreck;
  if (W.timer) clearTimeout(W.timer);
  W.nextWake = Math.floor(Date.now() / 1000) + seconds;
  W.timer = setTimeout(wreckLoopOnce, seconds * 1000);
  broadcast('wreck', publicWreck());
}

async function wreckLoopOnce() {
  const W = state.wreck;
  W.timer = null;
  if (!W.auto) { W.nextWake = null; broadcast('wreck', publicWreck()); return; }

  // 和农场共用同一套运行闸门：全局停止 / 不在时段 / 被顶退避都跳过
  const g = guard.canRun();
  if (!g.ok) {
    if (g.reason === 'stopped') {
      pushLog('[货轮] 全局已停止，货轮循环关闭', 'warn');
      stopWreckAuto('全局停止');
      return;
    }
    if (g.reason === 'backoff') {
      pushLog(`[货轮] ${g.text}（主动让位）`, 'warn');
      return wreckSchedule(Math.max(60, Math.min(g.left || 300, 900)));
    }
    const left = g.until ? Math.max(30, Math.round((g.until - Date.now()) / 1000)) : 600;
    return wreckSchedule(Math.min(left, 3600));
  }

  // 农场那一轮占用着会话（同账号只能一个 WS），等它跑完
  if (state.running) return wreckSchedule(5);

  state.running = true;
  W.running = true;
  broadcast('state', publicState());
  broadcast('wreck', publicWreck());
  let next = W.minGap;
  try {
    const r = await withLock(() => wreck.runWreckRound({
      dry: W.dry,
      colors: W.colors,
      minDuraRatio: W.minDuraRatio,
      doRepair: W.doRepair,
      doDispatch: W.doDispatch,
      maxPerWreck: W.maxPerWreck,
    }));
    for (const line of r.lines) pushLog('[货轮] ' + line, /失败/.test(line) ? 'error' : 'info');
    W.stats.rounds++;
    W.stats.repaired += r.repaired.length;
    W.stats.dispatched += r.dispatched.length;
    W.last = { at: Date.now(), repaired: r.repaired, dispatched: r.dispatched, skipped: r.skipped };
    if (r.snap) W.snap = r.snap;

    // 判断是否该收工：目标货轮消失 / 今日次数用完
    if (r.snap) {
      const st = wreck.loopStop(r.snap, { colors: W.colors });
      if (st.stop) {
        pushLog('[货轮] ' + st.text, 'ok');
        W.stopReason = st.reason;
        stopWreckAuto(st.text);
        return;
      }
      next = wreck.planNextWake(r.snap, {
        minGap: W.minGap, maxGap: 300,
        minDuraRatio: W.minDuraRatio, colors: W.colors,
      });
    }
  } catch (e) {
    W.stats.errors++;
    if (isYieldError(e)) {
      const k = guard.noteKick();
      pushLog(`[货轮] 被顶下线，退避 ${guard.fmtLeft(k.backoffMs / 1000)}`, 'warn');
      stopWreckAuto('被顶下线');
      return;
    }
    pushLog(`[货轮] 本轮异常: ${e.message}`, 'error');
    next = Math.max(W.minGap, 30);
  } finally {
    state.running = false;
    W.running = false;
  }
  broadcast('state', publicState());
  broadcast('wreck', publicWreck());
  if (W.auto) wreckSchedule(next);
  else { W.nextWake = null; broadcast('wreck', publicWreck()); }
}

function startWreckAuto() {
  const W = state.wreck;
  if (W.auto) return;
  W.auto = true;
  W.stopReason = '';
  pushLog('[货轮] 循环出兵开启：修复 → 派出 → 等修复 → 再派出，直到万吨货轮消失', 'ok');
  broadcast('wreck', publicWreck());
  wreckLoopOnce();
}

function stopWreckAuto(reason) {
  const W = state.wreck;
  W.auto = false;
  if (W.timer) { clearTimeout(W.timer); W.timer = null; }
  W.nextWake = null;
  if (reason) W.stopReason = W.stopReason || 'manual';
  pushLog('[货轮] 循环出兵已停止' + (reason ? `：${reason}` : ''), 'warn');
  broadcast('wreck', publicWreck());
}

// ---------- 联盟情报（手动触发，无常驻循环） ----------
// 情报每 8 小时刷新一批，只需在需要时点一次，因此不排定时器、不轮询。
function publicRadar() {
  const R = state.radar;
  return {
    dry: R.dry, doClaim: R.doClaim, doDispatch: R.doDispatch,
    types: R.types, fleets: R.fleets,
    running: R.running || false,
    stats: R.stats, last: R.last, snap: R.snap,
    petrolCost: radar.PETROL_COST, eventTypes: radar.EVENT_TYPES,
  };
}

// ---------- 搁浅的货轮（手动一轮 + 自动循环） ----------
function publicWreck() {
  const W = state.wreck;
  return {
    dry: W.dry, colors: W.colors, minDuraRatio: W.minDuraRatio,
    doRepair: W.doRepair, doDispatch: W.doDispatch, maxPerWreck: W.maxPerWreck,
    auto: W.auto, minGap: W.minGap, nextWake: W.nextWake, stopReason: W.stopReason,
    running: W.running || false,
    stats: W.stats, last: W.last, snap: W.snap,
    colorNames: wreck.COLOR_NAME, maxDailyReward: wreck.MAX_DAILY_REWARD,
  };
}

function publicState() {
  return {
    auto: state.auto,
    dry: state.dry,
    crop: state.crop,
    doHarvest: state.doHarvest,
    doPlant: state.doPlant,
    avoidWindow: state.avoidWindow,
    minGap: state.minGap,
    nextWake: state.nextWake,
    running: state.running,
    stats: state.stats,
    last: state.last,
    guard: guard.publicView(),
  };
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
  });
}

// ---------- 登录相关 ----------
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || 'unknown';
}

function sendFile(res, full, code = 200) {
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(code, {
      'content-type': MIME[path.extname(full)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}

function redirect(res, to) {
  res.writeHead(302, { location: to, 'cache-control': 'no-store' });
  res.end();
}

const PUBLIC_PATHS = new Set(['/login.html', '/favicon.ico', '/api/login', '/api/session']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  const ip = clientIp(req);
  const cookies = auth.parseCookies(req.headers.cookie);
  const token = cookies[auth.COOKIE];
  const sess = AUTH ? auth.getSession(token) : { user: 'local' };

  try {
    // ---- 登录 / 会话 API（无需鉴权） ----
    if (p === '/api/login' && req.method === 'POST') {
      const left = auth.isLocked(ip);
      if (left) return json(res, 429, { ok: false, error: `尝试次数过多，请 ${Math.ceil(left / 60)} 分钟后再试` });
      const b = await readBody(req);
      if (!auth.verify(b.user, b.pass)) {
        auth.noteFail(ip);
        pushLog(`登录失败：账号 ${String(b.user || '').slice(0, 24)} 来自 ${ip}`, 'warn');
        return json(res, 401, { ok: false, error: '账号或密码不正确' });
      }
      auth.noteOk(ip);
      const t = auth.createSession(String(b.user));
      const maxAge = b.remember ? 7 * 24 * 3600 : 12 * 3600;
      res.setHeader('set-cookie', auth.cookieHeader(t, maxAge, COOKIE_SECURE));
      pushLog(`登录成功：${b.user} 来自 ${ip}`, 'ok');
      return json(res, 200, { ok: true, user: String(b.user) });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      auth.destroySession(token);
      res.setHeader('set-cookie', auth.cookieHeader('', 0, COOKIE_SECURE));
      return json(res, 200, { ok: true });
    }

    if (p === '/api/session') {
      const acc = auth.readAccount ? auth.readAccount() : null;
      return json(res, 200, {
        loggedIn: !!sess,
        user: sess ? sess.user : null,
        firstRun: !acc,
        authEnabled: AUTH,
      });
    }

    // ---- 鉴权闸门 ----
    if (AUTH && !sess) {
      if (PUBLIC_PATHS.has(p)) {
        // 放行登录页与登录接口
      } else if (p.startsWith('/api/')) {
        return json(res, 401, { ok: false, error: '未登录', needLogin: true });
      } else {
        return redirect(res, '/login.html');
      }
    }

    // 已登录再访问登录页 → 回控制台
    if (AUTH && sess && p === '/login.html') return redirect(res, '/');

    // ---- API ----
    // 未到可运行时机（全局停止 / 不在时段 / 被顶退避中）时，所有需要连游戏服务器的接口一律拒绝，
    // 否则「偷偷读一下状态」同样会把正在玩的真人踢下线。
    {
      const BLOCKED = ['/api/snapshot', '/api/round', '/api/radar', '/api/radar/round',
        '/api/wreck', '/api/wreck/round'];
      const gb = guard.canRun();
      if (!gb.ok && BLOCKED.includes(p)) {
        const msg = gb.reason === 'stopped'
          ? '全局已停止，先切换到「指定时间段」或「立即运行」'
          : `${gb.text}；此时连服务器会把正在玩的账号顶下线，想现在就跑请切到「立即运行」`;
        return json(res, 409, { ok: false, error: msg, guard: guard.publicView() });
      }
    }

    if (p === '/api/status') {
      return json(res, 200, { state: publicState(), log: state.log.slice(-120) });
    }

    // ---- 在线更新（从 GitHub 拉取最新版，只覆盖程序文件）----
    if (p === '/api/version') {
      const v = update.readLocalVersion();
      return json(res, 200, { ok: true, ...v, repo: update.REPO, branch: update.BRANCH, node: process.version, platform: process.platform });
    }

    if (p === '/api/update/check') {
      try {
        const r = await update.checkUpdate();
        return json(res, 200, { ok: true, ...r });
      } catch (e) {
        return json(res, 502, { ok: false, error: '检查更新失败: ' + e.message, repo: update.REPO, branch: update.BRANCH });
      }
    }

    if (p === '/api/update/apply' && req.method === 'POST') {
      if (state.running) return json(res, 429, { ok: false, error: '正在执行操作，请稍后再试' });
      try {
        // 先查一次远端版本，把期望版本传给 applyUpdate 做校验，
        // 防止 codeload 的 CDN 缓存把旧压缩包写回来
        let want = '';
        try {
          const ck = await update.checkUpdate();
          want = ck.latest || '';
          if (!ck.hasUpdate) {
            return json(res, 200, { ok: true, upToDate: true, from: ck.current, to: ck.current, files: [], notes: ck.notes });
          }
          pushLog(`[更新] 开始从 GitHub 拉取 ${ck.latest}（当前 ${ck.current}）`, 'warn');
        } catch (e) {
          pushLog('[更新] 版本检查失败，直接尝试更新: ' + e.message, 'warn');
        }
        const r = await update.applyUpdate((m) => pushLog('[更新] ' + m), want);
        pushLog(`[更新] 完成 ${r.from} → ${r.to}，已写入 ${r.files.length} 个文件，即将重启`, 'ok');
        broadcast('state', publicState());
        json(res, 200, { ok: true, ...r, restarting: true });
        // 先把响应发出去，再退出让 start.sh / systemd 拉起新版本
        update.requestRestart(800);
        return;
      } catch (e) {
        pushLog('[更新] 失败: ' + e.message, 'error');
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // ---- 运行闸门（三个开关：指定时段 / 立即运行 / 全局停止）----
    // ---- 日志查询（云端排查「意外停止」用）----
    if (p === '/api/logs') {
      const want = url.searchParams.get('date') || '';
      const lines = Math.max(1, Math.min(5000, Number(url.searchParams.get('lines') || 500)));
      const listFile = () => {
        try {
          return fs.readdirSync(LOG_DIR)
            .filter((f) => /^server-\d{4}-\d{2}-\d{2}\.log$/.test(f))
            .sort().reverse();
        } catch (e) { return []; }
      };
      const files = listFile();
      if (!want) {
        return json(res, 200, { ok: true, dir: LOG_DIR, files, today: dayKey(new Date()) });
      }
      const name = /^\d{4}-\d{2}-\d{2}$/.test(want) ? `server-${want}.log` : '';
      if (!name || !files.includes(name)) {
        return json(res, 404, { ok: false, error: '没有这一天的日志: ' + want, files });
      }
      let text = '';
      try { text = fs.readFileSync(path.join(LOG_DIR, name), 'utf8'); }
      catch (e) { return json(res, 500, { ok: false, error: e.message }); }
      const all = text.split('\n');
      if (all.length && all[all.length - 1] === '') all.pop();
      const tail = all.slice(-lines);
      const fatal = all.filter((l) => l.includes('[fatal]'));
      return json(res, 200, {
        ok: true, date: want, file: name, total: all.length,
        shown: tail.length, lines: tail,
        fatal: fatal.slice(-30),
      });
    }

    if (p === '/api/guard') {
      return json(res, 200, { ok: true, guard: guard.publicView() });
    }

    if (p === '/api/guard/config' && req.method === 'POST') {
      const b = await readBody(req);
      let g;
      try { g = guard.set(b); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      // 切到「全局停止」时，连同自动循环一起停掉，避免定时器空转
      if (g.mode === 'stopped' && state.auto) {
        stopAuto();
        pushLog('全局停止：自动循环已关闭', 'warn');
      }
      if (g.mode === 'stopped' && state.wreck.auto) {
        stopWreckAuto('全局停止');
      }
      broadcast('state', publicState());
      return json(res, 200, { ok: true, guard: guard.publicView(), state: publicState() });
    }

    if (p === '/api/snapshot') {
      if (state.running) return json(res, 429, { ok: false, error: '正在执行一轮操作，请稍后' });
      state.running = true; broadcast('state', publicState());
      try {
        const s = await withLock(() => snapshot());
        // 前端每 60 秒自动刷新一次，这里不写日志，避免把有用的运行记录冲掉
        if (url.searchParams.get('quiet') !== '1') {
          pushLog(`读取状态：${s.farms.length} 块田，自动种田 ${s.autoFarming ? '开' : '关'}`);
        }
        return json(res, 200, s);
      } finally {
        state.running = false; broadcast('state', publicState());
      }
    }

    if (p === '/api/round' && req.method === 'POST') {
      const body = await readBody(req);
      if (state.running) return json(res, 429, { ok: false, error: 'busy' });
      state.running = true; broadcast('state', publicState());
      try {
        const r = await withLock(() => runRound({
          forceCrop: body.crop || state.crop || null,
          dry: body.dry !== undefined ? !!body.dry : state.dry,
          doHarvest: body.doHarvest !== undefined ? !!body.doHarvest : state.doHarvest,
          doPlant: body.doPlant !== undefined ? !!body.doPlant : state.doPlant,
        }));
        for (const line of r.lines) pushLog(line, /失败/.test(line) ? 'error' : 'info');
        state.stats.rounds++;
        state.stats.harvest += r.harvested.length;
        state.stats.plant += r.planted.length;
        state.last = { at: Date.now(), ...r };
        return json(res, 200, { ok: true, ...r });
      } catch (e) {
        state.stats.errors++;
        const h = handleOpError(e, '');
        return json(res, 500, { ok: false, ...h, guard: guard.publicView() });
      } finally {
        state.running = false; broadcast('state', publicState());
      }
    }

    // ---- 联盟情报 API ----
    if (p === '/api/radar') {
      if (url.searchParams.get('refresh') === '1') {
        if (state.running) return json(res, 429, { ok: false, error: '正在执行一轮操作，请稍后' });
        state.running = true; broadcast('state', publicState());
        try {
          const s = await withLock(() => radar.radarSnapshot());
          state.radar.snap = s;
          if (url.searchParams.get('quiet') !== '1') {
            pushLog(`[情报] 读取状态：${s.events.length} 个事件，空闲舰队 ${s.fleets.filter((f) => f.idle).length}`);
          }
          return json(res, 200, { ok: true, ...s, cfg: publicRadar() });
        } finally {
          state.running = false; broadcast('state', publicState());
          broadcast('radar', publicRadar());
        }
      }
      return json(res, 200, { ok: true, cfg: publicRadar() });
    }

    if (p === '/api/radar/round' && req.method === 'POST') {
      const body = await readBody(req);
      if (state.running) return json(res, 429, { ok: false, error: 'busy' });
      const R = state.radar;
      state.running = true; broadcast('state', publicState());
      try {
        // 点一下做完所有情报：循环 领奖 → 派舰队 → 等结算 → 再派，直到清空
        const r = await withLock(() => radar.runRadarAll({
          dry: body.dry !== undefined ? !!body.dry : R.dry,
          doClaim: body.doClaim !== undefined ? !!body.doClaim : R.doClaim,
          doDispatch: body.doDispatch !== undefined ? !!body.doDispatch : R.doDispatch,
          allowTypes: body.types !== undefined ? body.types : R.types,
          strategies: body.fleets !== undefined ? body.fleets : R.fleets,
          onLine: (line) => pushLog('[情报] ' + line, /失败/.test(line) ? 'error' : 'info'),
        }));
        R.stats.rounds++;
        R.stats.claimed += r.claimed.length;
        R.stats.dispatched += r.dispatched.length;
        R.last = {
          at: Date.now(), claimed: r.claimed, dispatched: r.dispatched,
          petrol: r.petrol, rounds: r.rounds, done: r.done, timedOut: r.timedOut,
        };
        if (r.after) R.snap = r.after;
        return json(res, 200, { ok: true, ...r });
      } catch (e) {
        R.stats.errors++;
        const h = handleOpError(e, '[情报] ');
        return json(res, 500, { ok: false, ...h, guard: guard.publicView() });
      } finally {
        state.running = false; broadcast('state', publicState());
        broadcast('radar', publicRadar());
      }
    }

    if (p === '/api/radar/config' && req.method === 'POST') {
      const b = await readBody(req);
      const R = state.radar;
      if (b.dry !== undefined) R.dry = !!b.dry;
      if (b.doClaim !== undefined) R.doClaim = !!b.doClaim;
      if (b.doDispatch !== undefined) R.doDispatch = !!b.doDispatch;
      if (b.types !== undefined) R.types = Array.isArray(b.types) ? b.types : [];
      if (b.fleets !== undefined) R.fleets = Array.isArray(b.fleets) ? b.fleets : [];
      broadcast('radar', publicRadar());
      return json(res, 200, { ok: true, cfg: publicRadar() });
    }

    // ---- 搁浅的货轮 API ----
    if (p === '/api/wreck') {
      if (url.searchParams.get('refresh') === '1') {
        if (state.running) return json(res, 429, { ok: false, error: '正在执行一轮操作，请稍后' });
        state.running = true; broadcast('state', publicState());
        try {
          const s = await withLock(() => wreck.wreckSnapshot());
          state.wreck.snap = s;
          if (url.searchParams.get('quiet') !== '1') {
            pushLog(`[货轮] 读取状态：${s.wrecks.length} 条货轮，剩余奖励次数 ${s.rewardLeft}`);
          }
          return json(res, 200, { ok: true, ...s, cfg: publicWreck() });
        } finally {
          state.running = false; broadcast('state', publicState());
          broadcast('wreck', publicWreck());
        }
      }
      return json(res, 200, { ok: true, cfg: publicWreck() });
    }

    if (p === '/api/wreck/round' && req.method === 'POST') {
      const body = await readBody(req);
      if (state.running) return json(res, 429, { ok: false, error: 'busy' });
      const W = state.wreck;
      state.running = true; broadcast('state', publicState());
      try {
        const r = await withLock(() => wreck.runWreckRound({
          dry: body.dry !== undefined ? !!body.dry : W.dry,
          colors: body.colors !== undefined ? body.colors : W.colors,
          minDuraRatio: body.minDuraRatio !== undefined ? Number(body.minDuraRatio) : W.minDuraRatio,
          doRepair: body.doRepair !== undefined ? !!body.doRepair : W.doRepair,
          doDispatch: body.doDispatch !== undefined ? !!body.doDispatch : W.doDispatch,
          maxPerWreck: body.maxPerWreck !== undefined ? Number(body.maxPerWreck) : W.maxPerWreck,
        }));
        for (const line of r.lines) pushLog('[货轮] ' + line, /失败/.test(line) ? 'error' : 'info');
        W.stats.rounds++;
        W.stats.repaired += r.repaired.length;
        W.stats.dispatched += r.dispatched.length;
        W.last = { at: Date.now(), repaired: r.repaired, dispatched: r.dispatched, skipped: r.skipped };
        if (r.snap) W.snap = r.snap;
        return json(res, 200, { ok: true, ...r });
      } catch (e) {
        W.stats.errors++;
        const h = handleOpError(e, '[货轮] ');
        return json(res, 500, { ok: false, ...h, guard: guard.publicView() });
      } finally {
        state.running = false; broadcast('state', publicState());
        broadcast('wreck', publicWreck());
      }
    }

    if (p === '/api/wreck/config' && req.method === 'POST') {
      const b = await readBody(req);
      const W = state.wreck;
      if (b.dry !== undefined) W.dry = !!b.dry;
      if (b.colors !== undefined) W.colors = Array.isArray(b.colors) ? b.colors.map(Number) : [5, 4, 3];
      if (b.minDuraRatio !== undefined) W.minDuraRatio = Math.max(0, Math.min(1, Number(b.minDuraRatio) || 1));
      if (b.doRepair !== undefined) W.doRepair = !!b.doRepair;
      if (b.doDispatch !== undefined) W.doDispatch = !!b.doDispatch;
      if (b.maxPerWreck !== undefined) W.maxPerWreck = Math.max(1, Math.min(10, Number(b.maxPerWreck) || 3));
      if (b.minGap !== undefined) W.minGap = Math.max(10, Math.min(1800, Number(b.minGap) || 45));
      if (b.auto !== undefined) { b.auto ? startWreckAuto() : stopWreckAuto('手动停止'); }
      broadcast('wreck', publicWreck());
      return json(res, 200, { ok: true, cfg: publicWreck() });
    }

    if (p === '/api/config' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.auto !== undefined) { b.auto ? startAuto() : stopAuto(); }
      if (b.dry !== undefined) state.dry = !!b.dry;
      if (b.crop !== undefined) state.crop = String(b.crop || '');
      if (b.doHarvest !== undefined) state.doHarvest = !!b.doHarvest;
      if (b.doPlant !== undefined) state.doPlant = !!b.doPlant;
      if (b.avoidWindow !== undefined) state.avoidWindow = !!b.avoidWindow;
      if (b.minGap !== undefined) state.minGap = Math.max(5, Math.min(3600, Number(b.minGap) || 30));
      broadcast('state', publicState());
      return json(res, 200, { ok: true, state: publicState() });
    }

    if (p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
      res.write(`event: radar\ndata: ${JSON.stringify(publicRadar())}\n\n`);
      res.write(`event: wreck\ndata: ${JSON.stringify(publicWreck())}\n\n`);
      for (const item of state.log.slice(-60)) {
        res.write(`data: ${JSON.stringify(item)}\n\n`);
      }
      state.conns.add(res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 20000);
      req.on('close', () => { clearInterval(ka); state.conns.delete(res); });
      return;
    }

    // ---- 静态文件 ----
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(PUB, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(PUB)) { res.writeHead(403); return res.end('forbidden'); }
    return sendFile(res, full);
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
});

// 首次启动自动建账号（密码打印一次到控制台）
let firstRun = null;
if (AUTH) {
  const r = auth.ensureAccount();
  if (r.created) firstRun = r.created;
}

server.listen(PORT, HOST, () => {
  pushLog(`控制台已启动 http://${HOST}:${PORT}`, 'ok');
  console.log(`疯狂水世界 控制台: http://${HOST}:${PORT}`);
  if (HOST === '0.0.0.0') console.log(`（已监听所有网卡，公网访问请用服务器公网 IP:${PORT}）`);
  if (!AUTH) {
    console.log('\n[警告] FARMBOT_NO_AUTH=1，登录已关闭，任何人都能直接访问控制台！\n');
  } else if (firstRun) {
    console.log('\n========================================');
    console.log(' 首次启动，已生成登录账号');
    console.log('   账号: ' + firstRun.user);
    console.log('   密码: ' + firstRun.pass);
    console.log(' 请立刻登录并修改密码（或删除 auth.json 用环境变量重建）');
    console.log('========================================\n');
  }
});

server.on('error', (e) => {
  fileLog('fatal', 'server error: ' + e.message, { code: e.code });
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[启动失败] 端口 ${PORT} 已被占用。`);
    console.error(`可能控制台已经在运行了，直接打开 http://${HOST}:${PORT} 看看。`);
    console.error(`如果想换端口：set PORT=8899 && node server.js\n`);
  } else {
    console.error(`\n[启动失败] ${e.message}\n`);
  }
  process.exit(1);
});

// ---------- 崩溃/退出原因落盘 ----------
// 云端「意外停止」最常见的原因：未捕获异常、OOM 被内核杀、systemd 重启。
// 前两种能在这里留下证据；被 SIGKILL/内核 OOM 杀掉只能靠 systemd 的 journalctl。
process.on('uncaughtException', (e) => {
  const detail = { message: e && e.message, stack: e && e.stack };
  fileLog('fatal', 'uncaughtException: ' + (e && e.message), detail);
  console.error('\n[致命] 未捕获异常，进程即将退出:\n', e);
  try { process.exit(1); } catch (_) {}
});
process.on('unhandledRejection', (e) => {
  const detail = { message: e && e.message, stack: e && e.stack };
  fileLog('fatal', 'unhandledRejection: ' + (e && e.message), detail);
  console.error('\n[致命] 未处理的 Promise 拒绝:\n', e);
  // 不直接退出：单个请求的异步错误不该拖死整个控制台
});
process.on('SIGTERM', () => { fileLog('warn', '收到 SIGTERM，正在退出'); console.log('\n收到 SIGTERM，正在退出'); process.exit(0); });
process.on('SIGINT', () => { fileLog('warn', '收到 SIGINT（Ctrl+C），正在退出'); process.exit(0); });
process.on('exit', (code) => { fileLog('warn', `进程退出，exit code = ${code}`); });
// 内存监控：OOM 前先留证据
setInterval(() => {
  const m = process.memoryUsage();
  if (m.rss > 900 * 1024 * 1024) {
    fileLog('warn', '内存占用偏高', { rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576) });
  }
}, 10 * 60 * 1000).unref();
pruneLogs();

