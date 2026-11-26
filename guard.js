// 运行闸门：控制 bot 什么时候允许连服务器
//
// 背景（实测确认）：
//   同一账号在服务端只保留一个 WS 会话。新会话登录时，旧会话立刻收到
//   SCChannelExpired{reason:1}（ChannelExpireReason.CE_SELF_KICK）并被断开。
//   游戏客户端被顶后会自动重连（onAutoRelogin），所以两边会来回抢，
//   真人玩家就会感觉「一直被踢下线」。
//   换设备号（did）没有用，服务端按账号判定。
//
// 因此这里用三条约束减少抢会话：
//   1. 只在指定时间段运行（玩家自己定的「我不玩的时间」）
//   2. 被顶即退避：连上后短时间内就被顶，说明有人正在玩 → 指数退避，越顶越久不跑
//   3. 全局停止：一键停掉所有自动行为
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'guard.json');

// 被顶后的退避阶梯（秒）：5分 → 15分 → 30分 → 1小时 → 2小时 → 4小时
const BACKOFF_STEPS = [300, 900, 1800, 3600, 7200, 14400];
// 连上后多久内被顶，算「有人正在玩」
const KICK_WINDOW_MS = 120 * 1000;

const DEFAULTS = {
  mode: 'stopped',          // stopped | manual | window
  start: '02:00',           // window 模式：开始时间 HH:MM
  end: '07:30',             // window 模式：结束时间 HH:MM（可跨零点）
  days: [1, 2, 3, 4, 5, 6, 0],  // 一周中允许运行的日子（0=周日）
  kickCount: 0,             // 连续被顶次数
  backoffUntil: 0,          // 退避到期时间戳（毫秒）
  lastKickAt: 0,
  lastRunAt: 0,
  lastOkAt: 0,
};

function nowMs() { return Date.now(); }

function readFile() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Object.assign({}, DEFAULTS, j);
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

function writeFile(s) {
  try { fs.writeFileSync(FILE, JSON.stringify(s, null, 2)); } catch (e) {}
}

let S = readFile();

function get() { return Object.assign({}, S); }

// "H:MM" / "HH:MM" → 当天分钟数；非法返回 null
function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function fmtMin(v) {
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}

// 当前时刻是否在运行时段内
function inWindow(ts = nowMs()) {
  const d = new Date(ts);
  const days = Array.isArray(S.days) && S.days.length ? S.days.map(Number) : DEFAULTS.days;
  const day = d.getDay();
  const startMin = toMin(S.start);
  const endMin = toMin(S.end);
  if (startMin === null || endMin === null || startMin === endMin) return false;
  const cur = d.getHours() * 60 + d.getMinutes();
  if (startMin < endMin) {
    // 同一天内，例如 02:00 → 07:30
    return days.includes(day) && cur >= startMin && cur < endMin;
  }
  // 跨零点，例如 22:30 → 07:30：前半夜算今天，后半夜算前一天开始的那段
  if (cur >= startMin) return days.includes(day);
  if (cur < endMin) return days.includes((day + 6) % 7);
  return false;
}

// 下一次进入时段的时间戳（毫秒）；进不去（比如没有任何可用星期）返回 0
function nextWindowStart(ts = nowMs()) {
  const startMin = toMin(S.start);
  if (startMin === null) return 0;
  for (let i = 0; i < 15 * 24 * 60; i += 1) {
    const t = ts + i * 60 * 1000;
    const d = new Date(t);
    const days = Array.isArray(S.days) && S.days.length ? S.days.map(Number) : DEFAULTS.days;
    if (!days.includes(d.getDay())) continue;
    if (d.getHours() * 60 + d.getMinutes() === startMin && d.getSeconds() < 60) {
      // 对齐到整分
      const aligned = new Date(t);
      aligned.setSeconds(0, 0);
      return aligned.getTime();
    }
  }
  return 0;
}

