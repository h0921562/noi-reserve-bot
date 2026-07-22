const express = require('express');
const line = require('@line/bot-sdk');
const { checkAvailability, makeReservation, getReservations, cancelReservation } = require('./reserve');
const { handleAudioMessage, handleMinutesText } = require('./minutes');
const { parseDateTime, stripCancelKeyword, zen2han } = require('./datetime');

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

const app = express();

// Webhook endpoint
app.use('/webhook', express.json());
app.post('/webhook', (req, res) => {
  res.status(200).end();
  console.log('Webhook received:', JSON.stringify(req.body && req.body.events ? req.body.events.map(e => e.message && e.message.type) : 'no events'));
  if (req.body && req.body.events) {
    Promise.all(req.body.events.map(async (event) => {
      try {
        await handleEvent(event);
      } catch (err) {
        console.error('handleEvent error:', err);
        // デバッグ: エラーをLINEに通知
        const uid = event.source && event.source.userId;
        if (uid) {
          pushMessage(uid, 'エラー: ' + (err.message || String(err)).substring(0, 300)).catch(() => {});
        }
      }
    }));
  }
});

// Health check
app.get('/', (req, res) => res.send('OK'));

// 確認待ち状態を管理（userId -> 予約情報）
const pendingConfirmations = new Map();

// 取消の選択待ち・確認待ち状態（userId -> { list } または { confirm }）
const pendingCancels = new Map();

function setPendingCancel(userId, state) {
  pendingCancels.set(userId, state);
  setTimeout(function () { pendingCancels.delete(userId); }, 5 * 60 * 1000);
}

