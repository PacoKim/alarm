-- IP 단위 요청 제한 (고정 시간창 카운터)
-- key = '용도:IP', window_start = 시간창 시작 epoch 초
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);
