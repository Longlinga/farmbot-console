// 农场核心逻辑：被 farmbot.js（CLI）和 server.js（Web 控制台）共用
// 关键原则：每次操作都是一次「短连接突发」——连上、干活、立刻断开，
// 不在线常驻，避免与玩家自己的游戏客户端争抢唯一会话。
const fs = require('fs');
const path = require('path');
const { Client } = require('./client');
const cfg = require('./cfg/FarmlandPlantCfg.json');
const gameParam = require('./cfg/GameParamCfg.json');
const vipLevelCfg = require('./cfg/VipLevelCfg.json');

const plantCfg = {};
for (const c of cfg.data) plantCfg[c.id] = c;
// 作物优先级：成熟时间短的优先（同时间内轮次更多）
const CROP_ORDER = cfg.data.slice().sort((a, b) => a.time - b.time).map((c) => c.id);

// 农产品库存上限：FarmView._maxStockNum = 5 * (产品存量初始上限 + VIP「加工品存量上限」效果)
// 超过上限后服务端会拒绝 FarmPlantRequest（PromptResponse: "item limit reached"）
const STOCK_BASE = (() => {
  const row = (gameParam.data || []).find((r) => r.paramName === '产品存量初始上限');
  return row ? Number(row.paramValue) : 50;
})();

function vipStockEffect(vipLevel) {
  const row = (vipLevelCfg.data || []).find((r) => Number(r.level) === Number(vipLevel));
  if (!row) return 0;
  const eff = (row.effects || []).find((e) => e[0] === '加工品存量上限');
  return eff ? Number(eff[1]) : 0;
}

function maxStock(vipLevel) {
  return 5 * (STOCK_BASE + vipStockEffect(vipLevel));
}

const now = () => Math.floor(Date.now() / 1000);

// 一次短连接：登录 → 执行 → 断开
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

function farmList(w) {
  return (w.building || []).filter((b) => /农田$/.test(b.buildingId));
}

async function readWater(c) {
  const w = await c.request('OnWaterRequest');
  return { farms: farmList(w), autoFarming: !!w.autoFarming, buildingCount: (w.building || []).length };
}

async function readItems(c) {
  const r = await c.request('AllItemRequest');
  const map = {};
  for (const it of r.items || []) {
    const lo = it.num && it.num.low ? Number(it.num.low) : 0;
    const hi = it.num && it.num.high ? Number(it.num.high) : 0;
    map[it.itemId] = lo + hi * 4294967296;
  }
  return map;
}

const { toNum: numOf } = require('./int64');

// 建筑产出分两类，领取协议不同：
//   工厂类（种子厂/建材厂/切鱼厂/食品厂…）：成品堆在 factory.finishedProducts
//     → GainFactoryProduceRequest{buildingId} 逐个领，回 GainFactoryProduceResponse{products}
//   手工类（训练营/精铁厂/宠物训练营…）：产在 product.asset
//     → CollectBuildingProductRequest{buildingId:[...]} 批量领，回 CollectBuildingProductResponse{reward[]}
// 注意：种子厂产的是「作物种子」，先收种子再补种，本轮就能用上新种子。
function prodList(w) {
  const factory = [];
  const manual = [];
  for (const b of w.building || []) {
    const f = b.factory;
    if (f && (f.finishedProducts || []).length) {
      factory.push({
        id: b.buildingId,
        level: b.level,
        finished: (f.finishedProducts || []).map((x) => ({ id: x.id, num: numOf(x.num) })),
        auto: f.autoProductId || '',
        queued: (f.factoryQ || []).length,
      });
    }
    const assets = (b.product && b.product.asset) || [];
    const items = assets.map((x) => ({ id: x.id, num: numOf(x.num) })).filter((x) => x.num > 0);
    if (items.length) manual.push({ id: b.buildingId, level: b.level, items });
  }
  return { factory, manual };
}

async function readProduction(c) {
  const w = await c.request('OnWaterRequest');
  return prodList(w);
}

function fmtAssets(arr) {
  if (!arr || !arr.length) return '(无)';
  // 同类物品合并计数：18 个训练营各自回一行「英雄经验」，合并后更可读
  const agg = new Map();
  for (const x of arr) agg.set(x.id, (agg.get(x.id) || 0) + x.num);
  return [...agg.entries()].map(([id, num]) => `${id}×${num}`).join(' ');
}

