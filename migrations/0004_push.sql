-- 웹 푸시 알림
--
-- 구독은 기기 단위다. 같은 사람이 아이폰·안드로이드·PC에서 각각 구독하면
-- 행이 여러 개 생기고, 알림은 모든 기기로 간다.
CREATE TABLE push_subscriptions (
  id         TEXT PRIMARY KEY,
  family_id  TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  ua         TEXT,
  created_at TEXT NOT NULL,
  last_ok_at TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_push_family ON push_subscriptions(family_id);
CREATE INDEX idx_push_member ON push_subscriptions(member_id);

-- 같은 알림을 두 번 보내지 않기 위한 기록.
-- key = '<종류>:<일정id>:<발생날짜>' 또는 '<종류>:<가족id>:<날짜>'
CREATE TABLE notify_log (
  key     TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
);
CREATE INDEX idx_notify_sent ON notify_log(sent_at);

-- 가족별 알림 설정 (모두 한국시간 기준)
ALTER TABLE families ADD COLUMN notify_enabled   INTEGER NOT NULL DEFAULT 1;
ALTER TABLE families ADD COLUMN notify_lead_min  INTEGER NOT NULL DEFAULT 30;   -- 시각 있는 일정: 몇 분 전
ALTER TABLE families ADD COLUMN notify_allday_at TEXT NOT NULL DEFAULT '08:00'; -- 종일 일정: 당일 몇 시
ALTER TABLE families ADD COLUMN notify_morning   TEXT;                          -- 아침 요약 시각, NULL이면 끔