// 是否允许运行；返回 { ok, reason, until }
function canRun(ts = nowMs()) {
  if (S.mode === 'stopped') return { ok: false, reason: 'stopped', text: '全局已停止' };
  if (S.backoffUntil && ts < S.backoffUntil) {
    const left = Math.ceil((S.backoffUntil - ts) / 1000);
    return { ok: false, reason: 'backoff', left, text: `被顶退避中，还需 ${fmtLeft(left)}` };
  }
  if (S.mode === 'manual') return { ok: true, reason: 'manual', text: '手动模式（随时可跑）' };
  if (S.mode === 'window') {
    if (inWindow(ts)) return { ok: true, reason: 'window', text: `运行时段内（${S.start}~${S.end}）` };
    const nx = nextWindowStart(ts);
    return {
      ok: false, reason: 'outside',
      until: nx,
      text: nx ? `不在运行时段（${S.start}~${S.end}），下次 ${fmtAt(nx)}` : `不在运行时段（${S.start}~${S.end}）`,
    };
  }
  return { ok: false, reason: 'stopped', text: '全局已停止' };
}

function fmtLeft(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h) return `${h}小时${m}分`;
  if (m) return `${m}分${ss}秒`;
  return `${ss}秒`;
}

function fmtAt(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 一轮成功完成（没被顶）
function noteOk(ts = nowMs()) {
  S.lastOkAt = ts;
  S.kickCount = 0;
  S.backoffUntil = 0;
  writeFile(S);
}

// 记录一次「开始跑」
function noteRun(ts = nowMs()) {
  S.lastRunAt = ts;
  writeFile(S);
}

// 被顶了：如果是在连上后 KICK_WINDOW_MS 内被顶，说明有人在玩 → 退避
function noteKick(ts = nowMs(), opts = {}) {
  const soon = opts.soon !== undefined ? opts.soon : (S.lastRunAt ? (ts - S.lastRunAt) < KICK_WINDOW_MS : false);
  S.lastKickAt = ts;
  if (!soon) {
    // 连上很久之后才被顶，可能只是网络抖动/服务端重连，不重罚
    writeFile(S);
    return { soon: false, backoffMs: 0, kickCount: S.kickCount };
  }
  S.kickCount = Math.min((S.kickCount || 0) + 1, BACKOFF_STEPS.length);
  const step = BACKOFF_STEPS[S.kickCount - 1];
  S.backoffUntil = ts + step * 1000;
  writeFile(S);
  return { soon: true, backoffMs: step * 1000, kickCount: S.kickCount, backoffUntil: S.backoffUntil };
}

// 修改配置
function set(patch = {}) {
  if (patch.mode !== undefined) {
    const m = String(patch.mode);
    if (!['stopped', 'manual', 'window'].includes(m)) throw new Error('mode 只能是 stopped / manual / window');
    S.mode = m;
  }
  if (patch.start !== undefined) {
    if (toMin(patch.start) === null) throw new Error('start 格式应为 HH:MM');
    S.start = fmtMin(toMin(patch.start));
  }
  if (patch.end !== undefined) {
    if (toMin(patch.end) === null) throw new Error('end 格式应为 HH:MM');
    S.end = fmtMin(toMin(patch.end));
  }
  if (patch.days !== undefined) {
    const arr = Array.isArray(patch.days) ? patch.days.map(Number) : String(patch.days).split(',').map(Number);
    S.days = arr.filter((d) => d >= 0 && d <= 6);
  }
  if (patch.clearBackoff) {
    S.backoffUntil = 0;
    S.kickCount = 0;
  }
  writeFile(S);
  return get();
}

// 给前端/状态接口用的完整视图
function publicView() {
  const c = canRun();
  const nx = nextWindowStart();
  return {
    mode: S.mode,
    start: S.start,
    end: S.end,
    days: S.days,
    running: c.ok,
    reason: c.reason,
    hint: c.text,
    nextWindowAt: nx || null,
    backoffUntil: S.backoffUntil || null,
    kickCount: S.kickCount || 0,
    lastKickAt: S.lastKickAt || null,
    lastOkAt: S.lastOkAt || null,
    backoffSteps: BACKOFF_STEPS,
  };
}

module.exports = { get, set, canRun, inWindow, nextWindowStart, noteOk, noteRun, noteKick, publicView, toMin, fmtLeft, fmtAt, FILE };
