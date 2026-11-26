// 通用协议客户端：登录 + 收发（支持 lz4 压缩包体）
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const lz4 = require('lz4js');
const { P } = require('./protoload');

const URL = 'wss://dhyaoj-gate.khlgamen.com/ws';

function buildFrame(name, body, seq = 0) {
  const nb = Buffer.from(name, 'ascii');
  const parts = [Buffer.from([2])];
  const s = Buffer.alloc(4); s.writeInt32BE(seq, 0); parts.push(s);
  parts.push(Buffer.from([nb.length])); parts.push(nb);
  parts.push(Buffer.from([0])); parts.push(body);
  const inner = Buffer.concat(parts);
  const head = Buffer.alloc(4); head.writeInt32BE(inner.length, 0);
  return Buffer.concat([head, inner]);
}

function splitFrames(buf) {
  const out = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = buf.readInt32BE(i);
    if (len <= 0 || i + 4 + len > buf.length) break;
    const f = buf.slice(i, i + 4 + len);
    const nlen = f[9];
    out.push({
      len, ver: f[4], seq: f.readInt32BE(5),
      name: f.slice(10, 10 + nlen).toString('ascii'),
      comp: f[10 + nlen],
      body: f.slice(11 + nlen),
    });
    i += 4 + len;
  }
  return out;
}

function maybeDecompress(body) {
  if (body.length < 8) return body;
  const want = body.readInt32BE(0);
  if (want <= 0 || want > 64 * 1024 * 1024) return body;
  const src = new Uint8Array(body.buffer, body.byteOffset + 4, body.length - 4);
  const dst = new Uint8Array(want);
  try {
    const n = lz4.decompressBlock(src, dst, 0, src.length, 0);
    if (n === want) return Buffer.from(dst.subarray(0, n));
  } catch (e) {}
  return body;
}

function decodeMsg(name, body) {
  const C = P[name];
  const raw = maybeDecompress(body);
  if (!C) return { __raw: raw.toString('hex') };
  try { return C.decode(raw); } catch (e) { return { __error: e.message }; }
}

function jstr(o) { return JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)); }

function parseLoginBody(file) {
  const d = fs.readFileSync(file || path.join(__dirname, 'buf_login.bin'));
  for (const fr of splitFrames(d)) if (fr.name === 'LoginRequest') return fr.body;
  throw new Error('no login frame in ' + file);
}

// 被顶下线（同账号在别处登录）时抛出的错误
class YieldError extends Error {
  constructor(reason) {
    super('SESSION_YIELD');
    this.name = 'YieldError';
    this.code = 'YIELD';
    this.reason = reason || 1;
  }
}

function isYieldError(e) {
  return !!(e && (e.code === 'YIELD' || e instanceof YieldError));
}

class Client {
  constructor(opts = {}) {
    this.seq = 1000;
    this.pending = new Map();      // seq -> {name, resolve, reject, timer}
    this.byName = new Map();       // name -> [{fn, reject, timer}]
    this.log = opts.log !== false;
    this.kicked = false;           // 是否收到过 SCChannelExpired
    this.kickReason = 0;           // ChannelExpireReason: 1=self_kick 2=server_closed 3=data_rollback 4=gm_kick 5=stale_register
  }

  // 立刻让所有等待中的请求失败（被顶时用，避免每个请求白等 10 秒）
  _abortAll(err) {
    for (const [, p] of this.pending) { try { p.reject(err); } catch (e) {} }
    this.pending.clear();
    for (const arr of this.byName.values()) {
      while (arr.length) {
        const w = arr.shift();
        try { clearTimeout(w.timer); w.reject(err); } catch (e) {}
      }
    }
    if (this._ackWaiters && this._ackWaiters.size) {
      for (const w of [...this._ackWaiters]) { try { w.fail(err); } catch (e) {} }
      this._ackWaiters.clear();
    }
  }

