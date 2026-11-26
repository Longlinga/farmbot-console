// 联盟情报（世界 → 雷达）命令行工具
// 用法:
//   node radar_cli.js                 # 看当前情报状态（只读）
//   node radar_cli.js --once          # 跑一轮：领奖 + 派空闲舰队
//   node radar_cli.js --once --dry    # 演练，只报告不动手
//   node radar_cli.js --watch         # 常驻短连接循环
//   node radar_cli.js --types 击退海盗,打捞宝箱   # 只跑指定类型事件
//   node radar_cli.js --help
const R = require('./radar_core');

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const val = (f, d) => {
  const i = ARGS.indexOf(f);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};

const HELP = `
联盟情报自动跑 —— 疯狂水世界

用法:
  node radar_cli.js                 查看当前状态（只读，不消耗汽油）
  node radar_cli.js --once          跑一轮：领取已完成奖励 + 派空闲舰队
  node radar_cli.js --once --dry    演练模式，只报告不动手
  node radar_cli.js --watch         常驻，短连接循环（每轮在线 1~2 秒）

开关:
  --dry                 演练，不实际派舰队/领奖
  --no-claim            不领奖
  --no-dispatch         不派舰队
  --types A,B           只打这些类型的事件
  --fleet-strategies "击退海盗|打捞宝箱"   按舰队分别指定类型（用 | 分隔三艘船，空 = 不限制）
                                    例: --fleet-strategies "击退海盗|打捞宝箱,救助海兽|"
  --help, -h            显示本帮助

可打的事件类型（共 ${R.EVENT_TYPES.length} 种）:
  ${R.EVENT_TYPES.join(' / ')}

说明:
  · 每派一次消耗 ${R.PETROL_COST} 汽油（全服统一参数）
  · 服务端同一账号只允许一个连接，所以每轮都是「连上→干活→立刻断开」
  · 三个舰队由脚本自动分配，一个事件只会派一个舰队
`;

function pct(n, t) { return t ? Math.round((n / t) * 100) : 0; }

function printSnap(s) {
  const idle = s.fleets.filter((f) => f.idle);
  console.log(`\n情报等级 Lv${s.level}  经验 ${s.exp}  汽油 ${s.petrol}（每次 -${R.PETROL_COST}）`);
  const cnt = { init: 0, locked: 0, start: 0, finished: 0 };
  for (const e of s.events) {
    if (e.state === 1) cnt.init++;
    else if (e.state === 2) cnt.locked++;
    else if (e.state === 3) cnt.start++;
    else if (e.state === 4) cnt.finished++;
  }
  console.log(`事件 共${s.events.length}：可派 ${cnt.init} / 锁定 ${cnt.locked} / 进行中 ${cnt.start} / 待领奖 ${cnt.finished}`);
  console.log(`舰队 空闲 ${idle.length}/${s.fleets.length}`);
  for (const f of s.fleets) {
    const st = f.idle ? '空闲' : `状态${f.state}`;
    console.log(`  ${f.id}  ${st}  耐久 ${f.durability}/${f.maxDura}  战力 ${f.power}`);
  }
  if (s.events.length) {
    console.log('事件列表:');
    for (const e of s.events) {
      const tag = ['', '可派', '锁定', '进行中', '待领奖'][e.state] || e.state;
      const extra = e.requirements ? `  需 ${e.requirements.map((r) => `${r.id}×${r.num}`).join(' ')}` : '';
      console.log(`  [${tag}] ${e.type}(${e.color}星) ev${e.eventId} grid=${e.gridIdx || '-'}${extra}`);
    }
  }
}

async function once() {
  const dry = has('--dry');
  const types = val('--types', '');
  const stratArg = val('--fleet-strategies', '');
  let strategies = [];
  if (stratArg) {
    strategies = stratArg.split('|').map((seg) => ({
      enabled: true,
      types: seg.split(',').map((x) => x.trim()).filter(Boolean),
    }));
  }
  const r = await R.runRadarRound({
    dry,
    doClaim: !has('--no-claim'),
    doDispatch: !has('--no-dispatch'),
    allowTypes: types ? types.split(',').map((x) => x.trim()).filter(Boolean) : [],
    strategies,
  });
  for (const l of r.lines) console.log(l);
  return r;
}

(async () => {
  if (has('--help') || has('-h')) { console.log(HELP); return; }

  if (has('--watch')) {
    let round = 0;
    for (;;) {
      round++;
      console.log(`\n===== 第 ${round} 轮 ${new Date().toLocaleTimeString('zh-CN')} =====`);
      let next = 60;
      try {
        const r = await once();
        next = r.nextWake || 60;
      } catch (e) {
        console.log('本轮异常: ' + e.message);
        next = 120;
      }
      console.log(`—— 断开，${next} 秒后重连 ——`);
      await new Promise((r) => setTimeout(r, next * 1000));
    }
  }

  if (has('--once')) { await once(); process.exit(0); }

  const s = await R.radarSnapshot();
  printSnap(s);
  process.exit(0);
})().catch((e) => { console.log('失败: ' + e.message); process.exit(1); });
