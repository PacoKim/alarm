-- 가족 단위 공간
CREATE TABLE families (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  join_code    TEXT NOT NULL UNIQUE,   -- 가족에게 공유하는 초대 코드
  pin_hash     TEXT NOT NULL,          -- PBKDF2(salt:hash)
  widget_token TEXT NOT NULL UNIQUE,   -- 위젯용 읽기 전용 토큰
  fail_count   INTEGER NOT NULL DEFAULT 0,  -- PIN 연속 실패 횟수
  locked_until TEXT,                        -- 잠금 해제 시각 (ISO)
  created_at   TEXT NOT NULL
);

-- 가족 구성원 (일정/메모에 "누구" 표시용)
CREATE TABLE members (
  id         TEXT PRIMARY KEY,
  family_id  TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#4f7cff',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_members_family ON members(family_id, sort_order);

-- 일정. 날짜/시간은 한국시간(Asia/Seoul) 기준 문자열로 저장한다.
-- date='2026-09-12', time='19:30' (time이 NULL이면 종일 일정)
CREATE TABLE events (
  id           TEXT PRIMARY KEY,
  family_id    TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  date         TEXT NOT NULL,
  time         TEXT,
  end_time     TEXT,
  location     TEXT,
  notes        TEXT,
  member_id    TEXT REFERENCES members(id) ON DELETE SET NULL,
  repeat       TEXT NOT NULL DEFAULT 'none',  -- none|daily|weekly|monthly|yearly
  repeat_until TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_events_family_date ON events(family_id, date);

-- 메모. pinned=1 이면 위젯 상단에 고정 노출
CREATE TABLE memos (
  id         TEXT PRIMARY KEY,
  family_id  TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  done       INTEGER NOT NULL DEFAULT 0,
  member_id  TEXT REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_memos_family ON memos(family_id, done, pinned, created_at);
