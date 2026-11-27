// 账号与会话：单用户登录，密码用 scrypt 加盐存储，会话在内存里（重启失效）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, 'auth.json');
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;   // 7 天
const COOKIE = 'sid';

function hashPass(pass, saltHex) {
  return crypto.scryptSync(String(pass), Buffer.from(saltHex, 'hex'), 64).toString('hex');
}

function readAccount() {
  try {
    const a = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return a && a.user && a.hash && a.salt ? a : null;
  } catch (e) { return null; }
}

function writeAccount(user, pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  const acc = { user: String(user), salt, hash: hashPass(pass, salt), updatedAt: new Date().toISOString() };
  fs.writeFileSync(FILE, JSON.stringify(acc, null, 2));
  try { fs.chmodSync(FILE, 0o600); } catch (e) {}
  return acc;
}

// 首次启动（没有 auth.json）时创建账号
// 优先用环境变量 FARMBOT_USER / FARMBOT_PASS，否则 admin + 随机密码（只在控制台打印一次）
function ensureAccount() {
  const acc = readAccount();
  if (acc) return { account: acc, created: null };
  const user = process.env.FARMBOT_USER || 'admin';
  const pass = process.env.FARMBOT_PASS ||
    crypto.randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  return { account: writeAccount(user, pass), created: { user, pass } };
}

function setPassword(user, pass) {
  return writeAccount(user, pass);
}

function verify(user, pass) {
  const acc = readAccount();
  if (!acc) return false;
  if (String(user) !== acc.user) return false;
  const got = Buffer.from(hashPass(pass, acc.salt), 'hex');
  const want = Buffer.from(acc.hash, 'hex');
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

// ---------- 会话 ----------
const sessions = new Map();

function createSession(user) {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, { user, exp: Date.now() + SESSION_TTL_MS });
  return t;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(token); return null; }
  s.exp = Date.now() + SESSION_TTL_MS;   // 每次访问续期
  return s;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

// 密码变更后让所有旧会话立即失效（改密后其他设备/浏览器要重新登录）
function destroyAllSessions() {
  sessions.clear();
  return true;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(token, maxAgeSec, secure) {
  const bits = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

// ---------- 登录失败限速 ----------
const fails = new Map();     // ip -> { n, until }
const MAX_FAIL = 5;
const LOCK_MS = 10 * 60 * 1000;

function isLocked(ip) {
  const f = fails.get(ip);
  if (!f) return 0;
  if (f.until && f.until > Date.now()) return Math.ceil((f.until - Date.now()) / 1000);
  return 0;
}

function noteFail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= MAX_FAIL) { f.until = Date.now() + LOCK_MS; f.n = 0; }
  fails.set(ip, f);
  return MAX_FAIL - f.n;
}

function noteOk(ip) { fails.delete(ip); }

module.exports = {
  ensureAccount, setPassword, verify, readAccount,
  createSession, getSession, destroySession, destroyAllSessions,
  parseCookies, cookieHeader, COOKIE,
  isLocked, noteFail, noteOk,
  FILE,
};