async function handleEvent(event) {
  if (event.type !== 'message') return;

  // デバッグ: 全メッセージタイプをログ
  const uid = event.source && event.source.userId;
  console.log('Event received:', event.message.type, 'from:', uid);

  // 音声・動画メッセージ → 議事録機能
  if (event.message.type === 'audio' || event.message.type === 'video') {
    await handleAudioMessage(event, config.channelAccessToken, pushMessage, reply);
    return;
  }

  // ファイルメッセージ（m4aファイルを直接送った場合）
  if (event.message.type === 'file') {
    const fname = event.message.fileName || '';
    if (/\.(m4a|mp3|wav|ogg|mp4|aac|flac|webm)$/i.test(fname)) {
      await handleAudioMessage(event, config.channelAccessToken, pushMessage, reply);
      return;
    }
  }

  if (event.message.type !== 'text') {
    // 未対応のメッセージタイプをデバッグ通知
    if (uid) await pushMessage(uid, 'メッセージタイプ: ' + event.message.type).catch(() => {});
    return;
  }

  const text = event.message.text.trim();
  const userId = event.source.userId;
  const replyToken = event.replyToken;

  // グループの場合はメンションされてるかチェック（確認待ちユーザーは除く）
  if (event.source.type === 'group' || event.source.type === 'room') {
    const mention = event.message.mention;
    if (!mention && !text.startsWith('@') && !pendingConfirmations.has(userId) && !pendingCancels.has(userId)) return;
  }

  // メンション部分を除去
  const cleanText = text.replace(/@\S+\s*/g, '').trim();

  try {
    // 取消の選択待ち・確認待ちの処理（予約の確認待ちより先に見る）
    if (pendingCancels.has(userId)) {
      const st = pendingCancels.get(userId);
      if (/^(いいえ|いや|やめる|やめ|中止|no|NO)$/i.test(cleanText)) {
        pendingCancels.delete(userId);
        await reply(replyToken, '取消をやめました');
        return;
      }
      if (st.list) {
        const n = parseInt(zen2han(cleanText).replace(/[^\d]/g, ''), 10);
        if (n >= 1 && n <= st.list.length) {
          pendingCancels.delete(userId);
          const r = st.list[n - 1];
          await executeCancel(replyToken, userId, r.date, (r.time || '').split('~')[0],
            r.date + ' ' + r.time + ' ' + r.room);
          return;
        }
        await reply(replyToken, '1〜' + st.list.length + ' の番号で選んでください（やめる場合は「いいえ」）');
        return;
      }
      if (st.confirm) {
        if (/^(はい|ok|OK|うん|了解|yes)$/i.test(cleanText)) {
          pendingCancels.delete(userId);
          await executeCancel(replyToken, userId, st.confirm.date, st.confirm.startTime, st.confirm.label);
          return;
        }
        await reply(replyToken, st.confirm.label + ' を取り消しますか？（はい / いいえ）');
        return;
      }
    }

    // 確認待ち状態の処理
    if (pendingConfirmations.has(userId)) {
      if (['ok', 'OK', 'はい', 'うん', 'おk', 'yes'].includes(cleanText)) {
        const info = pendingConfirmations.get(userId);
        pendingConfirmations.delete(userId);
        await reply(replyToken, '予約中...');

        const result = await makeReservation(info.date, info.startTime, info.endTime, info.roomId);
        if (result.success) {
          const cancelDeadline = calcCancelDeadline(info.date, info.startTime);
          const msg = [
            '予約完了',
            `${info.roomName} / ${info.date} ${info.startTime}-${info.endTime}`,
            result.password ? `パスワード: ${result.password}` : '',
            `キャンセル期限: ${cancelDeadline}`,
          ].filter(Boolean).join('\n');
          await pushMessage(userId, msg);
        } else {
          await pushMessage(userId, `予約失敗: ${result.error}`);
        }
        return;
      } else if (/(?:^[4４]$|4\s*(?:階|かい|カイ|f|F)|よん\s*(?:階|かい|カイ)|よんかい|４\s*(?:階|かい|カイ|f|F))/.test(cleanText)) {
        const info = pendingConfirmations.get(userId);
        if (info.roomId === '25') {
          await reply(replyToken, 'すでに4階で提案しています。予約しますか？（OK / いいえ）');
          return;
        }
        const availability = await checkAvailability(info.date, info.startTime, info.endTime);
        const room4 = availability.rooms.find(r => r.id === '25');
        if (room4 && room4.available) {
          info.roomId = room4.id;
          info.roomName = room4.name;
          pendingConfirmations.set(userId, info);
          const cancelDeadline = calcCancelDeadline(info.date, info.startTime);
          await reply(replyToken, `${room4.name}に変更します\n日時: ${info.date} ${info.startTime}-${info.endTime}\nキャンセル期限: ${cancelDeadline}\n\n予約しますか？（OK / いいえ）`);
        } else {
          await reply(replyToken, '4階は埋まっています。6階で予約しますか？（OK / いいえ）');
        }
        return;
      } else if (/(?:^[6６]$|6\s*(?:階|かい|カイ|f|F)|ろく\s*(?:階|かい|カイ)|ろっかい|ろくかい|６\s*(?:階|かい|カイ|f|F))/.test(cleanText)) {
        const info = pendingConfirmations.get(userId);
        if (info.roomId === '42') {
          await reply(replyToken, 'すでに6階で提案しています。予約しますか？（OK / いいえ）');
          return;
        }
        const availability = await checkAvailability(info.date, info.startTime, info.endTime);
        const room6 = availability.rooms.find(r => r.id === '42');
        if (room6 && room6.available) {
          info.roomId = room6.id;
          info.roomName = room6.name;
          pendingConfirmations.set(userId, info);
          const cancelDeadline = calcCancelDeadline(info.date, info.startTime);
          await reply(replyToken, `${room6.name}に変更します\n日時: ${info.date} ${info.startTime}-${info.endTime}\nキャンセル期限: ${cancelDeadline}\n\n予約しますか？（OK / いいえ）`);
        } else {
          await reply(replyToken, '6階は埋まっています。4階で予約しますか？（OK / いいえ）');
        }
        return;
      } else if (/^(いいえ|いや|やめる|no|やめ|なし|キャンセル|やめとく|やっぱ|やっぱり)/.test(cleanText) || /(?:キャンセル|やめ|いらない|なし|けし|消し|消す|消して|とりけし)/.test(cleanText)) {
        pendingConfirmations.delete(userId);
        await reply(replyToken, 'キャンセルしました');
        return;
      } else {
        const info = pendingConfirmations.get(userId);
        await reply(replyToken, info.roomName + ' / ' + info.date + ' ' + info.startTime + '-' + info.endTime + '\n予約しますか？（OK / いいえ）');
        return;
      }
    }

    // 議事録セッション中のテキスト処理
    const handled = await handleMinutesText(userId, cleanText, pushMessage);
    if (handled) return;

    // コマンド分岐
    if (/^(予約一覧|一覧|予約みせて|予約見せて|予約ある|予約確認|リスト)/.test(cleanText)) {
      await handleList(replyToken, userId);
    } else if (/(?:取消|キャンセル|やめたい|けし|消し|消す|消して|とりけし|とりやめ|取りやめ|取り消)/.test(cleanText)) {
      await handleCancel(replyToken, userId, cleanText);
    } else if (cleanText.startsWith('空き')) {
      await handleCheckOnly(replyToken, cleanText);
    } else {
      // 予約リクエスト（日時パース）
      await handleReserve(replyToken, userId, cleanText);
    }
  } catch (err) {
    console.error('Error handling event:', err);
    const errMsg = 'エラー: ' + (err.message || String(err)).substring(0, 300);
    await reply(replyToken, errMsg).catch(() =>
      pushMessage(userId, errMsg).catch(() => {})
    );
  }
}

