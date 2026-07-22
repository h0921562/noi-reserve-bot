// 日時パースの回帰テストランナー
//   node test/run.js baseline    … index.js 内の現行パーサを測る（修正前の基準値）
//   node test/run.js candidate   … datetime.js の新パーサを測る（修正後）
// baseline は index.js の内部関数を書き換えずに取り出して実行する。

const fs = require('fs');
const path = require('path');
const { NOW_JST, CASES } = require('./cases');

const ROOT = path.join(__dirname, '..');
const target = process.argv[2] || 'candidate';

// 取消文の前処理（index.js の handleCancel と同一ロジックを再現）
function baselineCancelClean(text) {
  return text
    .replace(/.*?(?:取消|キャンセル|やめたい|けし|消し|消す|消して|とりけし|とりやめ|取りやめ|取り消)\s*/, '')
    .replace(/(?:て|して|したい|お願い|ください|頼む|よろしく)\s*$/, '')
    .trim();
}

// baseline は new Date() でシステム時刻を読むため、基準時刻を固定しないと
// 実行日によって結果が変わる。Date を差し替えて NOW_JST に固定する。
function makeFakeDate(nowMs) {
  return class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(nowMs);
      else super(...args);
    }
    static now() { return nowMs; }
  };
}

function loadBaseline() {
  const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  if (!/function parseDateTime/.test(src)) {
    console.error('index.js に旧パーサ(parseDateTime)がありません。既に datetime.js へ移行済みです。');
    console.error('修正前の測定値は test/result_baseline.json に記録済み（26/53 pass）。');
    console.error('再測定するには修正前のコミットを checkout してから実行してください。');
    process.exit(2);
  }
  const stub = () => {};
  const fakeApp = { use: stub, post: stub, get: stub, listen: stub };
  function fakeRequire(n) {
    if (n === 'express') { const e = () => fakeApp; e.json = stub; return e; }
    if (n === '@line/bot-sdk') return { messagingApi: { MessagingApiClient: function () {} } };
    if (n === './reserve') return { checkAvailability: stub, makeReservation: stub, getReservations: stub, cancelReservation: stub };
    if (n === './minutes') return { handleAudioMessage: stub, handleMinutesText: stub };
    return require(n);
  }
  const nowMs = Date.parse(NOW_JST);
  const api = new Function('require', 'module', 'exports', 'Date', src + '\nreturn { parseDateTime: parseDateTime };')(
    fakeRequire, { exports: {} }, {}, makeFakeDate(nowMs)
  );
  return {
    parse: (text, isCancel) => api.parseDateTime(isCancel ? baselineCancelClean(text) : text),
    note: '現行 index.js（基準時刻を ' + NOW_JST + ' に固定・要 TZ=Asia/Tokyo）',
  };
}

function loadCandidate() {
  const dt = require(path.join(ROOT, 'datetime.js'));
  const nowMs = Date.parse(NOW_JST);
  return {
    parse: (text, isCancel) => dt.parseDateTime(isCancel ? dt.stripCancelKeyword(text) : text, nowMs),
    note: '新 datetime.js（基準時刻を ' + NOW_JST + ' に固定）',
  };
}

const impl = target === 'baseline' ? loadBaseline() : loadCandidate();

function fmt(r) {
  if (!r || !r.date) return null;
  return r.date + ' ' + r.startTime + '-' + r.endTime;
}

let pass = 0;
const failures = [];
const byTag = {};

for (const c of CASES) {
  let got;
  try {
    got = fmt(impl.parse(c.in, !!c.cancel));
  } catch (e) {
    got = 'THROW: ' + e.message;
  }
  const ok = got === c.exp;
  byTag[c.tag] = byTag[c.tag] || { pass: 0, total: 0 };
  byTag[c.tag].total++;
  if (ok) { pass++; byTag[c.tag].pass++; }
  else failures.push({ in: c.in, exp: c.exp, got, tag: c.tag });
}

console.log('target : ' + target);
console.log('impl   : ' + impl.note);
console.log('result : ' + pass + '/' + CASES.length + ' pass\n');

if (failures.length) {
  console.log('--- 失敗 ---');
  for (const f of failures) {
    console.log('[' + f.tag + '] "' + f.in + '"');
    console.log('   期待: ' + f.exp);
    console.log('   実際: ' + f.got);
  }
  console.log('');
}

console.log('--- タグ別 ---');
for (const t of Object.keys(byTag)) {
  console.log('  ' + (byTag[t].pass === byTag[t].total ? '✅' : '❌') + ' ' + t + ': ' + byTag[t].pass + '/' + byTag[t].total);
}

// 機械可読サマリ（baseline/candidate の比較用）
if (process.env.EMIT_JSON) {
  fs.writeFileSync(
    path.join(__dirname, 'result_' + target + '.json'),
    JSON.stringify({ target: target, pass: pass, total: CASES.length, failures: failures }, null, 2)
  );
}

process.exitCode = failures.length ? 1 : 0;
