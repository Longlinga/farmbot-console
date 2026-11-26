// 用 cred.json 重新构造 LoginRequest 帧 → buf_login.bin
// 与「从内存里抠原始帧」相比，这不受进程/地址变化影响，只要凭据字段还能扫到。
const fs = require('fs');
const path = require('path');
const { P } = require('./protoload');

const CRED = path.join(__dirname, 'cred.json');
const OUT = path.join(__dirname, 'buf_login.bin');

// 游戏登录帧的真实字段清单（已用 P.LoginRequest / EworldClientInfo 的 encode 源码逐个核对）
function toMsg(c) {
  return {
    language: c.language || 'zh_CN',                       // #4
    eworldParams: {                                        // #6
      openId: c.openId,                                    //   #1
      token: String(c.token),                              //   #2  ← 实际是 signToken 数字串
      timestamp: Number(c.ts),                             //   #3 int64
      sign: c.sign,                                        //   #4
    },
    eworldClientInfo: {                                    // #7
      appId: c.appId || '14021170',                        //   #1
      channelId: c.channelId || '1400',                    //   #2
      deviceModule: c.deviceModule || '',                  //   #3
      clientVersion: c.clientVersion || '1.14.5.112',      //   #4
      networkType: c.networkType || 'Wifi',                //   #5
      platform: c.platform || '5',                         //   #6 wechat
      did: c.did,                                          //   #7
      sc: c.sc || '',                                      //   #8
      extc: c.extc || '',                                  //   #9
      biz: c.biz || '',                                    //   #10
      isAuth: c.isAuth !== false,                          //   #11 bool
      birthday: c.birthday || '',                          //   #12
      originVersion: c.originVersion || '',                //   #13
    },
    worldId: 0,                                            // #8 int64
    systemLanguage: c.systemLanguage || 'zh_CN',           // #9
    loginRateType: 0,                                      // #10
  };
}

function makeFrame(name, body, seq) {
  const nb = Buffer.from(name, 'ascii');
  const seqBuf = Buffer.alloc(4); seqBuf.writeInt32BE(seq, 0);
  const inner = Buffer.concat([
    Buffer.from([2]), seqBuf, Buffer.from([nb.length]), nb, Buffer.from([0]), body,
  ]);
  const head = Buffer.alloc(4); head.writeInt32BE(inner.length, 0);
  return Buffer.concat([head, inner]);
}

function build(write = true) {
  const c = JSON.parse(fs.readFileSync(CRED, 'utf8'));
  const body = P.LoginRequest.encode(toMsg(c)).finish();
  const frame = makeFrame('LoginRequest', body, 938);
  if (write) fs.writeFileSync(OUT, frame);
  return { frame, body, cred: c };
}

if (require.main === module) {
  const { frame, body, cred } = build();
  console.log(`cred: openId=${cred.openId} sign=${cred.sign} signToken=${cred.token || cred.signToken} ts=${cred.ts} did=${cred.did}`);
  console.log(`wrote ${OUT} ${frame.length} bytes (body ${body.length})`);
  const d = P.LoginRequest.decode(body);
  console.log('self-check:', JSON.stringify(d, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

module.exports = { build, makeFrame, toMsg };