// 收获所有建筑产出。water 可传入本轮的 OnWaterResponse，省一次请求。
async function collectProduction(c, { dry = false, water = null } = {}) {
  const w = water || (await c.request('OnWaterRequest'));
  const { factory, manual } = prodList(w);
  const out = { factory: [], manual: [], reward: [], lines: [] };
  if (!factory.length && !manual.length) return out;

  if (dry) {
    if (manual.length) out.lines.push(`[dry] 可收集建筑产出 ${manual.length} 处: ${manual.map((x) => x.id).join(',')}`);
    if (factory.length) {
      out.lines.push(`[dry] 可收工厂成品 ${factory.length} 处: ${factory.map((x) => `${x.id}(${fmtAssets(x.finished)})`).join(' ')}`);
    }
    return out;
  }

  // 手工产出：一次批量领
  if (manual.length) {
    const ids = manual.map((x) => x.id);
    try {
      const r = await c.request('CollectBuildingProductRequest', { buildingId: ids }, 'CollectBuildingProductResponse', 15000);
      const got = [];
      for (const bp of r.reward || []) {
        for (const a of (bp.product && bp.product.asset) || []) got.push({ id: a.id, num: numOf(a.num) });
      }
      out.manual = ids;
      out.reward.push(...got);
      out.lines.push(`收集建筑产出 ${ids.length} 处 → ${fmtAssets(got)}`);
      if ((r.overflowItem || []).length) out.lines.push(`产出溢出未收: ${r.overflowItem.join(',')}`);
    } catch (e) {
      out.lines.push('收集建筑产出失败: ' + e.message);
    }
  }

  // 工厂成品：逐个领（每个工厂一个请求）
  for (const f of factory) {
    try {
      const r = await c.request('GainFactoryProduceRequest', { buildingId: f.id }, 'GainFactoryProduceResponse', 10000);
      const got = ((r.products && r.products.asset) || []).map((a) => ({ id: a.id, num: numOf(a.num) }));
      out.factory.push(f.id);
      out.reward.push(...got);
      out.lines.push(`收获工厂 ${f.id} → ${fmtAssets(got)}`);
    } catch (e) {
      out.lines.push(`收获工厂 ${f.id} 失败: ${e.message}`);
    }
  }
  return out;
}

// 选择要种的作物。
// seeds: 物品库存 map；force: 指定作物（仍受库存上限约束）
// opts.max: 农产品库存上限（超过后服务端会拒绝种植）；opts.room 需求：每块田产出 produceNum，默认 5
// 返回 { crop, reason } —— reason 用于日志说明为什么换作物
function pickCrop(seeds, force, opts = {}) {
  const max = opts.max || maxStock(opts.vipLevel || 1);
  const need = opts.needEach || 5;
  const room = (id) => max - (seeds[id] || 0);

  if (force && plantCfg[force]) {
    const seedItem = plantCfg[force].material[0];
    if ((seeds[seedItem] || 0) <= 0) return { crop: null, reason: `${seedItem} 没有库存` };
    if (room(force) < need) return { crop: null, reason: `${force} 已达库存上限（${seeds[force] || 0}/${max}）` };
    return { crop: force, reason: '' };
  }

  // 不指定作物时的挑选策略：
  //   1) 优先选「库存空间够把所有空地都种上」的作物，这样不会出现只种一半又顶到上限；
  //   2) 都能种满时，选成熟周期最短的（同样 8 块田，周期短的单位时间产量更高）；
  //   3) 都不够时，选能种最多块的。
  let skippedFull = [];
  const cands = [];
  const want = opts.farms || 0;
  for (const id of CROP_ORDER) {
    const seedItem = plantCfg[id].material[0];
    if ((seeds[seedItem] || 0) <= 0) continue;
    if (room(id) < need) { skippedFull.push(`${id}(${seeds[id] || 0}/${max})`); continue; }
    const farms = Math.floor(room(id) / need);
    cands.push({ id, farms, grow: plantCfg[id].time || 0, covers: farms >= want });
  }
  if (cands.length) {
    cands.sort((a, b) => (b.covers - a.covers) || (a.covers ? a.grow - b.grow : b.farms - a.farms));
    return { crop: cands[0].id, reason: skippedFull.length ? `跳过已满: ${skippedFull.join(' ')}` : '' };
  }
  if (skippedFull.length) return { crop: null, reason: `所有可用作物库存已满: ${skippedFull.join(' ')}（上限 ${max}）` };
  return { crop: null, reason: '没有任何可用种子' };
}

