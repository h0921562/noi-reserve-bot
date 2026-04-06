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
      if (['ok','OK','ã¯ã','ãã','ãë','yes'].includes(cleanText)) {
        const info = pendingConfirmations.get(userId);
        pendingConfirmations.delete(userId);
        await reply(replyToken, 'äºç´ä¸­...');
        const result = await makeReservation(info.date, info.startTime, info.endTime, info.roomId);
        if (result.success) {
          const dl = calcCancelDeadline(info.date, info.startTime);
          const msg = 'äºç´å®äº\n' + info.roomName + ' / ' + info.date + ' ' + info.startTime + '-' + info.endTime + (result.password ? '\nãã¹ã¯ã¼ã: ' + result.password : '') + '\nã­ã£ã³ã»ã«æé: ' + dl;
          await pushMessage(userId, msg);
        } else {
          await pushMessage(userId, 'äºç´å¤±æ: ' + result.error);
        }
        return;
      } else {
        pendingConfirmations.delete(userId);
        await reply(replyToken, 'ã­ã£ã³ã»ã«ãã¾ãã');
        return;
      }
    }
    if (cleanText === 'äºç´ä¸è¦§' || cleanText === 'ä¸è¦¥') {
      await handleList(replyToken, userId);
    } else if (cleanText.startsWith('åæ¶') || cleanText.startsWith('ã­ã£ã³ã»ã«')) {
      await handleCancel(replyToken, userId, cleanText);
    } else if (cleanText.startsWith('ç©ºã')) {
      await handleCheckOnly(replyToken, userId, cleanText);
    } else {
      await handleReserve(replyToken, userId, cleanText);
    }
  } catch (err) {
    console.error('Error handling event:', err);
    await reply(replyToken, 'ã¨ã©ã¼ãçºçãã¾ãããããä¸åº¦ãè©¦ããã ããã').catch(function(){});
  }
}

async function handleReserve(replyToken, userId, text) {
  const parsed = parseDateTime(text);
  if (!parsed) { await reply(replyToken, 'æ¥æãèªè­ã§ãã¾ããã§ããã\nä¾: 4/10 14:00-15:00'); return; }
  const date = parsed.date, startTime = parsed.startTime, endTime = parsed.endTime;
  await reply(replyToken, date + ' ' + startTime + '-' + endTime + ' ã®ç©ºãç¶æ³ãç¢ºèªä¸­...');
  const availability = await checkAvailability(date, startTime, endTime);
  const room6 = availability.rooms.find(function(r) { return r.id === '42'; });
  const room4 = availability.rooms.find(function(r) { return r.id === '25'; });
  var selectedRoom = null;
  if (room6.available) selectedRoom = room6;
  else if (room4.available) selectedRoom = room4;
  if (!selectedRoom) { await pushMessage(userId, date + ' ' + startTime + '-' + endTime + ' ã¯ä¸¡æ¹ã®ä¼è­°å®¤ãåã¾ã£ã¦ãã¾ãã'); return; }
  const dl = calcCancelDeadline(date, startTime);
  pendingConfirmations.set(userId, { date: date, startTime: startTime, endTime: endTime, roomId: selectedRoom.id, roomName: selectedRoom.name });
  setTimeout(function() { pendingConfirmations.delete(userId); }, 5 * 60 * 1000);
  const msg = selectedRoom.name + ' ãç©ºãã¦ãã¾ã\næ¥æ: ' + date + ' ' + startTime + '-' + endTime + '\nã­ã£ã³ã»ã«æé: ' + dl + '\n\näºç´ãã¾ããï¼ï¼OK / ãããï¼';
  await pushMessage(userId, msg);
}

