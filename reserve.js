const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://sd-reservsys.jp';
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

  try {
    await axios.post(BASE_URL + '/rsr/regist/active', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: getCookie() },
      validateStatus: function() { return true; }
    });
    saveCookies((await axios.get(BASE_URL + '/rsr', { headers: { Cookie: getCookie() } })).headers);
  } catch (err) {
    return { success: false, error: '\u767b\u9332\u30a8\u30e9\u30fc' };
  }

  // \u767b\u9332POST\u306e\u7d50\u679c\u3092\u898b\u305a\u306b\u6210\u529f\u3092\u8fd4\u3059\u3068\u3001\u67a0\u304c\u57cb\u307e\u3063\u3066\u3044\u3066\u62d2\u5426\u3055\u308c\u3066\u3082
  // bot\u304c\u300c\u4e88\u7d04\u5b8c\u4e86\u300d\u3068\u65ad\u8a00\u3057\u3066\u3057\u307e\u3046\u3002\u4e00\u89a7\u306b\u5b9f\u969b\u306b\u8f09\u3063\u305f\u304b\u3092\u78ba\u8a8d\u3059\u308b
  var after = parseReservationList(await getReservationPage());
  var created = after.some(function(r) {
    return r.rsr_date === date && (r.start_time || '').indexOf(startTime) === 0;
  });
  if (!created) {
    return { success: false, error: '\u4e88\u7d04\u30b5\u30a4\u30c8\u304c\u767b\u9332\u3092\u53d7\u3051\u4ed8\u3051\u307e\u305b\u3093\u3067\u3057\u305f\uff08\u67a0\u304c\u57cb\u307e\u3063\u3066\u3044\u308b\u53ef\u80fd\u6027\uff09' };
  }

  var password = await getLatestPassword(date, startTime);
  return { success: true, password: password };
}

async function getLatestPassword(date, startTime) {
  var r = await axios.get(BASE_URL + '/rsr', { headers: { Cookie: getCookie() } });
  var $ = cheerio.load(r.data);
  var password = null;
  $('table tbody tr').each(function() {
    var cells = $(this).find('td');
    if (cells.length >= 6) {
      var pw = $(cells[0]).text().trim();
      var dateText = $(cells[1]).text().trim();
      var timeText = $(cells[2]).text().trim();
      if (dateText.indexOf(date) >= 0 && timeText.indexOf(startTime) >= 0) password = pw;
    }
  });
  return password;
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

function parseReservationList(html) {
  var match = html.match(/const\s+reservationList\s*=\s*(\[[\s\S]*?\]);/);
  if (match) {
    try { return JSON.parse(match[1]); } catch(e) {}
  }
  return [];
}

async function getReservations() {
  var html = await getReservationPage();
  var list = parseReservationList(html);
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
  // bot\u304c\u300c\u53d6\u308a\u6d88\u3057\u307e\u3057\u305f\u300d\u3068\u65ad\u8a00\u3057\u3066\u3057\u307e\u3046\u3002\u4e00\u89a7\u3092\u8aad\u307f\u76f4\u3057\u3066\u5b9f\u969b\u306b\u6d88\u3048\u305f\u304b\u78ba\u8a8d\u3059\u308b
  var after = parseReservationList(await getReservationPage());
  var stillThere = after.some(function(r) { return r.rsr_id === target.rsr_id; });
  if (stillThere) {
    return { success: false, error: '\u4e88\u7d04\u30b5\u30a4\u30c8\u304c\u53d6\u6d88\u3092\u53d7\u3051\u4ed8\u3051\u307e\u305b\u3093\u3067\u3057\u305f\uff08\u671f\u9650\u5207\u308c\u306e\u53ef\u80fd\u6027\uff09' };
  }
  return { success: true };
}

module.exports = { checkAvailability, makeReservation, getReservations, cancelReservation };
