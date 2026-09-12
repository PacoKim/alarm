/* 우리가족 알림 — 프레임워크 없는 단일 파일 앱 */

import { parseKoreanSchedule } from "/nlp.js";

const TOKEN_KEY = "fr.token";
const root = document.getElementById("root");

const state = {
  token: localStorage.getItem(TOKEN_KEY),
  loading: true,
  /** onboard = 미로그인 · picker = 내 프로필 선택 대기 · app = 사용 중 */
  stage: "onboard",
  tab: "events",
  family: null,
  me: null,
  roster: [],
  members: [],
  events: [],
  memos: [],
  today: "",
};

/* ------------------------------ 유틸 ------------------------------ */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const WD = ["일", "월", "화", "수", "목", "금", "토"];

/** 이름의 첫 글자로 만드는 아바타 */
function avatar(member, cls = "") {
  if (!member) return "";
  const initial = String(member.name || "?").trim().slice(0, 1);
  return `<span class="avatar ${cls}" style="background:${esc(member.color || "#7a8396")}"
    >${esc(initial)}</span>`;
}

function memberOf(id) {
  return state.members.find((m) => m.id === id) ?? null;
}

/** '18:00' -> { h: '6:00', ampm: '오후' } */
function splitTime(time) {
  if (!time) return null;
  const [h, m] = time.split(":").map(Number);
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { h: `${h12}:${String(m).padStart(2, "0")}`, ampm };
}

function todayISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}

function shiftDate(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function shortDate(iso) {
  const [, m, d] = iso.split("-").map(Number);
  const [y] = iso.split("-").map(Number);
  const wd = WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d} (${wd})`;
}

/** 다가오는 토요일 (오늘이 토/일이면 이번 주말 그대로) */
function nextWeekend(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (day === 6 || day === 0) return iso;
  return shiftDate(iso, 6 - day);
}

let toastTimer;
function toast(msg) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2000);
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}를 복사했어요`);
  } catch {
    toast("복사에 실패했어요. 길게 눌러 선택해 주세요.");
  }
}

/* ------------------------------ API ------------------------------ */

