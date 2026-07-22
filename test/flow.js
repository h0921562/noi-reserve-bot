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
  // 本物と同じく会議室も照合する（room を無視すると別の階を消す事故が再現できない）
  cancelReservation: async (date, startTime, room) => {
    const i = fakeSite.reservations.findIndex(r =>
      r.date === date &&
      (r.time || '').indexOf(startTime) === 0 &&
      (!room || r.room === room));
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
// 確認待ち状態は userId 単位で index.js 内に残る。シナリオ間で漏れると
// 次のシナリオの発言が前の確認への回答として食われるため、利用者を切り替える
let userSeq = 0;
let currentUser = 'U_test0';
function newUser() { currentUser = 'U_test' + (++userSeq); return currentUser; }

function say(text, opts) {
  opts = opts || {};
  return bot.handleEvent({
    type: 'message',
    message: { type: 'text', text: text },
    source: { type: opts.group ? 'group' : 'user', userId: opts.userId || currentUser },
    replyToken: 'RT' + (++tokenSeq),
  });
}

// シナリオの先頭で呼ぶ。送受信ログと、botが保持する会話状態の両方を切り離す
function reset() { sent.reply = []; sent.push = []; newUser(); }
// 同一シナリオ内で送受信ログだけ消したいとき（会話状態は維持する）
function clearLog() { sent.reply = []; sent.push = []; }
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
  await say('はい'); // 取消は必ず確認を挟む
  check('確認のうえ取消が実行された', fakeSite.reservations.length === 0,
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
  await say('はい');
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

  console.log('\n■ シナリオ6: 実際の会話の再生（2026-07-22 のトーク）');
  // 実機で起きたやりとり:
  //   「4/28 16-17 キャンセル」→ 日時が消えて一覧提示
  //   「4/28 16〜17」        → 取消のつもりが新規予約の提案になった
  reset();
  fakeSite.reservations = [
    { date: '2026-07-10', time: '14:00~15:00', room: '6階 会議室' },
    { date: '2027-04-28', time: '16:00~17:00', room: '6階 会議室' },
  ];
  await say('4/28 16-17 キャンセル');
  const r6 = sent.reply.concat(sent.push).join('\n');
  check('日時を保持して対象を特定した（一覧提示に落ちない）',
    !/どの予約を取り消しますか/.test(r6), r6);
  await say('はい');
  check('2027-04-28 の予約だけが取り消された',
    fakeSite.reservations.length === 1 && fakeSite.reservations[0].date === '2026-07-10',
    '残: ' + JSON.stringify(fakeSite.reservations) + ' / 応答: ' + r6);
  check('新規予約の提案になっていない', !/予約しますか/.test(r6), r6);

  console.log('\n■ シナリオ6c: 遠い日付は年の取り違えを警告する');
  reset(); fakeSite.reservations = [];
  await say('4/28 16-17'); // 過ぎた月日 → 翌年と解釈される
  const warnMsg = sent.reply.concat(sent.push).join('\n');
  check('翌年として解釈したことを警告した', /年が正しいか確認/.test(warnMsg), warnMsg);
  check('確認前なので予約は入っていない', fakeSite.reservations.length === 0);
  reset();
  await say('いいえ');

  console.log('\n■ シナリオ6b: 一覧提示になった場合でも番号で選べる');
  reset();
  fakeSite.reservations = [
    { date: '2026-07-10', time: '14:00~15:00', room: '6階 会議室' },
    { date: '2027-04-28', time: '16:00~17:00', room: '6階 会議室' },
  ];
  await say('キャンセルしたい'); // 日時なし
  check('一覧が提示された', /どの予約を取り消しますか/.test(sent.reply.concat(sent.push).join('\n')));
  await say('2');
  await say('はい');
  check('番号選択で2件目が取り消された',
    fakeSite.reservations.length === 1 && fakeSite.reservations[0].date === '2026-07-10',
    JSON.stringify(fakeSite.reservations));

  console.log('\n■ シナリオ6d: 実機の再現（「4/28をキャンセル」→「2」）9:29のトーク');
  reset();
  fakeSite.reservations = [
    { date: '2026-07-28', time: '16:00~17:00', room: '6階 会議室' },
    { date: '2027-04-28', time: '16:00~17:00', room: '6階 会議室' },
  ];
  await say('4/28をキャンセル'); // 時刻がないので日時としては確定できない
  check('一覧が提示された', /どの予約を取り消しますか/.test(sent.reply.concat(sent.push).join('\n')),
    sent.reply.concat(sent.push).join(' | '));
  clearLog();
  await say('2');
  const r6d = sent.reply.concat(sent.push).join('\n');
  await say('はい');
  check('「2」が日時として解釈されない（旧実装はここで「日時を認識できませんでした」）',
    !/日時を認識できませんでした/.test(r6d), r6d);
  check('2件目(2027-04-28)だけが取り消された',
    fakeSite.reservations.length === 1 && fakeSite.reservations[0].date === '2026-07-28',
    JSON.stringify(fakeSite.reservations));

  console.log('\n■ シナリオ6e: 取消語の口語変化形（実機 10:52 で取りこぼした）');
  reset();
  fakeSite.reservations = [
    { date: '2026-07-28', time: '16:00~17:00', room: '6階 会議室' },
    { date: '2027-04-28', time: '16:00~17:00', room: '6階 会議室' },
  ];
  await say('4/28をキャンセる');
  const r6e = sent.reply.concat(sent.push).join('\n');
  check('取消として扱われる（新規予約の日時エラーにならない）',
    !/日時を認識できませんでした/.test(r6e), r6e);
  check('取消の対象選択に進んだ', /取り消しますか/.test(r6e), r6e);

  // ---- 独立レビュー(critic)が実際に再現した取消経路の欠陥 ----
  const far = futureDate(5);
  const farIso = far.y + '-' + String(far.m).padStart(2, '0') + '-' + String(far.d).padStart(2, '0');

  console.log('\n■ シナリオ7: 番号選択でも期限チェックを飛ばさない');
  reset();
  {
    const n2 = futureDate(0);
    const n2Iso = n2.y + '-' + String(n2.m).padStart(2, '0') + '-' + String(n2.d).padStart(2, '0');
    const nowJst2 = new Date(Date.now() + 9 * 3600000);
    const soon2 = String(nowJst2.getUTCHours()).padStart(2, '0') + ':00'; // 期限(2時間前)を過ぎている
    fakeSite.reservations = [
      { date: n2Iso, time: soon2 + '~' + soon2, room: '6階 会議室' },
      { date: farIso, time: '10:00~11:00', room: '6階 会議室' },
    ];
    await say('キャンセルしたい');
    clearLog();
    await say('1'); // 期限超過の予約を番号で選ぶ
    const r7 = sent.reply.concat(sent.push).join('\n');
    check('番号選択でも料金警告が出る', /料金が発生/.test(r7), r7);
    check('確認前に実行されない', fakeSite.reservations.length === 2,
      JSON.stringify(fakeSite.reservations));
  }

  console.log('\n■ シナリオ8: 番号選択待ちに時刻で答えても番号扱いしない');
  reset();
  fakeSite.reservations = [
    { date: farIso, time: '10:00~11:00', room: '6階 会議室' },
    { date: farIso, time: '13:00~14:00', room: '6階 会議室' },
  ];
  await say('キャンセルしたい');
  clearLog();
  await say('1時のやつ'); // 「1」を番号と解釈すると 10:00 の予約が消える
  check('10:00の予約が消えていない', fakeSite.reservations.length === 2,
    JSON.stringify(fakeSite.reservations));
  check('番号を送り直すよう促す', /番号だけを送って/.test(sent.reply.concat(sent.push).join('\n')),
    sent.reply.concat(sent.push).join(' | '));
  await say('いいえ');

  console.log('\n■ シナリオ9: 業務語「消し込み」を取消と誤判定しない');
  reset();
  fakeSite.reservations = [{ date: farIso, time: '14:00~16:00', room: '6階 会議室' }];
  await say(far.m + '/' + far.d + ' 14時から16時 議事録の消し込みの件');
  check('既存予約が消えていない', fakeSite.reservations.length === 1,
    JSON.stringify(fakeSite.reservations));
  check('取消完了を名乗っていない', !/取り消しました/.test(sent.reply.concat(sent.push).join('\n')),
    sent.reply.concat(sent.push).join(' | '));

  console.log('\n■ シナリオ10: 取消が会議室を取り違えない');
  reset();
  fakeSite.reservations = [
    { date: farIso, time: '14:00~15:00', room: '6階 会議室' },
    { date: farIso, time: '14:00~15:00', room: '4階 共用会議室' },
  ];
  await say(far.m + '/' + far.d + ' 14時の4階を取消');
  const r10 = sent.reply.concat(sent.push).join('\n');
  check('確認文に会議室名が入っている', /4階/.test(r10), r10);
  await say('はい');
  check('6階ではなく4階が消えた',
    fakeSite.reservations.length === 1 && fakeSite.reservations[0].room === '6階 会議室',
    JSON.stringify(fakeSite.reservations));

  console.log('\n■ シナリオ11: 「空き」の結果が届く');
  reset();
  fakeSite.reservations = [];
  await say('空き ' + far.m + '/' + far.d + ' 14時から16時');
  const r11 = sent.reply.concat(sent.push).join('\n');
  check('空き状況が実際に届く', /空き|埋まり/.test(r11), r11 || '(何も届かなかった)');

  console.log('\n■ シナリオ12: 予約確認待ち中の無関係な発言で提案を破棄しない');
  reset();
  fakeSite.reservations = [];
  await say(far.m + '/' + far.d + ' 14時から16時');
  clearLog();
  await say('消しゴム買ってきて');
  check('「キャンセルしました」と返さない',
    !/キャンセルしました/.test(sent.reply.concat(sent.push).join('\n')),
    sent.reply.concat(sent.push).join(' | '));

  console.log('\n■ シナリオ5: 応答トークンが切れたときの push フォールバック');
  reset();
  fakeSite.reservations = [{ date: iso, time: '10:00~11:00', room: '6階 会議室' }];
  replyTokenShouldFail = true;
  await say(md + ' 10:00を取消');
  replyTokenShouldFail = false;
  check('reply失敗時に push で届いた', sent.push.length >= 1, counts());
  await say('はい');
  check('取消自体は成功している', fakeSite.reservations.length === 0, JSON.stringify(fakeSite.reservations));

  console.log('\n' + (failures ? '❌ 失敗 ' + failures + ' 件' : '✅ 全シナリオ合格'));
  process.exit(failures ? 1 : 0);
})();
