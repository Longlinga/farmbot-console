# 疯狂水世界 控制台 · Linux 部署说明

一个 Node.js 单进程服务，监听一个 HTTP 端口。CPU/内存占用很低（常驻约 60–90MB），
1 核 1G 的云服务器足够。

---

## 一、最快跑起来（3 步）

```bash
# 1. 上传并解压
tar -xzf farmbot-console.tar.gz -C /opt/
cd /opt/farmbot-console

# 2. 启动（监听所有网卡，方便用公网 IP 访问）
HOST=0.0.0.0 ./start.sh          # 前台运行，Ctrl+C 停止，关掉 SSH 也会停
# 或者后台运行：
HOST=0.0.0.0 ./start.sh -d       # 后台运行，日志 logs/console.out
```

> **前台 vs 后台**
>
> - `./start.sh` 是**前台**的：占着这个终端，`Ctrl+C` 就停，**断开 SSH 也会停**。适合第一次试跑、看报错。
> - `./start.sh -d`（等同 `--daemon`）是**后台**的：进程脱离终端，关掉 SSH 不影响；日志写到 `logs/console.out`。
>   配套命令：`./start.sh status` 看状态、`./start.sh stop` 停止、`./start.sh restart` 重启。
> - **长期挂机推荐 systemd**（见第三节），比 `-d` 更可靠：开机自启、崩溃自动拉起、日志进 journal。

启动后控制台会打印一段账号密码：

```
========================================
 首次启动，已生成登录账号
   账号: admin
   密码: Is1ZEUERZa6S
========================================
```

**这串密码只打印一次**，请立刻记下来。然后浏览器打开：

```
http://你的服务器公网IP:8791
```

会自动跳到登录页，用上面的账号密码登录即可。

> 想自己指定账号密码，启动前设置环境变量：
> `FARMBOT_USER=admin FARMBOT_PASS='你的强密码' HOST=0.0.0.0 ./start.sh`
> 注意：`auth.json` 一旦生成，环境变量就不再覆盖它。要改密码就删除
> `/opt/farmbot-console/auth.json` 再重启。

---

## 二、必须做的两件事（安全）

### 1. 开放端口 / 配置防火墙

```bash
# Ubuntu (ufw)
sudo ufw allow 8791/tcp

# CentOS (firewalld)
sudo firewall-cmd --permanent --add-port=8791/tcp && sudo firewall-cmd --reload
```

同时到**云厂商控制台的「安全组」**里放行 8791 端口（这一步在网页上做，
服务器上改防火墙不管用）。

### 2. 别把 8791 裸奔在公网上（强烈建议）

这个控制台能直接操作你的游戏账号（种田、派舰队），密码泄露就等于账号被接管。
建议前面套一层 Nginx 做 HTTPS：