async function api(path, { method = "GET", body, noAuth = false, keepSession = false } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(state.token && !noAuth ? { authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  // 잘못된 초대 링크(401) 때문에 멀쩡한 로그인이 풀리지 않도록 noAuth 요청은 제외한다
  // keepSession: 비밀번호 확인처럼 401이 "틀렸다"는 뜻인 요청은 로그인을 풀지 않는다
  if (res.status === 401 && state.token && !noAuth && !keepSession) {
    logout();
    throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
  }
  if (!res.ok) {
    const err = new Error(data.error || "요청을 처리하지 못했습니다.");
    err.status = res.status;
    throw err;
  }
  return data;
}

async function refresh() {
  try {
    const data = await api("/state");
    Object.assign(state, data, { loading: false, stage: "app" });
  } catch (err) {
    // 가족 공간에는 들어왔지만 "내가 누구인지"를 아직 안 고른 상태
    if (err.status === 403) {
      await loadRoster();
      state.stage = "picker";
      state.loading = false;
    } else {
      throw err;
    }
  }
  render();
}

async function loadRoster() {
  const { members, familyName } = await api("/members/roster");
  state.roster = members;
  if (familyName) state.familyName = familyName;
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  Object.assign(state, {
    token: null,
    stage: "onboard",
    family: null,
    me: null,
    roster: [],
    members: [],
    events: [],
    memos: [],
  });
  render();
}

/* ------------------------------ 초대 링크 ------------------------------ */

function inviteLink(code) {
  // 해시(#)에 담아 서버 로그·리퍼러에 코드가 남지 않게 한다
  return `${location.origin}/#join=${code}`;
}

function fmtInvite(code) {
  return String(code || "").replace(/(.{4})(?=.)/g, "$1-");
}

/** 주소에 #join=코드 가 있으면 자동으로 가족 공간에 들어간다 */
async function handleInviteLink() {
  const m = location.hash.match(/join=([A-Za-z0-9-]+)/);
  if (!m) return false;
  history.replaceState(null, "", location.pathname + location.search);

  const res = await api("/family/join", {
    method: "POST",
    body: { inviteCode: m[1] },
    noAuth: true,
  });

  // 이미 같은 가족으로 로그인돼 있으면 그대로 둔다
  if (state.token) {
    try {
      const cur = await api("/state");
      if (cur.family?.id === res.family.id) {
        Object.assign(state, cur, { loading: false, stage: "app" });
        render();
        toast("이미 참여 중인 가족이에요");
        return true;
      }
    } catch {
      // 프로필 선택 전이거나 다른 가족 → 새 링크로 들어간다
    }
  }

  localStorage.setItem(TOKEN_KEY, res.token);
  state.token = res.token;
  state.familyName = res.family.name;
  await refresh();
  toast(`${res.family.name}에 오신 걸 환영해요`);
  return true;
}

/* ------------------------------ 온보딩 ------------------------------ */

function renderOnboard() {
  root.innerHTML = `
    <div class="onboard">
      <img class="logo" src="/icons/icon-192.png" alt="" />
      <h1>가족의 하루를<br /><em>잠금화면에서</em> 확인하세요</h1>
      <p class="lede">
        일정과 메모를 가족이 한곳에 모아두면,
        아이폰 잠금화면 위젯에 바로 떠서 아무도 잊지 않습니다.
      </p>
      <div class="invite-hint">
        <span class="ic">💌</span>
        <span>가족에게 <b>초대 링크</b>를 받았다면<br />그 링크를 누르기만 하면 돼요.</span>
      </div>
      <button class="btn ghost" data-action="show-join">초대 코드 직접 입력</button>
      <button class="btn ghost" data-action="show-create">가족 공간 새로 만들기</button>
      <p class="foot">
        <a href="#" data-action="install-guide"
           style="color:var(--brand);font-weight:700;text-decoration:none">
          휴대폰에 앱으로 설치하는 방법 →</a>
      </p>
    </div>`;
}

function createSheet() {
  openSheet(`
    <h2>가족 공간 만들기</h2>
    <div class="err" hidden></div>
    <div class="field">
      <label for="f-name">가족 이름</label>
      <input id="f-name" type="text" placeholder="예: 우리집, 김씨네" maxlength="40" />
    </div>
    <div class="field">
      <label for="f-members">구성원 (쉼표로 구분, 나중에 추가 가능)</label>
      <input id="f-members" type="text" placeholder="예: 엄마, 아빠, 지훈" />
    </div>
    <div class="field">
      <label for="f-signup">설치 코드</label>
      <input id="f-signup" type="password" autocomplete="off" maxlength="200"
             placeholder="배포할 때 받은 코드" />
      <p style="margin:8px 2px 0;font-size:12.5px;color:var(--text-dim);line-height:1.5">
        서버를 설치한 사람만 아는 코드입니다. 가족이 <b>참여</b>할 때는 필요하지 않고,
        새 가족 공간을 만들 때만 씁니다.</p>
    </div>
    <button class="btn" data-action="do-create">만들기</button>
  `, () => document.getElementById("f-name")?.focus());
}

function joinSheet() {
  openSheet(`
    <h2>가족 공간 참여하기</h2>
    <div class="err" hidden></div>
    <p class="lede">초대 링크를 누를 수 없을 때만 쓰세요. 링크 끝의 12자리 코드입니다.</p>
    <div class="field">
      <label for="j-code">초대 코드</label>
      <input id="j-code" type="text" placeholder="예: K7MQ-4P2X-9HTR" maxlength="20"
             autocapitalize="characters" autocomplete="off" style="text-transform:uppercase" />
    </div>
    <button class="btn" data-action="do-join">참여하기</button>
  `, () => document.getElementById("j-code")?.focus());
}

/* ------------------------------ 메인 화면 ------------------------------ */

function renderPicker() {
  const claimed = state.roster.filter((m) => m.claimed);
  const free = state.roster.filter((m) => !m.claimed);

  const card = (m) => `
    <button class="row" data-action="pick-profile" data-id="${esc(m.id)}"
            data-name="${esc(m.name)}" data-claimed="${m.claimed ? "1" : "0"}">
      <span class="when" style="flex:0 0 auto">${avatar(m, "lg")}</span>
      <span class="body">
        <span class="title">${esc(m.name)}</span>
        <span class="meta">${m.claimed ? "비밀번호 입력" : "처음이에요 · 비밀번호 4자리를 정해요"}</span>
      </span>
    </button>`;

  root.innerHTML = `
    <div class="app">
      <header class="topbar">
        <h1>나는 누구인가요?
          <span class="sub">${esc(state.familyName ?? "가족 공간")} · 내 이름을 눌러 주세요</span>
        </h1>
      </header>
      <main>
        ${
          claimed.length
            ? `<section class="day-group"><div class="day-head"><b>등록된 프로필</b></div>
                 <div class="card">${claimed.map(card).join("")}</div></section>`
            : ""
        }
        ${
          free.length
            ? `<section class="day-group"><div class="day-head"><b>아직 주인이 없는 프로필</b></div>
                 <div class="card">${free.map(card).join("")}</div></section>`
            : ""
        }
        ${
          !state.roster.length
            ? `<div class="empty"><div class="big">👋</div>
                 <p>등록된 구성원이 없어요.<br />아래에서 내 이름을 추가해 주세요.</p></div>`
            : ""
        }
        <section class="day-group">
          <div class="day-head"><b>목록에 내 이름이 없나요?</b></div>
          <div class="row-2">
            <input id="p-newname" type="text" maxlength="20" placeholder="내 이름 입력" />
            <button class="btn ghost" data-action="add-self" style="flex:0 0 90px">추가</button>
          </div>
        </section>
      </main>
      <div class="fab-bar">
        <button class="fab ghost" data-action="logout"
                style="background:var(--surface);color:var(--text);box-shadow:none;border:1px solid var(--line)">
          다른 가족 공간으로 로그인
        </button>
      </div>
    </div>`;
}

/* 비밀번호 키패드. 처음 정할 때는 4자리 · 숫자를 보여주고 4개가 되면 바로 저장,
   로그인할 때는 점으로 가리고 확인 버튼으로 보낸다(예전에 6자리 이상으로 정한 사람도 있음). */
let pinEntry = null;

function profilePinSheet(id, name, claimed) {
  pinEntry = { id, name, claimed, digits: "", busy: false };
  const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    .map((n) => `<button class="key" data-action="pin-key" data-k="${n}">${n}</button>`)
    .join("");

  openSheet(`
    <h2>${claimed ? `${esc(name)} 님, 반가워요` : `${esc(name)} 님의 비밀번호 정하기`}</h2>
    <p class="lede">${
      claimed
        ? "내 비밀번호를 눌러 주세요."
        : "숫자 4개를 정해 주세요. '나만 보기' 항목을 지켜주는 번호예요."
    }</p>
    <div class="err" hidden></div>
    <div class="pin-dots ${claimed ? "masked" : ""}" id="pin-dots"></div>
    <div class="keypad">
      ${keys}
      <button class="key ghost" data-action="pin-back" aria-label="지우기">⌫</button>
      <button class="key" data-action="pin-key" data-k="0">0</button>
      <button class="key ok" data-action="pin-ok">확인</button>
    </div>
  `);
  drawPinDots();
}

function drawPinDots() {
  const el = document.getElementById("pin-dots");
  if (!el || !pinEntry) return;
  const { digits, claimed } = pinEntry;
  const slots = claimed ? Math.max(4, digits.length) : 4;
  el.innerHTML = Array.from({ length: slots }, (_, i) => {
    const d = digits[i];
    return `<span class="pin-dot ${d !== undefined ? "on" : ""}">${
      !claimed && d !== undefined ? d : ""
    }</span>`;
  }).join("");
}

function pinPress(k) {
  if (!pinEntry || pinEntry.busy) return;
  const max = pinEntry.claimed ? 8 : 4;
  if (k === "back") pinEntry.digits = pinEntry.digits.slice(0, -1);
  else if (pinEntry.digits.length < max) pinEntry.digits += k;
  drawPinDots();
  // 새로 정할 때는 4개를 누르면 바로 저장한다
  if (!pinEntry.claimed && pinEntry.digits.length === 4) setTimeout(submitPin, 220);
}

async function submitPin() {
  if (!pinEntry || pinEntry.busy) return;
  const { id, digits } = pinEntry;
  if (digits.length < 4) return sheetError("숫자를 4개 이상 눌러 주세요.");

  pinEntry.busy = true;
  try {
    const res = await api("/members/claim", {
      method: "POST",
      body: { memberId: id, pin: digits },
      keepSession: true,
    });
    localStorage.setItem(TOKEN_KEY, res.token);
    state.token = res.token;
    pinEntry = null;
    closeSheet();
    await refresh();
    toast(`${res.me.name} 님으로 로그인했어요`);
  } catch (err) {
    pinEntry.busy = false;
    pinEntry.digits = "";
    drawPinDots();
    const dots = document.getElementById("pin-dots");
    dots?.classList.remove("shake");
    void dots?.offsetWidth;
    dots?.classList.add("shake");
    sheetError(err.message);
  }
}

function render() {
  if (!state.token) return renderOnboard();
  if (state.loading) {
    root.innerHTML = `<div class="spinner"></div>`;
    return;
  }
  if (state.stage === "picker") return renderPicker();

  const openMemos = state.memos.filter((m) => !m.done).length;
  const todayEvents = state.events.filter((e) => e.date === state.today);
  const isEvents = state.tab === "events";

  root.innerHTML = `
    <div class="app">
      <header class="topbar">
        <span class="brand-mark">📅</span>
        <span class="titles">
          <h1>${esc(state.family?.name ?? "우리가족")}</h1>
          <span class="sub">${
            state.me?.name ? `${esc(state.me.name)} 님으로 로그인` : "가족 공간"
          }</span>
        </span>
        <button class="icon-btn" data-action="refresh" aria-label="새로 고침">↻</button>
        <button class="icon-btn" data-action="settings" aria-label="설정">⚙</button>
      </header>

      <main>
        ${heroCard(todayEvents, openMemos)}

        <div class="tabs" role="tablist" data-tab="${state.tab}">
          <span class="glider"></span>
          <button class="tab" role="tab" data-action="tab" data-tab="events"
                  aria-selected="${isEvents}">일정</button>
          <button class="tab" role="tab" data-action="tab" data-tab="memos"
                  aria-selected="${!isEvents}">메모
            ${openMemos ? `<span class="count">${openMemos}</span>` : ""}</button>
        </div>

        ${isEvents ? eventsView() : memosView()}
      </main>

      <div class="fab-bar">
        <div class="fab-inner">
          <button class="fab" data-action="${isEvents ? "new-event" : "new-memo"}">
            <span>＋</span><span>${isEvents ? "일정 추가" : "메모 추가"}</span>
          </button>
          ${
            voiceSupported()
              ? `<button class="fab-mic" data-action="voice"
                         aria-label="음성으로 추가">🎙️</button>`
              : ""
          }
        </div>
      </div>
    </div>`;
}

/** 오늘 요약 카드 */
function heroCard(todayEvents, openMemos) {
  const [y, m, d] = state.today.split("-").map(Number);
  const wd = WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];

  // 오늘 남은 일정 중 가장 이른 것
  const now = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
  const next =
    todayEvents.find((e) => e.time && e.time >= now) ??
    state.events.find((e) => e.date > state.today);

  return `
    <section class="hero">
      <div class="eyebrow">오늘</div>
      <div class="date"><b>${m}월 ${d}일</b><span>${wd}요일</span></div>
      <div class="stats">
        <div class="stat"><div class="n">${todayEvents.length}</div><div class="l">오늘 일정</div></div>
        <div class="stat"><div class="n">${openMemos}</div><div class="l">할 일·메모</div></div>
        <div class="stat"><div class="n">${state.members.length}</div><div class="l">가족</div></div>
      </div>
      ${
        next
          ? `<div class="next">
               <span class="badge">${next.date === state.today ? "다음" : esc(next.dayLabel)}</span>
               <span class="t">${next.time ? esc(next.timeLabel) + " · " : ""}${esc(next.title)}</span>
             </div>`
          : `<div class="next"><span class="t">남은 일정이 없어요. 편하게 쉬세요 🌿</span></div>`
      }
    </section>`;
}

const RELATIVE_LABELS = new Set(["오늘", "내일", "모레", "어제"]);

/** 장소·담당·개인여부·반복을 배지와 점으로 표시한다 */
function eventMeta(ev) {
  const parts = [];
  if (ev.visibility === "private") parts.push('<span class="tag lock">🔒 나만</span>');
  if (ev.location) parts.push(`<span>${esc(ev.location)}</span>`);

  const member = memberOf(ev.member_id);
  if (member) parts.push(`<span class="who">${avatar(member)}${esc(member.name)}</span>`);
  if (ev.repeat && ev.repeat !== "none") {
    parts.push(`<span class="tag repeat">${esc(REPEAT_SHORT[ev.repeat] ?? "반복")}</span>`);
  }
  if (!parts.length) return "";
  return `<span class="meta">${parts.join('<span class="sep">·</span>')}</span>`;
}

const REPEAT_SHORT = {
  daily: "매일",
  weekly: "매주",
  monthly: "매월",
  yearly: "매년",
};

function eventsView() {
  const upcoming = state.events.filter((e) => e.date >= state.today);
  if (!upcoming.length) {
    return `<div class="empty">
      <div class="art">🗓️</div>
      <h3>아직 일정이 없어요</h3>
      <p>아래 버튼을 누르거나 🎙️ 를 눌러<br />"내일 오후 3시 치과"처럼 말해보세요.</p>
    </div>`;
  }

  const now = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());

  const groups = new Map();
  for (const ev of upcoming) {
    if (!groups.has(ev.date)) groups.set(ev.date, []);
    groups.get(ev.date).push(ev);
  }

  return [...groups]
    .map(([date, list]) => {
      const isToday = date === state.today;
      const label = list[0].dayLabel;
      return `
      <section class="day-group ${isToday ? "is-today" : ""}">
        <div class="day-head">
          <b>${esc(label)}</b>
          ${RELATIVE_LABELS.has(label) ? `<span class="date">${shortDate(date)}</span>` : ""}
          <span class="pill">${list.length}개</span>
        </div>
        <div class="card">${list.map((ev) => eventRow(ev, isToday, now)).join("")}</div>
      </section>`;
    })
    .join("");
}