function fmtReward(r) {
  if (!r || !r.reward || !r.reward.length) return [];
  const out = new Map();
  for (const ca of r.reward) {
    const d = ca.reward || ca;
    if (!d || !d.id) continue;
    const n = d.num ? Number(d.num.low) + Number(d.num.high || 0) * 4294967296 : 1;
    out.set(d.id, (out.get(d.id) || 0) + n);
  }
  return [...out.entries()].map(([k, v]) => ({ id: k, num: v }));
}

// 只读取状态，生成给前端的快照（不含任何写操作）
async function snapshot() {
  return withClient(async (c) => {
    const t = now();
    const water = await c.request('OnWaterRequest');
    const farms = farmList(water);
    const autoFarming = !!water.autoFarming;
    const prod = prodList(water);
    let seeds = {};
    try { seeds = await readItems(c); } catch (e) {}
    return {
      ok: true,
      serverTime: t,
      player: c.playerInfo ? { id: String(c.playerInfo.playerId), level: Number(c.playerInfo.level) || null } : null,
      autoFarming,
      vipLevel: c.playerInfo && c.playerInfo.vip ? Number(c.playerInfo.vip.vipLevel) : null,
      // 农产品库存上限与各作物当前库存（超上限后服务端拒绝种植）
      maxStock: maxStock(c.playerInfo && c.playerInfo.vip ? c.playerInfo.vip.vipLevel : 1),
      crops: CROP_ORDER.map((id) => ({
        id,
        stock: seeds[id] || 0,
        seeds: seeds[plantCfg[id].material[0]] || 0,
        full: (seeds[id] || 0) >= maxStock(c.playerInfo && c.playerInfo.vip ? c.playerInfo.vip.vipLevel : 1),
      })),
      seeds: Object.entries(seeds)
        // 只保留具体作物种子，排除形如 "种子" 的总计数聚合项
        .filter(([k]) => /种子$/.test(k) && k !== '种子')
        .map(([id, num]) => ({ id, num })),
      // 建筑待收产出（工厂成品 + 手工产出），前端用来显示「待收」
      production: {
        factory: prod.factory,
        manual: prod.manual,
        total: prod.factory.length + prod.manual.length,
      },
      farms: farms.map((f) => {
        const p = f.farm || {};
        const crop = p.productId || '';
        const ripe = p.ripeTime || 0;
        return {
          id: f.buildingId,
          level: f.level,
          crop,
          ripeTime: ripe,
          plantTime: p.plantTime || 0,
          left: crop ? ripe - t : 0,
          state: !crop ? 'empty' : ripe <= t ? 'ready' : 'growing',
          // 单次产出与耗时，来自配置表
          produceNum: crop && plantCfg[crop] ? plantCfg[crop].produceNum : null,
          growSec: crop && plantCfg[crop] ? plantCfg[crop].time : null,
          // 服务器下发的实际周期（可能含加速），用于前端显示与进度环计算
          growReal: p.plantTime && ripe > p.plantTime ? ripe - p.plantTime : null,
        };
      }),
    };
  });
}

