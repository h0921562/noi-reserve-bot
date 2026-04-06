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
      if (['ok','OK','はい','うん','おk','yes'].includes(cleanText)) {
        const info = pendingConfirmations.get(userId);
        pendingConfirmations.delete(userId);
        await reply(replyToken, '予約中...');
        const result = await makeReservation(info.date, info.startTime, info.endTime, info.roomId);
        if (result.success) {
          const cancelDeadline = calcCancelDeadline(info.date, info.startTime);
          const msg = ['予約完了', info.roomName + ' / ' + info.date + ' ' + info.startTime + '-' + info.endTime, result.password ? 'パスワード: ' + result.password : '', 'キャンセル期限: ' + cancelDeadline].filter(Boolean).join('\n');
          await pushMessage(userId, msg);
        } else {
          await pushMessage(userId, '予約失敗: ' + result.error);
        }
        return;
      } else {
        pendingConfirmations.delete(userId);
        await reply(replyToken, 'キャンセルしました');
        return;
      }
    }

    if (cleanText === '予約一覧' || cleanText === '一覧') {
      await handleList(replyToken, userId);
    } else if (cleanText.startsWith('取消') || cleanText.startsWith('キャンセル')) {
      await handleCancel(replyToken, userId, cleanText);
    } else if (cleanText.startsWith('空き')) {
      await handleCheckOnly(replyToken, userId, cleanText);
    } else {
      await handleReserve(replyToken, userId, cleanText);
    }
  } catch (err) {
    console.error('Error handling event:', err);
    await reply(replyToken, 'エラーが発生しました。もう一度お試しください。').catch(() => {});
  }
}

async function handleReserve(replyToken, userId, text) {
  const parsed = parseDateTime(text);
  if (!parsed) { await reply(replyToken, '日時を認識できませんでした。\n例: 4/10 14:00-15:00'); return; }
  const { date, startTime, endTime } = parsed;
  await reply(replyToken, date + ' ' + startTime + '-' + endTime + ' の空き状況を確認中...');
  const availability = await checkAvailability(date, startTime, endTime);
  const room6 = availability.rooms.find(r => r.id === '42');
  const room4 = availability.rooms.find(r => r.id === '25');
  let selectedRoom = null;
  if (room6.available) selectedRoom = room6;
  else if (room4.available) selectedRoom = room4;
  if (!selectedRoom) { await pushMessage(userId, date + ' ' + startTime + '-' + endTime + ' は両方の会議室が埋まっています。'); return; }
  const cancelDeadline = calcCancelDeadline(date, startTime);
  pendingConfirmations.set(userId, { date, startTime, endTime, roomId: selectedRoom.id, roomName: selectedRoom.name });
  setTimeout(() => pendingConfirmations.delete(userId), 5 * 60 * 1000);
  const msg = [selectedRoom.name + ' が空いています', '日時: ' + date + ' ' + startTime + '-' + endTime, 'キャンセル期限: ' + cancelDeadline, '', '予約しますか？（OK / いいえ）'].join('\n');
  await pushMessage(userId, msg);
}

async function handleCheckOnly(replyToken, userId, text) {
  const cleaned = text.replace(/^空き\s*/, '');
  const parsed = parseDateTime(cleaned);
  if (!parsed) { await reply(replyToken, '日時を認識できませんでした。\n例: 空き 4/10 14:00-15:00'); return; }
  const { date, startTime, endTime } = parsed;
  await reply(replyToken, date + ' ' + startTime + '-' + endTime + ' の空き状況を確認中...');
  const availability = await checkAvailability(date, startTime, endTime);
  const lines = availability.rooms.map(r => r.name + ': ' + (r.available ? '空き' : '埋まり'));
  await pushMessage(userId, [date + ' ' + startTime + '-' + endTime, ...lines].join('\n'));
}

async function handleList(replyToken, userId) {
  await reply(replyToken, '予約一覧を取得中...');
  const reservations = await getReservations();
  if (reservations.length === 0) { await pushMessage(userId, '現在の予約はありません'); return; }
  const lines = reservations.map(r => r.date + ' ' + r.time + '\n' + r.room + ' PW:' + r.password);
  await pushMessage(userId, '予約一覧\n\n' + lines.join('\n\n'));
}

async function handleCancel(replyToken, userId, text) {
  const cleaned = text.replace(/^(取消|キャンセル)\s*/, '');
  const parsed = parseDateTime(cleaned);
  if (!parsed) { await reply(replyToken, '日時を認識できませんでした。\n例: 取消 4/10 14:00'); return; }
  const now = new Date();
  const startDateTime = new Date(parsed.date + 'T' + parsed.startTime + ':00');
  const deadline = new Date(startDateTime.getTime() - 2 * 60 * 60 * 1000);
  if (now > deadline) { await reply(replyToken, 'キャンセル期限（開始2時間前: ' + formatDateTime(deadline) + '）を過ぎています。'); return; }
  await reply(replyToken, 'キャンセル中...');
  const result = await cancelReservation(parsed.date, parsed.startTime);
  if (result.success) await pushMessage(userId, 'キャンセル完了しました');
  else await pushMessage(userId, 'キャンセル失敗: ' + result.error);
}

function parseDateTime(text) {
  const patterns = [/(d{4}[-\/]\d{1,2}[-\/]\d{1,2})\s+(\d{1,2}:\d{2})\s*[-~〜]\s*(\d{1,2}:\d{2})/, /(\d{1,2}\/\d{1,2})\s+(\d{1,2}:\d{2})\s*[-~〜]\s*(\d{1,2}:\d{2})/, /(\d{1,2}\/\d{1,2})\s+(\d{1,2}:\d{2})/];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      let date = match[1]; const startTime = match[2]; const endTime = match[3] || addHour(startTime);
      if (date.match(/^\d{1,2}\/\d{1,2}$/)) { const [m, d] = date.split('/'); const year = new Date().getFullYear(); date = year + '-' + m.padStart(2, '0') + '-' + d.padStart(2, '0'); }
      date = date.replace(/\//g, '-');
      return { date, startTime: padTime(startTime), endTime: padTime(endTime) };
    }
  }
  return null;
}

function padTime(t) { const [h, m] = t.split(':'); return h.padStart(2, '0') + ':' + m; }
function addHour(time) { const [h, m] = time.split(':').map(Number); return String(h + 1).padStart(2, '0') + ':' + String(m).padStart(2, '0'); }
function calcCancelDeadline(date, startTime) { const dt = new Date(date + 'T' + startTime + ':00'); dt.setHours(dt.getHours() - 2); return formatDateTime(dt); }
function formatDateTime(dt) { return (dt.getMonth() + 1) + '/' + dt.getDate() + ' ' + String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0'); }

async function reply(replyToken, text) { return client.replyMessage({ replyToken, messages: [{ type: 'text', text }] }); }
async function pushMessage(userId, text) { if (!userId) return; return client.pushMessage({ to: userId, messages: [{ type: 'text', text }] }); }

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('Server running on port ' + port));
