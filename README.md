# 疯狂水世界 控制台

农田自动种田 + 联盟情报一键跑完 + 搁浅的货轮（世界宝藏）自动抢占。

不做图像识别、不抓包、不改游戏文件。直接读游戏进程内存拿到登录凭据，然后作为
一个独立的 WebSocket 客户端连游戏网关，用**游戏自带的 protobuf 协议**收发消息。
服务端认为这是同一个玩家正常在操作，所以种田/收获/派遣都是真实生效的。

## 一、原理（一句话版）

游戏是 Cocos + WSS 长连接，登录帧里带着 `openId / sign / signToken / ts / did`。
这五个字段以明文躺在小程序渲染进程的内存里，扫出来就能自己连上去。

## 二、快速上手

```bash
cd E:\DSH\farmbot

# 0) 网页控制台（推荐，可视化操作 + 实时日志）
node server.js
#   然后浏览器打开 http://127.0.0.1:8791
#   首次启动会打印初始账号密码（admin / 随机密码），登录后才能操作

# 1) 看一眼现在 8 块田什么状态（只读，不动手）
node farm_probe.js

# 2) 跑一轮：成熟的收掉，空地补种
node farmbot.js --once

# 3) 常驻（短连接突发模式，见下）
node farmbot.js

# 忘了参数就敲
node farmbot.js --help
```

不想碰命令行的，直接双击目录里的 **`启动控制台.bat`**，会自动起服务并打开浏览器。

### 部署到 Linux 云服务器

打包好的发行版在 `dist/farmbot-console.tar.gz`（1MB，含完整 node_modules，无需联网装依赖）。

```bash
# 服务器上
tar -xzf farmbot-console.tar.gz -C /opt/
cd /opt/farmbot-console
HOST=0.0.0.0 ./start.sh          # 首次会在控制台打印登录账号密码
```

然后浏览器打开 `http://服务器公网IP:8791`。详细说明（防火墙、Nginx HTTPS、
systemd 常驻、凭据过期处理）见包里的 `DEPLOY.md`。

常用开关：

| 参数 | 作用 |
|---|---|
| `--once` | 只跑一轮就退出 |
| `--dry` | 只报告不动手 |
| `--crop 番茄` | 指定作物，默认自动挑库存够的、成熟最快的 |
| `--min 30` | 轮询最短间隔秒数（默认 30） |
| `--avoid` | 检测到游戏窗口开着就跳过本轮（默认不跳） |
| `--no-collect` | 不自动收建筑产出（默认会收种子厂/工厂/训练营） |
| `--help` | 打印帮助 |

### 界面怎么用

打开 http://127.0.0.1:8791 后：

1. **先看底部日志**有没有「控制台已启动」和一次状态刷新 —— 说明已经连上服务端读到存档了。
2. **想先看清楚再动手**：把「演练模式」打开，点「立即执行一轮」，日志会打 `[dry] 可收获 8`，不会真的收。
3. **真要干活**：关掉演练，点「立即执行一轮」——几秒内日志出现 `收获工厂 1种子厂 → 玉米种子×2`、
   `收集建筑产出 18 处 → 英雄经验×…`、`收获 8 块 → 小麦×40`、`补种 小麦 ×8`，
   顶部「累计收获 / 累计补种 / 执行轮次」同步加数。
4. **想挂机**：点「开启自动」——顶栏变「自动运行」，出现「下次 HH:MM 后」倒计时。
   脚本自己算最近一块田的成熟时间，到点连上去收一轮就断开（短连接，不占会话）。再点一次停止。
5. **调参数**：作物下拉、最短间隔、四个开关（收获/补种/演练/避让游戏窗口），改完立即生效，不用重启。

> 游戏窗口开着时脚本连上去会把你顶掉（同账号只允许一个会话）。
> 介意就打开「避让游戏窗口」，检测到游戏开着就跳过本轮。

### 联盟情报（世界 → 雷达）面板

顶部「农田 / 联盟情报 / 搁浅的货轮」三个页签。切到**联盟情报**：

1. 第一次切过去会自动读一次实时情报（事件列表 + 3 艘舰队的当前状态）。
2. 上方统计卡：情报等级 / 经验 / 可派事件 / 待领奖 / 空闲舰队 / 下批刷新倒计时；页签右上角角标是「待领奖」数量。
3. **舰队**区显示三艘远征船的耐久条、战力、空闲/行军/战斗/修理/排队状态。
4. **事件**区按「待领奖 → 进行中 → 锁定 → 可派」排序，每个事件显示星级、类型、事件 id、
   坐标；解救难民这类会额外列出所需物资。
