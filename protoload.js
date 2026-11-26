// 用游戏自带的 proto-bundle.js（protobufjs 静态生成代码）做编解码
const fs = require('fs');
const path = require('path');
const pb = require('protobufjs/minimal');

let src = fs.readFileSync(path.join(__dirname, 'game_src', 'proto-bundle.js'), 'utf8');
src = src.replace(/,\s*$/, '');           // 去掉切分时多带的逗号

// 游戏 bundle 里的解码前导：e._(t,tg)||(t=tg.create(t))  —— e._ 就是 instanceof 判定
global.e = { _: (o, R) => o instanceof R };

const out = {};
global.System = {
  register(name, deps, fn) {
    const mod = fn((k, v) => { out[k] = v; });
    deps.forEach((d, i) => {
      if (!mod.setters[i]) return;
      if (d.includes('minimal')) mod.setters[i]({ default: pb });
      else mod.setters[i]({});
    });
    mod.execute();
  }
};
eval(src);

const P = out.protocol;
if (!P) throw new Error('protocol not exported, got: ' + Object.keys(out));
module.exports = { P, pb };
if (require.main === module) {
  const names = Object.keys(P).filter((k) => typeof P[k] === 'function');
  console.log('messages:', names.length);
  console.log(names.filter((n) => /Farm|Plant|Harvest|ResField/.test(n)).join('\n'));
}
