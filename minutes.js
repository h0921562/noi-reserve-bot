const axios = require('axios');

let openai, anthropic;
function getOpenAI() {
  if (!openai) { const O = require('openai'); openai = new O({ apiKey: process.env.OPENAI_API_KEY }); }
  return openai;
}
function getAnthropic() {
  if (!anthropic) { const A = require('@anthropic-ai/sdk'); anthropic = new A({ apiKey: process.env.ANTHROPIC_API_KEY }); }
  return anthropic;
}

const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;
const minutesSessions = new Map();

// 音声メッセージ受信
async function handleAudioMessage(event, channelAccessToken, pushFn, replyFn) {
  const userId = event.source.userId;
  const messageId = event.message.id;
  console.log('handleAudioMessage called:', messageId, userId);

  try {
    // reply即応答
    await replyFn(event.replyToken, '音声を受信しました。処理中...').catch(e => console.log('reply failed:', e.message));

    // ダウンロード（202の場合リトライ、最大60秒）
    const url = 'https://api-data.line.me/v2/bot/message/' + messageId + '/content';
    let audioBuffer = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise(r => setTimeout(r, attempt === 0 ? 3000 : 8000));
      console.log('Download attempt', attempt + 1, url);
      const resp = await axios.get(url, {
        headers: { 'Authorization': 'Bearer ' + channelAccessToken },
        responseType: 'arraybuffer',
        validateStatus: function() { return true; },
      });
      console.log('status:', resp.status, 'size:', resp.data ? resp.data.length : 0);
      if (resp.status === 200 && resp.data && resp.data.length > 0) {
        audioBuffer = Buffer.from(resp.data);
        break;
      }
      if (resp.status !== 202) {
        await pushFn(userId, 'ダウンロード失敗: status=' + resp.status);
        return;
      }
    }
    if (!audioBuffer) {
      await pushFn(userId, 'ダウンロード失敗: タイムアウト（音声変換に時間がかかっています。少し待ってから再送してください）');
      return;
    }

    await pushFn(userId, 'ダウンロード完了: ' + audioBuffer.length + 'bytes\n文字起こし中...');

    // 一時ファイルに保存してWhisper APIへ
    const fs = require('fs');
    const tmpPath = '/tmp/audio_' + Date.now() + '.m4a';
    fs.writeFileSync(tmpPath, audioBuffer);

    const transcript = await getOpenAI().audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(tmpPath),
      language: 'ja',
    });
    fs.unlinkSync(tmpPath);

    const text = transcript.text;
    if (minutesSessions.has(userId)) clearTimeout(minutesSessions.get(userId).timer);
    minutesSessions.set(userId, {
      transcript: text, additionalInfo: [], title: '', phase: 'collecting',
      minutes: null, docUrl: null, docId: null, docTitle: null,
      timer: setTimeout(function() { minutesSessions.delete(userId); }, 600000),
    });

    await pushFn(userId,
      '文字起こし完了（' + text.length + '文字）\n\n' +
      '追加情報はありますか？（参加者、クライアント名、補足など）\n\n' +
      'なければ「なし」と送ってください。そのまま議事録を作成します。'
    );
  } catch (err) {
    console.error('handleAudioMessage error:', err);
    await pushFn(userId, 'エラー: ' + (err.message || String(err)).substring(0, 400)).catch(function() {});
  }
}

