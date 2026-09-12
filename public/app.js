/* 우리가족 알림 — 프레임워크 없는 단일 파일 앱 */

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

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) {
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
  const { members } = await api("/members/roster");
  state.roster = members;
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

/* ------------------------------ 온보딩 ------------------------------ */

function renderOnboard() {
  root.innerHTML = `
    <div class="onboard">
      <img class="logo" src="/icons/icon-192.png" alt="" />
      <h1>우리가족 알림</h1>
      <p class="lede">일정과 메모를 가족이 함께 모아두고,<br />잠금화면 위젯으로 바로 확인해요.</p>
      <button class="btn" data-action="show-create">가족 공간 만들기</button>
      <button class="btn ghost" data-action="show-join">초대 코드로 참여하기</button>
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
      <label for="f-pin">공용 PIN (숫자 4~8자리)</label>
      <input id="f-pin" type="text" inputmode="numeric" autocomplete="off"
             placeholder="가족에게 알려줄 번호" maxlength="8" />
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
    <div class="field">
      <label for="j-code">초대 코드</label>
      <input id="j-code" type="text" placeholder="예: K7MQ4P" maxlength="12"
             autocapitalize="characters" autocomplete="off" style="text-transform:uppercase" />
    </div>
    <div class="field">
      <label for="j-pin">공용 PIN</label>
      <input id="j-pin" type="text" inputmode="numeric" autocomplete="off" maxlength="8" />
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
      <span class="when" style="flex:0 0 auto">
        <span class="dot" style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${esc(m.color)}"></span>
      </span>
      <span class="body">
        <span class="title">${esc(m.name)}</span>
        <span class="meta">${m.claimed ? "개인 PIN 입력" : "처음 로그인 · 개인 PIN을 새로 정합니다"}</span>
      </span>
    </button>`;

  root.innerHTML = `
    <div class="app">
      <header class="topbar">
        <h1>나는 누구인가요?
          <span class="sub">${esc(state.familyName ?? "가족 공간")} · 내 일정과 개인 메모를 구분하기 위해 필요해요</span>
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

function profilePinSheet(id, name, claimed) {
  openSheet(`
    <h2>${esc(name)} 님으로 로그인</h2>
    <div class="err" hidden></div>
    ${
      claimed
        ? `<p style="margin:0 0 16px;font-size:14px;color:var(--text-dim);line-height:1.6">
             ${esc(name)} 님이 정한 <b>개인 PIN</b>을 입력해 주세요.</p>`
        : `<p style="margin:0 0 16px;font-size:14px;color:var(--text-dim);line-height:1.6">
             이 프로필은 아직 주인이 없어요. 지금 입력하는 번호가
             <b>${esc(name)} 님의 개인 PIN</b>이 됩니다. 가족 공용 PIN과 다르게 정해도 됩니다.</p>`
    }
    <div class="field">
      <label for="p-pin">개인 PIN (숫자 4~8자리)</label>
      <input id="p-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="8" />
    </div>
    <button class="btn" data-action="do-claim" data-id="${esc(id)}">
      ${claimed ? "로그인" : "이 프로필 사용하기"}</button>
  `, () => document.getElementById("p-pin")?.focus());
}

function render() {
  if (!state.token) return renderOnboard();
  if (state.loading) {
    root.innerHTML = `<div class="spinner"></div>`;
    return;
  }
  if (state.stage === "picker") return renderPicker();

  const openMemos = state.memos.filter((m) => !m.done).length;
  const todayCount = state.events.filter((e) => e.date === state.today).length;

  root.innerHTML = `
    <div class="app">
      <header class="topbar">
        <h1>${esc(state.family?.name ?? "우리가족")}
          <span class="sub">${
            state.me?.name
              ? `${esc(state.me.name)} 님 · `
              : ""
          }${shortDate(state.today)} · 오늘 일정 ${todayCount}개</span>
        </h1>
        <span class="spacer"></span>
        <button class="icon-btn" data-action="refresh" aria-label="새로 고침">↻</button>
        <button class="icon-btn" data-action="settings" aria-label="설정">⚙</button>
      </header>

      <div class="tabs" role="tablist">
        <button class="tab" role="tab" data-action="tab" data-tab="events"
                aria-selected="${state.tab === "events"}">일정</button>
        <button class="tab" role="tab" data-action="tab" data-tab="memos"
                aria-selected="${state.tab === "memos"}">메모
          ${openMemos ? `<span class="count">${openMemos}</span>` : ""}</button>
      </div>

      <main>${state.tab === "events" ? eventsView() : memosView()}</main>

      <div class="fab-bar">
        <button class="fab" data-action="${state.tab === "events" ? "new-event" : "new-memo"}">
          ${state.tab === "events" ? "+  일정 추가" : "+  메모 추가"}
        </button>
      </div>
    </div>`;
}

const RELATIVE_LABELS = new Set(["오늘", "내일", "모레", "어제"]);

/** 시간·장소·담당·반복을 있는 것만 " · "로 이어 붙인다 */
function eventMeta(ev) {
  const parts = [];
  if (ev.visibility === "private") parts.push('<span class="lock">🔒 나만</span>');
  if (ev.time) parts.push(esc(ev.timeLabel));
  if (ev.location) parts.push(esc(ev.location));
  const name = memberName(ev.member_id);
  if (name) parts.push(memberDot(memberColor(ev.member_id), name));
  if (ev.repeat && ev.repeat !== "none") parts.push("반복");
  if (!parts.length) return "";
  return `<span class="meta">${parts.join(' <span aria-hidden="true">·</span> ')}</span>`;
}

function memberDot(color, name) {
  if (!name) return "";
  return `<span class="who"><span class="dot" style="background:${esc(color || "#888")}"></span>${esc(name)}</span>`;
}

function eventsView() {
  const upcoming = state.events.filter((e) => e.date >= state.today);
  if (!upcoming.length) {
    return `<div class="empty"><div class="big">🗓️</div>
      <p>등록된 일정이 없어요.<br />아래 버튼으로 첫 일정을 추가해 보세요.</p></div>`;
  }

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
        <div class="day-head"><b>${esc(label)}</b>
          ${RELATIVE_LABELS.has(label) ? `<span class="date">${shortDate(date)}</span>` : ""}</div>
        <div class="card">
          ${list
            .map(
              (ev) => `
            <button class="row" data-action="open-event" data-id="${esc(ev.id)}">
              <span class="when ${ev.time ? "" : "allday"}">${esc(ev.time ? ev.timeLabel.replace(/^(오전|오후) /, "") : "종일")}</span>
              <span class="body">
                <span class="title">${esc(ev.title)}</span>
                ${eventMeta(ev)}
              </span>
            </button>`,
            )
            .join("")}
        </div>
      </section>`;
    })
    .join("");
}

function memberName(id) {
  return state.members.find((m) => m.id === id)?.name ?? null;
}
function memberColor(id) {
  return state.members.find((m) => m.id === id)?.color ?? null;
}

function memosView() {
  if (!state.memos.length) {
    return `<div class="empty"><div class="big">📝</div>
      <p>메모가 없어요.<br />고정한 메모는 위젯에 바로 표시돼요.</p></div>`;
  }

  const open = state.memos.filter((m) => !m.done);
  const done = state.memos.filter((m) => m.done);

  const block = (list, heading) =>
    !list.length
      ? ""
      : `<section class="day-group">
          ${heading ? `<div class="day-head"><b>${heading}</b></div>` : ""}
          <div class="card">${list.map(memoRow).join("")}</div>
        </section>`;

  return block(open, "할 일 · 메모") + block(done, "완료");
}

function memoRow(m) {
  return `
    <div class="row memo-row ${m.done ? "done" : ""}">
      <button class="check" data-action="toggle-memo" data-id="${esc(m.id)}"
              aria-label="완료 표시">✓</button>
      <button class="body" style="background:none;border:none;padding:0;text-align:left"
              data-action="open-memo" data-id="${esc(m.id)}">
        <span class="title">${m.pinned ? `<span class="pin">📌</span> ` : ""}${
          m.visibility === "private" ? `<span class="lock">🔒</span> ` : ""
        }${esc(m.text)}</span>
        <span class="meta">${[
          m.visibility === "private" ? '<span class="lock">나만 보기</span>' : "",
          memberDot(memberColor(m.member_id), memberName(m.member_id)),
        ]
          .filter(Boolean)
          .join(' <span aria-hidden="true">·</span> ')}</span>
      </button>
    </div>`;
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

function eventSheet(ev) {
  const editing = !!ev;
  const today = state.today || todayISO();
  const date = ev?.date ?? today;
  const time = ev?.time ?? "";

  openSheet(`
    <h2>${editing ? "일정 수정" : "일정 추가"}</h2>
    <div class="err" hidden></div>

    <div class="field">
      <label for="e-title">무슨 일정인가요?</label>
      <input id="e-title" type="text" maxlength="120" value="${esc(ev?.title ?? "")}"
             placeholder="예: 지훈이 치과 예약" />
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

function memoSheet(memo) {
  const editing = !!memo;
  openSheet(`
    <h2>${editing ? "메모 수정" : "메모 추가"}</h2>
    <div class="err" hidden></div>
    <div class="field">
      <label for="m-text">메모 내용</label>
      <textarea id="m-text" maxlength="300"
        placeholder="예: 우유 사오기 / 관리비 25일까지">${esc(memo?.text ?? "")}</textarea>
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
      <p>개인 PIN으로 로그인한 상태입니다. 다른 가족이 이 기기를 쓴다면 프로필을 전환하세요.</p>
      <button class="btn ghost" data-action="switch-profile">프로필 전환</button>
    </div>

    <div class="info-card">
      <div class="k">가족 초대 코드</div>
      <div class="v">${esc(state.family.joinCode)}</div>
      <p>가족에게 이 코드와 공용 PIN을 알려주면 같은 일정·메모를 함께 볼 수 있어요.</p>
      <button class="btn ghost" data-action="copy-code">초대 코드 복사</button>
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
                    ${m.claimed ? '<span title="개인 PIN 등록됨" style="font-size:11px">🔒</span>' : ""}
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
        const pin = document.getElementById("f-pin").value.trim();
        const members = document
          .getElementById("f-members")
          .value.split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const signupCode = document.getElementById("f-signup").value.trim();
        if (!name) return sheetError("가족 이름을 입력해 주세요.");
        if (!/^\d{4,8}$/.test(pin)) return sheetError("PIN은 숫자 4~8자리로 만들어 주세요.");
        if (!signupCode) return sheetError("설치 코드를 입력해 주세요.");
        const res = await api("/family/create", {
          method: "POST",
          body: { name, pin, members, signupCode },
        });
        localStorage.setItem(TOKEN_KEY, res.token);
        state.token = res.token;
        state.familyName = res.family.name;
        state.joinCodeHint = res.family.joinCode;
        closeSheet();
        await refresh();
        return toast(`초대 코드 ${res.family.joinCode} · 이제 내 프로필을 골라주세요`);
      }

      case "do-join": {
        const joinCode = document.getElementById("j-code").value.trim().toUpperCase();
        const pin = document.getElementById("j-pin").value.trim();
        if (!joinCode || !pin) return sheetError("초대 코드와 PIN을 모두 입력해 주세요.");
        const res = await api("/family/join", { method: "POST", body: { joinCode, pin } });
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

      case "do-claim": {
        const pin = document.getElementById("p-pin").value.trim();
        if (!/^\d{4,8}$/.test(pin)) {
          return sheetError("개인 PIN은 숫자 4~8자리로 입력해 주세요.");
        }
        const res = await api("/members/claim", {
          method: "POST",
          body: { memberId: id, pin },
        });
        localStorage.setItem(TOKEN_KEY, res.token);
        state.token = res.token;
        closeSheet();
        await refresh();
        return toast(`${res.me.name} 님으로 로그인했어요`);
      }

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

      case "copy-code": return copy(state.family.joinCode, "초대 코드");
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

/* ------------------------------ 시작 ------------------------------ */

state.today = todayISO();

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

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