5. **只打这些类型**：7 个胶囊按钮（击退海盗/城战试探/收集资源/救助海兽/打捞宝箱/解救难民/占领宝藏），
   全不选 = 全打。
6. 按钮：「领奖 + 派舰队」真实执行；「只读取情报」只拉状态不动手。
7. 开关：领取奖励 / 派出舰队 / 演练。

> **情报不做常驻监测**。事件每 8 小时才刷新一批，所以只在你想收的时候点一次按钮即可，
> 每次连接也只在线 1~2 秒就断开，不占会话。统计卡里的「下批刷新」会告诉你还有多久出新的一批。

**点一次跑完全部**：按钮触发的是 `runRadarAll`，它在**一次会话内循环**——
领奖 → 派舰队 → 等事件跑完（约 32 秒一圈）→ 再领奖 → 再派下一个空闲舰队，
直到「没有待领奖 / 没有可派事件 / 舰队全在外面 / 汽油不够」才停，然后断开。
所以不需要你反复点。每次派遣消耗 **500 汽油**。

**三个舰队分开跑**：一个事件只会派一个舰队，从空闲舰队里按顺序分配。如果只想让某个舰队打特定类型，
用 CLI 的 `--fleet-strategies` 或直接调 `POST /api/radar/config` 传
`fleets: [{enabled:true, types:["击退海盗"]}, ...]`。

### 搁浅的货轮（世界宝藏）面板

游戏里叫「世界宝藏」，协议前缀 `TreasureLoot`。切到第三个页签**搁浅的货轮**：

1. **统计卡**：万吨/中型/小型各有几条 + 今日奖励次数（`2/3次`）+ 我的舰队在外几艘 + 下批刷新倒计时。
2. **我的舰队**：三条船的耐久条（`470/2470`）、战力、状态（空闲/行军/战斗/修复中/占领中），
   占了哪条货轮也会标出来；修复中的显示「还需 1:17」。
3. **货轮**区：每条显示品质、进度条、占领联盟与艘数（`联盟4 占3艘 · 我2艘`）、奖励项数。
   **鼠标悬停**（或键盘 Tab 聚焦）会弹出奖励明细卡：货物名称 + 数量逐行列出，标题带品质与当前进度，
   底部注明「进度 100% 结算 · 前 5 名有奖 · 每日上限 3 次」。弹卡会自动避开屏幕边缘。
   已满或无空位的显示「无人占领」/ 进度百分比。
4. **打哪些品质**：万吨/中型/小型三个胶囊，全不选 = 全都打。
5. 设置：战败自动修复 / 自动派出 / 演练；派出所需耐久比例（满耐久才派 / 80% / 60% / 不限）；
   每条货轮最多派几艘（1/2/3，默认 3）。
6. 按钮：「修复 + 派出」做一轮；「只读取货轮」只拉状态。

**派遣优先级是「先抢大船」**：先把**万吨货轮**占满（同一品质内优先进度高的，因为更快到 100% 结算），
万吨没有或已达名额上限才退到**中型**，再退到**小型**。万吨出「紫芯片宝箱」，只在中型/小型上打是拿不到的。

**战败自动回修再派出**：这一轮里凡是「回到驻点、耐久不满」的舰队先发 `RepairFleetRequest`
（修耐久消耗的是**汽油**，每点 6 汽油），修满后再派出去；战败回驻点后你下次点按钮，
它又会自动修复并重新派出，直到目标货轮消失。这跟游戏自带的自动逻辑一致。

> 同一条货轮最多 10 艘舰船（同联盟上限），所以脚本会按 `10 - 已占艘数` 算剩余名额。
> **刷新规则**（`TipsDescCfg` 的「世界宝藏」原文）：每天 **8:00~22:00 每个整点**都会刷新一轮货轮，
> 万吨也在其中（S1-S5 最多 1 个，征服赛季最多 2 个）；S4 赛季的 **19 点、21 点额外多刷 2 个万吨**，
> 那只是加成，不是万吨的唯一来源。想抢万吨就卡整点刚过的时候点一次。
> **不做常驻监测**——想抢的时候手动点一次。