```nginx
server {
    listen 443 ssl http2;
    server_name farm.example.com;

    ssl_certificate     /etc/letsencrypt/live/farm.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/farm.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8791;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # SSE 实时日志必须关掉缓冲，否则日志会攒着不动
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

套了 HTTPS 之后，启动时改成这样（Cookie 只能走 HTTPS、并信任代理头）：

```bash
HOST=127.0.0.1 PORT=8791 FARMBOT_COOKIE_SECURE=1 FARMBOT_TRUST_PROXY=1 ./start.sh
```

此时服务只监听本机，外网只能经 Nginx 进来，8791 不用在安全组里开放，更安全。

---

## 三、用 systemd 常驻（服务器重启后自动拉起）

### 最省事：跑一下安装脚本

```bash
cd /opt/farmbot-console
sudo HOST=0.0.0.0 PORT=8791 ./install-service.sh
```

脚本会自动：生成 `/etc/systemd/system/farmbot-console.service`（`ExecStart` 用真实的 node 路径、
`WorkingDirectory` 用当前目录，不用手改）、`daemon-reload`、`enable` 开机自启、`restart` 拉起，
最后检查服务是否真的起来了，并告诉你去哪找首次账号密码。

装之前它会自己处理两件最常见的失败原因：

- **端口被占**：如果 8791 上还挂着之前的 `start.sh` / `nohup node server.js` / `systemd-run`，脚本能认出
  「是本程序的 node 进程」就自动停掉再继续；认不出（别人的服务）就报错退出，让你换端口，不会乱杀。
- **同名临时单元**：检测到 `systemd-run` 建的临时单元会先清理，避免抢名字。

卸载：`sudo ./uninstall-service.sh`

> **别用 `systemd-run` 起同名的临时单元。** 临时单元也叫 `farmbot-console.service`，会和这里写的常驻单元抢名字，
> 报错就是 `Unit farmbot-console.service was already loaded or has a fragment file`；而且临时单元不会自动重启，
> 网页点更新后进程退出（退出码 75）就再没人拉起，表现为「更新后打不开了」。
> 已经踩过就清理一下：`sudo systemctl stop farmbot-console; sudo systemctl reset-failed farmbot-console`，
> 再按上面重装。

### 手动安装（想自己控制细节时）

```bash
# 1. 复制服务文件
sudo cp /opt/farmbot-console/farmbot-console.service /etc/systemd/system/

# 2. 如果你把程序放在别的目录，改这两行
sudo sed -i 's#/opt/farmbot-console#/你的实际目录#g' /etc/systemd/system/farmbot-console.service

# 3. 启用
sudo systemctl daemon-reload
sudo systemctl enable --now farmbot-console

# 查看状态 / 日志
sudo systemctl status farmbot-console
sudo journalctl -u farmbot-console -f
```

**注意**：装 systemd 服务前，先确认没有别的 `./start.sh` 还在跑（端口会被占）。
`ss -lntp | grep 8791` 查一下，有的话 `./start.sh stop` 或 `Ctrl+C` 停掉。

**首次启动的账号密码在 journal 里**，用这个命令找：

```bash
sudo journalctl -u farmbot-console | grep -A3 '首次启动'
```

### 日志在哪（排查「意外停止」）

程序会把日志按天写到 `logs/server-YYYY-MM-DD.log`，保留 14 天。
**这一步很重要**——进程崩了/被杀以后，内存里那 400 条日志会随之消失，只有文件里的还在。

三种查看方式：

```bash
# 1) 直接看文件（最可靠）
tail -n 200 /opt/farmbot-console/logs/server-$(date +%F).log
tail -f /opt/farmbot-console/logs/server-$(date +%F).log     # 实时跟

