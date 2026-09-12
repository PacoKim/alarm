/**
 * iCalendar(RFC 5545) 구독 피드.
 *
 * 휴대폰 기본 캘린더(아이폰 캘린더, 구글·삼성 캘린더)에 가족 일정을 구독시키면
 * 기본 캘린더 앱과 그 위젯, 시리·구글 어시스턴트가 우리 일정을 보여준다.
 * 읽기 전용이며 위젯과 같은 토큰·같은 공개 범위를 쓴다.
 *
 * 알림(VALARM)은 넣지 않는다. 알림은 우리 푸시가 보내므로 넣으면 두 번 울린다.
 */
import type { EventRow } from "./dates";

export interface IcsEvent extends EventRow {
  updated_at: string;
  member_name?: string | null;
}

const FREQ: Record<string, string> = {
  daily: "DAILY",
  weekly: "WEEKLY",
  monthly: "MONTHLY",
  yearly: "YEARLY",
};

/** TEXT 값 이스케이프 (RFC 5545 3.3.11) */
function text(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

const enc = new TextEncoder();

/**
 * 한 줄이 75옥텟을 넘으면 접는다 (RFC 5545 3.1).
 * 한글은 UTF-8로 3바이트라 글자 수가 아니라 바이트로 센다.
 * 이어지는 줄은 공백 한 칸으로 시작하고 그 공백도 75옥텟에 포함된다.
 */
function fold(line: string): string {
  const parts: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (bytes + b > limit) {
      parts.push(cur);
      cur = ch;
      bytes = b;
    } else {
      cur += ch;
      bytes += b;
    }
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

const ymd = (date: string) => date.replace(/-/g, "");
const hms = (time: string) => `${time.replace(":", "")}00`;

function addMinutes(date: string, time: string, minutes: number): { date: string; time: string } {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm) + minutes * 60_000);
  return {
    date: t.toISOString().slice(0, 10),
    time: t.toISOString().slice(11, 16),
  };
}

function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** ISO 시각 → UTC 기본형 (20260913T101500Z) */
function utcStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function eventLines(ev: IcsEvent, host: string): string[] {
  const lines = ["BEGIN:VEVENT", `UID:${ev.id}@${host}`, `DTSTAMP:${utcStamp(ev.updated_at)}`];

  if (ev.time) {
    // 시각 있는 일정: 한국시간 기준. 끝 시각이 없으면 1시간으로 둔다
    const end =
      ev.end_time && ev.end_time > ev.time
        ? { date: ev.date, time: ev.end_time }
        : addMinutes(ev.date, ev.time, 60);
    lines.push(`DTSTART;TZID=Asia/Seoul:${ymd(ev.date)}T${hms(ev.time)}`);
    lines.push(`DTEND;TZID=Asia/Seoul:${ymd(end.date)}T${hms(end.time)}`);
  } else {
    // 종일 일정: 끝 날짜는 다음 날(배타적)
    lines.push(`DTSTART;VALUE=DATE:${ymd(ev.date)}`);
    lines.push(`DTEND;VALUE=DATE:${ymd(nextDay(ev.date))}`);
  }

  const freq = FREQ[ev.repeat];
  if (freq) {
    let rule = `RRULE:FREQ=${freq}`;
    if (ev.repeat_until) {
      // DTSTART 가 TZID 형식이면 UNTIL 은 UTC 여야 한다. 종료일 23:59:59 KST = 14:59:59Z
      rule += ev.time
        ? `;UNTIL=${ymd(ev.repeat_until)}T145959Z`
        : `;UNTIL=${ymd(ev.repeat_until)}`;
    }
    lines.push(rule);
  }

  const prefix = [
    ev.visibility === "private" ? "🔒" : "",
    ev.member_name ? `[${ev.member_name}]` : "",
  ]
    .filter(Boolean)
    .join(" ");
  lines.push(`SUMMARY:${text(prefix ? `${prefix} ${ev.title}` : ev.title)}`);
  if (ev.location) lines.push(`LOCATION:${text(ev.location)}`);
  if (ev.notes) lines.push(`DESCRIPTION:${text(ev.notes)}`);
  if (ev.visibility === "private") lines.push("CLASS:PRIVATE");
  lines.push("END:VEVENT");
  return lines;
}

export function buildIcs(opts: { calName: string; host: string; events: IcsEvent[] }): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//uri-gajok//family-reminder//KO",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${text(opts.calName)}`,
    "X-WR-TIMEZONE:Asia/Seoul",
    // 구독한 기기가 새로 받아가는 주기 힌트 (기기가 따르지 않을 수도 있다)
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
    // 한국은 일광절약시간이 없어 표준시 하나로 충분하다
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Seoul",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0900",
    "TZOFFSETTO:+0900",
    "TZNAME:KST",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
  for (const ev of opts.events) lines.push(...eventLines(ev, opts.host));
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
