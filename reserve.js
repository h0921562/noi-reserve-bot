const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://sd-reservsys.jp';
const LOGIN_ID = process.env.RESERVE_LOGIN_ID;
const LOGIN_PW = process.env.RESERVE_LOGIN_PW;

function parseCookies(headers) {
  const cookies = [];
  const setCookies = headers['set-cookie'] || [];
  for (const sc of setCookies) {
    const parts = sc.split(';')[0];
    cookies.push(parts);
  }
  return cookies.join('; ');
}

async function login() {
  const res1 = await axios.get(BASE_URL + '/', { maxRedirects: 5 });
  let cookie = parseCookies(res1.headers);
  const $ = cheerio.load(res1.data);
  const token = $('input[type="hidden"]').first().val();
  const params = new URLSearchParams();
  params.append('_token', token);
  params.append('action', 'login');
  params.append('login_id', LOGIN_ID);
  params.append('password', LOGIN_PW);
  const res2 = await axios.post(BASE_URL + '/login', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    maxRedirects: 0, validateStatus: s => s < 400
  });
  const newCookie = parseCookies(res2.headers);
  return newCookie || cookie;
}

async function checkAvailability(date, startTime, endTime) {
  const cookie = await login();
  const res = await axios.get(BASE_URL + '/rsr/regist/search', { headers: { Cookie: cookie } });
  const $ = cheerio.load(res.data);
  const token = $('form input[type="hidden"]').first().val();
  const params = new URLSearchParams();
  params.append('_token', token);
  params.append('base_id', '6');
  params.append('rsrv_date', date);
  const searchRes = await axios.post(BASE_URL + '/rsr/regist/search', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }
  });
  const $s = cheerio.load(searchRes.data);
  const slots = [];
  $s('input[type="checkbox"]').each(function() {
    const name = $s(this).attr('name') || $s(this).val() || '';
    const parts = name.split('/');
    if (parts.length === 3) {
      slots.push({ index: parseInt(parts[0]), time: parts[1], roomId: parts[2], disabled: $s(this).prop('disabled') || false, checked: $s(this).prop('checked') || false });
    }
  });
  const filtered = slots.filter(function(s) { return s.time >= startTime && s.time < endTime; });
  const room6 = checkRoom(filtered, '42');
  const room4 = checkRoom(filtered, '25');
  return { date: date, startTime: startTime, endTime: endTime, rooms: [
    { name: '6階 会議室', id: '42', available: room6.available, slots: room6.slots },
    { name: '4階 共用会議室', id: '25', available: room4.available, slots: room4.slots }
  ]};
}

function checkRoom(slots, roomId) {
  var roomSlots = slots.filter(function(s) { return s.roomId === roomId; });
  var available = roomSlots.length > 0 && roomSlots.every(function(s) { return !s.disabled && !s.checked; });
  return { available: available, slots: roomSlots };
}

async function makeReservation(date, startTime, endTime, roomId) {
  const cookie = await login();
  const res = await axios.get(BASE_URL + '/rsr/regist/search', { headers: { Cookie: cookie } });
  var $ = cheerio.load(res.data);
  var token = $('form input[type="hidden"]').first().val();
  const searchParams = new URLSearchParams();
  searchParams.append('_token', token);
  searchParams.append('base_id', '6');
  searchParams.append('rsrv_date', date);
  const searchRes = await axios.post(BASE_URL + '/rsr/regist/search', searchParams.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }
  });
  $ = cheerio.load(searchRes.data);
  token = $('form input[type="hidden"]').first().val();
  const selectedSlots = [];
  $('input[type="checkbox"]').each(function() {
    const name = $(this).attr('name') || $(this).val() || '';
    const parts = name.split('/');
    if (parts.length === 3 && parts[2] === roomId && parts[1] >= startTime && parts[1] < endTime) {
      selectedSlots.push(name);
    }
  });
  if (selectedSlots.length === 0) return { success: false, error: '時間枠が見つかりませんでした' };
  const regParams = new URLSearchParams();
  regParams.append('_token', token);
  regParams.append('base_id', '6');
  regParams.append('rsrv_date', date);
  regParams.append('purpose', '');
  regParams.append('display_type', '1');
  regParams.append('memo', '');
  for (var i = 0; i < selectedSlots.length; i++) regParams.append('rsrv_time[]', selectedSlots[i]);
  try {
    await axios.post(BASE_URL + '/rsr/regist/store', regParams.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }
    });
  } catch (err) {
    if (err.response && err.response.status >= 400) return { success: false, error: '登録エラー' };
  }
  const password = await getLatestPassword(cookie, date, startTime);
  return { success: true, password: password };
}

async function getLatestPassword(cookie, date, startTime) {
  const res = await axios.get(BASE_URL + '/rsr', { headers: { Cookie: cookie } });
  const $ = cheerio.load(res.data);
  var password = null;
  $('table tbody tr').each(function() {
    const cells = $(this).find('td');
    if (cells.length >= 6) {
      const pw = $(cells[0]).text().trim();
      const dateText = $(cells[1]).text().trim();
      const timeText = $(cells[2]).text().trim();
      if (dateText.indexOf(date) >= 0 && timeText.indexOf(startTime) >= 0) password = pw;
    }
  });
  return password;
}

async function getReservations() {
  const cookie = await login();
  const res = await axios.get(BASE_URL + '/rsr', { headers: { Cookie: cookie } });
  const $ = cheerio.load(res.data);
  const reservations = [];
  $('table tbody tr').each(function() {
    const cells = $(this).find('td');
    if (cells.length >= 6) {
      reservations.push({ password: $(cells[0]).text().trim(), date: $(cells[1]).text().trim(), time: $(cells[2]).text().trim(), tenant: $(cells[3]).text().trim(), location: $(cells[4]).text().trim(), room: $(cells[5]).text().trim() });
    }
  });
  return reservations;
}

async function cancelReservation(date, startTime) {
  const cookie = await login();
  const res = await axios.get(BASE_URL + '/rsr', { headers: { Cookie: cookie } });
  const $ = cheerio.load(res.data);
  var cancelUrl = null;
  $('table tbody tr').each(function() {
    const cells = $(this).find('td');
    if (cells.length >= 6) {
      const dateText = $(cells[1]).text().trim();
      const timeText = $(cells[2]).text().trim();
      if (dateText.indexOf(date) >= 0 && timeText.indexOf(startTime) >= 0) {
        const link = $(this).find('a[href*="cancel"], a[href*="delete"]');
        if (link.length) cancelUrl = link.attr('href');
      }
    }
  });
  if (!cancelUrl) return { success: false, error: '該当する予約が見つかりませんでした' };
  const token = $('input[type="hidden"][name="_token"]').first().val();
  const params = new URLSearchParams();
  params.append('_token', token);
  try {
    await axios.post(cancelUrl.startsWith('http') ? cancelUrl : BASE_URL + cancelUrl, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: 'キャンセルエラー' };
  }
}

module.exports = { checkAvailability, makeReservation, getReservations, cancelReservation };