async function handleCheckOnly(replyToken, userId, text) {
  const cleaned = text.replace(/^ç©ºã\s*/, '');
  const parsed = parseDateTime(cleaned);
  if (!parsed) { await reply(replyToken, 'æ¥æãèªè­ã§ãã¾ããã§ããã\nä¾: ç©ºã 4/10 14:00-15:00'); return; }
  const date = parsed.date, startTime = parsed.startTime, endTime = parsed.endTime;
  await reply(replyToken, date + ' ' + startTime + '-' + endTime + ' ã®ç©ºãç¶æ³ãç¢ºèªä¸­...');
  const availability = await checkAvailability(date, startTime, endTime);
  var lines = availability.rooms.map(function(r) { return r.name + ': ' + (r.available ? 'ç©ºã' : 'åã¾ã'); });
  await pushMessage(userId, date + ' ' + startTime + '-' + endTime + '\n' + lines.join('\n'));
}

async function handleList(replyToken, userId) {
  await reply(replyToken, 'äºç´ä¸è¦§ãåå¾ä¸­...');
  const reservations = await getReservations();
  if (reservations.length === 0) { await pushMessage(userId, 'ç¾å¨ã®äºç´ã¯ããã¾ãã'); return; }
  var lines = reservations.map(function(r) { return r.date + ' ' + r.time + '\n' + r.room + ' PW:' + r.password; });
  await pushMessage(userId, 'äºç´ä¸è¦§\n\n' + lines.join('\n\n'));
}

async function handleCancel(replyToken, userId, text) {
  const cleaned = text.replace(/^(åæ¶|ã­ã£ã³ã»ã«)\s*/, '');
  const parsed = parseDateTime(cleaned);
  if (!parsed) { await reply(replyToken, 'æ¥æãèªè­ã§ãã¾ããã§ããã\nä¾: åæ¶ 4/10 14:00'); return; }
  const now = new Date();
  const startDateTime = new Date(parsed.date + 'T' + parsed.startTime + ':00');
  const deadline = new Date(startDateTime.getTime() - 2 * 60 * 60 * 1000);
  if (now > deadline) { await reply(replyToken, 'ã­ã£ã³ã»ã«æéãéãã¦ãã¾ãã'); return; }
  await reply(replyToken, 'ã­ã£ã³ã»ã«ä¸­...');
  const result = await cancelReservation(parsed.date, parsed.startTime);
  if (result.success) await pushMessage(userId, 'ã­ã£ã³ã»ã«å®äºãã¾ãã');
  else await pushMessage(userId, 'ã­ã£ã³ã»ã«å¤±æ: ' + result.error);
}

function parseDateTime(text) {
  var patterns = [
    /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})\s+(\d{1,2}:\d{2})\s*[-~ã]\s*(\d{1,2}:\d{2})/,
    /(\d{1,2}\/\d{1,2})\s+(\d{1,2}:\d{2})\s*[-~ã]\s*(\d{1,2}:\d{2})/,
    /(\d{1,2}\/\d{1,2})\s+(\d{1,2}:\d{2})/
  ];
  for (var i = 0; i < patterns.length; i++) {
    var match = text.match(patterns[i]);
    if (match) {
      var date = match[1], startTime = match[2], endTime = match[3] || addHour(startTime);
      if (/^\d{1,2}\/\d{1,2}$/.test(date)) {
        var parts = date.split('/');
        date = new Date().getFullYear() + '-' + parts[0].padStart(2, '0') + '-' + parts[1].padStart(2, '0');
      }
      date = date.replace(/\//g, '-');
      return { date: date, startTime: padTime(startTime), endTime: padTime(endTime) };
    }
  }
  return null;
}

function padTime(t) { var p = t.split(':'); return p[0].padStart(2, '0') + ':' + p[1]; }
function addHour(t) { var p = t.split(':').map(Number); return String(p[0] + 1).padStart(2, '0') + ':' + String(p[1]).padStart(2, '0'); }
function calcCancelDeadline(date, startTime) { var dt = new Date(date + 'T' + startTime + ':00'); dt.setHours(dt.getHours() - 2); return formatDateTime(dt); }
function formatDateTime(dt) { return (dt.getMonth() + 1) + '/' + dt.getDate() + ' ' + String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0'); }

async function reply(replyToken, text) { return client.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }); }
async function pushMessage(userId, text) { if (!userId) return; return client.pushMessage({ to: userId, messages: [{ type: 'text', text: text }] }); }

const port = process.env.PORT || 8080;
app.listen(port, function() { console.log('Server running on port ' + port); });
