const axios = require('axios');
const cheerio = require('cheerio');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

const BASE_URL = 'https://sd-reservsys.jp';
const LOGIN_ID = process.env.RESERVE_LOGIN_ID;
const LOGIN_PW = process.env.RESERVE_LOGIN_PW;

function createClient() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({ jar, baseURL: BASE_URL, withCredentials: true, maxRedirects: 5 }));
  return client;
}

async function login(client) {
  const res = await client.get('/');
  const $ = cheerio.load(res.data);
  const token = $('input[type="hidden"]').first().val();
  const params = new URLSearchParams();
  params.append('_token', token);
  params.append('action', 'login');
  params.append('login_id', LOGIN_ID);
  params.append('password', LOGIN_PW);
  await client.post('/login', params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
}

async function checkAvailability(date, startTime, endTime) {
  const client = createClient();
  await login(client);
  const res = await client.get('/rsr/regist/search');
  const $ = cheerio.load(res.data);
  const token = $('form input[type="hidden"]').first().val();
  const params = new URLSearchParams();
  params.append('_token', token);
  params.append('base_id', '6');
  params.append('rsrv_date', date);
  const searchRes = await client.post('/rsr/regist/search', params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const $s = cheerio.load(searchRes.data);
  const slots = [];
  $s('input[type="checkbox"]').each((_, el) => {
    const name = $s(el).attr('name') || $s(el).val() || '';
    const parts = name.split('/');
    if (parts.length === 3) {
      slots.push({ index: parseInt(parts[0]), time: parts[1], roomId: parts[2], disabled: $s(el).prop('disabled') || false, checked: $s(el).prop('checked') || false });
    }
  });
  const filtered = slots.filter(s => s.time >= startTime && s.time < endTime);
  const room6 = checkRoom(filtered, '42');
  const room4 = checkRoom(filtered, '25');
  return { date, startTime, endTime, rooms: [
    { name: '6階 会議室', id: '42', available: room6.available, slots: room6.slots },
    { name: '4階 共用会議室', id: '25', available: room4.available, slots: room4.slots },
  ]};
}

function checkRoom(slots, roomId) {
  const roomSlots = slots.filter(s => s.roomId === roomId);
  const available = roomSlots.length > 0 && roomSlots.every(s => !s.disabled && !s.checked);
  return { available, slots: roomSlots };
}

async function makeReservation(date, startTime, endTime, roomId) {
  const client = createClient();
  await login(client);
  const res = await client.get('/rsr/regist/search');
  let $ = cheerio.load(res.data);
  let token = $('form input[type="hidden"]').first().val();
  const searchParams = new URLSearchParams();
  searchParams.append('_token', token);
  searchParams.append('base_id', '6');
  searchParams.append('rsrv_date', date);
  const searchRes = await client.post('/rsr/regist/search', searchParams.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  $ = cheerio.load(searchRes.data);
  token = $('form input[type="hidden"]').first().val();
  const selectedSlots = [];
  $('input[type="checkbox"]').each((_, el) => {
    const name = $(el).attr('name') || $(el).val() || '';
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
  for (const slot of selectedSlots) regParams.append('rsrv_time[]', slot);
  try {
    await client.post('/rsr/regist/store', regParams.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  } catch (err) {
    if (err.response && err.response.status >= 400) return { success: false, error: '登録エラー (' + err.response.status + ')' };
  }
  const password = await getLatestPassword(client, date, startTime);
  return { success: true, password };
}

async function getLatestPassword(client, date, startTime) {
  const res = await client.get('/rsr');
  const $ = cheerio.load(res.data);
  let password = null;
  $('table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length >= 6) {
      const pw = $(cells[0]).text().trim();
      const dateText = $(cells[1]).text().trim();
      const timeText = $(cells[2]).text().trim();
      if (dateText.includes(date) && timeText.includes(startTime)) password = pw;
    }
  });
  return password;
}

async function getReservations() {
  const client = createClient();
  await login(client);
  const res = await client.get('/rsr');
  const $ = cheerio.load(res.data);
  const reservations = [];
  $('table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length >= 6) {
      reservations.push({ password: $(cells[0]).text().trim(), date: $(cells[1]).text().trim(), time: $(cells[2]).text().trim(), tenant: $(cells[3]).text().trim(), location: $(cells[4]).text().trim(), room: $(cells[5]).text().trim() });
    }
  });
  return reservations;
}

async function cancelReservation(date, startTime) {
  const client = createClient();
  await login(client);
  const res = await client.get('/rsr');
  const $ = cheerio.load(res.data);
  let cancelUrl = null;
  $('table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length >= 6) {
      const dateText = $(cells[1]).text().trim();
      const timeText = $(cells[2]).text().trim();
      if (dateText.includes(date) && timeText.includes(startTime)) {
        const link = $(row).find('a[href*="cancel"], a[href*="delete"]');
        if (link.length) cancelUrl = link.attr('href');
      }
    }
  });
  if (!cancelUrl) return { success: false, error: '該当する予約が見つかりませんでした' };
  const token = $('input[type="hidden"][name="_token"]').first().val();
  const params = new URLSearchParams();
  params.append('_token', token);
  try {
    await client.post(cancelUrl, params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    return { success: true };
  } catch (err) {
    return { success: false, error: 'キャンセルエラー' };
  }
}

module.exports = { checkAvailability, makeReservation, getReservations, cancelReservation };
