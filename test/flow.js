// 会話フローのエンドツーエンドテスト。
// LINE SDK と予約サイトアクセスを差し替えて index.js の handleEvent を直接叩き、
//   (1) 取消フローの状態遷移が成立するか
//   (2) 1フローあたり reply / push を何通使うか（push だけが LINE の課金対象）
// を実測する。

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const sent = { reply: [], push: [] };
let replyTokenShouldFail = false;

// --- 予約サイトの差し替え（状態を持つフェイク） ---
const fakeSite = {
  reservations: [],
  availability: { '42': true, '25': true },
};

const reserveStub = {
  checkAvailability: async (date, s, e) => ({
    date, startTime: s, endTime: e,
    rooms: [
      { name: '6階 会議室', id: '42', available: fakeSite.availability['42'] },
      { name: '4階 共用会議室', id: '25', available: fakeSite.availability['25'] },
    ],
  }),
  makeReservation: async (date, s, e, roomId) => {
    fakeSite.reservations.push({ date, time: s + '~' + e, room: roomId === '42' ? '6階 会議室' : '4階 共用会議室' });
    return { success: true, password: '1234' };
  },
  getReservations: async () => fakeSite.reservations.slice(),
  cancelReservation: async (date, startTime) => {
    const i = fakeSite.reservations.findIndex(r => r.date === date && (r.time || '').indexOf(startTime) === 0);
    if (i < 0) return { success: false, error: '該当する予約が見つかりませんでした' };
    fakeSite.reservations.splice(i, 1);
    return { success: true };
  },
};

function loadBot() {
  const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const stub = () => {};
  const fakeApp = { use: stub, post: stub, get: stub, listen: stub };
  function fakeRequire(n) {
    if (n === 'express') { const e = () => fakeApp; e.json = stub; return e; }
    if (n === '@line/bot-sdk') {
      return {
        messagingApi: {
          MessagingApiClient: function () {
            this.replyMessage = async ({ replyToken, messages }) => {
              if (replyTokenShouldFail) throw new Error('Invalid reply token');
              sent.reply.push(messages.map(m => m.text).join('\n'));
            };
            this.pushMessage = async ({ messages }) => {
              sent.push.push(messages.map(m => m.text).join('\n'));
            };
          },
        },
      };
    }
    if (n === './reserve') return reserveStub;
    if (n === './minutes') return { handleAudioMessage: async () => {}, handleMinutesText: async () => false };
    // 相対requireは index.js のある場所を基準に解決する
    if (n.startsWith('./')) return require(path.join(ROOT, n));
    return require(n);
  }
  return new Function('require', 'module', 'exports', src + '\nreturn { handleEvent: handleEvent };')(
    fakeRequire, { exports: {} }, {}
  );
}

const bot = loadBot();

let tokenSeq = 0;
function say(text, opts) {
  opts = opts || {};
  return bot.handleEvent({
    type: 'message',
    message: { type: 'text', text: text },
    source: { type: opts.group ? 'group' : 'user', userId: 'U_test' },
    replyToken: 'RT' + (++tokenSeq),
  });
}

function reset() { sent.reply = []; sent.push = []; }
function counts() { return 'reply=' + sent.reply.length + ' push=' + sent.push.length; }

// 未来日を動的に作る（テストが日付で腐らないように）
function futureDate(daysAhead) {
  const ms = Date.now() + daysAhead * 86400000 + 9 * 3600000;
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log('  ✅ ' + label); }
  else { failures++; console.log('  ❌ ' + label + (detail ? '\n       ' + detail : '')); }
}

