-- 초대 링크 방식으로 전환
--
-- 가족 공용 PIN을 없애고, 링크에 담기는 12자리 무작위 초대 코드 하나로
-- 가족 공간에 들어온다. 32종 문자 12자리 = 60비트라 추측이 사실상 불가능하고,
-- IP당 1분 10회 요청 제한도 그대로 걸린다.
-- 기존 가족은 값이 비어 있으며, 구성원이 처음 앱을 열 때 서버가 발급한다.
ALTER TABLE families ADD COLUMN invite_code TEXT;
CREATE UNIQUE INDEX idx_families_invite ON families(invite_code);
