// 在线更新：从 GitHub 仓库拉取最新代码，只覆盖程序文件，不动配置与凭据
// 设计原则：
//   1) 只在「代码文件白名单」内更新，绝不动 cfg/、game_src/、node_modules/、cred.json、buf_login.bin、auth.json、guard.json
//   2) 覆盖前先把旧文件备份到 _backup/<时间戳>/，出问题可以手工回滚
//   3) 更新完写一个重启标记，由 start.sh / systemd 负责把进程拉起来（退出码 75 = 请重启）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

const ROOT = __dirname;
const REPO = process.env.FARMBOT_REPO || 'Longlinga/farmbot-console';
const BRANCH = process.env.FARMBOT_BRANCH || 'main';
const REQUEST_TIMEOUT = 20000;

// 允许被更新覆盖的文件（相对路径）。注意：/ 结尾表示目录（整个目录下的文件都允许）
const ALLOW = [
  'server.js', 'client.js', 'farm_core.js', 'radar_core.js', 'wreck_core.js',
  'guard.js', 'auth.js', 'protoload.js', 'update.js',
  'farmbot.js', 'radar_cli.js', 'wreck_cli.js', 'build_login.js',
  'package.json', 'package-lock.json',
  'README.md', 'DEPLOY.md', 'version.json',
  'start.sh', 'farmbot-console.service',
  'web/',
];

// 永远不覆盖的文件（防呆：即使白名单写错也拦住）
const DENY = [
  'auth.json', 'guard.json', 'cred.json', 'buf_login.bin',
  'cfg/', 'game_src/', 'node_modules/', 'logs/', '_backup/', '.git/',
];

function isAllowed(rel) {
  const p = rel.split(path.sep).join('/');
  for (const d of DENY) {
    if (d.endsWith('/') ? p.startsWith(d) || p.includes('/' + d) : p === d || p.endsWith('/' + d)) return false;
  }
  for (const a of ALLOW) {
    if (a.endsWith('/')) { if (p.startsWith(a)) return true; }
    else if (p === a) return true;
  }
  return false;
}

function readLocalVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
  } catch (e) {
    return { version: '0.0.0', notes: '' };
  }
}

function httpsGet(url, redirects = 0, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向太多次'));
    const req = https.get(url, {
      headers: Object.assign({ 'user-agent': 'farmbot-console-updater', accept: '*/*' }, extraHeaders),
      timeout: REQUEST_TIMEOUT,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(httpsGet(next, redirects + 1, extraHeaders));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
  });
}

// 查远端最新版本（不下载代码，只读 version.json）
// 走 api.github.com 而不是 raw.githubusercontent.com：前者国内一般能通，后者经常被墙
async function checkUpdate() {
  const local = readLocalVersion();
  const url = `https://api.github.com/repos/${REPO}/contents/version.json?ref=${BRANCH}&t=${Date.now()}`;
  const buf = await httpsGet(url, 0, { accept: 'application/vnd.github.raw' });
  const remote = JSON.parse(buf.toString('utf8'));
  const hasUpdate = String(remote.version) !== String(local.version);
  return {
    repo: REPO, branch: BRANCH,
    current: String(local.version), latest: String(remote.version),
    hasUpdate,
    notes: String(remote.notes || ''),
    releasedAt: remote.releasedAt || '',
  };
}

// 极简 tar 解析（ustar / pax 头都能跳过，只取普通文件）
function parseTar(buf) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    let allZero = true;
    for (let i = 0; i < 512; i++) if (h[i] !== 0) { allZero = false; break; }
    if (allZero) break;
    const rawName = h.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0[\s\S]*$/, '');
    const sizeStr = h.subarray(124, 136).toString('ascii').replace(/\0[\s\S]*$/, '').trim();
    const size = parseInt(sizeStr || '0', 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === '0' || type === '\0') {
      out.push({ name: prefix ? prefix + '/' + rawName : rawName, size, data });
    }
  }
  return out;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 执行更新：下载 → 备份 → 覆盖
