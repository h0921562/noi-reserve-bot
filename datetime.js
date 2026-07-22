// 日時パース。index.js から切り出してテスト可能にしたもの。
//
// 設計上の要点（旧実装で実際に事故っていた点）:
//  1. 曜日パースを最後に置き、「曜」の字を必須にする。旧実装は先頭で
//     [月火水木金土日] と 1文字ひらがな(か/ど/に…)にマッチしていたため、
//     「7月22日」の「月」を月曜、「から」の「か」を火曜と誤認していた。
//  2. 範囲の区切りは文字列の選択肢として扱う。旧実装は [-~〜から] と
//     文字クラスに入れていたため「から」が1文字マッチになり終了時刻が落ちた。
//  3. 日付計算は JST 固定。サーバのタイムゾーン設定に依存させない。
//  4. 「階」「人」は時刻より先に除去する（「4階」を 04:00 と読まないため）。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function p2(n) { return String(n).padStart(2, '0'); }

// ミリ秒 → JST の年月日・曜日
function jstFields(ms) {
  const d = new Date(ms + JST_OFFSET_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() };
}
// JST のその日の 00:00 のミリ秒
function jstMidnight(y, mo, d) { return Date.UTC(y, mo - 1, d) - JST_OFFSET_MS; }
function msToDateStr(ms) { const f = jstFields(ms); return f.y + '-' + p2(f.mo) + '-' + p2(f.d); }

// 全角→半角。数字・英字・記号・空白のみ変換する
function zen2han(s) {
  return s
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[：]/g, ':')
    .replace(/[／]/g, '/')
    .replace(/[－―‐−]/g, '-')
    .replace(/[　]/g, ' ');
}

const WEEKDAY = { '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6 };

// ---------------------------------------------------------------- 日付の抽出
// 見つけたら { dateMs, index, length } を返す。曖昧さの少ない形式から順に試す。
function extractDate(text, nowMs) {
  const today = jstFields(nowMs);
  const todayMs = jstMidnight(today.y, today.mo, today.d);

  function hit(ms, m) { return { dateMs: ms, index: m.index, length: m[0].length }; }

  // 年が明示された日付: 2026-07-22 / 2026/7/22
  let m = text.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return hit(jstMidnight(+m[1], +m[2], +m[3]), m);

  // 相対日（「明後日」を「明日」より先に試す必要はないが順序は明示しておく）
  const rel = [
    { re: /(?:明々後日|しあさって|明明後日)/, off: 3 },
    { re: /(?:明後日|あさって|アサッテ)/, off: 2 },
    { re: /(?:明日|あした|あす|アシタ|アス|翌日)/, off: 1 },
    { re: /(?:今日|本日|きょう|キョウ)/, off: 0 },
  ];
  for (const r of rel) {
    m = text.match(r.re);
    if (m) return hit(todayMs + r.off * DAY_MS, m);
  }

  // 月日: 7月22日 / 7月22
  m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (m) return hit(resolveMonthDay(+m[1], +m[2], todayMs), m);

  // 来月/今月 + 日
  m = text.match(/(来月|らいげつ)\s*(\d{1,2})\s*日?/);
  if (m) {
    const t = jstFields(todayMs);
    const mo = t.mo === 12 ? 1 : t.mo + 1;
    const y = t.mo === 12 ? t.y + 1 : t.y;
    return hit(jstMidnight(y, mo, +m[2]), m);
  }

  // スラッシュ日付: 7/22
  m = text.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (m) return hit(resolveMonthDay(+m[1], +m[2], todayMs), m);

  // 曜日（「曜」必須。旧実装のような1文字マッチはしない）
  m = text.match(/(今週|来週|再来週|らいしゅう)?\s*([日月火水木金土])\s*曜\s*日?/);
  if (m) {
    const dow = WEEKDAY[m[2]];
    const t = jstFields(todayMs);
    let target;
    if (m[1] === '来週' || m[1] === 'らいしゅう' || m[1] === '再来週') {
      // 次の月曜を起点にした週の中の該当曜日
      const toNextMonday = ((8 - t.dow) % 7) || 7;
      const base = todayMs + toNextMonday * DAY_MS + (m[1] === '再来週' ? 7 * DAY_MS : 0);
      target = base + (((dow + 6) % 7)) * DAY_MS;
    } else {
      let diff = dow - t.dow;
      if (diff <= 0) diff += 7; // 当日は含めず次の該当曜日
      target = todayMs + diff * DAY_MS;
    }
    return hit(target, m);
  }

  // 日のみ: 22日
  m = text.match(/(\d{1,2})\s*日/);
  if (m) {
    const day = +m[1];
    if (day >= 1 && day <= 31) {
      const t = jstFields(todayMs);
      let y = t.y, mo = t.mo;
      if (day < t.d) { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
      return hit(jstMidnight(y, mo, day), m);
    }
  }

  return null;
}

// 年が書かれていない月日は、過ぎていれば翌年とみなす
function resolveMonthDay(mo, day, todayMs) {
  const t = jstFields(todayMs);
  let ms = jstMidnight(t.y, mo, day);
  if (ms < todayMs) ms = jstMidnight(t.y + 1, mo, day);
  return ms;
}

// ---------------------------------------------------------------- 時刻の抽出
const AMPM_RE = /^(午前|午後|ごぜん|ごご|AM|PM|am|pm)/;
const SEP_RE = /^\s*(?:から|カラ|より|〜|～|~|-|–|—|ー|to|TO)\s*/;
const DUR_RE = /^\s*(\d{1,3})\s*(時間|分)\s*(半)?/;

// 文字列先頭の時刻トークンを読む。{ h, mi, len, explicitAmPm } または null
function readTime(s) {
  let i = 0;
  let ampm = null;
  const a = s.match(AMPM_RE);
  if (a) { ampm = /午後|ごご|PM|pm/.test(a[1]) ? 'pm' : 'am'; i += a[0].length; }
  const ws = s.slice(i).match(/^\s*/)[0];
  i += ws.length;
  const rest = s.slice(i);

  let m, h, mi;
  if ((m = rest.match(/^(\d{1,2}):(\d{2})/))) { h = +m[1]; mi = +m[2]; }
  else if ((m = rest.match(/^(\d{1,2})\s*時\s*半/))) { h = +m[1]; mi = 30; }
  else if ((m = rest.match(/^(\d{1,2})\s*時\s*(\d{1,2})\s*分/))) { h = +m[1]; mi = +m[2]; }
  else if ((m = rest.match(/^(\d{1,2})\s*時/))) { h = +m[1]; mi = 0; }
  else if ((m = rest.match(/^(\d{2})(\d{2})(?!\d)/))) { h = +m[1]; mi = +m[2]; }
  else if ((m = rest.match(/^(\d)(\d{2})(?!\d)/))) { h = +m[1]; mi = +m[2]; }
  else if ((m = rest.match(/^(\d{1,2})(?!\d)/))) { h = +m[1]; mi = 0; }
  else return null;

  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (h > 24 || mi > 59) return null;

  return { h: h, mi: mi, len: i + m[0].length, explicitAmPm: !!ampm };
}

// 文中から最初の時刻トークンを探す
function findTime(s) {
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && /\d/.test(s[i - 1])) continue; // 数字の途中から読み始めない
    if (!/[\d午前後AaPp]/.test(s[i])) continue;
    const t = readTime(s.slice(i));
    if (t) return { t: t, index: i };
  }
  return null;
}