## 三、关键设计：短连接突发

服务端同一账号只允许**一个** WS 会话。如果你自己开着游戏窗口，而脚本又长期挂着，
两边会互相顶号。

所以常驻模式的做法是：

1. 连上去 → 读 8 块田的 `ripeTime` → 算出最近一块还要多久成熟
2. **立刻断开**
3. 离线睡到那个时间点（最长睡 30 分钟起来核查一次）
4. 到点再连，收 + 种，再断开

每次在线只有 1~2 秒，每轮之间完全离线。这样即使你手动玩游戏，撞车概率也很低。
如果确实不想有任何干扰，加 `--avoid`，脚本检测到游戏窗口存在就自动让路。

## 四、文件说明

| 文件 | 作用 |
|---|---|
| `server.js` | **网页控制台后端**，起在 127.0.0.1:8791，纯 Node 无额外依赖 |
| `auth.js` | **登录鉴权**：账号密码（scrypt 加盐）、会话 Cookie、失败限速 |
| `guard.js` | **运行闸门**：三个开关（指定时段 / 立即运行 / 全局停止）+ 被顶退避，状态存 `guard.json` |
| `web/login.html` | **登录页**，挂公网时必看 |
| `启动控制台.bat` | **一键启动**：双击即起服务并打开浏览器 |
| `web/index.html` | **网页控制台前端**，单文件深色界面，SSE 实时日志 |
| `farm_core.js` | CLI 与 Web 共用的核心逻辑（快照 / 跑一轮 / 挑作物） |
| `radar_core.js` | **联盟情报核心**：读情报+舰队、规划派遣、领奖、跑一轮 |
| `radar_cli.js` | 联盟情报命令行版（`--once` / `--watch` / `--types` / `--dry`） |
| `wreck_core.js` | **搁浅的货轮核心**：读货轮+舰队、按品质优先级分配、修复、派出 |
| `wreck_cli.js` | 货轮命令行版（`--once` / `--dry` / `--colors` / `--max`） |
| `farmbot.js` | 命令行主程序，自动收获 + 补种 |
| `client.js` | 协议客户端：登录、组帧、拆帧、lz4 解压、请求/响应 |
| `protoload.js` | 把游戏自带的 `proto-bundle.js`（1576 个消息类）加载进 Node |
| `build_login.js` | 用 `cred.json` 重新生成 `buf_login.bin` |
| `update.js` | **在线更新**：从 GitHub 拉最新代码，只覆盖程序文件，校验版本、备份旧文件 |
| `version.json` | 当前版本号与更新说明，在线更新比对的就是这个文件 |
| `refresh_login.py` | 从内存重新扫凭据（token 约 7 天过期） |
| `farm_probe.js` | 只读探测：农田状态 + 种子库存 |
| `farm_step.js` | 单步调试：收一次 + 种一次 |
| `gamecheck.py` | 检测游戏窗口是否存在（给 `--avoid` 用，仅 Windows） |
| `shot.js` / `shot2.js` / `click_test.js` / `auto_test.js` | 用 CDP 给控制台截图与点击验证（开发自测用） |
| `cfg/*.json` | 从游戏配置缓存抽出的 635 张配置表 |
| `game_src/all_js.txt` | 游戏全部 JS 源码（12.6MB，逆向依据） |
| `dist/farmbot-console.tar.gz` | **Linux 部署包**，含运行必需文件 + 完整 node_modules |
| `dist/farmbot-console/DEPLOY.md` | Linux 部署说明（端口、防火墙、Nginx HTTPS、systemd） |

### 登录与公网访问

控制台默认带登录闸门：

- 首次执行 `node server.js` 会生成 `auth.json` 并在控制台打印一次初始账号密码
- 账号密码可用环境变量指定：`FARMBOT_USER` / `FARMBOT_PASS`（仅首次生成时生效）
- 会话存在内存里，Cookie 有效期：勾「记住我」7 天，否则 12 小时
- 同一 IP 连续 5 次密码错误锁定 10 分钟
- **改密码**：控制台 →「关于」页签 →「账号」区块 →「修改密码」（需填原密码）。改完其他设备的登录立即失效，当前浏览器自动换发新登录态
- **退出登录**：同一区块的「退出登录」
- 想彻底关掉登录（仅本机调试）：`FARMBOT_NO_AUTH=1 node server.js`

