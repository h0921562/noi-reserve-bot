const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://sd-reservsys.jp';

// 会議室ID → 予約一覧に出る名称。登録結果の照合に使う
const ROOM_NAMES = { '42': '6階 会議室', '25': '4階 共用会議室' };
const LOGIN_ID = process.env.RESERVE_LOGIN_ID;
const LOGIN_PW = process.env.RESERVE_LOGIN_PW;

var sessionCookies = {};

function saveCookies(headers) {
  (headers['set-cookie'] || []).forEach(function(c) {
    sessionCookies[c.split('=')[0]] = c.split(';')[0];
  });
}

function getCookie() {
  return Object.values(sessionCookies).join('; ');
}

async function login() {
  sessionCookies = {};
  var r1 = await axios.get(BASE_URL + '/');
  saveCookies(r1.headers);
  var $ = cheerio.load(r1.data);
  var token = $('input[name="_token"]').val();
  var params = new URLSearchParams();
  params.append('_token', token);
  params.append('process_mode', 'login');
  params.append('user_email', LOGIN_ID);
  params.append('user_passwd', LOGIN_PW);
  var r2 = await axios.post(BASE_URL + '/login', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: getCookie() },
    maxRedirects: 0, validateStatus: function() { return true; }
  });
  saveCookies(r2.headers);
  // Follow redirect to get session established
  var r3 = await axios.get(BASE_URL + '/news', { headers: { Cookie: getCookie() } });
  saveCookies(r3.headers);
  return cheerio.load(r3.data)('input[name="_token"]').first().val();
}

async function navigateToRegist(token) {
  var params = new URLSearchParams();
  params.append('_token', token);
  var r = await axios.post(BASE_URL + '/rsr/regist', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: getCookie() }
  });
  saveCookies(r.headers);
  return cheerio.load(r.data)('input[name="_token"]').first().val();
}

async function searchAvailability(token, date) {
  var params = new URLSearchParams();
  params.append('_token', token);
  params.append('office_name', '6');
  params.append('search_date', date);
  var r = await axios.post(BASE_URL + '/rsr/regist/search', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: getCookie() }
  });
  saveCookies(r.headers);
  return r.data;
}

async function checkAvailability(date, startTime, endTime) {
  var token = await login();
  token = await navigateToRegist(token);
  var html = await searchAvailability(token, date);
  var $ = cheerio.load(html);

  var slots = [];
  $('input[type="checkbox"]').each(function() {
    var val = $(this).val() || '';
    var parts = val.split('/');
    if (parts.length === 3) {
      slots.push({
        index: parseInt(parts[0]),
        time: parts[1],
        roomId: parts[2],
        disabled: $(this).prop('disabled') || false,
        checked: $(this).prop('checked') || false,
        value: val
      });
    }
  });

  var filtered = slots.filter(function(s) { return s.time >= startTime && s.time < endTime; });
  var room6 = checkRoom(filtered, '42');
  var room4 = checkRoom(filtered, '25');

  return {
    date: date, startTime: startTime, endTime: endTime,
    rooms: [
      { name: '6\u968e \u4f1a\u8b70\u5ba4', id: '42', available: room6.available, slots: room6.slots },
      { name: '4\u968e \u5171\u7528\u4f1a\u8b70\u5ba4', id: '25', available: room4.available, slots: room4.slots }
    ]
  };
}

function checkRoom(slots, roomId) {
  var roomSlots = slots.filter(function(s) { return s.roomId === roomId; });
  var available = roomSlots.length > 0 && roomSlots.every(function(s) { return !s.disabled && !s.checked; });
  return { available: available, slots: roomSlots };
}

