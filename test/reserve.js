// reserve.js（予約サイトとの通信層）のテスト。
// これまで test/flow.js は ./reserve を丸ごとスタブで置換していたため、
// この層はテストが1行も通っていなかった。独立レビューで見つかった
// 「検証しているつもりで検証の失敗を成功に数える」欠陥はここで起きたので、
// axios を差し替えて reserve.js の実コードを動かす。

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log('  ✅ ' + label);
  else { failures++; console.log('  ❌ ' + label + (detail ? '\n       ' + detail : '')); }
}

// 予約一覧ページのHTMLを組み立てる。実物と同じく JS 変数として埋め込む
function listPage(rows) {
  return '<html><body><input name="_token" value="T">' +
    '<form id="roomDeleteForm" action="https://sd-reservsys.jp/rsr/delete"></form>' +
    '<script>const reservationList = ' + JSON.stringify(rows) + ';</script>' +
    '</body></html>';
}
// ログイン切れ等でパースできないページ（reservationList が無い）
const brokenPage = '<html><body><input name="_token" value="T">ログインしてください</body></html>';

// site: { pages: {}, onDelete, onRegist } を差し替えて挙動を作る
function loadReserve(site) {
  const src = fs.readFileSync(path.join(ROOT, 'reserve.js'), 'utf8');
  // 送信ボディを記録する。URLしか見ないスタブでは「正しい対象を選んだ上で
  // 別のIDをPOSTする」「全部屋の枠をPOSTする」といった、この層で最も避けたい
  // 事故を原理的に検出できない（変異テストで実証済み）
  site.sent = { delete: [], regist: [] };
  const fakeAxios = {
    get: async (url) => ({ headers: {}, data: site.pageFor(url, 'get') }),
    post: async (url, body) => {
      const params = new URLSearchParams(body || '');
      if (/\/rsr\/delete/.test(url)) {
        site.sent.delete.push({ rsr_id: params.get('rsr_id') });
        if (site.onDelete) site.onDelete();
      }
      if (/\/rsr\/regist\/active/.test(url)) {
        site.sent.regist.push({
          date: params.get('reservation_date'),
          slots: params.getAll('check[]'),
        });
        if (site.onRegist) site.onRegist();
      }
      return { headers: {}, data: site.pageFor(url, 'post') };
    },
  };
  function fakeRequire(n) {
    if (n === 'axios') return fakeAxios;
    return require(n);
  }
  return new Function('require', 'module', 'exports',
    src + '\nreturn module.exports;')(fakeRequire, { exports: {} }, {});
}

