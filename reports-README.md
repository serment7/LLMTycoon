# Reports

팀원이 HANDOFF를 수령하고 회신하는 **REPORT 아카이브**에 대한 프로젝트 루트 안내 파일입니다. 상세 규칙·필수 프런트매터·감마 체크리스트·디자이너 보조 규약은 `docs/reports/README.md` 를 근거로 삼습니다. 본 문서는 빠른 참조와 운영 책임 요약만 담습니다.

## 아카이브 위치
- 본체: `docs/reports/*.md`
- 규칙 문서(근거): `docs/reports/README.md`
- 자매 아카이브: `docs/handoffs/*.md` (HANDOFF 원본)
- 인박스: `docs/inbox/*.md` (사용자 지시 원문)

## 빠른 요약
- 1 HANDOFF = 1 REPORT 파일. 후속 회신은 `-followup-<n>` 순번으로.
- 파일명은 대응 HANDOFF의 `YYYY-MM-DD-<slug>` 파트를 상속.
- 필수 프런트매터: `status`, `from`, `to`, `opened`, `origin` (후속은 `parent_report` 추가).
- 본문은 `REPORT` 한 줄 → 전제 → 산출물 → 근거 → 후속 제안 순서 고정.

## REPORT 한 줄 포맷
```
REPORT <from>→알파 :: <done|blocked|wip> :: <산출물 경로> :: <후속 제안>
```

## 운영 책임
- **회신자**: `update_status("working", fileId)` 직후 리포트 파일 생성, 종료 시 상태 갱신.
- **감마**: 매 틱 아카이브를 스캔해 체크리스트 미달 건을 `docs/inbox/` 블록으로 역보고.
- **알파**: 감마 검수 완료 REPORT만 사용자 요약에 반영.

## 신규 리포트 추가 체크리스트
1. 대응 HANDOFF 경로를 `origin`에 정확히 기입했는가?
2. 후속이라면 `parent_report`로 직전 리포트를 가리켰는가?
3. `docs/reports/README.md` 말미 리포트 인덱스 표에 1행 추가했는가?
4. 근거 섹션에 파일 경로·수치·스샷 중 최소 1개가 있는가?
5. `blocked` 상태라면 차단 해제 조건을 1문장 이내로 적었는가?

세부 규약이 갱신되면 본 문서가 아니라 `docs/reports/README.md` 를 먼저 고치고, 요약 불일치 시 본 문서를 맞춥니다.