function eventRow(ev, isToday, now) {
  const t = splitTime(ev.time);
  const upcomingNow = isToday && ev.time && ev.time >= now;

  return `
    <button class="row ${upcomingNow ? "is-now" : ""}"
            data-action="open-event" data-id="${esc(ev.id)}">
      <span class="when ${t ? "" : "allday"}">
        ${
          t
            ? `<span class="ampm">${t.ampm}</span><span class="h">${t.h}</span>`
            : `<span class="h">종일</span>`
        }
      </span>
      <span class="body">
        <span class="title">${esc(ev.title)}</span>
        ${eventMeta(ev)}
      </span>
    </button>`;
}

function memosView() {
  if (!state.memos.length) {
    return `<div class="empty">
      <div class="art">📝</div>
      <h3>메모가 비어 있어요</h3>
      <p>장보기 목록, 현관 비밀번호, 준비물처럼<br />가족이 잊기 쉬운 것들을 적어두세요.</p>
    </div>`;
  }

  const open = state.memos.filter((m) => !m.done);
  const done = state.memos.filter((m) => m.done);

  const block = (list, heading) =>
    !list.length
      ? ""
      : `<section class="day-group">
          <div class="day-head"><b>${heading}</b><span class="pill">${list.length}개</span></div>
          <div class="card">${list.map(memoRow).join("")}</div>
        </section>`;

  return block(open, "할 일 · 메모") + block(done, "완료");
}

function memoRow(m) {
  const member = memberOf(m.member_id);
  const tags = [];
  if (m.visibility === "private") tags.push('<span class="tag lock">🔒 나만</span>');
  if (member) tags.push(`<span class="who">${avatar(member)}${esc(member.name)}</span>`);

  return `
    <div class="row memo-row ${m.done ? "done" : ""}">
      <button class="check" data-action="toggle-memo" data-id="${esc(m.id)}"
              aria-label="완료 표시">✓</button>
      <button class="body" style="background:none;border:none;padding:0;text-align:left"
              data-action="open-memo" data-id="${esc(m.id)}">
        <span class="title">${
          m.pinned ? `<span class="pin-mark">📌</span> ` : ""
        }${esc(m.text)}</span>
        ${tags.length ? `<span class="meta">${tags.join('<span class="sep">·</span>')}</span>` : ""}
      </button>
    </div>`;
}

/* ------------------------------ 음성 입력 ------------------------------ */

function SpeechRec() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function voiceSupported() {
  return !!SpeechRec();
}

let recognizer = null;

/** 음성 입력 시트. 말한 내용을 해석해 미리 보여주고 확인받는다. */
function voiceSheet() {
  const target = state.tab === "memos" ? "memo" : "event";

  openSheet(`
    <h2>${target === "event" ? "음성으로 일정 추가" : "음성으로 메모 추가"}</h2>
    <div class="err" hidden></div>
    <div class="voice-stage">
      <div class="mic-orb" id="v-orb">🎙️</div>
      <div class="voice-text" id="v-text"><span class="dim">듣고 있어요…</span></div>
      <div class="voice-hint" id="v-hint">
        ${
          target === "event"
            ? '예) "내일 오후 3시 지훈이 치과 예약"<br />"매주 토요일 재활용 쓰레기 배출"'
            : '예) "우유 계란 사오기"<br />"현관 비밀번호 0417"'
        }
      </div>
      <div id="v-preview"></div>
      <button class="btn" id="v-confirm" data-action="voice-confirm"
              data-target="${target}" hidden>이 내용으로 추가</button>
      <button class="btn ghost" id="v-retry" data-action="voice-retry" hidden
              style="margin-top:8px">다시 말하기</button>
      <button class="btn ghost" id="v-manual" data-action="voice-manual"
              data-target="${target}" hidden style="margin-top:8px">직접 입력으로 열기</button>
    </div>
  `, () => startListening(target));
}

let voiceResult = null;

