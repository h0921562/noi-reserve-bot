const express = require('express');
const line = require('@line/bot-sdk');
const { checkAvailability, makeReservation, getReservations, cancelReservation } = require('./reserve');

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

const app = express();

app.post('/webhook', line.middleware({ channelSecret: config.channelSecret }), (req, res) => {
  res.status(200).end();
  Promise.all(req.body.events.map(handleEvent)).catch(console.error);
});

app.get('/', (req, res) => res.send('OK'));

const pendingConfirmations = new Map();

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const text = event.message.text.trim();
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  if (event.source.type === 'group' || event.source.type === 'room') {
    const mention = event.message.mention;
    if (!mention && !text.startsWith('@')) return;
  }
  const cleanText = text.replace(/@\S+\s*/g, '').trim();
  try {
    if (pendingConfirmations.has(userId)) {
      if (['ok','OK','\u306f\u3044','\u3046\u3093','\u304ak','yes'].includes(cleanText)) {
        const info = pendingConfirmations.get(userId);
        pendingConfirmations.delete(userId);
        await reply(replyToken, '\u4e88\u7d04\u4e2d...');
        const result = await makeReservation(info.date, info.startTime, info.endTime, info.roomId);
        if (result.success) {
          const dl = calcCancelDeadline(info.date, info.startTime);
          const msg = '\u4e88\u7d04\u5b8c\u4e86\n' + info.roomName + ' / ' + info.date + ' ' + info.startTime + '-' + info.endTime + (result.password ? '\n\u30d1\u30b9\u30ef\u30fc\u30c9: ' + result.password : '') + '\n\u30ad\u30e3\u30f3\u30be\u30eb\u671f\u9650: ' + dl;
          await pushMessage(userId, msg);
        } else {
          await pushMessage(userId, '\u4e88\u7d04\u5931\u6557: ' + result.error);
        }
        return;
      } else {
        pendingConfirmations.delete(userId);
        await reply(replyToken, '\u30ad\u30e3\u30f3\u30be\u30eb\u3057\u307e\u3057\u305f');
        return;
      }
    }
    if (cleanText === '\u4e88\u7d04\u4e00\u89a7' || cleanText === '\u4e00\u89a7') {
      await handleList(replyToken, userId);
    } else if (cleanText.startsWith('\u53d6\u6d88') || cleanText.startsWith('\u30ad\u30e3\u30f3\u30bb\u30eb')) {
      await handleCancel(replyToken, userId, cleanText);
    } else if (cleanText.startsWith('\u7a7a\u304d')) {
      await handleCheckOnly(replyToken, userId, cleanText);
    } else {
      await handleReserve(replyToken, userId, cleanText);
    }
  } catch (err) {
    console.error('Error handling event:', err);
    await reply(replyToken, '\u30a8\u30e9\u30fc\u304c\u767a\u751f\u3057\u307e\u3057\u305f\u3002\u3082\u3046\u4e00\u5ea6\u304a\u8a66\u3057\u304f\u3060\u3055\u3044\u3002').catch(function(){});
  }
}

async function handleReserve(replyToken, userId, text) {
  const parsed = parseDateTime(text);
  if (!parsed) { await reply(replyToken, '\u65e5\u6642\u3092\u8a8d\u8b58\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\u3002\n\u4f8b: 4/10 14:00-15:00'); return; }
  const date = parsed.date, startTime = parsed.startTime, endTime = parsed.endTime;
  await reply(replyToken, date + ' ' + startTime + '-' + endTime + ' \u306e\u7a7a\u304d\u72b6\u6cc1\u3092\u78ba\u8a8d\u4e2d...');
  const availability = await checkAvailability(date, startTime, endTime);
  const room6 = availability.rooms.find(function(r) { return r.id === '42'; });
  const room4 = availability.rooms.find(function(r) { return r.id === '25'; });
  var selectedRoom = null;
  if (room6.available) selectedRoom = room6;
  else if (room4.available) selectedRoom = room4;
  if (!selectedRoom) { await pushMessage(userId, date + ' ' + startTime + '-' + endTime + ' \u306f\u4e21\u65b9\u306e\u4f1a\u8b70\u5ba4\u304c\u57cb\u307e\u3063\u3066\u3044\u307e\u3059\u3002'); return; }
  const dl = calcCancelDeadline(date, startTime);
  pendingConfirmations.set(userId, { date: date, startTime: startTime, endTime: endTime, roomId: selectedRoom.id, roomName: selectedRoom.name });
  setTimeout(function() { pendingConfirmations.delete(userId); }, 5 * 60 * 1000);
  const msg = selectedRoom.name + ' \u304c\u7a7a\u3044\u3066\u3044\u307e\u3059\n\u65e5\u6642: ' + date + ' ' + startTime + '-' + endTime + '\n\u30ad\u30e3\u30f3\u30bb\u30eb\u671f\u9650: ' + dl + '\n\n\u4e88\u7d04\u3057\u307e\u3059\u304b\uff1f\uff08OK / \u3044\u3044\u3048\uff09';
  await pushMessage(userId, msg);
}

