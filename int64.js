// int64 / uint64 数值转换工具
//
// 背景：proto-bundle 里的 int64/uint64 字段会被 protobufjs 解码成 Long 对象
// { low, high, unsigned }，其中 low / high 都是 **有符号 32 位整数**。
// 直接写 low + high * 2^32 是错的：当 low 超过 2^31 时它是负数，会把结果
// 少算 2^32。曾经真实踩过：联盟情报事件的 uid 算错 2^32，服务端回
// `no such event`，表现为「跑了两天之后舰队再也派不出去」。
//
// 正确做法：low / high 都按无符号 32 位处理。
//   >>> 0 把 -1 变成 4294967295，再乘 2^32 加 low，得到精确值。
// 注意 JS Number 的精确整数上限是 2^53，游戏里的数值（uid、金币、经验）
// 都远小于这个量级，因此用 Number 是安全的；真要超了，用 toStr() 拿字符串。

const U32 = 4294967296;

// 转成 JS Number（适合 < 2^53 的场景：uid、物品数量、经验、金币）
function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') {
    // Long 自带 toNumber()，优先用它（内部处理了 unsigned）
    if (typeof v.toNumber === 'function') {
      const n = v.toNumber();
      if (Number.isFinite(n)) return n;
    }
    // 退路：手工按无符号 32 位拼
    const hi = Number(v.high || 0) >>> 0;
    const lo = Number(v.low || 0) >>> 0;
    return hi * U32 + lo;
  }
  return Number(v);
}

// 转成字符串（超过 2^53 也不会丢精度，用于必须原样回传的 uid）
function toStr(v) {
  if (v == null) return '0';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(Math.trunc(v));
  if (typeof v === 'object') {
    if (typeof v.toString === 'function') {
      const s = v.toString();
      if (s && s !== '[object Object]') return s;
    }
    const hi = Number(v.high || 0) >>> 0;
    const lo = Number(v.low || 0) >>> 0;
    return String(hi * U32 + lo);
  }
  return String(v);
}

// 把 Number / 字符串 包成 Long（发请求时用，避免精度问题）
function toLong(v) {
  let Long;
  try { Long = require('long'); } catch (e) { return toNum(v); }
  if (v && typeof v === 'object' && typeof v.low === 'number' && typeof v.high === 'number') return v;
  const s = toStr(v);
  try { return Long.fromString(s, true); } catch (e) { return toNum(v); }
}

module.exports = { toNum, toStr, toLong, U32 };
