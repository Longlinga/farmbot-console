// 联盟情报（世界 → 雷达）核心逻辑：CLI 与 Web 共用
// 与 farm_core.js 同样遵循「短连接突发」：连上 → 派舰队/领奖 → 立刻断开。
const fs = require('fs');
const path = require('path');
const { Client } = require('./client');

const num = (v) =>
  v && typeof v === 'object' ? Number(v.low || 0) + Number(v.high || 0) * 4294967296 : Number(v || 0);
const now = () => Math.floor(Date.now() / 1000);

// 事件配置（中文 type/hangSeconds）
const randCfg = {};
for (const r of JSON.parse(fs.readFileSync(path.join(__dirname, 'cfg', 'RadarRandEventCfg.json'), 'utf8')).data) {
  randCfg[r.eventId] = r;
}
const EVENT_TYPES = [...new Set(Object.values(randCfg).map((r) => r.type))];
// 世界参数
const worldParam = {};
for (const r of JSON.parse(fs.readFileSync(path.join(__dirname, 'cfg', 'WorldParamCfg.json'), 'utf8')).data) {
  worldParam[r.paramName] = r.paramValue;
}
const PETROL_COST = worldParam['情报事件消耗汽油'] || 500;

// 舰队状态枚举
const FleetState = { IDLE: 1, MOVING: 2, BATTLING: 3, REPAIRING: 4, QUEUING: 5 };
const EvState = { INIT: 1, LOCKED: 2, START: 3, FINISHED: 4 };

