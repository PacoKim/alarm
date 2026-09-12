-- 구성원별 로그인과 개인 전용 항목 지원
--
-- members.pin_hash 가 NULL 이면 아직 아무도 그 프로필을 차지하지 않은 상태다.
-- 가족 공간에 들어온 사람이 이름을 고르고 개인 PIN을 정하면 그 프로필의 주인이 된다.
ALTER TABLE members ADD COLUMN pin_hash     TEXT;
ALTER TABLE members ADD COLUMN widget_token TEXT;
ALTER TABLE members ADD COLUMN claimed_at   TEXT;
ALTER TABLE members ADD COLUMN fail_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN locked_until TEXT;

-- 개인 위젯 주소용. SQLite는 UNIQUE 인덱스에서 NULL 중복을 허용한다.
CREATE UNIQUE INDEX idx_members_widget_token ON members(widget_token);

-- visibility: 'family' = 가족 전체 공유, 'private' = 만든 사람만
-- owner_id: 만든 사람. private 항목의 열람·수정 권한 판단에 쓴다.
ALTER TABLE events ADD COLUMN owner_id   TEXT;
ALTER TABLE events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'family';
ALTER TABLE memos  ADD COLUMN owner_id   TEXT;
ALTER TABLE memos  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'family';

CREATE INDEX idx_events_visibility ON events(family_id, visibility, owner_id);
CREATE INDEX idx_memos_visibility  ON memos(family_id, visibility, owner_id);
