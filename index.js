const express = require('express');
const line = require('@line/bot-sdk');
const { checkAvailability, makeReservation, getReservations, cancelReservation } = require('./reserve');
const { handleAudioMessage, handleMinutesText } = require('./minutes');

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
    if (!mention && !text.startsWith('@') && !pendingConfirmations.has(userId)) return;
  }

  // メンション部分を除去
  const cleanText = text.replace(/@\S+\s*/g, '').trim();

  try {
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
    await reply(replyToken, 'エラーが発生しました。もう一度お試しください。').catch(() => {});
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

  const availability = await checkAvailability(date, startTime, endTime);

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
  const cleaned = text.replace(/.*?(?:取消|キャンセル|やめたい|けし|消し|消す|消して|とりけし|とりやめ|取りやめ|取り消)\s*/, '').replace(/(?:て|して|したい|お願い|ください|頼む|よろしく)\s*$/, '').trim();
  const parsed = parseDateTime(cleaned);

  // 日時指定がない場合、予約が1件なら自動でそれをキャンセル
  if (!parsed) {
    await reply(replyToken, 'キャンセル処理中...');
    const reservations = await getReservations();
    if (reservations.length === 0) {
      await pushMessage(userId, '現在の予約はありません');
      return;
    }
    if (reservations.length === 1) {
      const r = reservations[0];
      const result = await cancelReservation(r.date, (r.time || '').split('~')[0]);
      if (result.success) {
        await pushMessage(userId, r.date + ' ' + r.time + ' ' + r.room + ' をキャンセルしました');
      } else {
        await pushMessage(userId, 'キャンセル失敗: ' + result.error);
      }
      return;
    }
    // 複数件ある場合は番号で選ばせる
    const lines = reservations.map(function(r, i) { return (i + 1) + '. ' + r.date + ' ' + r.time + ' ' + r.room; });
    await pushMessage(userId, 'どの予約をキャンセルしますか？\n\n' + lines.join('\n') + '\n\n番号または日時を送ってください');
    return;
  }

  // キャンセル期限チェック
  const now = new Date();
  const startDateTime = new Date(`${parsed.date}T${parsed.startTime}:00`);
  const deadline = new Date(startDateTime.getTime() - 2 * 60 * 60 * 1000);

  if (now > deadline) {
    await reply(replyToken, `キャンセル期限（開始2時間前: ${formatDateTime(deadline)}）を過ぎています。キャンセルすると料金が発生します。\n本当にキャンセルしますか？`);
    // TODO: 強制キャンセル確認フロー
    return;
  }

  await reply(replyToken, 'キャンセル中...');

  const result = await cancelReservation(parsed.date, parsed.startTime);
  if (result.success) {
    await pushMessage(userId, 'キャンセル完了しました');
  } else {
    await pushMessage(userId, `キャンセル失敗: ${result.error}`);
  }
}

// 全角→半角変換
function zen2han(str) {
  return str.replace(/[０-９]/g, function(s) {
    return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
  }).replace(/[：／～ー]/g, function(s) {
    return { '：': ':', '／': '/', '～': '~', 'ー': '-' }[s] || s;
  });
}

// ひらがな数字→半角数字
const KANA_NUMS = {
  'いち': '1', 'に': '2', 'さん': '3', 'よん': '4', 'し': '4', 'ご': '5',
  'ろく': '6', 'なな': '7', 'しち': '7', 'はち': '8', 'きゅう': '9', 'く': '9',
  'じゅう': '10', 'じゅういち': '11', 'じゅうに': '12', 'じゅうさん': '13',
  'じゅうよん': '14', 'じゅうし': '14', 'じゅうご': '15', 'じゅうろく': '16',
  'じゅうなな': '17', 'じゅうしち': '17', 'じゅうはち': '18', 'じゅうきゅう': '19', 'じゅうく': '19',
  'にじゅう': '20', 'にじゅういち': '21', 'にじゅうに': '22', 'にじゅうさん': '23',
  'にじゅうよん': '24', 'にじゅうご': '25', 'にじゅうろく': '26', 'にじゅうなな': '27',
  'にじゅうはち': '28', 'にじゅうきゅう': '29', 'にじゅうく': '29',
  'さんじゅう': '30', 'さんじゅういち': '31',
};

