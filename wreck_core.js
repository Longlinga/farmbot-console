// 世界宝藏（搁浅的货轮）核心逻辑：CLI 与 Web 共用
// 目标：舰队自动派出占领 → 战败回驻点自动修复 → 修复完再派出 → 直到目标货轮消失
const fs = require('fs');
const path = require('path');
const { Client } = require('./client');

const { toNum: num } = require('./int64');
const now = () => Math.floor(Date.now() / 1000);

// 颜色枚举（协议 Color：WHITE=1,GREEN=2,BLUE=3,PURPLE=4,ORANGE=5,RED=6）
// 货轮品质：BLUE=小型 / PURPLE=中型 / ORANGE=万吨
const WRECK_CFG = {};
for (const r of JSON.parse(fs.readFileSync(path.join(__dirname, 'cfg', 'TreasureLootCfg.json'), 'utf8')).data) {
  const colorMap = { BLUE: 3, PURPLE: 4, ORANGE: 5, RED: 6 };
  WRECK_CFG[colorMap[r.quality] || 0] = { name: r.name, quality: r.quality, score: r.score, qualityIndex: r.qualityIndex };
}
const COLOR_NAME = { 3: '小型货轮', 4: '中型货轮', 5: '万吨货轮', 6: '红色货轮' };
const ALL_COLORS = [5, 4, 3];

// 参数表
const param = {};
for (const r of JSON.parse(fs.readFileSync(path.join(__dirname, 'cfg', 'TreasureLootParamCfg.json'), 'utf8')).data) {
  param[r.paramName] = Number(r.paramValue);
}
const MAX_DAILY_REWARD = param['每日宝藏奖励次数'] || 3;

// 默认只在意的稀有奖励（用户要求：万吨货轮若带这两样就自动出兵）
const DEFAULT_WANT_REWARDS = ['橙装材料自选包', '橙技能书'];


// 世界参数（耐久消耗/修复）
const worldParam = {};
for (const r of JSON.parse(fs.readFileSync(path.join(__dirname, 'cfg', 'WorldParamCfg.json'), 'utf8')).data) {
  worldParam[r.paramName] = r.paramValue;
}

const FleetState = { IDLE: 1, MOVING: 2, BATTLING: 3, REPAIRING: 4, QUEUING: 5 };
const ST_NAME = { 1: '空闲', 2: '行军', 3: '战斗', 4: '修复中', 5: '占领中' };

// 每条船最多同时被同联盟 10 支舰队占领，后续自动遣返
const MAX_FLEET_PER_WRECK = 10;

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

function isHomeIdle(f) {
  return f.state === FleetState.IDLE && !f.curGridIdx && !f.treasureLootUid;
}

function canFight(f) {
  return f.durability > 0;
}

// 读货轮全量状态：统计 + 列表 + 我的舰队
async function readWreck(c) {
  const [st, ls, mf] = await Promise.all([
    c.request('TreasureLootStatsRequest', {}, 'TreasureLootStatsResponse', 10000),
    c.request('TreasureLootListRequest', {}, 'TreasureLootListResponse', 10000),
    c.request('MyFleetsRequest', {}, 'MyFleetsResponse', 10000),
  ]);
  const t = now();
  const fleets = (mf.fleets || []).map((f) => ({
    id: f.buildingId,
    state: f.state,
    stateName: ST_NAME[f.state] || String(f.state),
    durability: f.durability || 0,
    maxDura: f.maxDura || 0,
    power: num(f.power),
    curGridIdx: f.curGridIdx || 0,
    cityId: f.cityId || 0,
    treasureLootUid: f.treasureLootUid || 0,
    moveEndTs: f.moveEndTs || 0,
    repairing: f.repairing
      ? { startTs: f.repairing.startTs, endTs: f.repairing.endTs, endDura: f.repairing.endDura }
      : null,
    homeIdle: isHomeIdle(f),
    fullDura: (f.durability || 0) >= (f.maxDura || 0),
    canFight: canFight(f),
  }));
  const wrecks = (ls.treasure || []).map((w) => {
    const uid = num(w.uid);
    const mine = fleets.filter((f) => f.treasureLootUid === uid);
    return {
      uid,
      color: w.color || 0,
      colorName: COLOR_NAME[w.color] || ('货轮' + w.color),
      quality: (WRECK_CFG[w.color] || {}).quality || '',
      ownerGuildIdx: w.ownerGuildIdx || 0,
      ownerFleetNum: w.ownerFleetNum || 0,
      progress: w.progress || 0,
      gridIdx: w.gridIdx || 0,
      reward: ((w.reward && w.reward.asset) || []).map((a) => ({ id: a.id, num: num(a.num) })),
      rewardNames: ((w.reward && w.reward.asset) || []).map((a) => String(a.id)),
      mine: mine.length > 0,
      myFleets: mine.map((f) => f.id),
      roomLeft: Math.max(0, MAX_FLEET_PER_WRECK - (w.ownerFleetNum || 0)),
    };
  });
  return {
    stats: (st.stats || []).map((s) => ({ color: s.color, count: s.count })),
    nextRefreshTime: st.nextRefreshTime || 0,
    todayRewardTimes: st.todayRewardTimes || 0,
    totalRewardTimes: st.totalRewardTimes || 0,
    rewardLeft: Math.max(0, (st.totalRewardTimes || 0) - (st.todayRewardTimes || 0)),
    maxDailyReward: MAX_DAILY_REWARD,
    refreshLeft: Math.max(0, (st.nextRefreshTime || 0) - t),
    wrecks: wrecks.sort((a, b) => b.color - a.color || a.uid - b.uid),
    fleets,
    serverTime: t,
  };
}