// テキスト処理
async function handleMinutesText(userId, text, pushFn) {
  var session = minutesSessions.get(userId);
  if (!session) return false;
  var trimmed = text.trim();

  if (/^(キャンセル|やめる|やめ)$/.test(trimmed)) {
    clearTimeout(session.timer);
    minutesSessions.delete(userId);
    await pushFn(userId, '議事録作成をキャンセルしました');
    return true;
  }

  // 編集モード
  if (session.phase === 'editing') {
    if (/^(OK|ok|完了|おk|いいよ|大丈夫|問題ない|問題なし)$/.test(trimmed)) {
      clearTimeout(session.timer);
      minutesSessions.delete(userId);
      await pushFn(userId, '議事録を確定しました');
      return true;
    }
    await pushFn(userId, '修正中...');
    try {
      var revised = await reviseMinutes(session.minutes, trimmed);
      session.minutes = revised;
      var docResult = await createGoogleDoc(session.docTitle, revised);
      if (docResult.url) { session.docUrl = docResult.url; session.docId = docResult.id; }
      clearTimeout(session.timer);
      session.timer = setTimeout(function() { minutesSessions.delete(userId); }, 1800000);
      await pushFn(userId, (session.docUrl ? '修正しました\n' + session.docUrl : '修正しました') + '\n\n他に修正があれば送ってください。完了なら「OK」。');
    } catch (err) {
      await pushFn(userId, '修正失敗: ' + err.message);
    }
    return true;
  }

  // 収集モード - 「なし」で作成
  if (/^(なし|ない|特にない|ないです|なしで|大丈夫|ありません|no)$/.test(trimmed)) {
    return await generateMinutes(userId, session, pushFn);
  }

  session.additionalInfo.push(trimmed);
  await pushFn(userId, '追加情報を受け付けました（' + session.additionalInfo.length + '件）\n他にもあれば続けて送ってください。なければ「なし」で議事録を作成します。');
  return true;
}

async function generateMinutes(userId, session, pushFn) {
  await pushFn(userId, '議事録を作成中...');
  try {
    var prompt = '以下は会議の文字起こしです。議事録としてまとめてください。\n\n## 要件\n- 会議名: ' + (session.title || '会議') +
      '\n- 構成: 1.参加者 2.議題 3.議論の要点 4.決定事項 5.TODO 6.次回予定\n\n## 文字起こし\n' + session.transcript;
    if (session.additionalInfo.length > 0) prompt += '\n\n## 追加情報\n' + session.additionalInfo.join('\n');

    var response = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }],
    });
    var minutes = '';
    for (var b of response.content) { if (b.type === 'text') { minutes = b.text; break; } }

    var dateStr = new Date().toISOString().split('T')[0];
    var docTitle = dateStr + ' ' + (session.title || '会議');
    var docResult = await createGoogleDoc(docTitle, minutes);

    session.phase = 'editing';
    session.minutes = minutes;
    session.docTitle = docTitle;
    session.docUrl = docResult.url || null;
    clearTimeout(session.timer);
    session.timer = setTimeout(function() { minutesSessions.delete(userId); }, 1800000);

    if (docResult.url) {
      await pushFn(userId, '議事録が完成しました\n' + docTitle + '\n' + docResult.url + '\n\n修正があればそのまま送ってください。完了なら「OK」。');
    } else {
      var short = minutes.length > 4500 ? minutes.substring(0, 4500) + '\n...' : minutes;
      await pushFn(userId, '議事録が完成しました\n\n' + short + '\n\n修正があれば送ってください。完了なら「OK」。');
    }
  } catch (err) {
    await pushFn(userId, '議事録作成失敗: ' + err.message);
    minutesSessions.delete(userId);
  }
  return true;
}

async function reviseMinutes(current, instruction) {
  var response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 16000,
    messages: [{ role: 'user', content: '以下の議事録を修正してください。修正後の議事録全文を返してください。\n\n## 修正指示\n' + instruction + '\n\n## 現在の議事録\n' + current }],
  });
  for (var b of response.content) { if (b.type === 'text') return b.text; }
  return current;
}

async function createGoogleDoc(title, content) {
  if (!GAS_WEBAPP_URL) return { url: null };
  try {
    var resp = await axios.post(GAS_WEBAPP_URL, { title: title, content: content }, {
      headers: { 'Content-Type': 'application/json' }, maxRedirects: 5,
    });
    return resp.data;
  } catch (err) { return { url: null, error: err.message }; }
}

module.exports = { handleAudioMessage: handleAudioMessage, handleMinutesText: handleMinutesText };