function startListening(target) {
  const Rec = SpeechRec();
  const orb = document.getElementById("v-orb");
  const textEl = document.getElementById("v-text");
  if (!Rec) return sheetError("이 브라우저는 음성 입력을 지원하지 않습니다.");

  voiceResult = null;
  document.getElementById("v-preview").innerHTML = "";
  document.getElementById("v-confirm").hidden = true;
  document.getElementById("v-retry").hidden = true;
  document.getElementById("v-manual").hidden = true;
  textEl.innerHTML = '<span class="dim">듣고 있어요…</span>';
  orb.classList.add("listening");

  stopListening();
  recognizer = new Rec();
  recognizer.lang = "ko-KR";
  recognizer.interimResults = true;
  recognizer.continuous = false;
  recognizer.maxAlternatives = 1;

  // 화면에 보이는 글자를 결과로 쓰면 오류 안내문까지 "말한 내용"으로 오인한다.
  // 인식 결과는 별도 변수로만 추적한다.
  let finalText = "";
  let lastInterim = "";
  let errored = false;

  recognizer.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += chunk;
      else interim += chunk;
    }
    if (interim.trim()) lastInterim = interim.trim();
    const shown = (finalText + interim).trim();
    if (shown) textEl.textContent = shown;
  };

  recognizer.onerror = (e) => {
    errored = true;
    orb.classList.remove("listening");
    const msg =
      e.error === "not-allowed" || e.error === "service-not-allowed"
        ? "마이크 권한이 막혀 있습니다. 설정 → Safari → 마이크에서 허용해 주세요."
        : e.error === "no-speech"
          ? "소리가 들리지 않았어요. 다시 말해 주세요."
          : "음성 인식에 실패했어요. 직접 입력해 주세요.";
    textEl.innerHTML = `<span class="dim">${esc(msg)}</span>`;
    document.getElementById("v-retry").hidden = false;
    document.getElementById("v-manual").hidden = false;
  };

  recognizer.onend = () => {
    orb.classList.remove("listening");
    // 오류로 끝났으면 onerror가 이미 안내를 띄웠다
    if (errored) return;

    const said = (finalText.trim() || lastInterim).trim();
    if (!said) {
      textEl.innerHTML = '<span class="dim">소리가 들리지 않았어요. 다시 말해 주세요.</span>';
      document.getElementById("v-retry").hidden = false;
      document.getElementById("v-manual").hidden = false;
      return;
    }
    showVoiceResult(said, target);
  };

  try {
    recognizer.start();
  } catch {
    orb.classList.remove("listening");
    sheetError("음성 인식을 시작할 수 없습니다. 직접 입력해 주세요.");
  }
}

function stopListening() {
  if (!recognizer) return;
  try {
    recognizer.onresult = null;
    recognizer.onend = null;
    recognizer.onerror = null;
    recognizer.abort();
  } catch {
    /* 이미 종료된 경우 무시 */
  }
  recognizer = null;
}

function showVoiceResult(said, target) {
  const textEl = document.getElementById("v-text");
  textEl.textContent = said;

  if (target === "memo") {
    voiceResult = { text: said };
    document.getElementById("v-preview").innerHTML = `
      <div class="parse-preview">
        <div class="pp-title">${esc(said)}</div>
        <div class="pp-tags"><span class="pp-tag">메모</span></div>
      </div>`;
  } else {
    const parsed = parseKoreanSchedule(said, state.today);
    voiceResult = parsed;
    const tags = [];
    if (parsed.date) {
      tags.push(parsed.date === state.today ? "오늘" : dayTagLabel(parsed.date));
    } else {
      tags.push("오늘 (날짜 못 알아들음)");
    }
    tags.push(parsed.time ? timeTagLabel(parsed.time) : "종일");
    if (parsed.repeat !== "none") tags.push(REPEAT_SHORT[parsed.repeat]);

    document.getElementById("v-preview").innerHTML = `
      <div class="parse-preview">
        <div class="pp-title">${esc(parsed.title || said)}</div>
        <div class="pp-tags">${tags.map((t) => `<span class="pp-tag">${esc(t)}</span>`).join("")}</div>
      </div>`;
  }

  document.getElementById("v-hint").innerHTML =
    "내용이 맞으면 추가하세요. 고칠 곳이 있으면 직접 입력으로 열 수 있어요.";
  document.getElementById("v-confirm").hidden = false;
  document.getElementById("v-retry").hidden = false;
  document.getElementById("v-manual").hidden = false;
}

function dayTagLabel(date) {
  const delta = Math.round(
    (new Date(date + "T00:00:00Z") - new Date(state.today + "T00:00:00Z")) / 86400000,
  );
  if (delta === 0) return "오늘";
  if (delta === 1) return "내일";
  if (delta === 2) return "모레";
  return shortDate(date);
}

function timeTagLabel(time) {
  const t = splitTime(time);
  return `${t.ampm} ${t.h}`;
}

/* ------------------------------ 시트 ------------------------------ */

let sheetEl = null;

function openSheet(html, afterOpen) {
  closeSheet();
  sheetEl = document.createElement("div");
  sheetEl.className = "sheet-backdrop";
  sheetEl.innerHTML = `<div class="sheet"><div class="sheet-grip"></div>${html}</div>`;
  sheetEl.addEventListener("click", (e) => {
    if (e.target === sheetEl) closeSheet();
  });
  document.body.appendChild(sheetEl);
  document.body.style.overflow = "hidden";
  afterOpen?.();
}

function closeSheet() {
  stopListening();
  sheetEl?.remove();
  sheetEl = null;
  document.body.style.overflow = "";
}

function sheetError(msg) {
  const box = sheetEl?.querySelector(".err");
  if (!box) return toast(msg);
  box.textContent = msg;
  box.hidden = false;
  sheetEl.querySelector(".sheet").scrollTop = 0;
}

/* ---------- 일정 추가/수정 ---------- */

const REPEAT_LABELS = {
  none: "반복 없음",
  daily: "매일",
  weekly: "매주",
  monthly: "매월",
  yearly: "매년",
};

function eventSheet(ev, opts = {}) {
  // draft = 음성 인식 결과를 채워 넣은 새 일정 (수정이 아니다)
  const editing = !!ev && !opts.draft;
  const today = state.today || todayISO();
  const date = ev?.date ?? today;
  const time = ev?.time ?? "";

  openSheet(`
    <h2>${editing ? "일정 수정" : "일정 추가"}</h2>
    <div class="err" hidden></div>

    <div class="field">
      <label for="e-title">무슨 일정인가요?</label>
      <div class="row-2">
        <input id="e-title" type="text" maxlength="120" value="${esc(ev?.title ?? "")}"
               placeholder="예: 지훈이 치과 예약" />
        ${
          voiceSupported()
            ? `<button class="fab-mic" data-action="mic-fill" data-field="e-title"
                       style="flex:0 0 52px" aria-label="음성으로 입력">🎙️</button>`
            : ""
        }
      </div>
    </div>

    <div class="field">
      <label>날짜</label>
      <div class="chips" data-group="date">
        <button class="chip" data-pick-date="${today}">오늘</button>
        <button class="chip" data-pick-date="${shiftDate(today, 1)}">내일</button>
        <button class="chip" data-pick-date="${shiftDate(today, 2)}">모레</button>
        <button class="chip" data-pick-date="${nextWeekend(today)}">주말</button>
      </div>
      <input id="e-date" type="date" value="${esc(date)}" style="margin-top:8px" />
    </div>

    <div class="field">
      <label>시간</label>
      <div class="chips" data-group="time">
        <button class="chip" data-pick-time="">종일</button>
        <button class="chip" data-pick-time="09:00">오전 9시</button>
        <button class="chip" data-pick-time="12:00">정오</button>
        <button class="chip" data-pick-time="18:00">오후 6시</button>
      </div>
      <input id="e-time" type="time" value="${esc(time)}" style="margin-top:8px" />
    </div>

    ${memberField("e-member", ev?.member_id)}
    ${visibilityField(ev?.visibility)}

    <details style="margin-bottom:16px">
      <summary style="font-size:14px;font-weight:600;color:var(--text-dim);padding:8px 0">
        장소 · 반복 · 메모</summary>
      <div class="field" style="margin-top:12px">
        <label for="e-location">장소</label>
        <input id="e-location" type="text" maxlength="80" value="${esc(ev?.location ?? "")}"
               placeholder="예: 서울역 3번 출구" />
      </div>
      <div class="field">
        <label for="e-repeat">반복</label>
        <select id="e-repeat">
          ${Object.entries(REPEAT_LABELS)
            .map(
              ([v, l]) =>
                `<option value="${v}" ${(ev?.repeat ?? "none") === v ? "selected" : ""}>${l}</option>`,
            )
            .join("")}
        </select>
      </div>
      <div class="field">
        <label for="e-notes">메모</label>
        <textarea id="e-notes" maxlength="500"
                  placeholder="준비물, 전화번호 등">${esc(ev?.notes ?? "")}</textarea>
      </div>
    </details>

    <button class="btn" data-action="save-event" data-id="${esc(ev?.id ?? "")}">
      ${editing ? "저장" : "추가"}</button>
    ${editing ? `<button class="btn danger" data-action="delete-event" data-id="${esc(ev.id)}" style="margin-top:6px">이 일정 삭제</button>` : ""}
  `, () => {
    syncChips();
    if (!editing) document.getElementById("e-title")?.focus();
  });
}

