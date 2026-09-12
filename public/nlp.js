/**
 * 한국어 일정 문장 해석기
 *
 * "내일 오후 3시에 지훈이 치과 예약" 처럼 말한 문장에서
 * 날짜 · 시간 · 반복을 뽑아내고, 남은 말을 제목으로 쓴다.
 *
 * 날짜는 전부 한국시간 기준 'YYYY-MM-DD' 문자열로 다룬다(서버와 동일한 규칙).
 */

const WEEKDAYS = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };

function parseDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fmt(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = parseDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}
function dow(iso) {
  return parseDate(iso).getUTCDay();
}

/** 월요일 시작 기준 이번 주의 월요일 */
function mondayOf(iso) {
  const delta = (dow(iso) + 6) % 7;
  return addDays(iso, -delta);
}

/** 상대 날짜 표현 */
const RELATIVE = [
  [/그저께|그제/, -2],
  [/어제/, -1],
  [/오늘/, 0],
  [/내일모레|모레/, 2],
  [/낼|내일/, 1],
  [/글피/, 3],
];

/** '시' 없이 시간대만 말한 경우의 기본 시각 */
const DAYPARTS = [
  [/새벽/, "05:00"],
  [/아침/, "08:00"],
  [/점심|정오/, "12:00"],
  [/저녁/, "18:00"],
  [/밤/, "21:00"],
  [/자정/, "00:00"],
];

const REPEATS = [
  [/매일|날마다/, "daily"],
  [/매주|주마다/, "weekly"],
  [/매달|매월|달마다/, "monthly"],
  [/매년|매해|해마다/, "yearly"],
];

/** 제목에서 걷어낼 군더더기 */
const FILLER = [
  /일정\s*(추가|등록|넣어|만들어)\s*(해\s*줘|해|줘)?/g,
  /메모\s*(추가|등록|넣어|남겨)\s*(해\s*줘|해|줘)?/g,
  /알림\s*(추가|등록|설정)\s*(해\s*줘|해|줘)?/g,
  /(추가|등록|저장)\s*(해\s*줘|해|줘)/g,
  /해\s*줘|해줘|하기|해야\s*함|해야\s*해/g,
  /있어|있음|이야|이다|예요|이에요|입니다/g,
];

/** 숫자 한글 표기 (시/분에서 쓰이는 범위만) */
const KO_NUM = {
  한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9,
  열: 10, 열한: 11, 열두: 12,
};

function koNumToInt(token) {
  if (token in KO_NUM) return KO_NUM[token];
  const n = Number(token);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {string} raw 음성으로 받은 문장
 * @param {string} today 'YYYY-MM-DD' (한국시간 기준 오늘)
 * @returns {{title:string, date:string|null, time:string|null, repeat:string, matched:string[]}}
 */
export function parseKoreanSchedule(raw, today) {
  let text = ` ${String(raw || "").trim()} `;
  const matched = [];
  let date = null;
  let time = null;
  let repeat = "none";

  // 매칭된 부분을 제목에서 제거하기 위한 헬퍼
  const eat = (re, label) => {
    const m = text.match(re);
    if (!m) return null;
    text = text.replace(m[0], " ");
    if (label) matched.push(label);
    return m;
  };

  /* ---------- 반복 ---------- */
  for (const [re, val] of REPEATS) {
    if (re.test(text)) {
      repeat = val;
      eat(re, null);
      break;
    }
  }

  /* ---------- 날짜: N월 N일 ---------- */
  let m = eat(/(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s*(?:에는|에|부터))?/, null);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    const year = parseDate(today).getUTCFullYear();
    let cand = fmt(new Date(Date.UTC(year, month - 1, day)));
    // 이미 지난 날짜면 내년으로 본다
    if (cand < today) cand = fmt(new Date(Date.UTC(year + 1, month - 1, day)));
    date = cand;
  }

  /* ---------- 날짜: 요일 (이번주/다음주 포함) ---------- */
  if (!date) {
    m = eat(
      /(이번\s*주|다음\s*주|담주|돌아오는)?\s*([일월화수목금토])\s*요일(?:\s*(?:에는|에|부터))?/,
      null,
    );
    if (m) {
      const target = WEEKDAYS[m[2]];
      const scope = (m[1] || "").replace(/\s/g, "");
      if (scope === "다음주" || scope === "담주") {
        const monday = addDays(mondayOf(today), 7);
        date = addDays(monday, (target + 6) % 7);
      } else if (scope === "이번주") {
        date = addDays(mondayOf(today), (target + 6) % 7);
      } else {
        // 그냥 "수요일" → 다가오는 수요일 (오늘이면 오늘)
        date = addDays(today, (target - dow(today) + 7) % 7);
      }
    }
  }

  /* ---------- 날짜: 상대 표현 ---------- */
  if (!date) {
    for (const [re, delta] of RELATIVE) {
      if (re.test(text)) {
        date = addDays(today, delta);
        eat(re, null);
        break;
      }
    }
  }

  /* ---------- 날짜: N일 (이번 달) ---------- */
  if (!date) {
    m = eat(/(?:^|\s)(\d{1,2})\s*일(?!\s*정)/, null);
    if (m) {
      const day = Number(m[1]);
      const d = parseDate(today);
      let cand = fmt(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day)));
      if (cand < today) {
        cand = fmt(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, day)));
      }
      date = cand;
    }
  }

  /* ---------- 시간: (오전|오후) N시 N분 / N시 반 ---------- */
  m = eat(
    /(오전|오후|아침|저녁|밤|새벽|낮)?\s*(\d{1,2}|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열한|열두|열)\s*시\s*(?:(\d{1,2})\s*분|(반))?(?:\s*(?:에는|에|부터|까지))?/,
    null,
  );
  if (m) {
    let hour = koNumToInt(m[2]);
    const minute = m[3] ? Number(m[3]) : m[4] ? 30 : 0;
    const marker = m[1] || "";

    if (hour !== null && hour >= 0 && hour <= 24 && minute >= 0 && minute < 60) {
      if (/오후|저녁|밤|낮/.test(marker)) {
        if (hour < 12) hour += 12;
      } else if (/오전|아침|새벽/.test(marker)) {
        if (hour === 12) hour = 0;
      } else {
        // 표시가 없으면 생활 패턴에 맞춰 추측한다.
        // 1~7시는 오후, 8~11시는 오전으로 본다.
        if (hour >= 1 && hour <= 7) hour += 12;
      }
      if (hour === 24) hour = 0;
      if (hour < 24) {
        time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      }
    }
  }

  /* ---------- 시간: 시간대만 말한 경우 ---------- */
  if (!time) {
    for (const [re, val] of DAYPARTS) {
      if (re.test(text)) {
        time = val;
        eat(re, null);
        break;
      }
    }
  }

  /* ---------- 제목 정리 ---------- */
  let title = text;
  for (const re of FILLER) title = title.replace(re, " ");
  title = title
    .replace(/\s+/g, " ")
    .replace(/^[\s,.·~\-]+|[\s,.·~\-]+$/g, "")
    // 날짜·시간을 걷어낸 자리에 조사만 남는 경우가 있다
    .replace(/^(에는|에서|에|부터|까지|으로|로)\s*/, "")
    .replace(/\s*(에는|에서|에|부터|까지|으로|로)$/, "")
    .trim();

  if (date) matched.push("날짜");
  if (time) matched.push("시간");
  if (repeat !== "none") matched.push("반복");

  return { title, date, time, repeat, matched };
}
