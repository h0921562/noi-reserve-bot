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

// Health check（セルフpingがここを叩くので応答は変えない）
app.get('/', (req, res) => res.send('OK'));

// デプロイ確認用。どのビルドが動いているかを外から判別するために置く。
// 秘密情報は返さない。TZ は日付計算の前提確認に使う
const BUILD = '2026-07-22-critic-r4';
app.get('/version', (req, res) => res.json({
  build: BUILD,
  commit: process.env.RENDER_GIT_COMMIT || null,
  tz: process.env.TZ || null,
  serverTime: new Date().toISOString(),
  node: process.version,
}));

// 確認待ち状態を管理（userId -> 予約情報）
const pendingConfirmations = new Map();

// 取消の選択待ち・確認待ち状態（userId -> { list } または { confirm }）
const pendingCancels = new Map();

// 会話状態をどのトークで作ったかを表す。userId だけで持つと、DMで始めた
// 取消の確認に、グループでの何気ない「はい」が答えてしまう
function ctxOf(event) {
  const s = event.source || {};
  return (s.groupId || s.roomId || 'dm') + ':' + (s.userId || '');
}

let cancelStateGen = 0;
function setPendingCancel(userId, ctx, state) {
  state.ctx = ctx;
  const gen = (state.gen = ++cancelStateGen);
  pendingCancels.set(userId, state);
  // 状態を更新するたびにタイマーが積み上がる。世代を照合しないと、
  // 古いタイマーが数十秒前に作られた新しい状態を消してしまう
  setTimeout(function () {
    const cur = pendingCancels.get(userId);
    if (cur && cur.gen === gen) pendingCancels.delete(userId);
  }, 5 * 60 * 1000);
}