/** '나만 보기' 토글. 켜면 가족에게 안 보이고 내 위젯에만 나온다. */
function visibilityField(visibility) {
  const isPrivate = visibility === "private";
  return `
    <div class="field">
      <button class="toggle-row" data-action="toggle-visibility" style="width:100%">
        <span class="label"><b>나만 보기</b>
          <span>가족에게는 보이지 않고 내 위젯에만 표시됩니다</span></span>
        <span class="switch" data-role="visibility" aria-pressed="${isPrivate}"></span>
      </button>
    </div>`;
}

function pickedVisibility() {
  const sw = sheetEl?.querySelector('[data-role="visibility"]');
  return sw?.getAttribute("aria-pressed") === "true" ? "private" : "family";
}

function memberField(id, selected) {
  if (!state.members.length) return "";
  return `
    <div class="field">
      <label>누구 일정인가요? (선택)</label>
      <div class="chips" data-group="member" id="${id}">
        ${state.members
          .map(
            (m) => `<button class="chip" data-pick-member="${esc(m.id)}"
              aria-pressed="${selected === m.id}">
              <span class="dot" style="background:${esc(m.color)}"></span>${esc(m.name)}</button>`,
          )
          .join("")}
      </div>
    </div>`;
}

/** 날짜/시간 입력값에 맞춰 칩 선택 상태를 맞춘다 */
function syncChips() {
  const date = document.getElementById("e-date")?.value;
  const time = document.getElementById("e-time")?.value;
  sheetEl?.querySelectorAll("[data-pick-date]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.pickDate === date));
  });
  sheetEl?.querySelectorAll("[data-pick-time]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.pickTime === (time || "")));
  });
}

function pickedMember() {
  return sheetEl?.querySelector('[data-pick-member][aria-pressed="true"]')?.dataset.pickMember ?? null;
}

async function saveEvent(id) {
  const payload = {
    title: document.getElementById("e-title").value.trim(),
    date: document.getElementById("e-date").value,
    time: document.getElementById("e-time").value || null,
    location: document.getElementById("e-location")?.value.trim() || null,
    notes: document.getElementById("e-notes")?.value.trim() || null,
    repeat: document.getElementById("e-repeat")?.value || "none",
    memberId: pickedMember(),
    visibility: pickedVisibility(),
  };
  if (!payload.title) return sheetError("일정 내용을 입력해 주세요.");
  if (!payload.date) return sheetError("날짜를 선택해 주세요.");

  if (id) await api(`/events/${id}`, { method: "PATCH", body: payload });
  else await api("/events", { method: "POST", body: payload });

  closeSheet();
  await refresh();
  toast(id ? "일정을 수정했어요" : "일정을 추가했어요");
}

/* ---------- 메모 추가/수정 ---------- */

function memoSheet(memo, opts = {}) {
  const editing = !!memo && !opts.draft;
  openSheet(`
    <h2>${editing ? "메모 수정" : "메모 추가"}</h2>
    <div class="err" hidden></div>
    <div class="field">
      <label for="m-text">메모 내용</label>
      <textarea id="m-text" maxlength="300"
        placeholder="예: 우유 사오기 / 관리비 25일까지">${esc(memo?.text ?? "")}</textarea>
      ${
        voiceSupported()
          ? `<button class="btn ghost" data-action="mic-fill" data-field="m-text"
                     style="margin-top:9px">🎙️  음성으로 입력</button>`
          : ""
      }
    </div>
    ${memberField("m-member", memo?.member_id)}
    <div class="field">
      <button class="toggle-row" data-action="toggle-pin" style="width:100%">
        <span class="label"><b>위젯에 고정</b>
          <span>잠금화면 위젯 맨 위에 항상 보여줍니다</span></span>
        <span class="switch" data-role="pinned" aria-pressed="${!!memo?.pinned}"></span>
      </button>
    </div>
    ${visibilityField(memo?.visibility)}
    <button class="btn" data-action="save-memo" data-id="${esc(memo?.id ?? "")}">
      ${editing ? "저장" : "추가"}</button>
    ${editing ? `<button class="btn danger" data-action="delete-memo" data-id="${esc(memo.id)}" style="margin-top:6px">이 메모 삭제</button>` : ""}
  `, () => { if (!editing) document.getElementById("m-text")?.focus(); });
}

async function saveMemo(id) {
  const text = document.getElementById("m-text").value.trim();
  if (!text) return sheetError("메모 내용을 입력해 주세요.");
  const payload = {
    text,
    pinned:
      sheetEl.querySelector('[data-role="pinned"]')?.getAttribute("aria-pressed") === "true",
    memberId: pickedMember(),
    visibility: pickedVisibility(),
  };

  if (id) await api(`/memos/${id}`, { method: "PATCH", body: payload });
  else await api("/memos", { method: "POST", body: payload });

  closeSheet();
  await refresh();
  toast(id ? "메모를 수정했어요" : "메모를 추가했어요");
}

/* ---------- 알림 ---------- */

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function b64urlToU8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function u8ToB64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** 이 기기에서 알림 켜기 */
async function enablePush() {
  if (!pushSupported()) {
    throw new Error("이 브라우저는 알림을 지원하지 않습니다.");
  }
  if (!isStandalone() && platformGuess() === "ios") {
    throw new Error(
      "아이폰은 먼저 '홈 화면에 추가'를 한 뒤, 홈 화면 아이콘으로 열어서 켜야 합니다.",
    );
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("알림 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.");
  }

  const { publicKey } = await api("/push/key");
  const reg = await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64urlToU8(publicKey),
    });
  }

  await api("/push/subscribe", {
    method: "POST",
    body: {
      endpoint: sub.endpoint,
      p256dh: u8ToB64url(sub.getKey("p256dh")),
      auth: u8ToB64url(sub.getKey("auth")),
      ua: navigator.userAgent.slice(0, 180),
    },
  });
}

async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api("/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } });
  await sub.unsubscribe().catch(() => {});
}

const LEAD_OPTIONS = [
  [0, "정시에"],
  [10, "10분 전"],
  [30, "30분 전"],
  [60, "1시간 전"],
  [120, "2시간 전"],
];