// 予約リクエスト処理
async function handleReserve(replyToken, userId, text) {
  const parsed = parseDateTime(text);
  if (!parsed) {
    await reply(replyToken, '日時を認識できませんでした。\n例: 4/10 14:00-15:00');
    return;
  }

  const { date, startTime, endTime } = parsed;

  await reply(replyToken, `${date} ${startTime}-${endTime} の空き状況を確認中...`);

  let availability;
  try {
    availability = await checkAvailability(date, startTime, endTime);
  } catch (err) {
    console.error('checkAvailability error:', err);
    await pushMessage(userId, '予約サイトへの接続に失敗しました: ' + (err.message || String(err)).substring(0, 200));
    return;
  }

  const room6 = availability.rooms.find(r => r.id === '42');
  const room4 = availability.rooms.find(r => r.id === '25');

  // 階数指定があればそちらを優先、なければ6階優先
  const prefer4 = /(?:4\s*(?:階|かい|カイ|f|F)|よん\s*(?:階|かい|カイ)|よんかい|４\s*(?:階|かい|カイ|f|F))/.test(text);
  let selectedRoom = null;
  if (prefer4) {
    if (room4.available) selectedRoom = room4;
    else if (room6.available) selectedRoom = room6;
  } else {
    if (room6.available) selectedRoom = room6;
    else if (room4.available) selectedRoom = room4;
  }

  if (!selectedRoom) {
    await pushMessage(userId, `${date} ${startTime}-${endTime} は両方の会議室が埋まっています。`);
    return;
  }

  const cancelDeadline = calcCancelDeadline(date, startTime);

  // 確認待ち状態を保存
  pendingConfirmations.set(userId, {
    date,
    startTime,
    endTime,
    roomId: selectedRoom.id,
    roomName: selectedRoom.name,
  });

  // 5分後に自動キャンセル
  setTimeout(() => pendingConfirmations.delete(userId), 5 * 60 * 1000);

  const otherRoom = selectedRoom.id === '42' ? room4 : room6;
  const msg = [
    `${selectedRoom.name} が空いています`,
    otherRoom ? `${otherRoom.name}: ${otherRoom.available ? '空き' : '埋まり'}` : '',
    `日時: ${date} ${startTime}-${endTime}`,
    `キャンセル期限: ${cancelDeadline}`,
    '',
    `${selectedRoom.name}を予約しますか？（OK / いいえ）`,
  ].filter(Boolean).join('\n');

  await pushMessage(userId, msg);
}

// 空き確認のみ
async function handleCheckOnly(replyToken, text) {
  const cleaned = text.replace(/^空き\s*/, '');
  const parsed = parseDateTime(cleaned);
  if (!parsed) {
    await reply(replyToken, '日時を認識できませんでした。\n例: 空き 4/10 14:00-15:00');
    return;
  }

  const { date, startTime, endTime } = parsed;
  await reply(replyToken, `${date} ${startTime}-${endTime} の空き状況を確認中...`);

  const availability = await checkAvailability(date, startTime, endTime);

  const lines = availability.rooms.map(r =>
    `${r.name}: ${r.available ? '空き' : '埋まり'}`
  );
  await pushMessage(null, [`${date} ${startTime}-${endTime}`, ...lines].join('\n'));
}

// 予約一覧
async function handleList(replyToken, userId) {
  await reply(replyToken, '予約一覧を取得中...');

  const reservations = await getReservations();
  if (reservations.length === 0) {
    await pushMessage(userId, '現在の予約はありません');
    return;
  }

  const lines = reservations.map(r =>
    `${r.date} ${r.time}\n${r.room} PW:${r.password}`
  );
  await pushMessage(userId, '予約一覧\n\n' + lines.join('\n\n'));
}

