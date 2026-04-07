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
  var r3 = await axios.get(BASE_URL + '/news', { headers: { Cookie: getCookie() } });
  saveCookies(r3.headers);
  return cheerio.load(r3.data)('input[name="_token"]').first().val();
}
async function navigateToRegist(token) { var p = new URLSearchParams(); p.append('_token', token); var r = await axios.post(BASE_URL + '/rsr/regist', p.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: getCookie() } }); saveCookies(r.headers); return cheerio.load(r.data)('input[name="_token"]').first().val(); }
async function searchAvailability(token, date) { var p = new URLSearchParams(); p.append('_token', token); p.append('office_name', '6'); p.append('search_date', date); var r = await axios.post(BASE_URL + '/rsr/regist/search', p.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: getCookie() } }); saveCookies(r.headers); return r.data; }
async function checkAvailability(date, startTime, endTime) { var token = await login(); token = await navigateToRegist(token); var html = await searchAvailability(token, date); var $ = cheerio.load(html); var slots = []; $('input[type="checkbox"]').each(function() { var val = $(this).val() || ''; var parts = val.split('/'); if (parts.length === 3) { slots.push({ index: parseInt(parts[0]), time: parts[1], roomId: parts[2], disabled: $(this).prop('disabled') || false, checked: $(this).prop('checked') || false, value: val }); } }); var filtered = slots.filter(function(s) { return s.time >= startTime && s.time < endTime; }); var room6 = checkRoom(filtered, '42'); var room4 = checkRoom(filtered, '25'); return { date: date, startTime: startTime, endTime: endTime, rooms: [ { name: '6\u968e \u4f1a\u8b70\u5ba4', id: '42', available: room6.available, slots: room6.slots }, { name: '4\u968e \u5171\u7528\u4f1a\u8b70\u5ba4', id: '25', available: room4.available, slots: room4.slots } ] }; }
function checkRoom(slots, roomId) { var rs = slots.filter(function(s) { return s.roomId === roomId; }); return { available: rs.length > 0 && rs.every(function(s) { return !s.disabled && !s.checked; }), slots: rs }; }
async function makeReservation(date, startTime, endTime, roomId) { var token = await login(); token = await navigateToRegist(token); var html = await searchAvailability(token, date); var $ = cheerio.load(html); var selectedSlots = []; $('input[type="checkbox"]').each(function() { var val = $(this).val() || ''; var parts = val.split('/'); if (parts.length === 3 && parts[2] === roomId && parts[1] >= startTime && parts[1] < endTime) { selectedSlots.push(val); } }); if (selectedSlots.length === 0) return { success: false, error: '\u6642\u9593\u67a0\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3067\u3057\u305f' }; var newToken = $('input[name="_token"]').first().val(); var params = new URLSearchParams(); params.append('_token', newToken); params.append('reservation_date', date); params.append('reservation_office_id', '6'); params.append('purpose_of_use', ''); params.append('describe_title', '1'); params.append('remarks', ''); for (var i = 0; i < selectedSlots.length; i++) params.append('check[]', selectedSlots[i]); try { await axios.post(BASE_URL + '/rsr/regist/active', params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: getCookie() }, validateStatus: function() { return true; } }); } catch (err) { return { success: false, error: '\u767b\u9332\u30a8\u30e9\u30fc' }; } var password = await getLatestPassword(date, startTime); return { success: true, password: password }; }
async function getLatestPassword(date, startTime) { var html = await getReservationPage(); var list = parseReservationList(html); for (var i = 0; i < list.length; i++) { if (list[i].rsr_date === date && (list[i].start_time || '').indexOf(startTime) === 0) return list[i].e_key; } return null; }
async function getReservationPage() { var token = await login(); var p = new URLSearchParams(); p.append('_token', token); var r = await axios.post(BASE_URL + '/rsr', p.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: getCookie() } }); saveCookies(r.headers); return r.data; }
function parseReservationList(html) { var m = html.match(/const\s+reservationList\s*(=\s*(\[[\s\S]*?\]);/); if (m) { try { return JSON.parse(m[1]); } catch(e) {} } return []; }
async function getReservations() { var html = await getReservationPage(); var list = parseReservationList(html); return list.map(function(r) { return { rsr_id: r.rsr_id, password: r.e_key, date: r.rsr_date, time: (r.start_time || '').substring(0,5) + '~' + (r.end_time || '').substring(0,5), tenant: r.tenant_name, location: r.office_name, room: r.room_name }; }); }
async function cancelReservation(date, startTime) { var html = await getReservationPage(); var list = parseReservationList(html); var target = null; for (var i = 0; i < list.length; i++) { if (list[i].rsr_date === date && (list[i].start_time || '').indexOf(startTime) === 0) { target = list[i]; break; } } if (!target) return { success: false, error: '\u8a72\u5f53\u3059\u308b\u4e88\u7d04\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3067\u3057\u305f' }; var $ = cheerio.load(html); var token = $('input[name="_token"]').first().val(); var deleteForm = $('#roomDeleteForm'); var action = deleteForm.attr('action') || BASE_URL + '/rsr/delete'; var p = new URLSearchParams(); p.append('_token', token); p.append('rsr_id', target.rsr_id); try { await axios.post(action, p.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: getCookie() }, validateStatus: function() { return true; } }); return { success: true }; } catch (err) { return { success: false, error: '\u30ad\u30e3\u30f3\u30bb\u30eb\u30a8\u30e9\u30fc' }; } }
module.exports = { checkAvailability, makeReservation, getReservations, cancelReservation };