// カタカナ→ひらがな
function kata2hira(str) {
  return str.replace(/[\u30A1-\u30F6]/g, function(s) {
    return String.fromCharCode(s.charCodeAt(0) - 0x60);
  });
}

// ひらがな数字文字列を数値に変換
function kanaToNum(str) {
  var s = kata2hira(str).trim();
  if (KANA_NUMS[s] !== undefined) return parseInt(KANA_NUMS[s]);
  return NaN;
}

// 時間文字列を正規化（14→14:00, 1430→14:30, 14:00→14:00）
function normalizeTime(t) {
  t = t.replace(/[:\s]/g, '');
  if (t.length <= 2) return t.padStart(2, '0') + ':00';
  if (t.length === 3) return '0' + t[0] + ':' + t.substring(1);
  if (t.length === 4) return t.substring(0, 2) + ':' + t.substring(2);
  return t;
}

// YYYY-MM-DD形式でフォーマット
function formatDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 次の指定曜日の日付を返す（0=日,1=月,...6=土）
function nextWeekday(dayIndex, weeksAhead) {
  var now = new Date();
  var current = now.getDay();
  var diff = dayIndex - current;
  if (weeksAhead > 0) {
    diff += 7 * weeksAhead;
    if (diff <= 7 * weeksAhead - 7) diff += 7;
  } else {
    if (diff <= 0) diff += 7;
  }
  var target = new Date(now);
  target.setDate(now.getDate() + diff);
  return target;
}

// 曜日名→曜日インデックス
const WEEKDAY_MAP = {
  '月': 1, 'げつ': 1, 'ゲツ': 1,
  '火': 2, 'か': 2, 'カ': 2,
  '水': 3, 'すい': 3, 'スイ': 3,
  '木': 4, 'もく': 4, 'モク': 4,
  '金': 5, 'きん': 5, 'キン': 5,
  '土': 6, 'ど': 6, 'ド': 6,
  '日': 0, 'にち': 0, 'ニチ': 0,
};

// 月名（ひらがな）→月番号
const MONTH_KANA = {
  'いちがつ': 1, 'にがつ': 2, 'さんがつ': 3, 'しがつ': 4, 'ごがつ': 5, 'ろくがつ': 6,
  'しちがつ': 7, 'なながつ': 7, 'はちがつ': 8, 'くがつ': 9, 'きゅうがつ': 9,
  'じゅうがつ': 10, 'じゅういちがつ': 11, 'じゅうにがつ': 12,
};

// 時間のひらがな/漢字表現を数字に変換 (じゅうよじ→14, 9じ→9)
function parseTimeKana(str) {
  var s = kata2hira(str).trim();
  // 「〜じ」「〜時」で終わる部分を取り出す
  var m = s.match(/^(.+?)(?:じ|時)$/);
  if (!m) return NaN;
  var numPart = m[1];
  // まず数字か試す
  if (/^\d{1,2}$/.test(numPart)) return parseInt(numPart);
  // ひらがな数字
  return kanaToNum(numPart);
}