(async function main() {
  console.log('\n■ 取消: 正常系（対象が実際に消える）');
  {
    let rows = [{ rsr_id: 1, rsr_date: '2026-08-01', start_time: '14:00:00', end_time: '15:00:00', room_name: '6階 会議室', e_key: '1111' }];
    const site = {
      pageFor: () => listPage(rows),
      onDelete: () => { rows = []; },
    };
    const r = await loadReserve(site).cancelReservation('2026-08-01', '14:00', '6階 会議室');
    check('success を返す', r.success === true, JSON.stringify(r));
    check('削除POSTに対象の rsr_id を送っている',
      site.sent.delete.length === 1 && site.sent.delete[0].rsr_id === '1',
      JSON.stringify(site.sent.delete));
  }

  console.log('\n■ 取消: 一覧のパースに失敗したら成功を名乗らない（N3）');
  {
    let deleted = false;
    let rows = [{ rsr_id: 1, rsr_date: '2026-08-01', start_time: '14:00:00', end_time: '15:00:00', room_name: '6階 会議室', e_key: '1111' }];
    const site = {
      // 削除POSTのあとの読み直しだけがログイン切れHTMLになる
      pageFor: () => (deleted ? brokenPage : listPage(rows)),
      onDelete: () => { deleted = true; },
    };
    const r = await loadReserve(site).cancelReservation('2026-08-01', '14:00', '6階 会議室');
    check('success を名乗らない（確認できていないため）', r.success === false, JSON.stringify(r));
    check('確認できなかったと伝える', /確認できません/.test(r.error || ''), JSON.stringify(r));
  }

  console.log('\n■ 取消: サイトが拒否して対象が残っている場合');
  {
    const rows = [{ rsr_id: 1, rsr_date: '2026-08-01', start_time: '14:00:00', end_time: '15:00:00', room_name: '6階 会議室', e_key: '1111' }];
    const site = { pageFor: () => listPage(rows) }; // 削除しても消えない
    const r = await loadReserve(site).cancelReservation('2026-08-01', '14:00', '6階 会議室');
    check('success を名乗らない', r.success === false, JSON.stringify(r));
  }

  console.log('\n■ 取消: 会議室を照合する');
  {
    let rows = [
      { rsr_id: 1, rsr_date: '2026-08-01', start_time: '14:00:00', end_time: '15:00:00', room_name: '6階 会議室', e_key: '1111' },
      { rsr_id: 2, rsr_date: '2026-08-01', start_time: '14:00:00', end_time: '15:00:00', room_name: '4階 共用会議室', e_key: '2222' },
    ];
    let deletedId = null;
    const site = {
      pageFor: () => listPage(rows),
      onDelete: () => { deletedId = 2; rows = rows.filter(r => r.rsr_id !== 2); },
    };
    const r = await loadReserve(site).cancelReservation('2026-08-01', '14:00', '4階 共用会議室');
    check('4階を指定して4階が消える', r.success === true && deletedId === 2, JSON.stringify(r));
    check('削除POSTに4階側の rsr_id を送っている',
      site.sent.delete.length === 1 && site.sent.delete[0].rsr_id === '2',
      JSON.stringify(site.sent.delete));
  }

  console.log('\n■ 一覧取得: 読み取れないときは null を返す（X3の本体）');
  {
    const site = { pageFor: () => brokenPage };
    const r = await loadReserve(site).getReservations();
    check('null を返す（[] に潰さない）', r === null, JSON.stringify(r));
  }

  console.log('\n■ 一覧取得: 予約が無いときは空配列を返す');
  {
    const site = { pageFor: () => listPage([]) };
    const r = await loadReserve(site).getReservations();
    check('[] を返す（null と区別する）', Array.isArray(r) && r.length === 0, JSON.stringify(r));
  }

  console.log('\n■ 一覧取得: 正常系は整形して返す');
  {
    const rows = [{ rsr_id: 3, rsr_date: '2026-08-01', start_time: '14:00:00', end_time: '15:00:00', room_name: '6階 会議室', e_key: '7777', tenant_name: 'T', office_name: 'O' }];
    const site = { pageFor: () => listPage(rows) };
    const r = await loadReserve(site).getReservations();
    check('日時・会議室・パスワードを取り出す',
      r.length === 1 && r[0].date === '2026-08-01' && r[0].time === '14:00~15:00' &&
      r[0].room === '6階 会議室' && r[0].password === '7777',
      JSON.stringify(r));
  }

  console.log('\n■ 予約: 他室の予約を自分の成功と誤認しない（N4）');
  {
    // 一覧には 4階 14:00 しかない。6階(42) の登録はサイトが受け付けない
    const rows = [{ rsr_id: 9, rsr_date: '2026-08-01', start_time: '14:00:00', end_time: '15:00:00', room_name: '4階 共用会議室', e_key: '9999' }];
    const site = { pageFor: (url) => (/regist\/search/.test(url) ? slotPage() : listPage(rows)) };
    const r = await loadReserve(site).makeReservation('2026-08-01', '14:00', '15:00', '42');
    check('success を名乗らない', r.success === false, JSON.stringify(r));
    check('他室のパスワードを返さない', r.password !== '9999', JSON.stringify(r));
  }

  console.log('\n■ 予約: 正常系は自室のパスワードを返す');
  {
    let rows = [];
    const site = {
      pageFor: (url) => (/regist\/search/.test(url) ? slotPage() : listPage(rows)),
      onRegist: () => {
        rows = [{ rsr_id: 10, rsr_date: '2026-08-01', start_time: '14:00:00', end_time: '15:00:00', room_name: '6階 会議室', e_key: '5555' }];
      },
    };
    const r = await loadReserve(site).makeReservation('2026-08-01', '14:00', '15:00', '42');
    check('success を返す', r.success === true, JSON.stringify(r));
    check('自室のパスワードを返す', r.password === '5555', JSON.stringify(r));
    // 指定した部屋の枠だけを送っているか。全部屋を送ると両方押さえてしまう
    const slots = site.sent.regist[0] ? site.sent.regist[0].slots : [];
    check('登録POSTが6階(42)の枠だけを含む',
      slots.length === 2 && slots.every(v => v.endsWith('/42')),
      JSON.stringify(slots));
    check('登録POSTが要求した時間帯の枠だけを含む',
      slots.length === 2 && slots.includes('0/14:00/42') && slots.includes('0/14:30/42'),
      JSON.stringify(slots));
    check('要求範囲外(13:30 や 15:00 以降)の枠を含まない',
      !slots.some(v => /13:30|15:00|15:30|16:00/.test(v)),
      JSON.stringify(slots));
  }

  console.log('\n■ 取消: 削除POSTが落ちても、実際に消えていれば成功と報告する（E1の取消側）');
  {
    let rows = [{ rsr_id: 1, rsr_date: '2026-08-01', start_time: '14:00:00', end_time: '15:00:00', room_name: '6階 会議室', e_key: '1111' }];
    let posted = false;
    const site = {
      pageFor: () => listPage(rows),
      onDelete: () => { posted = true; rows = []; },
    };
    // 削除は成立するが POST の応答が返らない状況
    const mod = loadReserve(site);
    const origPost = site.onDelete;
    site.onDelete = () => { origPost(); throw new Error('socket hang up'); };
    let r, threw = false;
    try { r = await mod.cancelReservation('2026-08-01', '14:00', '6階 会議室'); }
    catch (e) { threw = true; r = { thrown: e.message }; }
    check('例外を投げない', !threw, JSON.stringify(r));
    check('実際に消えているので成功と報告する', r && r.success === true, JSON.stringify(r) + ' posted=' + posted);
  }

  console.log('\n■ 予約: 確認の読み直しが通信エラーでも例外を投げない（E1）');
  {
    let registered = false;
    const site = {
      pageFor: (url) => {
        if (/regist\/search/.test(url)) return slotPage();
        if (registered) throw new Error('socket hang up'); // 読み直しだけ落ちる
        return listPage([]);
      },
      onRegist: () => { registered = true; },
    };
    let r, threw = false;
    try { r = await loadReserve(site).makeReservation('2026-08-01', '14:00', '15:00', '42'); }
    catch (e) { threw = true; r = { thrown: e.message }; }
    check('例外を投げずに結果を返す', !threw, JSON.stringify(r));
    check('確認できなかったと伝える', r && r.success === false && /確認できません/.test(r.error || ''),
      JSON.stringify(r));
  }

  console.log('\n' + (failures ? '❌ 失敗 ' + failures + ' 件' : '✅ reserve.js 全ケース合格'));
  process.exit(failures ? 1 : 0);
})();

// 空き状況グリッドのページ（チェックボックスの value は {index}/{HH:MM}/{room_id}）
function slotPage() {
  let boxes = '';
  // 要求範囲(14:00-15:00)の外にも枠を置く。2枠しか無いと
  // 「開始以降の全枠をPOSTする」変異が要求範囲と一致して素通りする
  for (const t of ['13:30', '14:00', '14:30', '15:00', '15:30', '16:00']) {
    for (const room of ['42', '25']) {
      boxes += '<input type="checkbox" value="0/' + t + '/' + room + '">';
    }
  }
  return '<html><body><input name="_token" value="T">' + boxes + '</body></html>';
}
