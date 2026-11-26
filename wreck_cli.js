// 搁浅的货轮（世界宝藏）命令行工具
// 用法:
//   node wreck_cli.js                  # 看当前货轮/舰队状态（只读）
//   node wreck_cli.js --once           # 跑一轮：修复不满耐久的 + 派出空闲舰队
//   node wreck_cli.js --once --dry     # 演练，只报告不动手
//   node wreck_cli.js --watch          # 常驻短连接循环（默认关闭，一般不用）
//   node wreck_cli.js --colors 5,4     # 只打万吨和中型
//   node wreck_cli.js --max 1          # 每条货轮最多派 1 艘
const W = require('./wreck_core');

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const val = (f, d) => {
  const i = ARGS.indexOf(f);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};

const HELP = `
搁浅的货轮（世界宝藏）自动抢占 —— 疯狂水世界

用法:
  node wreck_cli.js                      查看当前状态（只读）
  node wreck_cli.js --once               跑一轮：修耐久 + 按品质优先级派出
  node wreck_cli.js --once --dry         演练模式，只报告不动手
  node wreck_cli.js --watch              常驻，短连接循环（每轮在线 1~2 秒）
  node wreck_cli.js --colors 5,4         只打万吨(5)和中型(4)
  node wreck_cli.js --max 2              每条货轮最多派 2 艘

开关:
  --dry                  演练，不实际修复/派出
  --no-repair            不自动修复
  --no-dispatch          不派出
  --colors A,B           品质过滤，3=小型 4=中型 5=万吨（默认 5,4,3 全打）
  --max N                每条货轮最多派几艘（默认 3）
  --dura R               派出所需耐久比例（1=满耐久/0.8/0.6/0=不限，默认 1）
  --help, -h             显示本帮助

说明:
  · 派出顺序：先把**万吨货轮**占满（同品质优先进度高的），没万吨才退中型、再退小型
  · 万吨的奖励库才出「紫芯片宝箱」，中型/小型拿不到
  · 刷新：8:00~22:00 **每个整点**都会刷一轮，万吨也在其中（S1-S5 最多 1 个 / 征服赛季 2 个）；
    S4 的 19 点、21 点额外多刷 2 个万吨。想抢万吨就卡整点刚过时跑一次。
  · 修复消耗汽油，每点耐久 6 汽油；打守军每战 -100 耐久
  · 一条件货轮同联盟最多 10 艘，脚本按剩余名额派
  · 每人每天最多 3 次领奖（脚本不领奖，占领后由游戏结算）
`;

function printSnap(s) {
  console.log(
    `\n奖励次数 ${s.todayRewardTimes}/${s.maxDailyReward}（剩 ${s.rewardLeft}）  下批刷新 ${Math.floor(s.refreshLeft / 60)} 分后`
  );
  const byColor = { 5: 0, 4: 0, 3: 0 };
  for (const st of s.stats) byColor[st.color] = st.count;
  console.log(`货轮 万吨 ${byColor[5]} / 中型 ${byColor[4]} / 小型 ${byColor[3]}`);
  for (const w of s.wrecks) {
    const own = w.ownerGuildIdx > 0 ? `联盟${w.ownerGuildIdx}占${w.ownerFleetNum}艘` : '无人占领';
    const mine = w.myFleets.length ? ` 我${w.myFleets.length}艘` : '';
    console.log(`  ${w.colorName} #${w.uid}  进度${w.progress}%  ${own}${mine}  格${w.gridIdx}`);
  }
  console.log(`\n我的舰队:`);
  for (const f of s.fleets) {
    const tl = f.treasureLootUid ? ` 占领#${f.treasureLootUid}` : '';
    const rep = f.repairing ? ` 修复还需${Math.max(0, f.repairing.endTs - s.serverTime)}s` : '';
    console.log(`  ${f.id}  ${f.stateName}  耐久 ${f.durability}/${f.maxDura}  战力 ${f.power}${tl}${rep}`);
  }
}

async function once() {
  const dry = has('--dry');
  const colorsArg = val('--colors', '');
  const colors = colorsArg
    ? colorsArg.split(',').map((x) => Number(x.trim())).filter((n) => n > 0)
    : W.ALL_COLORS;
  const r = await W.runWreckRound({
    dry,
    colors,
    maxPerWreck: Number(val('--max', 3)),
    minDuraRatio: Number(val('--dura', 1)),
    doRepair: !has('--no-repair'),
    doDispatch: !has('--no-dispatch'),
  });
  for (const l of r.lines) console.log(l);
  return r;
}

(async () => {
  if (has('--help') || has('-h')) {
    console.log(HELP);
    return;
  }

  if (has('--watch')) {
    let round = 0;
    for (;;) {
      round++;
      console.log(`\n===== 第 ${round} 轮 ${new Date().toLocaleTimeString('zh-CN')} =====`);
      let next = 120;
      try {
        const r = await once();
        next = r.nextWake || 120;
      } catch (e) {
        console.log('本轮异常: ' + e.message);
        next = 180;
      }
      console.log(`—— 断开，${next} 秒后重连 ——`);
      await new Promise((r) => setTimeout(r, next * 1000));
    }
  }

  if (has('--once')) {
    await once();
    process.exit(0);
  }

  const s = await W.wreckSnapshot();
  printSnap(s);
  process.exit(0);
})().catch((e) => {
  console.log('失败: ' + e.message);
  process.exit(1);
});