挂公网用 `HOST=0.0.0.0`，并且**一定要套 HTTPS 反向代理**，详见
`dist/farmbot-console/DEPLOY.md`。

### 只在你不玩的时候运行（三个开关 + 被顶退避）

同一账号在服务端只保留一个连接：新连接一登录，原来那个立刻被踢。
如果脚本 24 小时常驻，你在手机上玩的时候就会被反复顶下线。控制台顶部有一排运行控制：

| 开关 | 行为 |
| --- | --- |
| **指定时间段** | 只在设定的小时区间内运行，可跨零点（如 `22:30 → 07:30`），并可选哪几天生效 |
| **立即运行** | 不管时段，任何时候点都能跑（临时用一下） |
| **全局停止** | 全部停止，**并且连读状态的接口也拒绝**——不会偷偷连上去把你顶掉 |

除了这三个开关，还有一层自动保护：**被顶退避**。

- 连上去后 2 分钟内就被踢 → 判定为「有人正在玩」，脚本主动退让
- 退让时长逐次递增：5 分 → 15 分 → 30 分 → 1 小时 → 2 小时 → 4 小时
- 只要有一轮完整跑完没被踢，计数清零
- 退让中界面会显示剩余时间，也可以手动点「清除退避」立刻恢复

设置会存到 `guard.json`，重启后保留。默认是**全局停止**——装好后要先选一个模式才会动。

### 在线更新（不用每次全量传包）

代码放在 GitHub 仓库 `Longlinga/farmbot-console`，服务器上点一下就能更新：

**网页**：控制台 → **关于** 页签 → 「检查更新」→ 有新版就点「立即更新并重启」。

**命令行**：

```bash
cd /opt/farmbot-console
node update.js check    # 只看有没有新版
node update.js apply    # 下载并覆盖程序文件
```

更新只覆盖**程序文件**（`*.js` / `web/` / 文档 / `version.json`），
不会动 `cfg/`、`game_src/`、`node_modules/`、`cred.json`、`buf_login.bin`、
`auth.json`、`guard.json`、`logs/`。覆盖前旧文件会备份到 `_backup/<时间戳>/`。

更新完进程以退出码 **75** 退出：`systemd` 的 `Restart=always`、或 `start.sh` 里的循环，
都会自动把新版本拉起来，不用手工重启。

> 发布新版只要改 `version.json` 里的 `version`，然后推到仓库即可。
> GitHub 的打包下载有 CDN 缓存，刚推完的几分钟内可能拿到上一版；
> `update.js` 会先查远端版本号，下载后再校验包内 `version.json`，
> 对不上就换下载源重试，不会把旧代码写回去。

### 网页控制台能做什么

- 8 块田的实时状态：进度环 + 倒计时 + 作物 + 周期（周期取自服务器实际的 `ripeTime - plantTime`，含账号加速）
- **种子库存**：与农田卡同一卡片样式，显示每种种子的数量与「够种多少块田」，用完标灰、少于 20 标红
- **农产品库存**：同一卡片样式，显示每种作物当前数量 / 上限与剩余可种空间，达上限标黄（上限 = `5 × (50 + VIP「加工品存量上限」)`）
- **待收产出**：同一卡片样式，列出每个工厂/训练营/精铁厂的待收成品与数量（收获农田时自动一并收取）
- 一键「立即执行一轮」：先收建筑产出（含 1 种子厂的种子）→ 收成熟农田 → 补种空地，结果实时打到日志
- 「开启自动」：按最近一块成熟时间自动排下一轮，顶栏显示下次唤醒倒计时
- 开关：收获 / 补种 / 演练（只报告不动手）/ 避让游戏窗口
- 指定作物（13 种可选）与最短间隔（默认 30 秒）
- 建筑产出归属：工厂类（种子厂/建材厂/切鱼厂/食品厂…）用 `GainFactoryProduceRequest` 逐个领；
  训练营/精铁厂这类用 `CollectBuildingProductRequest` 批量领。`--no-collect` 可关闭。
  1 种子厂收获的种子会先入库，同轮补种立刻可用。

> **库存上限注意**：农产品有库存上限，达上限后服务端会拒绝种植（`PromptResponse: item limit reached`）。
> 脚本会自动跳到下一种未满的作物；若所有作物都满了，会在日志里明确说明原因而不是假装成功。