// 执行一轮：收获成熟 → 补种空地。返回结构化结果 + 人类可读日志行
async function runRound(opts = {}) {
  const { forceCrop = null, dry = false, doHarvest = true, doPlant = true, doCollect = true } = opts;
  return withClient(async (c) => {
    const lines = [];
    const t0 = now();
    // 一次 OnWaterRequest 同时拿到农田与建筑产出状态，省一次往返
    const water = await c.request('OnWaterRequest');
    const farms = farmList(water);
    const autoFarming = !!water.autoFarming;
    const result = { harvested: [], planted: [], reward: [], collected: [], skipped: null, autoFarming, nextWake: 300 };

    // 先收建筑产出（含 1 种子厂 的种子），再补种——这样刚收的种子本轮就能用上
    if (doCollect) {
      const cp = await collectProduction(c, { dry, water });
      for (const l of cp.lines) lines.push(l);
      result.collected = [...cp.manual, ...cp.factory];
      result.reward.push(...cp.reward);
    }

    if (!farms.length) {
      lines.push('没有找到农田建筑（可能不在水上场景）');
      return { ...result, lines };
    }
    if (autoFarming) {
      lines.push(`服务端官方自动种田已开启（${farms.length} 块田），脚本无需干预`);
      result.skipped = 'autoFarming';
      return { ...result, lines, nextWake: 1800 };
    }

    const ready = [], empty = [];
    for (const f of farms) {
      const p = f.farm || {};
      if (!p.productId) empty.push(f);
      else if ((p.ripeTime || 0) <= t0) ready.push(f);
    }

    if (ready.length && doHarvest) {
      const ids = ready.map((f) => f.buildingId);
      if (dry) {
        lines.push(`[dry] 可收获 ${ids.length} 块: ${ids.join(',')}`);
        empty.push(...ready);
      } else {
        try {
          const r = await c.request('FarmHarvestRequest', { buildingId: ids }, 'FarmHarvestResponse', 8000);
          result.harvested = ids;
          const rw = fmtReward(r);
          result.reward.push(...rw);
          const rs = rw.map((x) => `${x.id}×${x.num}`).join(' ') || '(无奖励)';
          lines.push(`收获 ${ids.length} 块 → ${rs}`);
          empty.push(...ready);
        } catch (e) {
          lines.push(`收获失败: ${e.message}`);
        }
      }
    } else if (ready.length) {
      lines.push(`可收获 ${ready.length} 块（已按设置跳过）`);
      empty.push(...ready);
    }

    if (empty.length && doPlant) {
      const seeds = await readItems(c);
      const vipLevel = c.playerInfo && c.playerInfo.vip ? Number(c.playerInfo.vip.vipLevel) : 1;
      const max = maxStock(vipLevel);
      const picked = pickCrop(seeds, forceCrop, { max, vipLevel, farms: empty.length });
      const crop = picked.crop;
      if (!crop) {
        lines.push(picked.reason || '没有任何可用种子，无法补种');
      } else {
        const seedItem = plantCfg[crop].material[0];
        const have = seeds[seedItem] || 0;
        const perFarm = plantCfg[crop].produceNum || 5;
        // 受「种子数量」与「农产品库存上限」双重约束
        const roomFarms = Math.floor(Math.max(0, max - (seeds[crop] || 0)) / perFarm);
        const canPlant = Math.max(0, Math.min(empty.length, have, roomFarms));
        const chosen = empty.slice(0, canPlant);
        const ids = chosen.map((f) => f.buildingId);
        if (picked.reason) lines.push(picked.reason);
        if (!chosen.length) {
          lines.push(`${crop} 无法补种：种子 ${have}、库存 ${seeds[crop] || 0}/${max}（每块产出 ${perFarm}），${empty.length} 块空地`);
        } else if (dry) {
          lines.push(`[dry] 将种 ${crop} ×${ids.length}: ${ids.join(',')}（种子 ${have}、库存 ${seeds[crop] || 0}/${max}）`);
        } else {
          // 逐块发送并确认：OkResponse 才算成功，PromptResponse 视为失败并记录原因
          const ok = [], fails = [];
          for (const b of ids) {
            try {
              await c.requestAck('FarmPlantRequest', { args: [{ buildingId: b, productId: crop }] }, 8000);
              ok.push(b);
            } catch (e) {
              fails.push(`${b}: ${e.message}`);
              break; // 同一原因（如库存满）会连锁，无需再试
            }
          }
          result.planted = ok;
          if (ok.length) lines.push(`补种 ${crop} ×${ok.length} (${seedItem} 库存 ${have})`);
          if (fails.length) lines.push(`补种失败 ${fails.length} 块 → ${fails[0]}`);
        }
      }
    }

    // 刷新一次，算下次该醒来的时间
    try {
      const t1 = now();
      const w2 = await readWater(c);
      const lefts = w2.farms.map((f) => {
        const p = f.farm || {};
        return p.productId ? (p.ripeTime || t1) - t1 : 0;
      });
      const min = lefts.length ? Math.min(...lefts) : 1800;
      result.nextWake = Math.max(30, Math.min(1800, min + 3));
      const tips = w2.farms
        .map((f) => `${f.buildingId}:${f.farm && f.farm.productId ? (f.farm.ripeTime - t1) + 's' : '空'}`)
        .join(' ');
      lines.push(`${w2.farms.length} 块田 ${tips}`);
    } catch (e) {
      lines.push('状态刷新失败: ' + e.message);
    }

    return { ...result, lines };
  });
}

module.exports = {
  withClient, readWater, readItems, pickCrop, fmtReward,
  snapshot, runRound, plantCfg, CROP_ORDER, now,
  maxStock, vipStockEffect, STOCK_BASE,
  numOf, prodList, readProduction, collectProduction, fmtAssets,
};