# 2) 只看崩溃记录
grep '\[fatal\]' /opt/farmbot-console/logs/*.log

# 3) 控制台里点「日志」页签，或调接口
curl -b 'sid=你的cookie' 'http://127.0.0.1:8791/api/logs'
curl -b 'sid=你的cookie' 'http://127.0.0.1:8791/api/logs?date=2026-11-26&lines=500'
```

如果 **`logs/` 里连一条退出记录都没有**（没有 `[warn] 进程退出` 也没有 `[fatal]`），
说明进程是被**强杀**的（`kill -9`、内核 OOM killer），这种死法进程自己留不下任何痕迹，
只能靠 systemd 的 journal 看：

```bash
sudo journalctl -u farmbot-console -n 200 --no-pager
sudo journalctl -u farmbot-console | grep -iE 'killed|oom|signal'
dmesg | grep -i 'killed process'          # 内核 OOM 的证据
```

判断表：

| 日志里看到 | 说明 |
| --- | --- |
| `[fatal] uncaughtException: ...` + 堆栈 | 代码 bug，把堆栈发我 |
| `[fatal] unhandledRejection: ...` | 某次请求的异步错误（进程会继续跑） |
| `[warn] 收到 SIGTERM` | 正常停止（`systemctl stop`、部署脚本） |
| `[warn] 进程退出，exit code = N` | 有记录就一定能在上面找到原因行 |
| 什么都没有，日志突然断 | 被强杀/OOM/机器重启 → 查 `journalctl` 和 `dmesg` |
| 日志在重启后又从「控制台已启动」开始 | systemd 自动拉起了，看上一轮的最后几行 |

服务文件里已经配了 `Restart=always`，所以崩溃后 systemd 会自动拉起；
想保留崩溃现场就先 `sudo systemctl stop farmbot-console` 再查日志。

---

## 四、更新部署

### 方式 A：网页点一下（推荐，不用重装）

打开控制台 → **关于** 页签 → 点 **「检查更新」**：

- 显示「已是最新」就没事；
- 显示「有新版可用」→ 点 **「立即更新并重启」**。

它会从 GitHub 下载最新代码，覆盖程序文件，然后让新版本跑起来。怎么跑起来分两种情况：

| 你的启动方式 | 更新后怎么重启 |
| --- | --- |
| systemd（`install-service.sh` 装的） | 进程退出码 75，`Restart=always` 自动拉起 |
| `./start.sh` / `./start.sh -d` | 退出码 75，脚本里的循环自动拉起 |
| 裸 `node server.js` / `nohup` | **进程自己 fork 一个新进程**接着跑，不需要你管 |

启动日志里会写明走的是哪条路：`更新后由 systemd 自动拉起新版本` / `更新后由 start.sh 自动拉起新版本` /
`未检测到监管程序，更新后由进程自己重新拉起`。看到第三种就说明你是裸跑的，这也正常。

**安全性**：只覆盖程序文件（`*.js` / `web/` / 文档 / `version.json`），
绝不会动这些：

```
cfg/  game_src/  node_modules/
cred.json  buf_login.bin  auth.json  guard.json  logs/  _backup/
```

登录凭据、你的三开关设置、日志都保留。覆盖前还会把旧文件备份到
`_backup/<时间戳>/`，新版有问题可以直接拷回去。

### 方式 B：命令行

```bash
cd /opt/farmbot-console
node update.js check     # 只检查，不下载
node update.js apply     # 下载并更新，然后自己重启服务
```

`apply` 完不会自动重启（命令行模式下），需要你再 `sudo systemctl restart farmbot-console`。

### 更新后打不开 / 没有自动起来

1. 先看进程还在不在：`ps aux | grep 'node server.js'`、`ss -lntp | grep 8791`
2. 看日志里的退出原因：`tail -n 50 logs/server-$(date +%F).log`
   - `[warn] 更新完成，退出码 75，等待监管程序拉起新版本` + 后面没有新的启动记录
     → **没有任何监管程序**。说明你是裸跑的 node（这种情况新版本会自己 fork 起来，除非 fork 也失败了）。
   - 完全没有任何记录就停了 → 被外部强杀，看 `journalctl` / `dmesg | grep -i 'killed process'`
3. 手动拉起来：`cd /opt/farmbot-console && HOST=0.0.0.0 ./start.sh -d`
4. 如果之前用 `systemd-run` 起过临时单元，先清掉同名冲突：
   ```bash
   sudo systemctl stop farmbot-console
   sudo systemctl reset-failed farmbot-console
   sudo HOST=0.0.0.0 ./install-service.sh
   ```

### 方式 C：整包重装（改动了 `package.json` 依赖时才需要）

```bash
sudo systemctl stop farmbot-console
tar -xzf farmbot-console.tar.gz -C /opt/
# 注意：auth.json / cred.json / buf_login.bin / guard.json / cfg/ 不要覆盖
sudo systemctl start farmbot-console
```

> **关于 codeload 的缓存**：GitHub 的打包下载有 CDN 缓存，刚推完的几分钟内
> 可能拿到上一版。`update.js` 已经做了防护：先查远端 `version.json` 拿到期望版本，
> 下载后校验包内 `version.json`，版本对不上就换下载源重试；
> 四个源都只给旧版本时会明确报错让你过几分钟再试，不会把旧代码写回去。

---

## 五、凭据过期怎么办

游戏登录凭据（`cred.json` / `buf_login.bin`）**大约 7 天会过期**。过期后
控制台日志会连续报登录失败。

原来的做法是在 Windows 上从微信小程序进程内存里扫凭据，**Linux 服务器上做不到**
（游戏不在那台机器上跑）。所以有两种处理方式：

### 方式 A（推荐）：在 Windows 上刷新，把凭据传上去

在一台开着微信小游戏的 Windows 机器上（就是本机）执行：

```bash
cd E:\DSH\farmbot
node build_login.js          # 用 cred.json 重建登录帧
# 如果 cred.json 本身过期了，需要先从游戏进程内存重新扫一次凭据
```

然后把新的 `cred.json` 和 `buf_login.bin` 传到服务器：

```bash
scp cred.json buf_login.bin root@你的服务器:/opt/farmbot-console/
sudo systemctl restart farmbot-console
```

### 方式 B：把服务跑在有游戏的 Windows 机器上

如果不想来回传文件，也可以直接在 Windows 上跑这个服务，用内网穿透
（frp / tailscale / cloudflared）把端口暴露出去。这样凭据刷新可以在同一台机器完成。

---

## 六、常见问题

**Q: 打不开网页 / 连接超时**
- 云厂商安全组里没放行端口（最常见）
- 服务器本机防火墙没放行
- 确认启动时用的是 `HOST=0.0.0.0`（默认是 `127.0.0.1`，只有本机能访问）

**Q: 页面能开但一直是「离线」/ 日志不动**
- 反向代理没关缓冲，`proxy_buffering off;` 必须加
- 或者直接直连 IP:8791 试试，排除代理问题

**Q: 提示「端口已被占用」**
```bash
sudo ss -lptn 'sport = :8791'
# 或直接换端口
PORT=8899 HOST=0.0.0.0 ./start.sh
```

**Q: 忘记密码了**
```bash
rm /opt/farmbot-console/auth.json
sudo systemctl restart farmbot-console
sudo journalctl -u farmbot-console | grep -A3 '首次启动'
```

**Q: 想改密码（还记得原密码）**

打开控制台 → 最后一个「关于」页签 → 最下方「账号」区块 → 点「修改密码」，填原密码和两遍新密码即可。改完**其他设备上的登录会立即失效**，当前浏览器会自动换发新登录态，不用重新登录。

密码用 scrypt 加盐后存在 `auth.json`，明文不落盘。同一个区块里还有「退出登录」。

**Q: 想让某台机器免登录访问（不建议）**
```bash
FARMBOT_NO_AUTH=1 HOST=127.0.0.1 ./start.sh
```
只在确认这台机器不对外暴露时才这么用。

---

## 七、目录说明

| 文件 | 作用 |
|---|---|
| `server.js` | HTTP 服务，所有 API 与静态文件 |
| `auth.js` | 登录、会话、密码哈希（scrypt） |
| `client.js` | 游戏协议客户端（WebSocket + protobuf + lz4） |
| `farm_core.js` | 农田逻辑（收获、补种、库存上限、建筑产出） |
| `radar_core.js` | 联盟情报逻辑 |
| `wreck_core.js` | 搁浅的货轮（世界宝藏）逻辑 |
| `protoload.js` | 加载游戏自带的 1576 个 protobuf 消息定义 |
| `game_src/proto-bundle.js` | 游戏原版协议定义（1.3MB，不要改） |
| `cfg/*.json` | 用到的配置表（作物时长、VIP 库存上限、货轮规则等） |
| `web/index.html` | 控制台页面 |
| `web/login.html` | 登录页 |
| `buf_login.bin` | 登录帧（由 cred.json 生成） |
| `cred.json` | 游戏登录凭据（**保密，别提交到 git**） |
| `auth.json` | 控制台账号密码哈希（**首次启动自动生成，保密**） |
| `farmbot.js` / `radar_cli.js` / `wreck_cli.js` | 命令行版本（服务器上也能直接跑） |
