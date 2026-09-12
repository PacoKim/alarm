// Variables used by Scriptable.
// These must be at the very top of the file. Comments must be translated!
// icon-color: indigo; icon-glyph: calendar-alt;

/**
 * 우리가족 알림 — Scriptable 위젯
 *
 * [설치]
 *  1. App Store에서 "Scriptable" 설치 (무료)
 *  2. Scriptable 앱 → 우측 상단 + → 이 파일 내용을 전체 붙여넣기 → 이름: 우리가족위젯
 *  3. 스크립트를 한 번 실행하면 위젯 주소를 물어봅니다. 웹앱 설정에서 복사한 주소를 붙여넣으세요.
 *  4. 잠금화면: 화면 길게 누르기 → 사용자화 → 잠금화면 → 위젯 영역 탭
 *     → Scriptable 선택 → 위젯을 길게 눌러 "우리가족위젯" 스크립트 지정
 *  5. 홈화면: 빈 곳 길게 누르기 → + → Scriptable → 크기 선택 → 같은 방식으로 스크립트 지정
 *
 * [위젯 매개변수(Parameter)]  위젯 설정의 Parameter 칸에 입력하면 표시 내용을 바꿀 수 있습니다.
 *   (비워둠) → 일정 + 메모 함께      memo → 메모만      event → 일정만
 */

const KEYCHAIN_KEY = "familyReminder.widgetUrl";
const CACHE_FILE = "family-reminder-cache.json";
const REFRESH_MINUTES = 15;

/* ------------------------------ 설정된 주소 가져오기 ------------------------------ */

async function getWidgetUrl() {
  const param = (args.widgetParameter ?? "").trim();
  // 매개변수에 주소를 직접 넣은 경우 그것을 우선한다
  if (param.startsWith("http")) return param;

  if (Keychain.contains(KEYCHAIN_KEY)) return Keychain.get(KEYCHAIN_KEY);

  if (!config.runsInApp) return null; // 위젯에서는 물어볼 수 없다

  const alert = new Alert();
  alert.title = "위젯 주소 입력";
  alert.message =
    "우리가족 알림 웹앱 → 설정 → '위젯 주소 복사'로 복사한 주소를 붙여넣어 주세요.";
  alert.addTextField("https://...", "");
  alert.addAction("저장");
  alert.addCancelAction("취소");
  if ((await alert.present()) === -1) return null;

  const url = alert.textFieldValue(0).trim();
  if (!url.startsWith("http")) {
    const bad = new Alert();
    bad.title = "주소가 올바르지 않습니다";
    bad.message = "https:// 로 시작하는 주소를 넣어 주세요.";
    bad.addAction("확인");
    await bad.present();
    return null;
  }
  Keychain.set(KEYCHAIN_KEY, url);
  return url;
}

function displayMode() {
  const param = (args.widgetParameter ?? "").trim().toLowerCase();
  if (param === "memo" || param === "메모") return "memo";
  if (param === "event" || param === "일정") return "event";
  return "both";
}

/* ------------------------------ 데이터 (+오프라인 캐시) ------------------------------ */

function cachePath() {
  const fm = FileManager.local();
  return fm.joinPath(fm.documentsDirectory(), CACHE_FILE);
}

function readCache() {
  try {
    const fm = FileManager.local();
    const path = cachePath();
    if (!fm.fileExists(path)) return null;
    return JSON.parse(fm.readString(path));
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    FileManager.local().writeString(cachePath(), JSON.stringify(data));
  } catch {
    // 캐시 저장 실패는 무시한다
  }
}

async function loadData(url) {
  try {
    const req = new Request(url);
    req.timeoutInterval = 12;
    const data = await req.loadJSON();
    if (!data || !Array.isArray(data.events)) throw new Error("bad payload");
    writeCache(data);
    return { data, stale: false };
  } catch {
    const cached = readCache();
    return cached ? { data: cached, stale: true } : { data: null, stale: true };
  }
}

/* ------------------------------ 표시용 문자열 ------------------------------ */

/** '오늘 18:00' / '내일 종일' / '9/21 오전 10시' 같은 접두 라벨 */
function whenLabel(ev, { short = false } = {}) {
  const day = ev.dayLabel; // 서버가 '오늘/내일/모레/9월 21일 (월)' 로 내려준다
  const dayShort = day.replace(/^(\d+)월 (\d+)일 .*$/, "$1/$2");
  const time = ev.time ? (short ? ev.time : ev.timeLabel) : "종일";
  return `${short ? dayShort : day} ${time}`;
}

function line(ev, { short = false } = {}) {
  return `${whenLabel(ev, { short })}  ${ev.title}`;
}

/* ------------------------------ 잠금화면 위젯 ------------------------------ */