async function notifySheet() {
  const sub = await currentSubscription();
  const status = await api(
    `/push/status${sub ? `?endpoint=${encodeURIComponent(sub.endpoint)}` : ""}`,
  ).catch(() => null);

  const supported = pushSupported();
  const iosNeedsInstall = platformGuess() === "ios" && !isStandalone();
  const perm = supported ? Notification.permission : "unsupported";
  const on = !!status?.subscribed && perm === "granted";
  const st = status?.settings ?? { enabled: true, leadMin: 30, allDayAt: "08:00", morning: null };

  openSheet(`
    <h2>알림 설정</h2>
    <p class="lede">일정 시각이 되면 잠금화면에 알림이 뜹니다.
      기기마다 한 번씩 켜야 합니다.</p>
    <div class="err" hidden></div>

    ${
      !supported
        ? `<div class="info-card"><div class="k">지원하지 않음</div>
             <p style="margin-top:10px;margin-bottom:0">이 브라우저는 알림을 지원하지 않습니다.
             안드로이드는 Chrome, 아이폰은 홈 화면에 추가한 앱에서 사용해 주세요.</p></div>`
        : iosNeedsInstall
          ? `<div class="info-card"><div class="k">먼저 홈 화면에 추가</div>
               <p style="margin-top:10px">아이폰은 홈 화면에 추가한 앱에서만 알림을 받을 수 있습니다.
                  (iOS 16.4 이상)</p>
               <button class="btn ghost" data-action="install-guide">추가하는 방법 보기</button>
             </div>`
          : `<div class="field">
               <button class="toggle-row" data-action="toggle-push" style="width:100%">
                 <span class="label"><b>이 기기에서 알림 받기</b>
                   <span>${
                     perm === "denied"
                       ? "브라우저에서 차단됨 · 설정에서 허용해 주세요"
                       : on
                         ? "켜져 있습니다"
                         : "꺼져 있습니다"
                   }</span></span>
                 <span class="switch" aria-pressed="${on}"></span>
               </button>
             </div>
             ${
               status?.deviceCount
                 ? `<p class="help" style="margin:-8px 2px 16px">가족 전체에서 ${status.deviceCount}개 기기가 알림을 받고 있어요.</p>`
                 : ""
             }`
    }

    <div class="info-card">
      <div class="k">시각이 있는 일정</div>
      <p style="margin-top:10px">언제 미리 알려줄까요?</p>
      <div class="chips">
        ${LEAD_OPTIONS.map(
          ([v, l]) =>
            `<button class="chip" data-action="set-lead" data-v="${v}"
                     aria-pressed="${st.leadMin === v}">${l}</button>`,
        ).join("")}
      </div>
    </div>

    <div class="info-card">
      <div class="k">종일 일정</div>
      <p style="margin-top:10px">날짜만 있는 일정은 당일 이 시각에 알려줍니다.</p>
      <input id="n-allday" type="time" value="${esc(st.allDayAt)}" />
      <button class="btn ghost" data-action="save-allday" style="margin-top:10px">저장</button>
    </div>

    <div class="info-card">
      <div class="k">아침 요약</div>
      <p style="margin-top:10px">오늘 일정을 한 번에 모아서 보내줍니다.</p>
      <button class="toggle-row" data-action="toggle-morning" style="width:100%;margin-bottom:10px">
        <span class="label"><b>아침 요약 보내기</b>
          <span>${st.morning ? `매일 ${esc(st.morning)}` : "꺼져 있음"}</span></span>
        <span class="switch" data-role="morning" aria-pressed="${!!st.morning}"></span>
      </button>
      <input id="n-morning" type="time" value="${esc(st.morning ?? "07:30")}"
             ${st.morning ? "" : "disabled"} />
      <button class="btn ghost" data-action="save-morning" style="margin-top:10px">저장</button>
    </div>

    <p class="help">알림은 5분 단위로 확인해 보내므로 설정한 시각에서 최대 5분 정도
      늦을 수 있습니다. 개인 전용 항목은 만든 사람에게만 알림이 갑니다.</p>
  `);
}

/* ---------- 홈 화면에 추가 안내 ---------- */

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function platformGuess() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && "ontouchend" in document)) {
    return "ios";
  }
  if (/Android/.test(ua)) return "android";
  return "desktop";
}

function installSheet() {
  const p = platformGuess();

  const ios = `
    <div class="info-card">
      <div class="k">아이폰 · 아이패드</div>
      <p style="margin-top:10px">
        1. 이 화면을 <b>Safari</b>로 열어주세요 (크롬·카톡 내부 브라우저는 안 됩니다)<br />
        2. 아래쪽 <b>공유 버튼</b>
           <span style="display:inline-block;transform:translateY(2px)">⬆️</span> 을 누르세요<br />
        3. 목록을 내려서 <b>"홈 화면에 추가"</b>를 누르세요<br />
        4. 오른쪽 위 <b>추가</b>를 누르면 끝입니다
      </p>
      <p style="margin-bottom:0">
        홈 화면에 앱 아이콘이 생기고, 열면 주소창 없이 앱처럼 전체화면으로 켜집니다.
      </p>
    </div>`;

  const android = `
    <div class="info-card">
      <div class="k">안드로이드</div>
      <p style="margin-top:10px">
        1. 이 화면을 <b>Chrome</b>으로 열어주세요<br />
        2. 오른쪽 위 <b>⋮ 메뉴</b>를 누르세요<br />
        3. <b>"앱 설치"</b> 또는 <b>"홈 화면에 추가"</b>를 누르세요
      </p>
      <p style="margin-bottom:0">화면 아래에 설치 안내 배너가 바로 뜨는 경우도 있습니다.</p>
    </div>`;

  openSheet(`
    <h2>휴대폰에 앱으로 설치</h2>
    <p class="lede">
      앱스토어에는 없습니다. 이 앱은 <b>홈 화면에 추가</b>하는 방식이라
      설치 심사도, 업데이트 다운로드도 필요하지 않습니다.
    </p>
    <div class="err" hidden></div>
    ${
      isStandalone()
        ? `<div class="info-card"><div class="k">설치 완료</div>
             <p style="margin-top:10px;margin-bottom:0">
               이미 홈 화면 앱으로 실행 중입니다. 추가로 할 일이 없어요.</p></div>`
        : ""
    }
    ${p === "android" ? android + ios : ios + android}
    <div class="info-card">
      <div class="k">가족에게 보낼 때</div>
      <p style="margin-top:10px;margin-bottom:0">
        설정 → <b>가족 초대</b> → "초대 링크 보내기"로 카톡에 보내면,
        가족은 링크를 누르고 이름만 고르면 됩니다.
      </p>
      <button class="btn ghost" data-action="copy-url" style="margin-top:12px">
        앱 주소 복사</button>
    </div>
  `);
}

/* ---------- 설정 ---------- */