async function makeReservation(date, startTime, endTime, roomId) {
  var token = await login();
  token = await navigateToRegist(token);
  var html = await searchAvailability(token, date);
  var $ = cheerio.load(html);

  var selectedSlots = [];
  $('input[type="checkbox"]').each(function() {
    var val = $(this).val() || '';
    var parts = val.split('/');
    if (parts.length === 3 && parts[2] === roomId && parts[1] >= startTime && parts[1] < endTime) {
      selectedSlots.push(val);
    }
  });

  if (selectedSlots.length === 0) return { success: false, error: '\u6642\u9593\u67a0\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3067\u3057\u305f' };

  var newToken = $('input[name="_token"]').first().val();
  var params = new URLSearchParams();
  params.append('_token', newToken);
  params.append('reservation_date', date);
  params.append('reservation_office_id', '6');
  params.append('purpose_of_use', '');
  params.append('describe_title', '1');
  params.append('remarks', '');
  for (var i = 0; i < selectedSlots.length; i++) {
    params.append('check[]', selectedSlots[i]);
  }

  // POST\u304c\u843d\u3061\u3066\u3082\u767b\u9332\u304c\u6210\u7acb\u3057\u3066\u3044\u308b\u53ef\u80fd\u6027\u304c\u3042\u308b\u3002\u3053\u3053\u3067\u5931\u6557\u3092\u65ad\u5b9a\u305b\u305a\u3001
  // \u4e0b\u306e\u300c\u4e00\u89a7\u3092\u8aad\u307f\u76f4\u3057\u3066\u78ba\u8a8d\u3059\u308b\u300d\u306b\u5224\u65ad\u3092\u59d4\u306d\u308b
  var postFailed = false;
  try {
    await axios.post(BASE_URL + '/rsr/regist/active', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: getCookie() },
      validateStatus: function() { return true; }
    });
  } catch (err) {
    postFailed = true;
  }
  // \u30af\u30c3\u30ad\u30fc\u66f4\u65b0\u306f\u4ed8\u968f\u51e6\u7406\u3002\u5931\u6557\u3057\u3066\u3082\u672c\u4f53\u306e\u5224\u5b9a\u306b\u306f\u5f71\u97ff\u3055\u305b\u306a\u3044
  try {
    saveCookies((await axios.get(BASE_URL + '/rsr', { headers: { Cookie: getCookie() } })).headers);
  } catch (e) { /* noop */ }

  // \u767b\u9332POST\u306e\u7d50\u679c\u3092\u898b\u305a\u306b\u6210\u529f\u3092\u8fd4\u3059\u3068\u3001\u67a0\u304c\u57cb\u307e\u3063\u3066\u3044\u3066\u62d2\u5426\u3055\u308c\u3066\u3082
  // bot\u304c\u300c\u4e88\u7d04\u5b8c\u4e86\u300d\u3068\u65ad\u8a00\u3057\u3066\u3057\u307e\u3046\u3002\u4e00\u89a7\u306b\u5b9f\u969b\u306b\u8f09\u3063\u305f\u304b\u3092\u78ba\u8a8d\u3059\u308b\u3002
  // \u65e5\u4ed8\u3068\u958b\u59cb\u6642\u523b\u3060\u3051\u3067\u7167\u5408\u3059\u308b\u3068\u3001\u540c\u3058\u6642\u9593\u306b\u5225\u306e\u968e\u306e\u4e88\u7d04\u304c\u3042\u308b\u3068\u304d
  // \u305d\u308c\u3092\u81ea\u5206\u306e\u6210\u529f\u3068\u8aa4\u8a8d\u3057\u3001\u4ed6\u5ba4\u306e\u30d1\u30b9\u30ef\u30fc\u30c9\u3092\u8fd4\u3057\u3066\u3057\u307e\u3046
  var roomName = ROOM_NAMES[roomId];
  // 読み直しが通信エラーで落ちると、登録は成立しているのに
  // 利用者には「エラー: socket hang up」が出て成否が判別できない。
  // 確認できなかった場合と同じ扱いにする
  var after = null;
  try { after = parseReservationList(await getReservationPage()); } catch (e) { after = null; }
  if (after === null) {
    return { success: false, error: '予約結果を確認できませんでした。予約一覧でご確認ください' };
  }
  var created = after.filter(function(r) {
    return r.rsr_date === date &&
      (r.start_time || '').indexOf(startTime) === 0 &&
      (r.end_time || '').indexOf(endTime) === 0 &&
      (!roomName || r.room_name === roomName);
  });
  if (created.length === 0) {
    return {
      success: false,
      error: postFailed
        ? '\u4e88\u7d04\u30b5\u30a4\u30c8\u306b\u63a5\u7d9a\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\u3002\u4e88\u7d04\u4e00\u89a7\u3067\u3054\u78ba\u8a8d\u304f\u3060\u3055\u3044'
        : '\u4e88\u7d04\u30b5\u30a4\u30c8\u304c\u767b\u9332\u3092\u53d7\u3051\u4ed8\u3051\u307e\u305b\u3093\u3067\u3057\u305f\uff08\u67a0\u304c\u57cb\u307e\u3063\u3066\u3044\u308b\u53ef\u80fd\u6027\uff09'
    };
  }

  return { success: true, password: created[0].e_key || null };
}


async function getReservationPage() {
  var token = await login();
  var params = new URLSearchParams();
  params.append('_token', token);
  var r = await axios.post(BASE_URL + '/rsr', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: getCookie() }
  });
  saveCookies(r.headers);
  return r.data;
}

