const axios = require('axios');

// 遅延初期化（ビルド時のクラッシュ防止）
let openai, anthropic;
function getOpenAI() {
  if (!openai) {
    const OpenAI = require('openai');
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}
function getAnthropic() {
  if (!anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;

// セッション管理 (userId -> session)
// phase: 'collecting' | 'editing'
const minutesSessions = new Map();

function getSession(userId) {
  return minutesSessions.get(userId);
}

function clearSession(userId) {
  minutesSessions.delete(userId);
}

// 音声ファイルをLINEからダウンロード
async function downloadAudio(messageId, channelAccessToken) {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${channelAccessToken}` },
    responseType: 'arraybuffer',
  });
  const contentType = resp.headers['content-type'] || 'audio/mp3';
  return { buffer: Buffer.from(resp.data), contentType };
}

// Whisper APIで文字起こし
async function transcribe(audioBuffer, contentType) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  // LINEの音声はContent-Typeに関係なく.m4aとして保存
  // OpenAI Whisper APIはファイル名の拡張子でフォーマットを判定する
  const tmpPath = path.join(os.tmpdir(), 'audio_' + Date.now() + '.m4a');
  fs.writeFileSync(tmpPath, audioBuffer);
  // ファイルの先頭バイトをログ（フォーマット判定用）
  const header = audioBuffer.slice(0, 12).toString('hex');
  console.log('Audio saved:', tmpPath, 'size:', audioBuffer.length, 'contentType:', contentType, 'header:', header);

  try {
    const resp = await getOpenAI().audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(tmpPath),
      language: 'ja',
    });
    return resp.text;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch(e) {}
  }
}

// Claude APIで議事録整形
async function formatMinutes(transcript, additionalInfo, title) {
  let prompt = `以下は会議の文字起こしです。これを議事録としてまとめてください。

## 要件
- 会議名: ${title || '会議'}
- 以下の構成でまとめる:
  1. 参加者（判別できる範囲で）
  2. 議題・アジェンダ
  3. 議論の要点（トピックごとに整理）
  4. 決定事項
  5. TODO / アクションアイテム（担当者・期限があれば）
  6. 次回予定（言及があれば）

## 文字起こし
${transcript}`;

  if (additionalInfo && additionalInfo.length > 0) {
    prompt += `\n\n## 追加情報（以下の情報も議事録に反映してください）\n${additionalInfo.join('\n')}`;
  }

  const response = await getAnthropic().messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  });

  for (const block of response.content) {
    if (block.type === 'text') return block.text;
  }
  return '';
}

// Claude APIで議事録を修正
async function reviseMinutes(currentMinutes, instruction) {
  const response = await getAnthropic().messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    messages: [{
      role: 'user',
      content: `以下の議事録を修正してください。修正後の議事録全文を返してください。

## 修正指示
${instruction}

## 現在の議事録
${currentMinutes}`,
    }],
  });

  for (const block of response.content) {
    if (block.type === 'text') return block.text;
  }
  return currentMinutes;
}

// Google Apps Script Web Appでドキュメント作成/更新
async function createGoogleDoc(title, content) {
  if (!GAS_WEBAPP_URL) {
    return { url: null, error: 'GAS_WEBAPP_URL not configured' };
  }
  try {
    const resp = await axios.post(GAS_WEBAPP_URL, { title, content }, {
      headers: { 'Content-Type': 'application/json' },
      maxRedirects: 5,
    });
    return resp.data;
  } catch (err) {
    return { url: null, error: err.message };
  }
}

// 議事録を生成してGoogle Docを作成
async function generateMinutes(userId, session, pushMessageFn) {
  await pushMessageFn(userId, '議事録を作成中...');

  try {
    const minutes = await formatMinutes(session.transcript, session.additionalInfo, session.title);
    const dateStr = new Date().toISOString().split('T')[0];
    const docTitle = `${dateStr} ${session.title || '会議'}`;
    const docResult = await createGoogleDoc(docTitle, minutes);

    // セッションを編集モードに移行
    session.phase = 'editing';
    session.minutes = minutes;
    session.docTitle = docTitle;
    session.docUrl = docResult.url || null;
    session.docId = docResult.id || null;

    // 30分後に自動クリア
    clearTimeout(session.timer);
    session.timer = setTimeout(() => minutesSessions.delete(userId), 30 * 60 * 1000);

    if (docResult.url) {
      await pushMessageFn(userId,
        `議事録が完成しました\n${docTitle}\n${docResult.url}\n\n` +
        '修正があればそのまま送ってください。\n完了なら「OK」と送ってください。'
      );
    } else {
      const shortMinutes = minutes.length > 4500 ? minutes.substring(0, 4500) + '\n...(続き省略)' : minutes;
      await pushMessageFn(userId,
        `議事録が完成しました\n\n${shortMinutes}\n\n` +
        '修正があればそのまま送ってください。\n完了なら「OK」と送ってください。'
      );
    }
  } catch (err) {
    console.error('Minutes creation error:', err);
    await pushMessageFn(userId, '議事録作成に失敗しました: ' + err.message);
    minutesSessions.delete(userId);
  }
  return true;
}