function accessoryInline(w, data, mode) {
  const memo = data.memos.find((m) => m.pinned);
  const ev = data.events[0];

  let text = "일정 없음";
  if (mode === "memo") text = memo ? `📌 ${memo.text}` : data.memos[0]?.text ?? "메모 없음";
  else if (ev) text = line(ev, { short: true });
  else if (memo) text = `📌 ${memo.text}`;

  w.addText(text);
}

function accessoryCircular(w, data) {
  const todayCount = data.events.filter((e) => e.isToday).length;
  const stack = w.addStack();
  stack.layoutVertically();
  stack.centerAlignContent();

  const num = stack.addText(String(todayCount));
  num.font = Font.boldSystemFont(20);
  num.centerAlignText();

  const label = stack.addText("오늘");
  label.font = Font.systemFont(9);
  label.centerAlignText();
}

function accessoryRectangular(w, data, mode) {
  w.setPadding(2, 2, 2, 2);
  const memo = data.memos.find((m) => m.pinned) ?? data.memos[0];
  const rows = [];

  if (mode === "memo") {
    for (const m of data.memos.slice(0, 3)) rows.push({ text: m.text, pin: m.pinned });
  } else if (mode === "event") {
    for (const ev of data.events.slice(0, 3)) rows.push({ text: line(ev, { short: true }) });
  } else {
    for (const ev of data.events.slice(0, memo ? 2 : 3)) {
      rows.push({ text: line(ev, { short: true }) });
    }
    if (memo) rows.push({ text: memo.text, pin: true });
  }

  if (!rows.length) {
    const t = w.addText("일정·메모 없음");
    t.font = Font.systemFont(12);
    return;
  }

  rows.forEach((row, i) => {
    const t = w.addText(`${row.pin ? "📌 " : ""}${row.text}`);
    t.font = i === 0 ? Font.boldSystemFont(12) : Font.systemFont(11);
    t.lineLimit = 1;
    t.minimumScaleFactor = 0.8;
    if (i > 0) t.textOpacity = 0.85;
  });
}

/* ------------------------------ 홈화면 위젯 ------------------------------ */

const BRAND = new Color("#4f6df5");
const TODAY_COLOR = new Color("#ff6b6b");

function homeHeader(w, data, stale) {
  const head = w.addStack();
  head.layoutHorizontally();
  head.centerAlignContent();

  const title = head.addText(data.family);
  title.font = Font.boldSystemFont(13);
  title.textColor = BRAND;
  title.lineLimit = 1;

  head.addSpacer();

  const [, mm, dd] = data.today.split("-");
  const right = head.addText(stale ? "오프라인" : `${Number(mm)}/${Number(dd)}`);
  right.font = Font.systemFont(11);
  right.textColor = Color.gray();

  w.addSpacer(7);
}

function eventRow(container, ev, { compact = false } = {}) {
  const row = container.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();

  const when = row.addText(ev.time ? ev.time : "종일");
  when.font = Font.boldSystemFont(compact ? 11 : 12);
  when.textColor = ev.isToday ? TODAY_COLOR : BRAND;
  when.lineLimit = 1;

  const gap = row.addStack();
  gap.size = new Size(7, 0);

  const title = row.addText(ev.title);
  title.font = Font.systemFont(compact ? 11 : 12.5);
  title.lineLimit = 1;
  title.minimumScaleFactor = 0.85;

  row.addSpacer();

  if (!ev.isToday) {
    const day = row.addText(ev.dayLabel.replace(/^(\d+)월 (\d+)일 .*$/, "$1/$2"));
    day.font = Font.systemFont(compact ? 9.5 : 10.5);
    day.textColor = Color.gray();
    day.lineLimit = 1;
  }
}

function memoRow(container, memo, { compact = false } = {}) {
  const row = container.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();

  const icon = row.addText(memo.pinned ? "📌" : "•");
  icon.font = Font.systemFont(compact ? 9 : 10);

  const gap = row.addStack();
  gap.size = new Size(5, 0);

  const t = row.addText(memo.text);
  t.font = Font.systemFont(compact ? 11 : 12);
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.85;
  t.textOpacity = 0.9;
  row.addSpacer();
}

function sectionLabel(w, text) {
  const t = w.addText(text);
  t.font = Font.boldSystemFont(10);
  t.textColor = Color.gray();
  w.addSpacer(4);
}

