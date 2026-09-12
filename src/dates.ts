/**
 * 날짜는 전부 한국시간(Asia/Seoul) 기준 'YYYY-MM-DD' 문자열로 다룬다.
 * 문자열 비교가 곧 날짜 순서이므로 정렬/범위 질의가 단순하고 타임존 버그가 없다.
 */

export const TZ = "Asia/Seoul";

/** 서버가 어디서 돌든 '한국의 오늘' */
export function todayKST(now = new Date()): string {
  // en-CA 로케일은 YYYY-MM-DD 형식을 준다
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now);
}

/** 한국시간 기준 현재 'HH:MM' */
export function nowTimeKST(now = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

/** 'YYYY-MM-DD' -> UTC 자정 Date (날짜 산술용. 타임존 개입 없음) */
function parse(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

export function diffDays(from: string, to: string): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
}

/** 0=일 ... 6=토 */
export function weekday(date: string): number {
  return parse(date).getUTCDay();
}

const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

/** 위젯/목록에 쓰는 사람 친화 라벨: 오늘 / 내일 / 9월 15일 (월) */
export function dayLabel(date: string, today = todayKST()): string {
  const delta = diffDays(today, date);
  if (delta === 0) return "오늘";
  if (delta === 1) return "내일";
  if (delta === 2) return "모레";
  if (delta === -1) return "어제";
  const d = parse(date);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 (${WEEKDAY_KO[d.getUTCDay()]})`;
}

/** '19:30' -> '오후 7:30' */
export function timeLabel(time: string | null): string {
  if (!time) return "종일";
  const [h, m] = time.split(":").map(Number);
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${ampm} ${h12}시` : `${ampm} ${h12}:${String(m).padStart(2, "0")}`;
}

export interface EventRow {
  id: string;
  title: string;
  date: string;
  time: string | null;
  end_time: string | null;
  location: string | null;
  notes: string | null;
  member_id: string | null;
  repeat: string;
  repeat_until: string | null;
}

export interface Occurrence extends EventRow {
  /** 실제 발생 날짜 (반복 일정은 원본 date와 다름) */
  occurs_on: string;
}

/**
 * 반복 일정을 [from, to] 구간의 개별 발생으로 펼친다.
 * 원본 date 이전에는 발생하지 않고, repeat_until 이후에는 멈춘다.
 */
export function expandOccurrences(rows: EventRow[], from: string, to: string): Occurrence[] {
  const out: Occurrence[] = [];

  for (const row of rows) {
    if (row.repeat === "none" || !row.repeat) {
      if (row.date >= from && row.date <= to) out.push({ ...row, occurs_on: row.date });
      continue;
    }

    const limit = row.repeat_until && row.repeat_until < to ? row.repeat_until : to;
    // 구간 시작점은 원본 시작일보다 뒤로 갈 수 없다
    const start = row.date > from ? row.date : from;
    if (start > limit) continue;

    const base = parse(row.date);

    switch (row.repeat) {
      case "daily": {
        for (let d = start; d <= limit; d = addDays(d, 1)) {
          out.push({ ...row, occurs_on: d });
        }
        break;
      }
      case "weekly": {
        // 원본 요일과 같은 날만
        let d = start;
        while (weekday(d) !== weekday(row.date) && d <= limit) d = addDays(d, 1);
        for (; d <= limit; d = addDays(d, 7)) {
          out.push({ ...row, occurs_on: d });
        }
        break;
      }
      case "monthly": {
        const dom = base.getUTCDate();
        const cur = parse(start);
        cur.setUTCDate(1);
        for (let guard = 0; guard < 400; guard++) {
          const y = cur.getUTCFullYear();
          const m = cur.getUTCMonth();
          const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
          if (dom <= lastDay) {
            const cand = fmt(new Date(Date.UTC(y, m, dom)));
            if (cand > limit) break;
            if (cand >= start && cand >= row.date) out.push({ ...row, occurs_on: cand });
          }
          cur.setUTCMonth(m + 1);
          if (fmt(cur) > limit) break;
        }
        break;
      }
      case "yearly": {
        const m = base.getUTCMonth();
        const dom = base.getUTCDate();
        const startYear = parse(start).getUTCFullYear();
        for (let y = startYear; y <= parse(limit).getUTCFullYear(); y++) {
          const cand = fmt(new Date(Date.UTC(y, m, dom)));
          if (cand >= start && cand <= limit && cand >= row.date) {
            out.push({ ...row, occurs_on: cand });
          }
        }
        break;
      }
    }
  }

  return out.sort((a, b) => {
    if (a.occurs_on !== b.occurs_on) return a.occurs_on < b.occurs_on ? -1 : 1;
    const at = a.time ?? "00:00";
    const bt = b.time ?? "00:00";
    if (at !== bt) return at < bt ? -1 : 1;
    return a.title.localeCompare(b.title, "ko");
  });
}