async function withClient(fn) {
  const c = new Client({ log: false });
  c.quiet = true;
  try {
    await c.connect();
    return await fn(c);
  } finally {
    try { c.close(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
}

function eventKind(e) {
  if (e.pirate) return 'pirate';
  if (e.refugee) return 'refugee';
  if (e.collectRes) return 'collectRes';
  if (e.citySpy) return 'citySpy';
  return 'other';
}

function evName(e) {
  const cfg = randCfg[e.eventId];
  if (!cfg) return '事件' + e.eventId;
  return cfg.type;
}

function isIdle(f) {
  return f.state === FleetState.IDLE && !f.curGridIdx && !f.treasureLootUid && f.durability > 0;
}

async function readRadar(c) {
  const [ri, ff] = await Promise.all([
    c.request('RadarInfoRequest', {}, 'RadarInfoResponse', 10000),
    c.request('MyFleetsRequest', {}, 'MyFleetsResponse', 10000),
  ]);
  const info = ri.radarInfo || {};
  const t = now();
  return {
    level: info.level || 0,
    exp: info.exp || 0,
    storedNum: info.storedNum || 0,
    nextRefreshTime: info.nextRefreshTime || 0,
    fixedEvent: info.fixedEvent || null,
    events: (info.events || []).map((e) => {
      const cfg = randCfg[e.eventId] || {};
      const req = e.refugee ? (e.refugee.requirements || []).map((r) => ({ id: r.id, num: num(r.num) })) : null;
      return {
        uid: num(e.uid),
        eventId: e.eventId,
        color: e.color || 0,
        gridIdx: e.gridIdx || 0,
        state: e.state,
        startTime: e.startTime || 0,
        kind: eventKind(e),
        type: cfg.type || '',
        name: cfg.type || '事件' + e.eventId,
        hangSeconds: cfg.hangSeconds || 0,
        requirements: req,
        reward: e.reward ? (e.reward.asset || []).map((a) => ({ id: a.id, num: num(a.num) })) : [],
        left: e.startTime ? Math.max(0, e.startTime + (cfg.hangSeconds || 0) + 1 - t) : null,
      };
    }),
    fleets: (ff.fleets || []).map((f) => ({
      id: f.buildingId,
      state: f.state,
      durability: f.durability || 0,
      maxDura: f.maxDura || 0,
      power: num(f.power),
      curGridIdx: f.curGridIdx || 0,
      targetGridIdx: f.targetGridIdx || 0,
      moveStartTs: f.moveStartTs || 0,
      moveEndTs: f.moveEndTs || 0,
      autoFight: f.autoFight ? !!f.autoFight.isOn : false,
      idle: isIdle(f),
    })),
    serverTime: t,
  };
}

async function readPetrol(c) {
  const r = await c.request('AllItemRequest', {}, 'AllItemResponse', 12000);
  const items = r.items || r.assets || [];
  const hit = items.find((it) => (it.itemId || it.id) === '汽油');
  return hit ? num(hit.num) : 0;
}

function assetsEnough(have, requirements) {
  if (!requirements || !requirements.length) return true;
  return requirements.every((r) => (have[r.id] || 0) >= r.num);
}

// 给每个舰队挑事件：优先按舰队的 types 偏好，其次按「收益/耗时」排序
// 保证一个事件只派一个舰队（不重复派）
function planDispatch(snap, opts = {}) {
  const { strategies = [], allowTypes = [], minPetrol = PETROL_COST, petrol = Infinity } = opts;
  const idle = snap.fleets.filter((f) => f.idle);
  const init = snap.events.filter((e) => e.state === EvState.INIT);
  const taken = new Set();
  const plans = [];

  const score = (e) => {
    // 颜色越高奖励越好；hangSeconds 越短越快回来
    const hang = randCfg[e.eventId] ? randCfg[e.eventId].hangSeconds || 0 : 0;
    return e.color * 100 - hang;
  };
  const sorted = init.slice().sort((a, b) => score(b) - score(a));

  let budget = petrol;
  for (let i = 0; i < idle.length; i++) {
    const fleet = idle[i];
    const st = strategies[i] || {};
    if (st.enabled === false) continue;
    const prefer = (st.types && st.types.length ? st.types : allowTypes) || [];
    if (budget < minPetrol) break;

    const cands = sorted.filter((e) => {
      if (taken.has(e.uid)) return false;
      if (prefer.length && !prefer.includes(e.type)) return false;
      return true;
    });
    const ev = cands[0];
    if (!ev) continue;
    taken.add(ev.uid);
    budget -= PETROL_COST;
    plans.push({ fleet: fleet.id, event: ev, reason: prefer.length ? '策略匹配' : '任意' });
  }
  return plans;
}

// 一轮情报：领已完成奖励 → 派空闲舰队
async function runRadarRound(opts = {}) {
  const { dry = false, doClaim = true, doDispatch = true, strategies = [], allowTypes = [], maxDispatch = 3 } = opts;
  return withClient(async (c) => {
    const lines = [];
    const res = { claimed: [], dispatched: [], petrol: 0, skipped: null, lines, nextWake: 60 };

    const snap = await readRadar(c);
    let petrol = 0;
    try { petrol = await readPetrol(c); } catch (e) {}
    res.petrol = petrol;
    res.before = snap;

    const finished = snap.events.filter((e) => e.state === EvState.FINISHED);
    if (finished.length && doClaim) {
      if (dry) lines.push(`[dry] 可领奖 ${finished.length} 个事件`);
      else {
        try {
          const r = await c.request('RadarGetAllRewardsRequest', {}, 'GotRewardResponse', 10000);
          const rw = fmtReward(r);
          res.claimed = finished.map((e) => ({ uid: e.uid, type: e.type }));
          lines.push(`领取 ${finished.length} 个情报奖励 → ${rw.map((x) => `${x.id}×${x.num}`).join(' ') || '(无)'}`);
        } catch (e) {
          lines.push('领奖失败: ' + e.message);
        }
      }
    } else if (finished.length) {
      lines.push(`${finished.length} 个事件已完成待领奖（已按设置跳过）`);
    }

    if (doDispatch) {
      // 难民事件要先看物资够不够
      let items = {};
      try { items = await readItemMap(c); } catch (e) {}
      const usable = snap.events.filter(
        (e) => e.state === EvState.INIT && (!e.requirements || assetsEnough(items, e.requirements))
      );
      const snap2 = { ...snap, events: usable };
      const plans = planDispatch(snap2, { strategies, allowTypes, petrol }).slice(0, maxDispatch);

      if (!plans.length) {
        const idleN = snap.fleets.filter((f) => f.idle).length;
        if (!idleN) lines.push('没有空闲舰队（都在外执行任务）');
        else if (petrol < PETROL_COST) lines.push(`汽油不足（${petrol} < ${PETROL_COST}）`);
        else lines.push('没有可派的事件（可能事件都在进行中或物资不足）');
        res.skipped = idleN ? 'no-event' : 'no-fleet';
      } else {
        for (const p of plans) {
          if (dry) { lines.push(`[dry] ${p.fleet} → ${p.event.type}(ev${p.event.eventId} uid=${p.event.uid})`); continue; }
          try {
            // 用 requestAck 等 OkResponse 确认，服务端拒绝会抛错（原先静默 send 会误报成功）
            await c.requestAck('RadarSendFleetsRequest', { uid: p.event.uid, fleetBuildingIds: [p.fleet] }, 8000);
            res.dispatched.push({ fleet: p.fleet, uid: p.event.uid, type: p.event.type, eventId: p.event.eventId });
            lines.push(`派出 ${p.fleet} → ${p.event.type}（${p.event.color}星 格${p.event.gridIdx || '-'}）`);
            await new Promise((r) => setTimeout(r, 700));
          } catch (e) {
            lines.push(`派 ${p.fleet} 失败: ${e.message}`);
          }
        }
      }
    }

    // 算下次该醒来的时间：有进行中事件就按最短剩余时间；否则等刷新
    try {
      const s2 = await readRadar(c);
      res.after = s2;
      const pend = s2.events.filter((e) => e.state === EvState.START || e.state === EvState.LOCKED);
      const lefts = pend.map((e) => e.left).filter((x) => x != null && x > 0);
      const finNow = s2.events.filter((e) => e.state === EvState.FINISHED).length;
      const idleNow = s2.fleets.filter((f) => f.idle).length;
      const initNow = s2.events.filter((e) => e.state === EvState.INIT).length;
      let next = 60;
      if (finNow > 0) next = 8;
      else if (lefts.length) next = Math.max(10, Math.min(300, Math.min(...lefts) + 2));
      else if (idleNow > 0 && initNow > 0) next = 15;
      else next = 120;
      res.nextWake = next;
      lines.push(`情报 Lv${s2.level} 经验${s2.exp} | 事件${s2.events.length}个（可派${initNow}/进行中${pend.length}/待领${finNow}）| 空闲舰队${idleNow}`);
    } catch (e) {
      lines.push('状态刷新失败: ' + e.message);
    }

    return res;
  });
}

function fmtReward(resp) {
  const out = new Map();
  const pack = (resp && (resp.reward || resp.assetPackage)) || null;
  const assets = (pack && pack.asset) || [];
  for (const a of assets) {
    if (!a || !a.id) continue;
    out.set(a.id, (out.get(a.id) || 0) + num(a.num));
  }
  for (const h of (resp && resp.hero) || []) {
    const id = h.heroId || h.id;
    if (id) out.set(id, (out.get(id) || 0) + 1);
  }
  return [...out.entries()].map(([id, n]) => ({ id, num: n }));
}

async function readItemMap(c) {
  const r = await c.request('AllItemRequest', {}, 'AllItemResponse', 12000);
  const map = {};
  for (const it of r.items || r.assets || []) map[it.itemId || it.id] = num(it.num);
  return map;
}

// 「点一下做完所有情报」：在一次会话里循环——领完奖 → 派空闲舰队 → 等事件结算 → 再派，
// 直到没有可派事件、没有进行中事件、没有待领奖励为止（或超时/演练）。
// 情报事件全周期约 32 秒，10 个事件 3 条船约 3~4 轮即可清空。
async function runRadarAll(opts = {}) {
  const {
    dry = false,
    doClaim = true,
    doDispatch = true,
    strategies = [],
    allowTypes = [],
    onLine = null,
    maxMs = 8 * 60 * 1000,
    pollMs = 4000,
  } = opts;

  const t0 = Date.now();
  return withClient(async (c) => {
    const lines = [];
    const res = { claimed: [], dispatched: [], petrol: 0, lines, rounds: 0, done: false, timedOut: false, nextWake: 0 };
    const say = (s) => { lines.push(s); if (onLine) { try { onLine(s); } catch (e) {} } };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    let petrol = 0;
    try { petrol = await readPetrol(c); } catch (e) {}
    res.petrol = petrol;

    for (let round = 1; ; round++) {
      res.rounds = round;
      const snap = await readRadar(c);

      // 1) 领奖：一次领走全部已完成事件
      const finished = snap.events.filter((e) => e.state === EvState.FINISHED);
      if (finished.length && doClaim) {
        if (dry) say(`[dry] 可领奖 ${finished.length} 个事件`);
        else {
          try {
            const r = await c.request('RadarGetAllRewardsRequest', {}, 'GotRewardResponse', 12000);
            const rw = fmtReward(r);
            for (const e of finished) res.claimed.push({ uid: e.uid, type: e.type });
            say(`领取 ${finished.length} 个情报奖励 → ${rw.map((x) => `${x.id}×${x.num}`).join(' ') || '(无)'}`);
          } catch (e) {
            say('领奖失败: ' + e.message);
          }
        }
      }

      // 2) 派舰队：把空闲舰队全部派出去（一事件一船）
      const snapNow = finished.length && !dry ? await readRadar(c) : snap;
      const usable = snapNow.events.filter(
        (e) => e.state === EvState.INIT && (!e.requirements || true)
      );
      const idleNow = snapNow.fleets.filter((f) => f.idle);
      const pendingNow = snapNow.events.filter((e) => e.state === EvState.LOCKED || e.state === EvState.START);
      const initNow = snapNow.events.filter((e) => e.state === EvState.INIT);

      if (doDispatch && initNow.length && idleNow.length && petrol >= PETROL_COST) {
        let items = {};
        try { items = await readItemMap(c); } catch (e) {}
        const okEvents = initNow.filter((e) => !e.requirements || assetsEnough(items, e.requirements));
        const plans = planDispatch({ ...snapNow, events: okEvents }, { strategies, allowTypes, petrol });
        for (const p of plans) {
          if (dry) { say(`[dry] ${p.fleet} → ${p.event.type}(ev${p.event.eventId} uid=${p.event.uid})`); continue; }
          try {
            await c.requestAck('RadarSendFleetsRequest', { uid: p.event.uid, fleetBuildingIds: [p.fleet] }, 8000);
            res.dispatched.push({ fleet: p.fleet, uid: p.event.uid, type: p.event.type, eventId: p.event.eventId });
            say(`派出 ${p.fleet} → ${p.event.type}（${p.event.color}星 格${p.event.gridIdx || '-'}）`);
            petrol -= PETROL_COST;
            await sleep(600);
          } catch (e) {
            say(`派 ${p.fleet} 失败: ${e.message}`);
          }
        }
      }

      // 3) 判断是否收工：没有可派、没有进行中、没有待领
      const after = dry ? snapNow : await readRadar(c);
      const finAfter = after.events.filter((e) => e.state === EvState.FINISHED);
      const pendAfter = after.events.filter((e) => e.state === EvState.LOCKED || e.state === EvState.START);
      const initAfter = after.events.filter((e) => e.state === EvState.INIT);
      const idleAfter = after.fleets.filter((f) => f.idle);
      say(
        `第${round}轮：事件${after.events.length}（可派${initAfter.length}/进行中${pendAfter.length}/待领${finAfter.length}）空闲舰队${idleAfter.length}`
      );

      // 待领且还能领 → 立刻再来一轮
      if (finAfter.length && doClaim && !dry) continue;
      // 还有进行中的事件 → 等它们结算
      if (pendAfter.length) {
        if (Date.now() - t0 > maxMs) { res.timedOut = true; say('到达时间上限，先收工（剩下的下次再点）'); break; }
        const lefts = pendAfter.map((e) => e.left).filter((x) => x != null && x > 0);
        const wait = lefts.length ? Math.max(pollMs, Math.min(15000, Math.min(...lefts) * 1000 + 1500)) : pollMs;
        await sleep(wait);
        continue;
      }
      // 还有可派事件 + 有空闲舰队 + 汽油够 → 继续派
      if (doDispatch && initAfter.length && idleAfter.length && petrol >= PETROL_COST) continue;
      if (initAfter.length && !idleAfter.length) { say('可派事件还在，但舰队都在外，先收工'); break; }
      // 都清干净了
      res.done = true;
      break;
    }

    try {
      const s2 = await readRadar(c);
      res.after = s2;
      res.nextWake = s2.nextRefreshTime ? Math.max(0, s2.nextRefreshTime - now()) : 0;
      say(`情报 Lv${s2.level} 经验${s2.exp} | 剩余事件 ${s2.events.length} 个 | 空闲舰队 ${s2.fleets.filter((f) => f.idle).length}`);
      if (res.nextWake > 0) say(`下批情报 ${Math.floor(res.nextWake / 3600)} 小时后刷新`);
    } catch (e) {
      say('状态刷新失败: ' + e.message);
    }
    return res;
  });
}

async function radarSnapshot(opts = {}) {
  return withClient(async (c) => {
    const snap = await readRadar(c);
    let petrol = 0;
    try { petrol = await readPetrol(c); } catch (e) {}
    return { ok: true, ...snap, petrol, petrolCost: PETROL_COST, eventTypes: EVENT_TYPES };
  });
}

module.exports = {
  withClient, readRadar, readPetrol, readItemMap, planDispatch, runRadarRound, runRadarAll,
  radarSnapshot, fmtReward, randCfg, EVENT_TYPES, PETROL_COST, FleetState, EvState, num, now,
};