async function applyUpdate(log = () => {}) {
  const before = readLocalVersion();
  // 多个下载源，按顺序尝试（codeload 和 api 在国内通常能通，github.com 常被墙）
  const sources = [
    `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}`,
    `https://api.github.com/repos/${REPO}/tarball/${BRANCH}`,
  ];
  let gz = null, lastErr = null;
  for (const tarUrl of sources) {
    try {
      log(`正在下载 ${tarUrl}`);
      gz = await httpsGet(tarUrl);
      log(`下载完成 ${(gz.length / 1024).toFixed(1)} KB`);
      break;
    } catch (e) {
      lastErr = e;
      log(`下载源失败（${e.message}），尝试下一个`);
    }
  }
  if (!gz) throw new Error('所有下载源都失败: ' + (lastErr ? lastErr.message : '未知'));
  log('开始解压');

  let tar;
  try { tar = zlib.gunzipSync(gz); }
  catch (e) { throw new Error('解压失败: ' + e.message); }

  const entries = parseTar(tar);
  log(`压缩包内 ${entries.length} 个文件`);

  // GitHub tarball 顶层目录形如 `farmbot-console-main/`，去掉第一段
  const files = [];
  for (const e of entries) {
    const seg = e.name.split('/');
    if (seg.length < 2) continue;
    const rel = seg.slice(1).join('/');
    if (!rel || rel.endsWith('/')) continue;
    if (!isAllowed(rel)) continue;
    files.push({ rel, data: e.data });
  }
  if (!files.length) throw new Error('压缩包里没有可更新的文件（检查仓库里的 version.json 与文件结构）');

  // 备份将被覆盖的旧文件
  const bkDir = path.join(ROOT, '_backup', stamp());
  const backup = [];
  for (const f of files) {
    const dst = path.join(ROOT, f.rel);
    if (fs.existsSync(dst)) {
      const bk = path.join(bkDir, f.rel);
      fs.mkdirSync(path.dirname(bk), { recursive: true });
      fs.copyFileSync(dst, bk);
      backup.push(f.rel);
    }
  }
  if (backup.length) log(`已备份 ${backup.length} 个旧文件到 _backup/${path.basename(bkDir)}/`);

  // 写入新文件
  let written = 0;
  for (const f of files) {
    const dst = path.join(ROOT, f.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, f.data);
    written++;
  }
  // start.sh 保持可执行
  try { fs.chmodSync(path.join(ROOT, 'start.sh'), 0o755); } catch (e) {}

  const after = readLocalVersion();
  log(`已更新 ${written} 个文件：${before.version} → ${after.version}`);
  return {
    ok: true,
    from: String(before.version), to: String(after.version),
    files: files.map((f) => f.rel),
    backupDir: backup.length ? path.join('_backup', path.basename(bkDir)) : '',
  };
}

// 请求进程重启：退出码 75 由 start.sh / systemd 识别
function requestRestart(delayMs = 600) {
  setTimeout(() => process.exit(75), delayMs);
}

// CLI：node update.js [check|apply]
if (require.main === module) {
  const cmd = process.argv[2] || 'check';
  const log = (m) => console.log('[update] ' + m);
  (async () => {
    if (cmd === 'check') {
      const r = await checkUpdate();
      log(`本地 ${r.current} / 远端 ${r.latest} → ${r.hasUpdate ? '有更新' : '已是最新'}`);
      if (r.notes) log('更新说明: ' + r.notes);
      process.exit(0);
    }
    if (cmd === 'apply') {
      const r = await applyUpdate(log);
      log(`完成：${r.from} → ${r.to}`);
      log('请重启服务生效：systemctl restart farmbot-console（或重跑 ./start.sh）');
      process.exit(0);
    }
    console.error('用法: node update.js [check|apply]');
    process.exit(2);
  })().catch((e) => {
    console.error('[update] 失败: ' + e.message);
    process.exit(1);
  });
}

module.exports = {
  checkUpdate, applyUpdate, requestRestart,
  readLocalVersion, parseTar, isAllowed, ROOT, REPO, BRANCH, ALLOW, DENY,
};
