// 疯狂水世界 自动种田机器人 —— 短连接模式
//
// 设计要点：服务端同一账号只允许一个 WS 会话，长期挂在线上会把游戏客户端顶下线。
// 因此本脚本采用「短连接突发」策略：算出下一次成熟时间 -> 离线等待 -> 到点才连上
// 做一次收获/补种 -> 立刻断开。在线时间每次约 1~2 秒，每 15 分钟一次。
//
// 逻辑全部委托给 farm_core.js（与网页控制台共用同一份实现，避免两处不一致）。
//
// 用法:
//   node farmbot.js              常驻（短连接突发，推荐）
//   node farmbot.js --once       立刻跑一轮就退出
//   node farmbot.js --dry        只报告不动手
//   node farmbot.js --crop 番茄  指定作物（默认自动挑库存够的、时间最短的）
//   node farmbot.js --min 30     最短轮询间隔（秒），默认 30
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('./farm_core');

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry');
const ONCE = ARGS.includes('--once');
const HELP = ARGS.includes('--help') || ARGS.includes('-h');
const AVOID = ARGS.includes('--avoid');       // 游戏窗口开着时自动避让（默认不避让）
const NO_COLLECT = ARGS.includes('--no-collect'); // 不自动收建筑产出（种子厂/工厂/训练营）
const MIN_GAP = (() => { const i = ARGS.indexOf('--min'); return i >= 0 ? Number(ARGS[i + 1]) : 30; })();
const FORCE_CROP = (() => { const i = ARGS.indexOf('--crop'); return i >= 0 ? ARGS[i + 1] : null; })();

if (HELP) {
  const crops = core.CROP_ORDER.join(' / ');
  console.log(`
疯狂水世界 · 自动种田 CLI

用法:
  node farmbot.js [选项]

选项:
  --once            跑一轮就退出（收成熟 + 补种空地）
  --dry             演练模式：只报告要做什么，不真的收/种
  --crop <作物名>   指定作物，默认自动挑「库存够的里面周期最短的」
  --min <秒>        两轮之间最短间隔，默认 30
  --avoid           检测到游戏窗口开着就跳过本轮（避免顶号），默认不跳
  --no-collect      不自动收建筑产出（默认会收：种子厂/各类工厂/训练营）
  -h, --help        显示本帮助

可用作物:
  ${crops}

注意: 农产品有库存上限（5 × (50 + VIP「加工品存量上限」)），
      达上限后服务端会拒绝种植，脚本会自动换一种未满的作物。

示例:
  node farmbot.js --once               # 立刻收一轮
  node farmbot.js --once --dry         # 只看会做什么
  node farmbot.js --crop 番茄 --min 60 # 常驻，只种番茄，最短 60 秒一轮
  node farmbot.js                      # 常驻自动（Ctrl+C 停止）

提示: 图形界面更省事 —— node server.js 然后开 http://127.0.0.1:8791
`);
  process.exit(0);
}

const MAX_SLEEP = 1800;     // 最长睡 30 分钟就醒一次做心跳式核查
const LOGFILE = path.join(__dirname, 'farmbot.log');

// 游戏窗口是否正开着：开着说明玩家在手动玩，此时连上去会把他顶掉
function gameWindowOpen() {
  try {
    const out = execFileSync('python', [path.join(__dirname, 'gamecheck.py')], { encoding: 'utf8', timeout: 8000 });
    return out.trim() === '1';
  } catch (e) {
    return false;   // 检测失败就当没开，避免完全不工作
  }
}

const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOGFILE, line + '\n'); } catch (e) {}
}

let stats = { harvest: 0, plant: 0, rounds: 0 };

async function round() {
  stats.rounds++;
  if (AVOID && gameWindowOpen()) {
    log('检测到游戏窗口正开着（玩家在玩），本轮跳过以免顶号');
    return 600;
  }
  const r = await core.runRound({ forceCrop: FORCE_CROP, dry: DRY, doHarvest: true, doPlant: true, doCollect: !NO_COLLECT });
  for (const line of r.lines) log(line);
  stats.harvest += (r.harvested || []).length;
  stats.plant += (r.planted || []).length;
  log(`累计 收${stats.harvest} 种${stats.plant}`);
  return Math.max(MIN_GAP, Math.min(MAX_SLEEP, r.nextWake || MIN_GAP));
}

(async () => {
  if (ONCE) { await round(); return process.exit(0); }
  for (;;) {
    let wait = MIN_GAP;
    try {
      wait = await round();
    } catch (e) {
      log(`本轮异常: ${e.message}（${MIN_GAP}s 后重试）`);
      wait = MIN_GAP;
    }
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