// 取消の意図を示す語。ルータと「確認待ち中の言い直し」判定で共有する
const CANCEL_RE = /(?:取消|取り消|キャンセ[ルるりらろっ]*|とりけし|とりやめ|取りやめ|やめたい|消して|消しとい|消去)/;

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

  const ctx = ctxOf(event);
  // 状態は「同じトークで作られたもの」だけを使う。別トークからの返答は無関係とみなす
  const cancelState = pendingCancels.get(userId);
  const confirmState = pendingConfirmations.get(userId);
  const hasCancelState = !!(cancelState && cancelState.ctx === ctx);
  const hasConfirmState = !!(confirmState && confirmState.ctx === ctx);

  // グループの場合はメンションされてるかチェック（確認待ちユーザーは除く）
  if (event.source.type === 'group' || event.source.type === 'room') {
    const mention = event.message.mention;
    const waiting = hasConfirmState || hasCancelState;
    const mentionees = (mention && Array.isArray(mention.mentionees)) ? mention.mentionees : [];
    // メンション先がbot自身かを見る。以前は誰宛でも起動していたため、
    // 同僚宛の雑談で予約提案が立ち上がり push 枠も消費していた。
    // isSelf を返さない環境では判定できないので従来どおり反応する（保守的）
    const toBot = mentionees.some(function (m) { return m.isSelf === true || m.type === 'all'; });
    const toOthersOnly = mentionees.length > 0 && !toBot &&
      mentionees.every(function (m) { return m.isSelf === false; });
    // 他人宛は待機中でも無視する。待機中を素通りさせると、実行寸前の利用者が
    // 同僚に返した「はい」で取消が確定してしまう
    if (toOthersOnly) return;
    if (!mention && !text.startsWith('@') && !waiting) return;
  }

  // メンション部分を除去
  const cleanText = text.replace(/@\S+\s*/g, '').trim();

  try {
    // 取消の選択待ち・確認待ちの処理（予約の確認待ちより先に見る）
    if (hasCancelState) {
      const st = cancelState;
      // 「やっぱりキャンセルするのやめる」のような中止は、完全一致だと拾えず
      // CANCEL_RE の「キャンセ」に先に当たって取消メニューに進んでしまう。
      // 日時を含まない中止表現は、取消語より先に中止として扱う
      const isAbort = /^(いいえ|いや|やめる|やめ|中止|no|NO)$/i.test(cleanText) ||
        (/やめ|中止|いらな|結構です|大丈夫です/.test(cleanText) &&
          !parseDateTime(stripCancelKeyword(cleanText)));
      if (isAbort) {
        pendingCancels.delete(userId);
        await reply(replyToken, '取消をやめました');
        return;
      }
      if (st.list) {
        // 数字だけを抜き出すと「1時のやつ」が 1番 と解釈され、別の予約を消す。
        // 番号だけが書かれている場合に限って選択とみなす
        const m = zen2han(cleanText).match(/^\s*(\d{1,2})\s*(?:番|番目)?\s*$/);
        const n = m ? parseInt(m[1], 10) : NaN;
        if (n >= 1 && n <= st.list.length) {
          const r = st.list[n - 1];
          // 選択後も即実行しない。期限超過なら課金されるため確認を挟む
          await askCancelConfirm(replyToken, userId, ctx, r.date, (r.time || '').split('~')[0],
            r.date + ' ' + r.time + ' ' + r.room, r.room);
          return;
        }
        await reply(replyToken,
          '1〜' + st.list.length + ' の番号だけを送ってください（やめる場合は「いいえ」）');
        return;
      }
      if (st.confirm) {
        if (/^(はい|ok|OK|うん|了解|yes)$/i.test(cleanText)) {
          pendingCancels.delete(userId);
          await executeCancel(replyToken, userId, st.confirm.date, st.confirm.startTime,
            st.confirm.label, st.confirm.room);
          return;
        }
        // 別の予約の取消を言い直した場合はやり直す。ただし「取消の意図が
        // 明示されている」ことを要求する。日時が読めるだけで取消に倒すと、
        // 確認中に送った予約依頼が取消確認に化け、「はい」で別の予約が消える
        if (CANCEL_RE.test(cleanText)) {
          pendingCancels.delete(userId);
          await handleCancel(replyToken, userId, ctx, cleanText);
          return;
        }
        // 取消語が無くても日時だけで言い直す人はいる。勝手に切り替えると
        // 予約依頼を取消に反転させてしまうので、切り替えずに「その日時なら
        // こう送ってください」と検出結果を提示する
        const other = parseDateTime(stripCancelKeyword(cleanText));
        const wantsReserve = /予約|押さえ|取って|とって|空き|空いて/.test(cleanText);
        await reply(replyToken,
          (wantsReserve ? '先に取消の確認にお答えください。\n\n' : '') +
          st.confirm.label + ' を取り消しますか？（はい / いいえ）\n' +
          (other && !(other.date === st.confirm.date && other.startTime === st.confirm.startTime)
            ? '※ ' + other.date + ' ' + other.startTime + ' の取消でしたら「取消 ' +
              other.date + ' ' + other.startTime + '」と送ってください'
            : '別の予約を取り消す場合は「取消 7/28 14時」のように送ってください'));
        return;
      }
    }

    // 確認待ち状態の処理
    if (hasConfirmState) {
      if (['ok', 'OK', 'はい', 'うん', 'おk', 'yes'].includes(cleanText)) {
        const info = confirmState;
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
        const info = confirmState;
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
        const info = confirmState;
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
      // 「消しゴム買ってきて」で予約提案が破棄されるため、否定は明確な語に限る
      } else if (/^(いいえ|いや|やめる|no|NO|やめ|なし|キャンセ[ルるりらろっ]*|やめとく|やっぱ|やっぱり|いらない|中止)$/i.test(cleanText)) {
        pendingConfirmations.delete(userId);
        await reply(replyToken, 'キャンセルしました');
        return;
      } else {
        const info = confirmState;
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
    // 「キャンセる」のような口語の変化形は拾うが、「消し」「消す」単体は拾わない。
    // 「議事録の消し込みの件」のような業務語で取消と誤判定され、
    // 同じ時間帯の既存予約が消える事故があったため
    } else if (/(?:取消|取り消|キャンセ[ルるりらろっ]*|とりけし|とりやめ|取りやめ|やめたい|消して|消しとい|消去)/.test(cleanText)) {
      await handleCancel(replyToken, userId, ctx, cleanText);
    } else if (cleanText.startsWith('空き')) {
      await handleCheckOnly(replyToken, userId, cleanText);
    } else {
      // 予約リクエスト（日時パース）
      await handleReserve(replyToken, userId, ctx, cleanText);
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
async function handleReserve(replyToken, userId, ctx, text) {
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
    ctx,
    date,
    startTime,
    endTime,
    roomId: selectedRoom.id,
    roomName: selectedRoom.name,
  });

  // 5分後に自動キャンセル
  setTimeout(() => pendingConfirmations.delete(userId), 5 * 60 * 1000);

  // 「4/28」のように年を書かずに過ぎた月日を送ると翌年と解釈される。
  // 実際に2027年の予約が入ってしまった事故があるため、遠い日付は警告する
  const daysAhead = Math.floor((jstToMs(date, startTime) - Date.now()) / (24 * 60 * 60 * 1000));
  const farWarning = daysAhead > 90
    ? `⚠️ ${date} は約${Math.round(daysAhead / 30)}ヶ月先です。年が正しいか確認してください`
    : '';

  // 予約サイトは30分刻み。指定が刻みに乗っていない場合は丸めた事実を伝える
  // （黙って別の時間帯を押さえないため）
  const snapWarning = parsed.snapped
    ? `⚠️ 30分単位に調整しました（${startTime}-${endTime}）`
    : '';

  const otherRoom = selectedRoom.id === '42' ? room4 : room6;
  const msg = [
    `${selectedRoom.name} が空いています`,
    otherRoom ? `${otherRoom.name}: ${otherRoom.available ? '空き' : '埋まり'}` : '',
    `日時: ${date} ${startTime}-${endTime}`,
    `キャンセル期限: ${cancelDeadline}`,
    farWarning,
    snapWarning,
    '',
    `${selectedRoom.name}を予約しますか？（OK / いいえ）`,
  ].filter(Boolean).join('\n');

  // ここでは replyToken を「空き状況を確認中...」で使い切っているため push で送る。
  // reply への一本化は無料枠の原因が確定してから行う
  await pushMessage(userId, msg);
}

// 空き確認のみ
async function handleCheckOnly(replyToken, userId, text) {
  const cleaned = text.replace(/^空き\s*/, '');
  const parsed = parseDateTime(cleaned);
  if (!parsed) {
    await reply(replyToken, '日時を認識できませんでした。\n例: 空き 4/10 14:00-15:00');
    return;
  }

  const { date, startTime, endTime } = parsed;
  const availability = await checkAvailability(date, startTime, endTime);

  const lines = availability.rooms.map(r =>
    `${r.name}: ${r.available ? '空き' : '埋まり'}`
  );
  // 以前は pushMessage(null, ...) で、userId が無いため結果が永久に届かなかった
  await sendResult(replyToken, userId, [`${date} ${startTime}-${endTime}`, ...lines].join('\n'));
}

// 予約一覧
async function handleList(replyToken, userId) {
  await reply(replyToken, '予約一覧を取得中...');

  const reservations = await getReservations();
  // null は「読み取れなかった」。[] と同じに扱うと「予約はありません」と
  // 断定してしまい、利用者は取り消せていないことに気づけない
  if (reservations === null) {
    await sendResult(replyToken, userId, '予約一覧を読み取れませんでした。時間をおいて再度お試しください');
    return;
  }
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
async function handleCancel(replyToken, userId, ctx, text) {
  // 取消語を「その場で」除去する。旧実装は取消語より前を全部削っていたため、
  // 「7/22 14時をキャンセル」のように日時が先に来る自然な語順で日時ごと消えていた。
  const cleaned = stripCancelKeyword(text);
  const parsed = parseDateTime(cleaned);

  // 日時が読めなかった場合は予約一覧から選ばせる
  if (!parsed) {
    const reservations = await getReservations();
    if (reservations === null) {
      await sendResult(replyToken, userId, '予約一覧を読み取れませんでした。時間をおいて再度お試しください');
      return;
    }
    if (reservations.length === 0) {
      await sendResult(replyToken, userId, '現在の予約はありません');
      return;
    }
    // 1件だけでも即実行はしない。利用者が指定した日時を読めていない以上、
    // botが対象を推測している状態であり、取消は不可逆で課金もありうる
    if (reservations.length === 1) {
      const r = reservations[0];
      await askCancelConfirm(replyToken, userId, ctx, r.date, (r.time || '').split('~')[0],
        r.date + ' ' + r.time + ' ' + r.room);
      return;
    }
    // 複数件は番号で選ばせる。選択待ち状態を保持しないと番号を受け取れない
    const lines = reservations.map(function (r, i) {
      return (i + 1) + '. ' + r.date + ' ' + r.time + ' ' + r.room;
    });
    setPendingCancel(userId, ctx, { list: reservations });
    await sendResult(replyToken, userId,
      'どの予約を取り消しますか？\n\n' + lines.join('\n') + '\n\n番号を送ってください（やめる場合は「いいえ」）');
    return;
  }

  // 日時が読めても、その時間に複数の会議室が入っていることがある。
  // 日付と開始時刻だけで消すと別の階の予約を消してしまうため、実物と突き合わせる
  const all = await getReservations();
  if (all === null) {
    await sendResult(replyToken, userId, '予約一覧を読み取れませんでした。時間をおいて再度お試しください');
    return;
  }
  let matches = all.filter(function (r) {
    return r.date === parsed.date && (r.time || '').indexOf(parsed.startTime) === 0;
  });

  // 本文に階の指定があれば絞り込む
  const floorHint = /4\s*(?:階|F|f)|よん\s*かい/.test(text) ? '4階'
    : /6\s*(?:階|F|f)|ろく\s*かい|ろっかい/.test(text) ? '6階' : null;
  if (floorHint) {
    const narrowed = matches.filter(function (r) { return (r.room || '').indexOf(floorHint) === 0; });
    if (narrowed.length) matches = narrowed;
  }

  if (matches.length === 0) {
    await sendResult(replyToken, userId,
      parsed.date + ' ' + parsed.startTime + ' の予約は見つかりませんでした。\n「予約一覧」で確認できます');
    return;
  }
  if (matches.length > 1) {
    const lines = matches.map(function (r, i) { return (i + 1) + '. ' + r.date + ' ' + r.time + ' ' + r.room; });
    setPendingCancel(userId, ctx, { list: matches });
    await sendResult(replyToken, userId,
      'その時間に複数の予約があります。どれを取り消しますか？\n\n' + lines.join('\n') +
      '\n\n番号を送ってください（やめる場合は「いいえ」）');
    return;
  }

  const r = matches[0];
  await askCancelConfirm(replyToken, userId, ctx, r.date, (r.time || '').split('~')[0],
    r.date + ' ' + r.time + ' ' + r.room, r.room);
}

// 取消前の確認。すべての取消経路をここに集約する。
// 期限チェックもここで一度だけ行い、経路によって確認が抜ける状態を作らない
async function askCancelConfirm(replyToken, userId, ctx, date, startTime, label, room) {
  const deadlineMs = jstToMs(date, startTime) - 2 * 60 * 60 * 1000;
  const late = Date.now() > deadlineMs;
  setPendingCancel(userId, ctx, { confirm: { date: date, startTime: startTime, label: label, room: room } });
  await sendResult(replyToken, userId,
    (late
      ? 'キャンセル期限（開始2時間前: ' + formatDateTime(deadlineMs) + '）を過ぎています。\n取り消すと料金が発生します。\n\n'
      : '') +
    label + ' を取り消しますか？（はい / いいえ）');
}

// 実際に取り消す。呼び出し元は askCancelConfirm の「はい」だけにすること
async function executeCancel(replyToken, userId, date, startTime, label, room) {
  const result = await cancelReservation(date, startTime, room);
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