// 音声メッセージ受信時
async function handleAudioMessage(event, channelAccessToken, pushMessageFn, replyFn) {
  const userId = event.source.userId;
  const messageId = event.message.id;

  if (minutesSessions.has(userId)) {
    clearTimeout(minutesSessions.get(userId).timer);
    minutesSessions.delete(userId);
  }

  // まずreplyで即応答（replyTokenは1回しか使えない）
  if (replyFn) {
    await replyFn(event.replyToken, '音声を受信しました。文字起こし中...').catch(() => {});
  }

  try {
    const { buffer: audioBuffer, contentType } = await downloadAudio(messageId, channelAccessToken);
    const transcript = await transcribe(audioBuffer, contentType);

    const session = {
      transcript,
      additionalInfo: [],
      title: '',
      phase: 'collecting',
      minutes: null,
      docUrl: null,
      docId: null,
      docTitle: null,
      timer: setTimeout(() => minutesSessions.delete(userId), 10 * 60 * 1000),
    };
    minutesSessions.set(userId, session);

    await pushMessageFn(userId,
      `文字起こし完了（${transcript.length}文字）\n\n` +
      '追加情報はありますか？（参加者、クライアント名、補足など）\n\n' +
      'なければ「なし」と送ってください。そのまま議事録を作成します。'
    );
  } catch (err) {
    console.error('Transcription error:', err);
    const detail = err.response ? JSON.stringify(err.response.data).substring(0, 200) : err.message;
    const { buffer: ab, contentType: ct } = await downloadAudio(messageId, channelAccessToken).catch(() => ({ buffer: null, contentType: 'unknown' }));
    const size = ab ? ab.length : 'unknown';
    const hdr = ab ? ab.slice(0, 8).toString('hex') : 'unknown';
    await pushMessageFn(userId, '失敗: ' + detail + '\ntype:' + ct + ' size:' + size + ' hdr:' + hdr);
  }
}

// テキストメッセージ処理
async function handleMinutesText(userId, text, pushMessageFn) {
  const session = minutesSessions.get(userId);
  if (!session) return false;

  const trimmed = text.trim();

  // キャンセル
  if (/^(キャンセル|やめる|やめ)$/.test(trimmed)) {
    clearTimeout(session.timer);
    minutesSessions.delete(userId);
    await pushMessageFn(userId, '議事録作成をキャンセルしました');
    return true;
  }

  // === 編集モード ===
  if (session.phase === 'editing') {
    // 完了
    if (/^(OK|ok|完了|おk|いいよ|大丈夫|問題ない|問題なし)$/.test(trimmed)) {
      clearTimeout(session.timer);
      minutesSessions.delete(userId);
      await pushMessageFn(userId, '議事録を確定しました');
      return true;
    }

    // 修正指示
    await pushMessageFn(userId, '修正中...');
    try {
      const revised = await reviseMinutes(session.minutes, trimmed);
      session.minutes = revised;

      // Google Doc更新（新しいドキュメントを作成して差し替え）
      const docResult = await createGoogleDoc(session.docTitle, revised);
      if (docResult.url) {
        session.docUrl = docResult.url;
        session.docId = docResult.id;
      }

      // タイマーリセット
      clearTimeout(session.timer);
      session.timer = setTimeout(() => minutesSessions.delete(userId), 30 * 60 * 1000);

      if (session.docUrl) {
        await pushMessageFn(userId,
          `修正しました\n${session.docUrl}\n\n` +
          '他に修正があれば送ってください。\n完了なら「OK」と送ってください。'
        );
      } else {
        const short = revised.length > 4500 ? revised.substring(0, 4500) + '\n...' : revised;
        await pushMessageFn(userId, `修正しました\n\n${short}\n\n他に修正があれば送ってください。`);
      }
    } catch (err) {
      console.error('Revision error:', err);
      await pushMessageFn(userId, '修正に失敗しました: ' + err.message);
    }
    return true;
  }

  // === 収集モード ===
  // 「なし」→ 即作成
  if (/^(なし|ない|特にない|ないです|なしで|大丈夫|ありません|no)$/.test(trimmed)) {
    return await generateMinutes(userId, session, pushMessageFn);
  }

  // 追加情報を蓄積
  session.additionalInfo.push(trimmed);
  await pushMessageFn(userId,
    `追加情報を受け付けました（${session.additionalInfo.length}件）\n` +
    '他にもあれば続けて送ってください。\nなければ「なし」で議事録を作成します。'
  );
  return true;
}

module.exports = {
  handleAudioMessage,
  handleMinutesText,
  getSession,
  clearSession,
};