  connect(loginFile, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      const to = setTimeout(() => reject(new Error('connect timeout')), timeoutMs);
      this.ws.on('open', () => { this.ws.send(buildFrame('LoginRequest', parseLoginBody(loginFile), 938)); });
      this.ws.on('error', (e) => { clearTimeout(to); reject(e); });
      this.ws.on('close', () => { this._abortAll(this.kicked ? new YieldError(this.kickReason) : new Error('closed')); });
      this.ws.on('message', (data) => {
        for (const fr of splitFrames(Buffer.from(data))) {
          if (fr.name === 'PingRequest') {
            this.ws.send(buildFrame('Ack', Buffer.from([8, 0]), 0));
            continue;
          }
          // 被顶下线：服务端要求本会话让位（reason=1 通常是同账号在别处登录）
          if (fr.name === 'SCChannelExpired') {
            const d = decodeMsg('SCChannelExpired', fr.body);
            this.kicked = true;
            this.kickReason = d.reason || 1;
            if (this.onKick) { try { this.onKick(d.reason || 1); } catch (e) {} }
            this._abortAll(new YieldError(this.kickReason));
            try { this.ws.close(); } catch (e) {}
            continue;
          }
          if (fr.name === 'LoginResponse') {
            const r = decodeMsg('LoginResponse', fr.body);
            if (this.log) console.log('[login] result=' + r.result);
            clearTimeout(to);
            if (r.result === 0) { this.playerInfo = r.playerInfo; resolve(r); }
            else reject(new Error('login failed: ' + jstr(r)));
            continue;
          }
          const decoded = decodeMsg(fr.name, fr.body);
          if (this.onAny) { try { this.onAny(fr.name, decoded); } catch (e) {} }
          // 写操作的确认回包：OkResponse = 成功；PromptResponse = 服务端拒绝（如 item limit reached）
          if (this._ackWaiters && this._ackWaiters.size) {
            if (fr.name === 'OkResponse') {
              for (const w of [...this._ackWaiters]) w.done({ ok: true });
            } else if (fr.name === 'PromptResponse') {
              const msg = (decoded.args || []).join(' ') || ('prompt #' + decoded.prompt);
              for (const w of [...this._ackWaiters]) w.fail(new Error('服务端拒绝: ' + msg));
            }
          }
          if (this.log && !this.quiet) console.log('[push] ' + fr.name + ' ' + jstr(decoded).slice(0, 300));
          const waiters = this.byName.get(fr.name);
          if (waiters && waiters.length) {
            const w = waiters.shift();
            w.fn(decoded);
          } else {
            (this.buffered || (this.buffered = {}) )[fr.name] = decoded;
          }
        }
      });
    });
  }

  send(name, obj = {}) {
    // 被顶之后连接已作废，直接抛 YieldError，不要挂在死连接上等超时
    if (this.kicked) throw new YieldError(this.kickReason);
    if (!this.ws || this.ws.readyState !== 1) throw new Error('连接未打开');
    const C = P[name];
    const body = C ? C.encode(obj).finish() : Buffer.alloc(0);
    const seq = ++this.seq;
    this.ws.send(buildFrame(name, body, seq));
    return seq;
  }

  // 发请求等同名 Response
  request(name, obj = {}, respName = null, timeoutMs = 10000) {
    const want = respName || name.replace(/Request$/, 'Response');
    if (!P[want]) throw new Error('no such response schema: ' + want);
    return new Promise((resolve, reject) => {
      if (this.kicked) return reject(new YieldError(this.kickReason));
      let arr = this.byName.get(want);
      if (!arr) this.byName.set(want, arr = []);
      const timer = setTimeout(() => reject(new Error('timeout waiting ' + want)), timeoutMs);
      arr.push({ fn: (d) => { clearTimeout(timer); resolve(d); }, reject, timer });
      try { this.send(name, obj); }
      catch (e) { clearTimeout(timer); arr.pop(); reject(e); }
    });
  }

  // 发请求并等待「确认类」回包：OkResponse（成功）或 PromptResponse（服务端拒绝）
  // 用于没有专门 XxxResponse 的写操作（FarmPlantRequest / RadarSendFleetsRequest 等）
  requestAck(name, obj = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (this.kicked) return reject(new YieldError(this.kickReason));
      const done = (v) => { clearTimeout(timer); this._ackWaiters.delete(waiter); resolve(v); };
      const fail = (e) => { clearTimeout(timer); this._ackWaiters.delete(waiter); reject(e); };
      const waiter = { done, fail };
      if (!this._ackWaiters) this._ackWaiters = new Set();
      this._ackWaiters.add(waiter);
      const timer = setTimeout(() => fail(new Error('timeout waiting ack for ' + name)), timeoutMs);
      try { this.send(name, obj); }
      catch (e) { clearTimeout(timer); this._ackWaiters.delete(waiter); reject(e); }
    });
  }

  close() { try { this.ws.close(); } catch (e) {} }
}

module.exports = { Client, YieldError, isYieldError, buildFrame, splitFrames, decodeMsg, maybeDecompress, jstr, P, URL };