// パースできなかった場合は null、予約が無い場合は [] を返す。
// 両方を [] にすると「読めなかった」を「予約が無い＝消えた」と誤読し、
// 取消の確認が失敗を成功として数えてしまう
function parseReservationList(html) {
  var match = html.match(/const\s+reservationList\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch(e) { return null; }
}

// 一覧を読み取れなかった場合は null を返す。[] に潰すと呼び出し元が
// 「予約はありません」と断定してしまい、利用者は取り消せていないことに
// 気づけないままキャンセル期限が過ぎて課金される
async function getReservations() {
  var html = await getReservationPage();
  var list = parseReservationList(html);
  if (list === null) return null;
  return list.map(function(r) {
    return {
      rsr_id: r.rsr_id,
      password: r.e_key,
      date: r.rsr_date,
      time: (r.start_time || '').substring(0,5) + '~' + (r.end_time || '').substring(0,5),
      tenant: r.tenant_name,
      location: r.office_name,
      room: r.room_name
    };
  });
}

// roomName を渡すと会議室も照合する。日付と開始時刻だけで消すと、
// 同じ時間に複数の階が入っているとき別の階の予約を消してしまう
async function cancelReservation(date, startTime, roomName) {
  var html = await getReservationPage();
  var list = parseReservationList(html);
  if (list === null) {
    return { success: false, error: '予約一覧を読み取れませんでした。時間をおいて試してください' };
  }
  var target = null;
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (r.rsr_date !== date) continue;
    if ((r.start_time || '').indexOf(startTime) !== 0) continue;
    if (roomName && r.room_name !== roomName) continue;
    target = r;
    break;
  }
  if (!target && roomName) {
    return { success: false, error: '指定の会議室の予約が見つかりませんでした' };
  }
  if (!target) return { success: false, error: '\u8a72\u5f53\u3059\u308b\u4e88\u7d04\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3067\u3057\u305f' };

  var $ = cheerio.load(html);
  var token = $('input[name="_token"]').first().val();
  // Find the delete form
  var deleteForm = $('#roomDeleteForm');
  var action = deleteForm.attr('action') || BASE_URL + '/rsr/delete';

  var params = new URLSearchParams();
  params.append('_token', token);
  params.append('rsr_id', target.rsr_id);
  try {
    await axios.post(action, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: getCookie() },
      validateStatus: function() { return true; }
    });
  } catch (err) {
    return { success: false, error: '\u30ad\u30e3\u30f3\u30bb\u30eb\u30a8\u30e9\u30fc' };
  }

  // POST\u306e\u30ec\u30b9\u30dd\u30f3\u30b9\u3092\u898b\u305a\u306b\u6210\u529f\u3092\u8fd4\u3059\u3068\u3001\u30b5\u30a4\u30c8\u304c\u671f\u9650\u5207\u308c\u7b49\u3067\u62d2\u5426\u3057\u3066\u3082
  // bot\u304c\u300c\u53d6\u308a\u6d88\u3057\u307e\u3057\u305f\u300d\u3068\u65ad\u8a00\u3057\u3066\u3057\u307e\u3046\u3002\u4e00\u89a7\u3092\u8aad\u307f\u76f4\u3057\u3066\u5b9f\u969b\u306b\u6d88\u3048\u305f\u304b\u78ba\u8a8d\u3059\u308b\u3002
  //
  // \u305f\u3060\u3057 parseReservationList \u306f\u30d1\u30fc\u30b9\u5931\u6557\u30fb\u30ed\u30b0\u30a4\u30f3\u5207\u308c\u3067\u3082\u9ed9\u3063\u3066 [] \u3092\u8fd4\u3059\u3002
  // \u7a7a\u914d\u5217\u3092\u300c\u6d88\u3048\u305f\u300d\u3068\u8aad\u3080\u3068\u3001\u691c\u8a3c\u306e\u5931\u6557\u3092\u6210\u529f\u3068\u3057\u3066\u6570\u3048\u308b\u3053\u3068\u306b\u306a\u308b\u305f\u3081\u3001
  // \u78ba\u8a8d\u3067\u304d\u306a\u304b\u3063\u305f\u5834\u5408\u306f\u5931\u6557\u5074\u306b\u5012\u3059\uff08\u30d5\u30a7\u30a4\u30eb\u30af\u30ed\u30fc\u30ba\uff09
  // \u8aad\u307f\u76f4\u3057\u304c\u901a\u4fe1\u30a8\u30e9\u30fc\u3067\u843d\u3061\u3066\u3082\u3001\u78ba\u8a8d\u3067\u304d\u306a\u304b\u3063\u305f\u5834\u5408\u3068\u540c\u3058\u6271\u3044\u306b\u3059\u308b
  var after = null;
  try { after = parseReservationList(await getReservationPage()); } catch (e) { after = null; }
  if (after === null) {
    return { success: false, error: '\u53d6\u6d88\u7d50\u679c\u3092\u78ba\u8a8d\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\u3002\u4e88\u7d04\u4e00\u89a7\u3067\u3054\u78ba\u8a8d\u304f\u3060\u3055\u3044' };
  }
  var stillThere = after.some(function(r) { return r.rsr_id === target.rsr_id; });
  if (stillThere) {
    return { success: false, error: '\u4e88\u7d04\u30b5\u30a4\u30c8\u304c\u53d6\u6d88\u3092\u53d7\u3051\u4ed8\u3051\u307e\u305b\u3093\u3067\u3057\u305f\uff08\u671f\u9650\u5207\u308c\u306e\u53ef\u80fd\u6027\uff09' };
  }
  return { success: true };
}

module.exports = { checkAvailability, makeReservation, getReservations, cancelReservation };