async function handleCheckOnly(replyToken, userId, text) {
  const cleaned = text.replace(/^\u7a7a\u304d\s*/, '');
  const parsed = parseDateTime(cleaned);
  if (!parsed) { await reply(replyToken, '\u65e5\u6642\u3092\u8a8d\u8b58\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\u3002\n\u4f8b: \u7a7a\u304d 4/10 14:00-15:00'); return; }
  const date = parsed.date, startTime = parsed.startTime, endTime = parsed.endTime;
  await reply(replyToken, date + ' ' + startTime + '-' + endTime + ' \u306e\u7a7a\u304d\u72b6\u6cc1\u3092\u78ba\u8a8d\u4e2d...');
  const availability = await checkAvailability(date, startTime, endTime);
  var lines = availability.rooms.map(function(r) { return r.name + ': ' + (r.available ? '\u7a7a\u304d' : '\u57cb\u307e\u308a'); });
  await pushMessage(userId, date + ' ' + startTime + '-' + endTime + '\n' + lines.join('\n'));
}

async function handleList(replyToken, userId) {
  await reply(replyToken, '\u4e88\u7d04\u4e00\u89a7\u3092\u53d6\u5f97\u4e2d...');
  const reservations = await getReservations();
  if (reservations.length === 0) { await pushMessage(userId, '\u73fe\u5728\u306e\u4e88\u7d04\u306f\u3042\u308a\u307e\u305b\u3093'); return; }
  var lines = reservations.map(function(r) { return r.date + ' ' + r.time + '\n' + r.room + ' PW:' + r.password; });
  await pushMessage(userId, '\u4e88\u7d04\u4e00\u89a7\n\n' + lines.join('\n\n'));
}

async function handleCancel(replyToken, userId, text) {
  const cleaned = text.replace(/^(\u53d6\u6d88|\u30ad\u30e3\u30f3\u30bb\u30eb)\s*/, '');
  const parsed = parseDateTime(cleaned);
  if (!parsed) { await reply(replyToken, '\u65e5\u6642\u3092\u8a8d\u8b58\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\u3002\n\u4f8b: \u53d6\u6d88 4/10 14:00'); return; }
  const now = new Date();
  const startDateTime = new Date(parsed.date + 'T' + parsed.startTime + ':00');
  const deadline = new Date(startDateTime.getTime() - 2 * 60 * 60 * 1000);
  if (now > deadline) { await reply(replyToken, '\u30ad\u30e3\u30f3\u30bb\u30eb\u671f\u9650\u3092\u904e\u304e\u3066\u3044\u307e\u3059\u3002'); return; }
  await reply(replyToken, '\u30ad\u30e3\u30f3\u30bb\u30eb\u4e2d...');
  const result = await cancelReservation(parsed.date, parsed.startTime);
  if (result.success) await pushMessage(userId, '\u30ad\u30e3\u30f3\u30bb\u30eb\u5b8c\u4e86\u3057\u307e\u3057\u305f');
  else await pushMessage(userId, '\u30ad\u30e3\u30f3\u30bb\u30eb\u5931\u6557: ' + result.error);
}