// 需要修复的舰队：已回到家、耐久未满、且不在修复中
function needRepair(snap) {
  return snap.fleets.filter((f) => f.homeIdle && !f.fullDura && f.durability >= 0);
}

// 可派出的舰队：在家、空闲、耐久满（或够打）
function readyFleets(snap, minDuraRatio = 1) {
  return snap.fleets.filter(
    (f) => f.homeIdle && f.canFight && f.durability >= Math.max(1, Math.floor(f.maxDura * minDuraRatio))
  );
}

// 挑目标：按颜色优先级（万吨 > 中型 > 小型），跳过已满员的
function pickWrecks(snap, colors) {
  const want = colors && colors.length ? colors : ALL_COLORS;
  return snap.wrecks.filter((w) => want.includes(w.color) && w.roomLeft > 0);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

// 自动循环的停止判定：点了「循环出兵」之后一直跑，直到目标货轮消失
// 返回 { stop, reason, text }
function loopStop(snap, opts = {}) {
  const colors = opts.colors && opts.colors.length ? opts.colors : ALL_COLORS;
  const targetColor = colors[0]; // 最高品质（默认 5 = 万吨）
  const targetName = COLOR_NAME[targetColor] || '目标货轮';
  const want = opts.wantRewards || [];
  const tops = snap.wrecks.filter((w) => w.color === targetColor);
  if (!tops.length) {
    return { stop: true, reason: 'gone', text: `${targetName}已消失，循环结束` };
  }
  if (want.length && !tops.some((w) => matchRewards(w, want))) {
    return { stop: true, reason: 'gone', text: `${targetName}里已没有带「${want.join('/')}」的了，循环结束` };
  }
  if (snap.rewardLeft <= 0) {
    return { stop: true, reason: 'no-reward', text: `今日货轮奖励次数已用完（${snap.todayRewardTimes}/${snap.totalRewardTimes}），循环结束` };
  }
  return { stop: false, reason: '', text: `${targetName} ${tops.length} 条` };
}

// 自动循环的下一轮等待时间（秒）
// 依据：修复中等到修复完成；在外面就中等间隔轮询；有活干就很快回来
function planNextWake(snap, opts = {}) {
  const { minGap = 45, maxGap = 300, minDuraRatio = 1, colors = ALL_COLORS } = opts;
  const t = snap.serverTime || now();

  const repairing = snap.fleets.filter((f) => f.state === FleetState.REPAIRING && f.repairing);
  if (repairing.length) {
    const soonest = Math.min(...repairing.map((f) => Math.max(0, f.repairing.endTs - t)));
    return clamp(soonest + 5, 8, maxGap);
  }
  const busy = snap.fleets.filter(
    (f) => f.state === FleetState.MOVING || f.state === FleetState.BATTLING || f.state === FleetState.QUEUING
  );
  if (busy.length) return clamp(minGap, 20, maxGap);
  if (needRepair(snap).length) return 8;
  if (readyFleets(snap, minDuraRatio).length && pickWrecks(snap, colors).length) return 8;
  return clamp(minGap, 60, maxGap);
}

// 一轮：先修复，再派出
// opts: { dry, colors, minDuraRatio, repair, dispatch, maxPerWreck }
async function runWreckRound(opts = {}) {
  const {
    dry = false,
    colors = ALL_COLORS,
    minDuraRatio = 1,
    doRepair = true,
    doDispatch = true,
    maxPerWreck = 3,
    wantRewards = [],
    water = null,
  } = opts;

  return withClient(async (c) => {
    const lines = [];
    const res = { repaired: [], dispatched: [], lines, snap: null, nextWake: 15 };
    const snap = water || (await readWreck(c));
    res.snap = snap;

    const rl = snap.rewardLeft;
    lines.push(
      `货轮 万吨${(snap.stats.find((s) => s.color === 5) || {}).count || 0} / 中型${
        (snap.stats.find((s) => s.color === 4) || {}).count || 0
      } / 小型${(snap.stats.find((s) => s.color === 3) || {}).count || 0} | 今日奖励 ${
        snap.todayRewardTimes
      }/${snap.totalRewardTimes}`
    );

    // 1) 修复回驻点的舰队
    if (doRepair) {
      for (const f of needRepair(snap)) {
        if (dry) {
          lines.push(`[dry] 修复 ${f.id}（耐久 ${f.durability}/${f.maxDura}）`);
          continue;
        }
        try {
          await c.requestAck('RepairFleetRequest', { buildingId: f.id }, 8000);
          res.repaired.push(f.id);
          lines.push(`修复 ${f.id} 耐久 ${f.durability}/${f.maxDura}`);
        } catch (e) {
          lines.push(`修复 ${f.id} 失败: ${e.message}`);
        }
      }
      // 修复中的舰队提示剩余时间
      for (const f of snap.fleets.filter((x) => x.state === FleetState.REPAIRING && x.repairing)) {
        const left = Math.max(0, f.repairing.endTs - snap.serverTime);
        if (left > 0) lines.push(`${f.id} 修复中，还需 ${Math.ceil(left / 60)} 分钟`);
      }
    }

    // 2) 派出空闲满耐久舰队
    if (doDispatch) {
      let targets = pickWrecks(snap, colors);
      if (wantRewards && wantRewards.length) {
        const before = targets.length;
        targets = targets.filter((w) => matchRewards(w, wantRewards));
        if (!targets.length) {
          lines.push(`没有符合奖励要求（${wantRewards.join(' / ')}）的货轮（原有 ${before} 条可打）`);
          res.skipped = 'no-reward-match';
        }
      }
      if (!targets.length) {
        if (!res.skipped) {
          lines.push('没有可打的货轮（目标品质的都已被占满或已消失）');
          res.skipped = 'no-target';
        }
      } else {
        const ready = readyFleets(snap, minDuraRatio);
        if (!ready.length) {
          lines.push('没有可派出的舰队（都在外面/修复中/耐久不足）');
          res.skipped = 'no-fleet';
        } else {
          const pairs = allocateWrecks(targets, ready, maxPerWreck);
          res.pairs = pairs.map((p) => ({ fleet: p.fleet.id, uid: p.wreck.uid, color: p.wreck.color }));
          for (const p of pairs) {
            const f = p.fleet;
            const w = p.wreck;
            if (dry) {
              lines.push(`[dry] ${f.id} → ${w.colorName}（uid ${w.uid} 格${w.gridIdx}）`);
              continue;
            }
            try {
              await c.requestAck('TreasureLootSendFleetsRequest', { uid: w.uid, fleetBuildingIds: [f.id] }, 10000);
              res.dispatched.push({ fleet: f.id, uid: w.uid, color: w.color, colorName: w.colorName });
              lines.push(`派出 ${f.id} → ${w.colorName}（uid ${w.uid} 格${w.gridIdx}）`);
              await new Promise((r) => setTimeout(r, 700));
            } catch (e) {
              lines.push(`派 ${f.id} 失败: ${e.message}`);
            }
          }
        }
      }
    }

    return res;
  });
}

// 把可派舰队分配到目标货轮上（纯函数，便于测试）
// 策略：优先让「一艘船去一条货轮」尽量分散；船还有剩才叠加到同一条货轮。
// 约束：每条货轮上我自己的船 ≤ maxPerWreck；连同别家总数 ≤ MAX_FLEET_PER_WRECK(同联盟上限)。
// 把可派舰队分配到目标货轮上（纯函数，便于测试）
// 策略：**按品质优先级抢占** —— 先占满万吨货轮，万吨没有/已满才退到中型，再退到小型。
// 同品质内：进度高的优先（更接近 100% 结算，收益更快兑现），其次 uid 小的优先。
// 约束：每条货轮上我自己的船 ≤ maxPerWreck；连同别家总数 ≤ MAX_FLEET_PER_WRECK(同联盟上限)。
function allocateWrecks(targets, ready, maxPerWreck) {
  if (!targets || !targets.length || !ready || !ready.length) return [];
  const rank = (w) => {
    const i = ALL_COLORS.indexOf(w.color);
    return i < 0 ? ALL_COLORS.length : i; // ALL_COLORS = [5,4,3]，index 越小品质越高
  };
  const sorted = [...targets].sort(
    (a, b) => rank(a) - rank(b) || (b.progress || 0) - (a.progress || 0) || a.uid - b.uid
  );
  const pairs = [];
  let idx = 0;
  for (const w of sorted) {
    if (idx >= ready.length) break;
    const mineNow = w.myFleets ? w.myFleets.length : 0;
    const byGuild = Math.max(0, MAX_FLEET_PER_WRECK - (w.ownerFleetNum || 0));
    const quota = Math.max(0, Math.min(maxPerWreck - mineNow, byGuild));
    for (let k = 0; k < quota && idx < ready.length; k++) {
      pairs.push({ fleet: ready[idx++], wreck: w });
    }
  }
  return pairs;
}


// ---- 排行 / 个人占用 ----
// TreasureLootRankResponse.items[] = { playerId, nickname, power, progress, estProgress, rank, guildIdx, avatar, rewardTimes }
// progress = 该玩家累计贡献的占领进度百分比；estProgress = 预计还要多久到 100%（游戏内文案用）
async function readRank(c, uid) {
  const r = await c.request('TreasureLootRankRequest', { uid }, 'TreasureLootRankResponse', 8000);
  return (r.items || [])
    .map((it) => ({
      playerId: String(it.playerId && it.playerId.toString ? it.playerId.toString() : it.playerId || ''),
      nickname: it.nickname || '',
      power: num(it.power),
      progress: it.progress || 0,
      estProgress: it.estProgress || 0,
      rank: it.rank || 0,
      guildIdx: it.guildIdx || 0,
      rewardTimes: it.rewardTimes || 0,
    }))
    .sort((a, b) => (a.rank || 999) - (b.rank || 999));
}

// 给快照补上「我在这条货轮上占多少」+ 前几名。逐条请求，失败不影响整体。
// opts: { max = 8, players = 5, mineId }
async function attachRanks(c, snap, opts = {}) {
  const { max = 8, players = 5 } = opts;
  const mineId = String(opts.mineId || '');
  // 只查有意义的：有人在占、或者我已经派了船
  const list = snap.wrecks.filter((w) => w.progress > 0 || w.mine).slice(0, max);
  for (const w of list) {
    try {
      const items = await readRank(c, w.uid);
      w.rank = items;
      w.rankCount = items.length;
      const me = mineId ? items.find((it) => it.playerId === mineId) : null;
      w.myRank = me ? me.rank : 0;
      w.myProgress = me ? me.progress : 0;
      w.top = items.slice(0, players);
      await new Promise((r) => setTimeout(r, 120));
    } catch (e) {
      w.rankError = e.message;
      if (/SESSION_YIELD|YIELD/.test(String(e.code || e.message))) break;
    }
  }
  return snap;
}

// 按奖励关键词筛目标货轮（空数组=不筛）
function matchRewards(w, want) {
  if (!want || !want.length) return true;
  const names = w.rewardNames || (w.reward || []).map((r) => String(r.id));
  return want.some((k) => names.some((n) => n.indexOf(k) >= 0));
}

// 整点自动出兵的目标：最高品质（默认万吨）里带指定奖励、且还有位置的那条
function pickTargets(snap, opts = {}) {
  const colors = opts.colors && opts.colors.length ? opts.colors : ALL_COLORS;
  // 留空 = 不限奖励（与面板文案一致）；默认推荐项只在 UI 里作为快捷胶囊展示
  const want = opts.wantRewards && opts.wantRewards.length ? opts.wantRewards : [];
  const top = colors[0];
  return snap.wrecks.filter(
    (w) => w.color === top && w.roomLeft > 0 && matchRewards(w, want)
  );
}

// 下一次整点检测的时间戳（秒）。只在 [from, to] 小时内排，跨到第二天继续。
// 例：from=8, to=22 → 8:00 到 22:00 每个整点；22:00 之后排到次日 8:00。
function nextHourlyAt(ts, from = 8, to = 22) {
  const d = new Date((ts + 1) * 1000);
  d.setSeconds(0, 0);
  d.setMinutes(0);
  d.setHours(d.getHours() + 1);
  const H = d.getHours();
  if (H < from || H > to) {
    if (H > to) d.setDate(d.getDate() + 1);
    d.setHours(from);
  }
  return Math.floor(d.getTime() / 1000);
}

// 货轮快照（给 Web 面板只读用）
async function wreckSnapshot(opts = {}) {
  return withClient(async (c) => {
    const snap = await readWreck(c);
    if (opts.ranks) {
      const pi = c.playerInfo || {};
      await attachRanks(c, snap, { mineId: String(pi.playerId || ''), max: opts.maxRanks || 8 });
    }
    return { ok: true, ...snap, colors: WRECK_CFG, maxDailyReward: MAX_DAILY_REWARD };
  });
}

module.exports = {
  withClient, readWreck, runWreckRound, wreckSnapshot, needRepair, readyFleets, pickWrecks, allocateWrecks,
  loopStop, planNextWake,
  readRank, attachRanks, matchRewards, pickTargets, nextHourlyAt, DEFAULT_WANT_REWARDS,
  FleetState, ST_NAME, COLOR_NAME, WRECK_CFG, ALL_COLORS, MAX_DAILY_REWARD, MAX_FLEET_PER_WRECK,
  num, now,
};