### 联盟情报能做什么

- 读情报等级/经验/待领奖数量，事件状态与星级，3 艘舰队的耐久/战力/空闲状态
- 「领奖 + 派舰队」：把 `state=4`（已完成）的事件用**一键全领**（`RadarGetAllRewardsRequest`）领掉，
  然后给每艘空闲舰队派一个不同的事件（`RadarSendFleetsRequest`）
- **不常驻监测**：事件每 8 小时才刷新一批，所以只在需要时点一次按钮，每次连接在线 1~2 秒就断开
- 统计卡显示「下批刷新」倒计时，知道还有多久出新的一批
- 页签角标提示还有几个奖励没领
- 事件类型过滤、领奖/派遣独立开关、演练模式
- CLI 也支持 `--watch` 常驻（如果你确实想让它自己轮），Web 面板本身不带常驻循环


## 五、协议备忘

帧格式（**长度与 seq 都是大端**）：

```
[0:4]  int32 BE  后续字节数（不含自身）
[4]    ver = 2
[5:9]  int32 BE  seq（无序号消息用 0）
[9]    nameLen
[10:..] 消息名 ASCII
[..]   压缩标志 0=无 / 1=lz4
[..]   protobuf body
```

大包体是 lz4 block 压缩：前 4 字节是解压后长度，之后是 lz4 数据。
必须用 `lz4js.decompressBlock(src, dst, 0, src.length, 0)`，不能用 `lz4.decompress()`。

用到的消息：

| 消息 | 字段 |
|---|---|
| `OnWaterRequest` | 空。响应里 `building[]` 是全部水上建筑 |
| `FarmHarvestRequest` | `#1 buildingId: string[]` |
| `FarmPlantRequest` | `#1 args: PlantArg[]`，`PlantArg{#1 buildingId, #2 productId}` |
| `AllItemRequest` | 空。响应 `items[]` 是背包 |
| `SetAutoFarmingRequest` | `#1 isOn: bool` —— 服务端官方自动种田（需 VIP6） |

农田的 `buildingId` 就是 `"5农田"` 这种「序号+建筑名」，`productId` 是作物名如 `"小麦"`。

### 写操作的确认回包（重要）

`FarmPlantRequest` / `FarmHarvestRequest` / `RadarSendFleetsRequest` 这类**没有专门 Response 类**的写操作，
成功时服务端回 `OkResponse`（空 body），失败时回 `PromptResponse`：

```
PromptResponse { #1 style int32, #2 prompt int32, #3 args string[] }
```

例如库存满时会收到 `{"style":1,"prompt":5,"args":["item limit reached"]}`
（`prompt:5` = `Prompt.BUSINESS_BLOCKING`）。

**因此不能用「发出去就算成功」的写法**——服务端拒绝时不会有任何报错帧，脚本会误以为自己种上了。
正确做法是 `client.requestAck(name, obj, timeoutMs)`：等到 `OkResponse` 才 resolve，
收到 `PromptResponse` 就 reject 并带上 `args` 里的原因。

联盟情报（世界 → 雷达）用到的消息：

| 消息 | 字段 / 说明 |
|---|---|
| `RadarInfoRequest` | 空。响应 `RadarInfoResponse{#1 radarInfo}` |
| `RadarInfo` | `#1 level #2 exp #3 storedNum #4 events[] #5 nextRefreshTime #6 fixedEvent` |
| `RadarEvent` | `#1 uid(int64) #2 eventId #3 color #4 gridIdx #5 reward #7 pirate #8 refugee #9 collectRes #10 citySpy #12 state` |
| `RadarSendFleetsRequest` | `#1 uid(int64) #2 fleetBuildingIds: string[]` —— 回 `OkResponse` |
| `RadarGetAllRewardsRequest` | 空。一键领走全部已完成事件，回 `GotRewardResponse` |
| `RadarGetRewardRequest` | `#1 uid(int64)` —— 领单个，回 `GotRewardResponse` |
| `MyFleetsRequest` | 空。响应 `#1 fleets[] WorldFleet` |