// \u5168\u89d2\u2192\u534a\u89d2\u5909\u63db
function zen2han(str) {
  return str.replace(/[\uff10-\uff19]/g, function(s) {
    return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
  }).replace(/[\uff1a\uff0f\uff5e\u30fc]/g, function(s) {
    return { '\uff1a': ':', '\uff0f': '/', '\uff5e': '~', '\u30fc': '-' }[s] || s;
  });
}

// \u6642\u9593\u6587\u5b57\u5217\u3092\u6b63\u898f\u5316\uff0814\u219214:00, 1430\u219214:30, 14:00\u219214:00\uff09
function normalizeTime(t) {
  t = t.replace(/[:\s]/g, '');
  if (t.length <= 2) return t.padStart(2, '0') + ':00';
  if (t.length === 3) return '0' + t[0] + ':' + t.substring(1);
  if (t.length === 4) return t.substring(0, 2) + ':' + t.substring(2);
  return t;
}

// \u65e5\u6642\u30d1\u30fc\u30b5\u30fc
function parseDateTime(text) {
  text = zen2han(text);

  // \u65e5\u4ed8\u90e8\u5206\u3092\u63a2\u3059
  const datePatterns = [
    /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/,
    /(\d{1,2}\/\d{1,2})/,
  ];

  // \u6642\u9593\u90e8\u5206\u3092\u63a2\u3059\uff08\u30b3\u30ed\u30f3\u3042\u308a\u30fb\u306a\u3057\u4e21\u5bfe\u5fdc\uff09
  // 14:00-15:00, 14-15, 1400-1500, 14~1430, 14:00 15:00 etc
  const timePattern = /(\d{1,4}(?::\d{2})?)\s*[-~\u301c]\s*(\d{1,4}(?::\d{2})?)/;
  const singleTimePattern = /(\d{1,4}(?::\d{2})?)/;

  let date = null;
  let remaining = text;

  for (const dp of datePatterns) {
    const dateMatch = text.match(dp);
    if (dateMatch) {
      date = dateMatch[1];
      remaining = text.substring(dateMatch.index + dateMatch[0].length).trim();
      break;
    }
  }

  if (!date) return null;

  // \u6642\u9593\u7bc4\u56f2\u3092\u63a2\u3059
  let startTime, endTime;
  const rangeMatch = remaining.match(timePattern);
  if (rangeMatch) {
    startTime = normalizeTime(rangeMatch[1]);
    endTime = normalizeTime(rangeMatch[2]);
  } else {
    const singleMatch = remaining.match(singleTimePattern);
    if (singleMatch) {
      startTime = normalizeTime(singleMatch[1]);
      endTime = addHour(startTime);
    } else {
      return null;
    }
  }

  // \u6708/\u65e5 \u2192 YYYY-MM-DD
  if (date.match(/^\d{1,2}\/\d{1,2}$/)) {
    const [m, d] = date.split('/');
    const year = new Date().getFullYear();
    date = year + '-' + m.padStart(2, '0') + '-' + d.padStart(2, '0');
  }
  date = date.replace(/\//g, '-');

  return { date: date, startTime: startTime, endTime: endTime };
}

function padTime(t) {
  const [h, m] = t.split(':');
  return h.padStart(2, '0') + ':' + m;
}

function addHour(time) {
  const parts = time.split(':').map(Number);
  return String(parts[0] + 1).padStart(2, '0') + ':' + String(parts[1]).padStart(2, '0');
}

function calcCancelDeadline(date, startTime) {
  const dt = new Date(`${date}T${startTime}:00`);
  dt.setHours(dt.getHours() - 2);
  return formatDateTime(dt);
}

function formatDateTime(dt) {
  const m = dt.getMonth() + 1;
  const d = dt.getDate();
  const h = String(dt.getHours()).padStart(2, '0');
  const min = String(dt.getMinutes()).padStart(2, '0');
  return `${m}/${d} ${h}:${min}`;
}

async function reply(replyToken, text) {
  return client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text }],
  });
}

async function pushMessage(userId, text) {
  if (!userId) return;
  return client.pushMessage({
    to: userId,
    messages: [{ type: 'text', text }],
  });
}

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server running on port ${port}`));