(async function main() {
  const f = futureDate(3);
  const md = f.m + '/' + f.d;
  const iso = f.y + '-' + String(f.m).padStart(2, '0') + '-' + String(f.d).padStart(2, '0');

  console.log('\n■ シナリオ1: 予約（提案 → OK）');
  reset(); fakeSite.reservations = [];
  await say(md + ' 14時から16時');
  const proposal = (sent.reply.concat(sent.push)).join('\n');
  check('16時までと解釈されている（旧実装は15時に丸めていた）', /14:00-16:00/.test(proposal), proposal);
  await say('OK');
  check('予約が1件入った', fakeSite.reservations.length === 1, JSON.stringify(fakeSite.reservations));
  check('正しい日付で入った', fakeSite.reservations[0] && fakeSite.reservations[0].date === iso,
    'expected ' + iso + ' got ' + (fakeSite.reservations[0] || {}).date);
  console.log('     消費: ' + counts() + '  ← push が LINE の課金対象');

  console.log('\n■ シナリオ2: 取消（日時が先に来る自然な語順）');
  reset();
  await say(md + ' 14:00をキャンセル');
  check('取消が実行された', fakeSite.reservations.length === 0,
    '残: ' + JSON.stringify(fakeSite.reservations) + ' / 応答: ' + sent.reply.concat(sent.push).join(' | '));
  console.log('     消費: ' + counts());

  console.log('\n■ シナリオ3: 取消（複数件 → 番号で選択）');
  reset();
  fakeSite.reservations = [
    { date: iso, time: '10:00~11:00', room: '6階 会議室' },
    { date: iso, time: '14:00~15:00', room: '4階 共用会議室' },
  ];
  await say('取消');
  const listMsg = sent.reply.concat(sent.push).join('\n');
  check('一覧が提示された', /1\./.test(listMsg) && /2\./.test(listMsg), listMsg);
  await say('2');
  check('2件目だけが取り消された',
    fakeSite.reservations.length === 1 && fakeSite.reservations[0].time === '10:00~11:00',
    JSON.stringify(fakeSite.reservations));
  console.log('     消費: ' + counts());

  console.log('\n■ シナリオ3b: 日時が読めず予約が1件のとき、勝手に取り消さない');
  reset();
  fakeSite.reservations = [{ date: iso, time: '10:00~11:00', room: '6階 会議室' }];
  await say('4/28をキャンセル'); // 過去日なので日時として解決できない
  check('即実行せず確認を求めた',
    fakeSite.reservations.length === 1 && /取り消しますか/.test(sent.reply.concat(sent.push).join('\n')),
    '残: ' + JSON.stringify(fakeSite.reservations) + ' / 応答: ' + sent.reply.concat(sent.push).join(' | '));
  await say('いいえ');
  check('「いいえ」で取り消されずに済む', fakeSite.reservations.length === 1, JSON.stringify(fakeSite.reservations));

  console.log('\n■ シナリオ4: 期限超過の取消は確認を挟む');
  reset();
  const near = futureDate(0);
  const nearIso = near.y + '-' + String(near.m).padStart(2, '0') + '-' + String(near.d).padStart(2, '0');
  const nowJst = new Date(Date.now() + 9 * 3600000);
  const soon = String(nowJst.getUTCHours()).padStart(2, '0') + ':00'; // 今の時刻＝2時間前を過ぎている
  fakeSite.reservations = [{ date: nearIso, time: soon + '~' + soon, room: '6階 会議室' }];
  await say(near.m + '/' + near.d + ' ' + soon + ' を取消');
  const warn = sent.reply.concat(sent.push).join('\n');
  check('即実行せず確認を求めた', /料金が発生/.test(warn) && fakeSite.reservations.length === 1, warn);
  await say('はい');
  check('「はい」で取消が実行された', fakeSite.reservations.length === 0, JSON.stringify(fakeSite.reservations));

  console.log('\n■ シナリオ5: 応答トークンが切れたときの push フォールバック');
  reset();
  fakeSite.reservations = [{ date: iso, time: '10:00~11:00', room: '6階 会議室' }];
  replyTokenShouldFail = true;
  await say(md + ' 10:00を取消');
  replyTokenShouldFail = false;
  check('reply失敗時に push で届いた', sent.push.length >= 1, counts());
  check('取消自体は成功している', fakeSite.reservations.length === 0, JSON.stringify(fakeSite.reservations));

  console.log('\n' + (failures ? '❌ 失敗 ' + failures + ' 件' : '✅ 全シナリオ合格'));
  process.exit(failures ? 1 : 0);
})();