// キャンセル処理
async function handleCancel(replyToken, userId, text) {
  // 取消語を「その場で」除去する。旧実装は取消語より前を全部削っていたため、
  // 「7/22 14時をキャンセル」のように日時が先に来る自然な語順で日時ごと消えていた。
  const cleaned = stripCancelKeyword(text);
  const parsed = parseDateTime(cleaned);

  // 日時が読めなかった場合は予約一覧から選ばせる
  if (!parsed) {
    const reservations = await getReservations();
    if (reservations.length === 0) {
      await sendResult(replyToken, userId, '現在の予約はありません');
      return;
    }
    // 1件だけでも即実行はしない。利用者が指定した日時を読めていない以上、
    // botが対象を推測している状態であり、取消は不可逆で課金もありうる
    if (reservations.length === 1) {
      const r = reservations[0];
      await askCancelConfirm(replyToken, userId, r.date, (r.time || '').split('~')[0],
        r.date + ' ' + r.time + ' ' + r.room);
      return;
    }
    // 複数件は番号で選ばせる。選択待ち状態を保持しないと番号を受け取れない
    const lines = reservations.map(function (r, i) {
      return (i + 1) + '. ' + r.date + ' ' + r.time + ' ' + r.room;
    });
    setPendingCancel(userId, { list: reservations });
    await sendResult(replyToken, userId,
      'どの予約を取り消しますか？\n\n' + lines.join('\n') + '\n\n番号を送ってください（やめる場合は「いいえ」）');
    return;
  }

  const label = parsed.date + ' ' + parsed.startTime;
  const deadlineMs = jstToMs(parsed.date, parsed.startTime) - 2 * 60 * 60 * 1000;

  // 期限を過ぎた取消は課金される。実行せず確認を取る
  if (Date.now() > deadlineMs) {
    await askCancelConfirm(replyToken, userId, parsed.date, parsed.startTime, label);
    return;
  }

  await executeCancel(replyToken, userId, parsed.date, parsed.startTime, label);
}

// 取消前の確認。期限を過ぎている場合は課金される旨も伝える
async function askCancelConfirm(replyToken, userId, date, startTime, label) {
  const deadlineMs = jstToMs(date, startTime) - 2 * 60 * 60 * 1000;
  const late = Date.now() > deadlineMs;
  setPendingCancel(userId, { confirm: { date: date, startTime: startTime, label: label } });
  await sendResult(replyToken, userId,
    (late
      ? 'キャンセル期限（開始2時間前: ' + formatDateTime(deadlineMs) + '）を過ぎています。\n取り消すと料金が発生します。\n\n'
      : '') +
    label + ' を取り消しますか？（はい / いいえ）');
}

async function executeCancel(replyToken, userId, date, startTime, label) {
  const result = await cancelReservation(date, startTime);
  await sendResult(replyToken, userId,
    result.success ? label + ' を取り消しました' : '取消に失敗しました: ' + result.error);
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 'YYYY-MM-DD' と 'HH:MM' を JST として解釈しミリ秒に変換する。
// new Date('2026-07-22T14:00:00') はサーバのタイムゾーンで解釈されるため、
// TZ=UTC のホストだと9時間ずれる。ここではホスト設定に依存させない。
function jstToMs(date, time) {
  const p = String(date).split('-').map(Number);
  const t = String(time).split(':').map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2], t[0], t[1] || 0) - JST_OFFSET_MS;
}

function formatDateTime(ms) {
  const d = new Date(ms + JST_OFFSET_MS);
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' ' +
    String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

function calcCancelDeadline(date, startTime) {
  return formatDateTime(jstToMs(date, startTime) - 2 * 60 * 60 * 1000);
}

// 結果は応答メッセージ(reply)で返す。LINEの課金対象は push のみで、
// reply は通数にカウントされない（グループでは push が人数分カウントされる）。
// 応答トークンが切れていた場合だけ push にフォールバックする。
async function sendResult(replyToken, userId, text) {
  try {
    await reply(replyToken, text);
  } catch (err) {
    console.error('reply failed, falling back to push:', err && err.message);
    await pushMessage(userId, text).catch(function () {});
  }
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
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  // 14分ごとにセルフpingしてスリープ防止
  setInterval(function() {
    require('axios').get('https://noi-reserve-bot.onrender.com/').catch(function() {});
  }, 14 * 60 * 1000);
});