// ---------------------------------------------------------------- 本体
// text: 利用者のメッセージ / nowMs: 基準時刻（省略時は現在）
function parseDateTime(text, nowMs) {
  if (typeof text !== 'string' || !text.trim()) return null;
  if (nowMs === undefined || nowMs === null) nowMs = Date.now();

  const src = zen2han(text);

  const d = extractDate(src, nowMs);
  if (!d) return null;

  // 日付部分を取り除いた残りから時刻を読む
  let rest = (src.slice(0, d.index) + ' ' + src.slice(d.index + d.length));
  // 「4階」「6F」「3人」を時刻として読まないよう先に除去する
  rest = rest.replace(/\d{1,2}\s*(?:階|かい|カイ)/g, ' ')
             .replace(/\d{1,2}\s*[fF](?![a-zA-Z])/g, ' ')
             .replace(/\d{1,2}\s*(?:人|名)/g, ' ');

  const start = findTime(rest);
  if (!start) return null;

  let sh = start.t.h, smi = start.t.mi;
  let eh = null, emi = null;

  let after = rest.slice(start.index + start.t.len);
  const sep = after.match(SEP_RE);
  if (sep) {
    after = after.slice(sep[0].length);
    // 「2時間」「30分」のような所要時間を先に判定する（'2時間' を 02:00 と読まないため）
    const dur = after.match(DUR_RE);
    if (dur) {
      let add = dur[2] === '時間' ? +dur[1] * 60 : +dur[1];
      if (dur[2] === '時間' && dur[3]) add += 30; // 1時間半
      const total = sh * 60 + smi + add;
      eh = Math.floor(total / 60); emi = total % 60;
    } else {
      const end = readTime(after);
      if (end) { eh = end.h; emi = end.mi; }
    }
  }

  if (eh === null) { eh = sh + 1; emi = smi; } // 終了未指定は1時間

  // 「午後2時から4時」のように終了側の午前午後が省略された場合を補う
  if (eh * 60 + emi <= sh * 60 + smi && eh + 12 <= 24) {
    eh += 12;
  }

  // 予約サイトは30分刻み。開始は切り下げ、終了は切り上げて枠に合わせる
  const snapped = (smi % 30 !== 0) || (emi % 30 !== 0);
  smi = Math.floor(smi / 30) * 30;
  if (emi % 30 !== 0) { emi = Math.ceil(emi / 30) * 30; if (emi === 60) { emi = 0; eh += 1; } }

  const startMin = sh * 60 + smi;
  const endMin = eh * 60 + emi;
  if (endMin <= startMin) return null;
  if (endMin > 24 * 60) return null;

  // 過去日・遠すぎる日は受け付けない
  const today = jstFields(nowMs);
  const todayMs = jstMidnight(today.y, today.mo, today.d);
  if (d.dateMs < todayMs) return null;
  if (d.dateMs > todayMs + 366 * DAY_MS) return null;

  return {
    date: msToDateStr(d.dateMs),
    startTime: p2(sh) + ':' + p2(smi),
    endTime: p2(eh) + ':' + p2(emi),
    snapped: snapped,
  };
}

// 取消メッセージから取消語だけを「その場で」抜く。
// 旧実装は取消語より前を全部削っていたため、「7/22 14時をキャンセル」のように
// 日時が先に来る自然な語順で日時ごと消えていた。
function stripCancelKeyword(text) {
  return String(text)
    .replace(/取り?消し?(?:て|たい|ます)?/g, ' ')
    .replace(/(?:キャンセ[ルるりらろっ]*|とりけし|とりやめ|取りやめ|やめたい|やめて|消して|消す)/g, ' ')
    .replace(/の?予約(?:を|は|が)?/g, ' ')
    .replace(/(?:お願いします|お願い|ください|下さい|したい|して|頼む|よろしく)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { parseDateTime, stripCancelKeyword, zen2han, jstFields, msToDateStr };