// 日時パーサー
function parseDateTime(text) {
  text = zen2han(text);
  var hiraText = kata2hira(text);

  var date = null;
  var remaining = text;

  // --- 相対日パース ---
  var relativePatterns = [
    { pattern: /(?:今日|きょう|キョウ)/, offset: 0 },
    { pattern: /(?:明日|あした|あす|アシタ|アス)/, offset: 1 },
    { pattern: /(?:明後日|あさって|アサッテ)/, offset: 2 },
  ];
  for (var rp of relativePatterns) {
    var rm = text.match(rp.pattern);
    if (rm) {
      var d = new Date();
      d.setDate(d.getDate() + rp.offset);
      date = formatDate(d);
      remaining = text.substring(rm.index + rm[0].length).trim();
      break;
    }
  }

  // --- 曜日パース（来週X曜、X曜）---
  if (!date) {
    var weekdayMatch = text.match(/(?:(来週|らいしゅう|ライシュウ)\s*)?([月火水木金土日]|げつ|か|すい|もく|きん|ど|にち|ゲツ|カ|スイ|モク|キン|ド|ニチ)(?:よう(?:び|日)?|曜(?:日)?)?/);
    if (weekdayMatch) {
      var isNextWeek = !!weekdayMatch[1];
      var dayKey = weekdayMatch[2];
      var dayIdx = WEEKDAY_MAP[dayKey] !== undefined ? WEEKDAY_MAP[dayKey] : WEEKDAY_MAP[kata2hira(dayKey)];
      if (dayIdx !== undefined) {
        var target = nextWeekday(dayIdx, isNextWeek ? 1 : 0);
        date = formatDate(target);
        remaining = text.substring(weekdayMatch.index + weekdayMatch[0].length).trim();
      }
    }
  }

  // --- 来月Xにち ---
  if (!date) {
    var nextMonthMatch = text.match(/(?:来月|らいげつ|ライゲツ)\s*(\d{1,2})(?:日|にち)?/);
    if (nextMonthMatch) {
      var nd = new Date();
      nd.setMonth(nd.getMonth() + 1);
      nd.setDate(parseInt(nextMonthMatch[1]));
      date = formatDate(nd);
      remaining = text.substring(nextMonthMatch.index + nextMonthMatch[0].length).trim();
    }
  }

  // --- ひらがな月日（しがつじゅうにち等）---
  if (!date) {
    for (var mk in MONTH_KANA) {
      var monthIdx = hiraText.indexOf(mk);
      if (monthIdx >= 0) {
        var monthNum = MONTH_KANA[mk];
        var afterMonth = hiraText.substring(monthIdx + mk.length);
        // 日の部分を取得（ひらがな数字 or 数字 + にち/日）
        var dayNum = null;
        var dayMatchLen = 0;
        // 数字+にち/日
        var dayDigit = afterMonth.match(/^(\d{1,2})(?:にち|日)?/);
        if (dayDigit) {
          dayNum = parseInt(dayDigit[1]);
          dayMatchLen = dayDigit[0].length;
        } else {
          // ひらがな数字+にち/日
          for (var kn in KANA_NUMS) {
            if (afterMonth.startsWith(kn + 'にち') || afterMonth.startsWith(kn + '日')) {
              dayNum = parseInt(KANA_NUMS[kn]);
              dayMatchLen = kn.length + (afterMonth.startsWith(kn + 'にち') ? 2 : 1);
              break;
            }
            if (afterMonth.startsWith(kn)) {
              dayNum = parseInt(KANA_NUMS[kn]);
              dayMatchLen = kn.length;
              break;
            }
          }
        }
        if (dayNum) {
          var year = new Date().getFullYear();
          var now = new Date();
          // 過去の月日なら来年
          var candidate = new Date(year, monthNum - 1, dayNum);
          if (candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
            year++;
          }
          date = year + '-' + String(monthNum).padStart(2, '0') + '-' + String(dayNum).padStart(2, '0');
          remaining = text.substring(0, monthIdx) + text.substring(monthIdx + mk.length + dayMatchLen);
          remaining = remaining.trim();
          break;
        }
      }
    }
  }

  // --- 漢字月日（4月10日 等）---
  if (!date) {
    var kanjiDateMatch = text.match(/(\d{1,2})月(\d{1,2})日?/);
    if (kanjiDateMatch) {
      var km = parseInt(kanjiDateMatch[1]);
      var kd = parseInt(kanjiDateMatch[2]);
      var ky = new Date().getFullYear();
      var kcandidate = new Date(ky, km - 1, kd);
      if (kcandidate < new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())) {
        ky++;
      }
      date = ky + '-' + String(km).padStart(2, '0') + '-' + String(kd).padStart(2, '0');
      remaining = text.substring(kanjiDateMatch.index + kanjiDateMatch[0].length).trim();
    }
  }

  // --- 数字日付（4/10, 2026-4-10 等）---
  if (!date) {
    var datePatterns = [
      /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/,
      /(\d{1,2}\/\d{1,2})/,
    ];
    for (var dp of datePatterns) {
      var dateMatch = text.match(dp);
      if (dateMatch) {
        date = dateMatch[1];
        remaining = text.substring(dateMatch.index + dateMatch[0].length).trim();
        break;
      }
    }
  }

  if (!date) return null;

  // --- 時間パース ---
  // 時間部分を探す（コロンあり・なし両対応）
  var timePattern = /(\d{1,4}(?::\d{2})?)\s*[-~\u301c]\s*(\d{1,4}(?::\d{2})?)/;
  var singleTimePattern = /(\d{1,4}(?::\d{2})?)/;

  var startTime, endTime;
  var rangeMatch = remaining.match(timePattern);
  if (rangeMatch) {
    startTime = normalizeTime(rangeMatch[1]);
    endTime = normalizeTime(rangeMatch[2]);
  } else {
    // 「じゅうよじ」「14じ」等のひらがな時間
    var kanaTimeRange = remaining.match(/(.+?)\s*[-~\u301cから]\s*(.+)/);
    if (kanaTimeRange) {
      var st = parseTimeKana(kanaTimeRange[1]);
      var et = parseTimeKana(kanaTimeRange[2]);
      if (!isNaN(st) && !isNaN(et)) {
        startTime = String(st).padStart(2, '0') + ':00';
        endTime = String(et).padStart(2, '0') + ':00';
      }
    }
    if (!startTime) {
      // 「X時からY時」パターン（数字+時）
      var jiRange = remaining.match(/(\d{1,2})時\s*[-~\u301cから]\s*(\d{1,2})時/);
      if (jiRange) {
        startTime = String(parseInt(jiRange[1])).padStart(2, '0') + ':00';
        endTime = String(parseInt(jiRange[2])).padStart(2, '0') + ':00';
      }
    }
    if (!startTime) {
      // 「X時半からY時」等（半=30分）
      var jiHanRange = remaining.match(/(\d{1,2})時半\s*[-~\u301cから]\s*(\d{1,2})時(?:半)?/);
      if (jiHanRange) {
        startTime = String(parseInt(jiHanRange[1])).padStart(2, '0') + ':30';
        var eHalf = remaining.includes(jiHanRange[2] + '時半');
        endTime = String(parseInt(jiHanRange[2])).padStart(2, '0') + (eHalf ? ':30' : ':00');
      }
    }
    if (!startTime) {
      // 数字単体
      var singleMatch = remaining.match(singleTimePattern);
      if (singleMatch) {
        startTime = normalizeTime(singleMatch[1]);
        endTime = addHour(startTime);
      } else {
        // ひらがな単体時間
        var kst = parseTimeKana(remaining);
        if (!isNaN(kst)) {
          startTime = String(kst).padStart(2, '0') + ':00';
          endTime = addHour(startTime);
        }
      }
    }
    if (!startTime) return null;
  }

  // 月/日 → YYYY-MM-DD
  if (date.match(/^\d{1,2}\/\d{1,2}$/)) {
    var parts = date.split('/');
    var yr = new Date().getFullYear();
    var cand = new Date(yr, parseInt(parts[0]) - 1, parseInt(parts[1]));
    if (cand < new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())) {
      yr++;
    }
    date = yr + '-' + parts[0].padStart(2, '0') + '-' + parts[1].padStart(2, '0');
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
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  // 14分ごとにセルフpingしてスリープ防止
  setInterval(function() {
    require('axios').get('https://noi-reserve-bot.onrender.com/').catch(function() {});
  }, 14 * 60 * 1000);
});