function settingsSheet() {
  const myUrl = state.me?.widgetToken
    ? `${location.origin}/api/widget/${state.me.widgetToken}`
    : null;
  const familyUrl = `${location.origin}/api/widget/${state.family.widgetToken}`;
  openSheet(`
    <h2>설정</h2>
    <div class="err" hidden></div>

    <div class="info-card">
      <div class="k">내 프로필</div>
      <div style="display:flex;align-items:center;gap:9px;margin:8px 0 12px">
        <span style="width:12px;height:12px;border-radius:50%;background:${esc(state.me?.color ?? "#888")}"></span>
        <b style="font-size:17px">${esc(state.me?.name ?? "-")}</b>
      </div>
      <p>비밀번호로 로그인한 상태입니다. 다른 가족이 이 기기를 쓴다면 프로필을 전환하세요.</p>
      <button class="btn ghost" data-action="switch-profile">프로필 전환</button>
    </div>

    <div class="info-card">
      <div class="k">가족 초대</div>
      <p style="margin-top:10px">이 링크를 카톡으로 보내면 가족은 누르고 이름만 고르면 돼요.
        비밀번호는 각자 정합니다.</p>
      <div class="v invite">${esc(fmtInvite(state.family.inviteCode))}</div>
      <button class="btn" data-action="share-invite">초대 링크 보내기</button>
      <button class="btn ghost" data-action="reset-invite" style="margin-top:8px">새 초대 링크 만들기</button>
      <p class="help">모르는 사람에게 링크가 퍼졌다면 새로 만드세요. 이전 링크는 바로 막히고,
        이미 들어온 가족은 그대로 유지됩니다.</p>
    </div>

    <div class="info-card">
      <div class="k">알림</div>
      <p style="margin-top:10px">일정 시각이 되면 잠금화면에 알림이 뜹니다.
        기기마다 한 번씩 켜주세요.</p>
      <button class="btn ghost" data-action="notify-settings">알림 설정</button>
    </div>

    <div class="info-card">
      <div class="k">휴대폰에 앱으로 설치</div>
      <p style="margin-top:10px">
        홈 화면에 추가하면 주소창 없이 앱처럼 켜집니다.
        ${isStandalone() ? "<b>현재 앱으로 실행 중입니다.</b>" : ""}
      </p>
      <button class="btn ghost" data-action="install-guide">설치 방법 보기</button>
    </div>

    ${
      myUrl
        ? `<div class="info-card">
             <div class="k">내 위젯 주소 (읽기 전용)</div>
             <code>${esc(myUrl)}</code>
             <p><b>가족 공유 일정 + 내 개인 항목</b>이 함께 보입니다.
                내 아이폰 위젯에는 이 주소를 넣으세요.
                이 주소는 나만 쓰는 것이니 가족에게도 알려주지 마세요.</p>
             <button class="btn ghost" data-action="copy-my-widget">내 위젯 주소 복사</button>
           </div>`
        : ""
    }

    <div class="info-card">
      <div class="k">가족 공용 위젯 주소 (읽기 전용)</div>
      <code>${esc(familyUrl)}</code>
      <p><b>가족 공유 일정만</b> 보입니다. 개인 항목은 나오지 않습니다.
         거실 아이패드처럼 여러 사람이 함께 보는 기기에 쓰세요.</p>
      <button class="btn ghost" data-action="copy-widget">공용 위젯 주소 복사</button>
    </div>

    <div class="info-card">
      <div class="k">구성원</div>
      <div class="member-list" style="margin-top:10px">
        ${
          state.members.length
            ? state.members
                .map(
                  (m) => `<span class="member-tag">
                    <span class="dot" style="width:9px;height:9px;border-radius:50%;background:${esc(m.color)}"></span>
                    ${esc(m.name)}${m.id === state.me?.id ? " (나)" : ""}
                    ${m.claimed ? '<span title="비밀번호 등록됨" style="font-size:11px">🔒</span>' : ""}
                    <button class="x" data-action="del-member" data-id="${esc(m.id)}"
                            aria-label="${esc(m.name)} 삭제">×</button></span>`,
                )
                .join("")
            : `<span style="font-size:14px;color:var(--text-dim)">아직 없어요</span>`
        }
      </div>
      <div class="row-2">
        <input id="s-member" type="text" maxlength="20" placeholder="이름 추가" />
        <button class="btn ghost" data-action="add-member" style="flex:0 0 80px">추가</button>
      </div>
    </div>

    <button class="btn danger" data-action="logout">이 기기에서 로그아웃</button>
  `);
}