function homeSmall(w, data, stale, mode) {
  homeHeader(w, data, stale);

  const items = mode === "memo" ? [] : data.events.slice(0, 3);
  if (items.length) {
    items.forEach((ev, i) => {
      if (i) w.addSpacer(6);
      eventRow(w, ev, { compact: true });
    });
  }

  const memos = mode === "event" ? [] : data.memos.slice(0, items.length ? 1 : 3);
  if (memos.length) {
    if (items.length) w.addSpacer(8);
    memos.forEach((m, i) => {
      if (i) w.addSpacer(5);
      memoRow(w, m, { compact: true });
    });
  }

  if (!items.length && !memos.length) emptyState(w);
  w.addSpacer();
}

function homeMedium(w, data, stale, mode) {
  homeHeader(w, data, stale);

  const showEvents = mode !== "memo";
  const showMemos = mode !== "event";
  const events = showEvents ? data.events.slice(0, showMemos ? 4 : 6) : [];
  const memos = showMemos ? data.memos.slice(0, events.length ? 2 : 5) : [];

  events.forEach((ev, i) => {
    if (i) w.addSpacer(6);
    eventRow(w, ev);
  });

  if (memos.length) {
    if (events.length) w.addSpacer(9);
    memos.forEach((m, i) => {
      if (i) w.addSpacer(5);
      memoRow(w, m);
    });
  }

  if (!events.length && !memos.length) emptyState(w);
  w.addSpacer();
}

function homeLarge(w, data, stale, mode) {
  homeHeader(w, data, stale);

  const showEvents = mode !== "memo";
  const showMemos = mode !== "event";

  if (showEvents) {
    const today = data.events.filter((e) => e.isToday);
    const later = data.events.filter((e) => !e.isToday);

    sectionLabel(w, "오늘");
    if (today.length) {
      today.forEach((ev, i) => {
        if (i) w.addSpacer(6);
        eventRow(w, ev);
      });
    } else {
      const t = w.addText("오늘은 남은 일정이 없어요");
      t.font = Font.systemFont(12);
      t.textColor = Color.gray();
    }

    if (later.length) {
      w.addSpacer(12);
      sectionLabel(w, "다가오는 일정");
      later.slice(0, 6).forEach((ev, i) => {
        if (i) w.addSpacer(6);
        eventRow(w, ev);
      });
    }
  }

  if (showMemos && data.memos.length) {
    w.addSpacer(12);
    sectionLabel(w, "메모");
    data.memos.slice(0, 5).forEach((m, i) => {
      if (i) w.addSpacer(5);
      memoRow(w, m);
    });
  }

  w.addSpacer();
}

function emptyState(w) {
  const t = w.addText("등록된 일정·메모가 없어요");
  t.font = Font.systemFont(12);
  t.textColor = Color.gray();
}

/* ------------------------------ 오류 위젯 ------------------------------ */

function errorWidget(message) {
  const w = new ListWidget();
  const family = config.widgetFamily ?? "medium";
  const accessory = family.startsWith("accessory");

  const t = w.addText(accessory ? message : `우리가족 알림\n${message}`);
  t.font = Font.systemFont(accessory ? 11 : 12);
  t.lineLimit = accessory ? 2 : 0;
  if (!accessory) t.textColor = Color.gray();
  return w;
}

/* ------------------------------ 조립 ------------------------------ */

async function buildWidget() {
  const url = await getWidgetUrl();
  if (!url) return errorWidget("Scriptable 앱에서 스크립트를 한 번 실행해 위젯 주소를 등록해 주세요.");

  const { data, stale } = await loadData(url);
  if (!data) return errorWidget("일정을 불러올 수 없습니다. 인터넷 연결을 확인해 주세요.");

  const w = new ListWidget();
  const family = config.widgetFamily ?? "medium";
  const mode = displayMode();

  // 위젯을 탭하면 웹앱이 열린다
  try {
    w.url = new URL(url).origin;
  } catch {
    // 주소 파싱 실패 시 링크 없이 표시
  }
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);

  switch (family) {
    case "accessoryInline":
      accessoryInline(w, data, mode);
      break;
    case "accessoryCircular":
      accessoryCircular(w, data);
      break;
    case "accessoryRectangular":
      accessoryRectangular(w, data, mode);
      break;
    case "small":
      w.setPadding(12, 13, 12, 13);
      homeSmall(w, data, stale, mode);
      break;
    case "large":
    case "extraLarge":
      w.setPadding(16, 16, 16, 16);
      homeLarge(w, data, stale, mode);
      break;
    default:
      w.setPadding(14, 15, 14, 15);
      homeMedium(w, data, stale, mode);
  }

  return w;
}

/* ------------------------------ 실행 ------------------------------ */

const widget = await buildWidget();

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  // 앱에서 직접 실행하면 미리보기를 띄운다
  const family = config.widgetFamily ?? "medium";
  if (family === "small") await widget.presentSmall();
  else if (family === "large") await widget.presentLarge();
  else await widget.presentMedium();
}

Script.complete();