事件状态 `1=可派 2=锁定 3=进行中 4=待领奖`；舰队状态 `1=空闲 2=行军 3=战斗 4=修理 5=排队`。
空闲舰队判定（游戏源码 `WarUtil.idleTroopIds`）：`treasureLootUid==0 && state==1 && !curGridIdx && durability>0`。
每次派舰队消耗 **500 汽油**（`WorldParamCfg` 的「情报事件消耗汽油」）。
单轮实测：派出后约 32 秒事件就全部 `4=待领奖`，所以点两次按钮（一次派、一次领）即可闭环，
不需要常驻轮询——事件本身 8 小时才刷新一批。

建筑产出（工厂 / 训练营）用到的消息：

| 消息 | 字段 / 说明 |
|---|---|
| `GainFactoryProduceRequest` | `#1 buildingId` —— 收**工厂**成品（种子厂/建材厂/切鱼厂…），回 `GainFactoryProduceResponse{#1 products DisplayAssetPackage}` |
| `CollectBuildingProductRequest` | `#1 buildingId: string[]` —— 批量收**手工产**建筑（训练营/精铁厂/宠物训练营），回 `CollectBuildingProductResponse{#1 reward[] BuildingProduct #2 overflowItem[]}` |
| `BuildingProduct` | `#1 buildingId #2 product DisplayAssetPackage` |

工厂成品堆在 `building.factory.finishedProducts[]`，手工产出在 `building.product.asset[]`。
工厂库存上限是 `产品存量初始上限 + 加工品存量上限`（**不加 5 倍**，农田才是 `5×`）。

搁浅的货轮（世界宝藏）用到的消息：

| 消息 | 字段 / 说明 |
|---|---|
| `TreasureLootStatsRequest` | 空。响应 `{#1 stats[] {color,count} #2 nextRefreshTime #3 todayRewardTimes #4 totalRewardTimes}` |
| `TreasureLootListRequest` | 空。响应 `#1 treasure[] TreasureLootInstance` |
| `TreasureLootInstance` | `#1 uid #2 color #3 ownerGuildIdx #4 ownerFleetNum #5 progress #6 reward #7 gridIdx #8 battlePoint` |
| `TreasureLootSendFleetsRequest` | `#1 uid(int32) #2 fleetBuildingIds: string[]` —— 回 `OkResponse` |
| `TreasureLootDefenceRequest` | `#1 uid` —— 看防守方 `#1 fleets[]` |
| `TreasureLootRankRequest` | `#1 uid` —— 看进度排行（前 5 名有奖） |
| `RepairFleetRequest` | `#1 buildingId` —— 修耐久，回 `OkResponse` |
| `SpeedUpRepairRequest` | `#1 buildingId #2 speedUp` —— 加速修复 |

**颜色即品质**：`3=小型货轮 4=中型货轮 5=万吨货轮`（游戏 `Color` 枚举 `BLUE=3/PURPLE=4/ORANGE=5`）。
万吨货轮的奖励库 `libId 3001` 才出「紫芯片宝箱」，中型 `libId 2001` 出蓝芯片宝箱，小型 `libId 1001` 出绿芯片宝箱。

**修复即消耗汽油**：耐久材料是「汽油」，每点耐久 6 汽油，每分钟修复 400 点。
打货轮守军每战 -100 耐久，耐用性低于 1600 开始有战力惩罚。

**同联盟上限 10 艘**：一条货轮上同一联盟的舰队不超过 10 支，超出会被自动遣返，
所以剩余名额 = `10 - ownerFleetNum`（含别家）。每日领奖次数上限 3 次（`TreasureLootParamCfg` 的「每日宝藏奖励次数」）。

## 六、凭据过期怎么办

`signToken` 有有效期（约 7 天）。过期后登录会失败，重新扫内存：

```bash
python refresh_login.py     # 扫进程内存，写 cred.json
node build_login.js         # 用 cred.json 重新生成 buf_login.bin
```

前提是游戏客户端当时处于已登录状态（内存里才有新鲜凭据）。

## 七、数据来源（已核实）

- 配置表：`%APPDATA%\Tencent\xwechat\radium\users\<uid>\applet\local\wx2ea52a972ea18e5e\usr\gamecaches\config_cn\179445065092922.json`（11.3MB 明文）
- 协议定义：从游戏 JS bundle 里的 `proto-bundle.js` 直接加载，无需手写 schema
- 登录凭据：小程序渲染进程内存明文

游戏 appid `wx2ea52a972ea18e5e`，网关 `wss://dhyaoj-gate.khlgamen.com/ws`。