/* ------------------------------ 이벤트 위임 ------------------------------ */

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action], [data-pick-date], [data-pick-time], [data-pick-member]");
  if (!el) return;

  // 칩 선택은 화면만 바꾸고 끝
  if (el.dataset.pickDate !== undefined) {
    document.getElementById("e-date").value = el.dataset.pickDate;
    return syncChips();
  }
  if (el.dataset.pickTime !== undefined) {
    document.getElementById("e-time").value = el.dataset.pickTime;
    return syncChips();
  }
  if (el.dataset.pickMember !== undefined) {
    const on = el.getAttribute("aria-pressed") === "true";
    el.closest(".chips").querySelectorAll("[data-pick-member]").forEach((b) =>
      b.setAttribute("aria-pressed", "false"),
    );
    el.setAttribute("aria-pressed", String(!on));
    return;
  }

  const { action, id } = el.dataset;
  const busy = el.tagName === "BUTTON" && el.classList.contains("btn");
  if (busy) el.disabled = true;

  try {
    switch (action) {
      case "show-create": return createSheet();
      case "show-join": return joinSheet();

      case "do-create": {
        const name = document.getElementById("f-name").value.trim();
        const members = document
          .getElementById("f-members")
          .value.split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const signupCode = document.getElementById("f-signup").value.trim();
        if (!name) return sheetError("가족 이름을 입력해 주세요.");
        if (!signupCode) return sheetError("설치 코드를 입력해 주세요.");
        const res = await api("/family/create", {
          method: "POST",
          body: { name, members, signupCode },
          noAuth: true,
        });
        localStorage.setItem(TOKEN_KEY, res.token);
        state.token = res.token;
        state.familyName = res.family.name;
        closeSheet();
        await refresh();
        return toast("가족 공간을 만들었어요. 이제 내 이름을 골라 주세요");
      }

      case "do-join": {
        const inviteCode = document.getElementById("j-code").value.trim();
        if (!inviteCode) return sheetError("초대 코드를 입력해 주세요.");
        const res = await api("/family/join", {
          method: "POST",
          body: { inviteCode },
          noAuth: true,
        });
        localStorage.setItem(TOKEN_KEY, res.token);
        state.token = res.token;
        state.familyName = res.family.name;
        closeSheet();
        return refresh();
      }

      case "tab":
        state.tab = el.dataset.tab;
        return render();

      case "refresh":
        await refresh();
        return toast("최신 상태로 업데이트했어요");

      case "settings": return settingsSheet();

      case "new-event": return eventSheet(null);
      case "new-memo": return memoSheet(null);

      case "voice": return voiceSheet();
      case "voice-retry": {
        stopListening();
        return startListening(el.closest(".sheet").querySelector("[data-target]").dataset.target);
      }
      case "voice-manual": {
        const t = el.dataset.target;
        const v = voiceResult;
        closeSheet();
        if (t === "memo") return memoSheet({ text: v?.text ?? "" }, { draft: true });
        return eventSheet(
          {
            title: v?.title ?? "",
            date: v?.date ?? state.today,
            time: v?.time ?? null,
            repeat: v?.repeat ?? "none",
          },
          { draft: true },
        );
      }
      case "voice-confirm": {
        const t = el.dataset.target;
        if (!voiceResult) return;
        if (t === "memo") {
          if (!voiceResult.text) return sheetError("내용을 알아듣지 못했어요.");
          await api("/memos", { method: "POST", body: { text: voiceResult.text } });
        } else {
          const title = voiceResult.title || "";
          if (!title) return sheetError("일정 내용을 알아듣지 못했어요. 다시 말해 주세요.");
          await api("/events", {
            method: "POST",
            body: {
              title,
              date: voiceResult.date ?? state.today,
              time: voiceResult.time ?? null,
              repeat: voiceResult.repeat ?? "none",
            },
          });
        }
        closeSheet();
        await refresh();
        return toast(t === "memo" ? "메모를 추가했어요" : "일정을 추가했어요");
      }

      case "install-guide": return installSheet();

      case "notify-settings": return notifySheet();

      case "toggle-push": {
        const sw = el.querySelector(".switch");
        const wasOn = sw.getAttribute("aria-pressed") === "true";
        if (wasOn) {
          await disablePush();
          closeSheet();
          await notifySheet();
          return toast("이 기기에서 알림을 껐어요");
        }
        await enablePush();
        closeSheet();
        await notifySheet();
        return toast("알림을 켰어요");
      }

      case "set-lead": {
        await api("/push/settings", { method: "PATCH", body: { leadMin: Number(el.dataset.v) } });
        closeSheet();
        await notifySheet();
        return toast("미리 알림 시간을 바꿨어요");
      }

      case "save-allday": {
        const v = document.getElementById("n-allday").value;
        if (!v) return sheetError("시각을 선택해 주세요.");
        await api("/push/settings", { method: "PATCH", body: { allDayAt: v } });
        closeSheet();
        await notifySheet();
        return toast("종일 일정 알림 시각을 저장했어요");
      }

      case "toggle-morning": {
        const sw = el.querySelector('[data-role="morning"]');
        const turningOn = sw.getAttribute("aria-pressed") !== "true";
        const v = document.getElementById("n-morning").value || "07:30";
        await api("/push/settings", { method: "PATCH", body: { morning: turningOn ? v : null } });
        closeSheet();
        await notifySheet();
        return toast(turningOn ? `아침 요약을 매일 ${v}에 보내요` : "아침 요약을 껐어요");
      }

      case "save-morning": {
        const v = document.getElementById("n-morning").value;
        if (!v) return sheetError("시각을 선택해 주세요.");
        await api("/push/settings", { method: "PATCH", body: { morning: v } });
        closeSheet();
        await notifySheet();
        return toast(`아침 요약을 매일 ${v}에 보내요`);
      }
      case "mic-fill": {
        // 폼 안에서 제목 칸을 음성으로 채운다
        const Rec = SpeechRec();
        if (!Rec) return toast("이 브라우저는 음성 입력을 지원하지 않습니다.");
        const field = document.getElementById(el.dataset.field);
        if (!field) return;
        stopListening();
        recognizer = new Rec();
        recognizer.lang = "ko-KR";
        recognizer.interimResults = true;
        el.textContent = "●";
        recognizer.onresult = (e) => {
          let out = "";
          for (let i = 0; i < e.results.length; i++) out += e.results[i][0].transcript;
          field.value = out.trim();
        };
        recognizer.onend = () => { el.textContent = "🎙️"; };
        recognizer.onerror = () => {
          el.textContent = "🎙️";
          toast("음성 인식에 실패했어요.");
        };
        try { recognizer.start(); } catch { el.textContent = "🎙️"; }
        return;
      }

      case "open-event": {
        const ev = state.events.find((x) => x.id === id);
        return ev && eventSheet(ev);
      }
      case "open-memo": {
        const m = state.memos.find((x) => x.id === id);
        return m && memoSheet(m);
      }

      case "save-event": return saveEvent(id || null);
      case "save-memo": return saveMemo(id || null);

      case "delete-event": {
        if (!confirm("이 일정을 삭제할까요? 반복 일정이면 전체가 삭제됩니다.")) return;
        await api(`/events/${id}`, { method: "DELETE" });
        closeSheet();
        await refresh();
        return toast("일정을 삭제했어요");
      }
      case "delete-memo": {
        if (!confirm("이 메모를 삭제할까요?")) return;
        await api(`/memos/${id}`, { method: "DELETE" });
        closeSheet();
        await refresh();
        return toast("메모를 삭제했어요");
      }

      case "toggle-memo": {
        const m = state.memos.find((x) => x.id === id);
        if (!m) return;
        m.done = m.done ? 0 : 1; // 즉시 반영
        render();
        return api(`/memos/${id}`, { method: "PATCH", body: { done: !!m.done } }).then(refresh);
      }

      case "toggle-pin":
      case "toggle-visibility": {
        const sw = el.querySelector(".switch");
        sw.setAttribute("aria-pressed", String(sw.getAttribute("aria-pressed") !== "true"));
        return;
      }

      case "pick-profile":
        return profilePinSheet(id, el.dataset.name, el.dataset.claimed === "1");

      case "pin-key": return pinPress(el.dataset.k);
      case "pin-back": return pinPress("back");
      case "pin-ok": return submitPin();

      case "add-self": {
        const input = document.getElementById("p-newname");
        const name = input.value.trim();
        if (!name) return toast("이름을 입력해 주세요.");
        await api("/members", { method: "POST", body: { name } });
        input.value = "";
        await loadRoster();
        return render();
      }

      case "switch-profile": {
        closeSheet();
        await loadRoster();
        state.stage = "picker";
        return render();
      }

      case "copy-my-widget":
        return copy(`${location.origin}/api/widget/${state.me.widgetToken}`, "내 위젯 주소");

      case "copy-url": return copy(location.origin, "앱 주소");
      case "share-invite": {
        const url = inviteLink(state.family.inviteCode);
        const text = `${state.family.name} 가족 알림에 초대합니다. 링크를 누르고 내 이름을 골라 주세요.`;
        if (navigator.share) {
          try {
            await navigator.share({ title: "우리가족 알림 초대", text, url });
            return;
          } catch (e) {
            if (e?.name === "AbortError") return;
          }
        }
        return copy(`${text}\n${url}`, "초대 링크");
      }

      case "reset-invite": {
        if (!confirm("새 초대 링크를 만들까요? 지금 링크는 더 이상 쓸 수 없게 됩니다.")) return;
        const res = await api("/family/invite/reset", { method: "POST" });
        state.family.inviteCode = res.inviteCode;
        closeSheet();
        settingsSheet();
        return toast("새 초대 링크를 만들었어요");
      }
      case "copy-widget":
        return copy(`${location.origin}/api/widget/${state.family.widgetToken}`, "위젯 주소");

      case "add-member": {
        const input = document.getElementById("s-member");
        const name = input.value.trim();
        if (!name) return;
        await api("/members", { method: "POST", body: { name } });
        input.value = "";
        await refresh();
        return settingsSheet();
      }
      case "del-member": {
        await api(`/members/${id}`, { method: "DELETE" });
        await refresh();
        return settingsSheet();
      }

      case "logout":
        if (!confirm("로그아웃하면 초대 코드와 PIN으로 다시 들어와야 합니다. 계속할까요?")) return;
        closeSheet();
        return logout();
    }
  } catch (err) {
    if (sheetEl) sheetError(err.message);
    else toast(err.message);
  } finally {
    if (busy) el.disabled = false;
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "e-date" || e.target.id === "e-time") syncChips();
});

// 앱으로 돌아올 때 자동으로 최신 상태를 받아온다
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.token && !sheetEl) refresh().catch(() => {});
});

document.addEventListener("keydown", (e) => {
  if (!pinEntry || !sheetEl) return;
  if (/^[0-9]$/.test(e.key)) pinPress(e.key);
  else if (e.key === "Backspace") pinPress("back");
  else if (e.key === "Enter") submitPin();
});

// 앱이 열린 상태에서 초대 링크를 다시 누른 경우
window.addEventListener("hashchange", () => {
  handleInviteLink().catch((err) => toast(err.message));
});

/* ------------------------------ 시작 ------------------------------ */

state.today = todayISO();

(async () => {
  try {
    if (await handleInviteLink()) return;
  } catch (err) {
    // 링크가 틀려도 기존 로그인은 그대로 이어간다
    toast(err.message);
  }
  if (state.token) {
    refresh().catch((err) => {
      state.loading = false;
      render();
      toast(err.message);
    });
  } else {
    state.loading = false;
    render();
  }
})();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
