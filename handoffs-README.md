# Handoffs

알파가 발행하는 **HANDOFF 아카이브**에 대한 프로젝트 루트 안내 파일입니다. 세부 프로토콜·파일 규칙·상태 태그 정의는 `docs/handoffs/README.md` 및 `docs/collab-protocol.md` 를 근거로 삼습니다. 본 문서는 빠른 참조와 운영 책임 요약만 담습니다.

## 아카이브 위치
- 본체: `docs/handoffs/*.md`
- 규칙 문서(근거): `docs/handoffs/README.md`
- 자매 아카이브: `docs/reports/*.md` (팀원 REPORT 회신)
- 인박스: `docs/inbox/*.md` (사용자 지시 원문)

## 빠른 요약
- 1 지시 = 최소 1 HANDOFF. 알파는 단독 작업을 금지한다.
- 파일명: `YYYY-MM-DD-<from>-to-<to>-<slug>.md`
- 필수 프런트매터: `status`, `from`, `to`, `opened`
- 본문은 `HANDOFF` 한 줄 → 배경 → 기대 산출물 체크리스트 → `REPORT` 수신란 순서 고정.

## HANDOFF 한 줄 포맷
```
HANDOFF 알파→<to> :: <slug> :: <기대 산출물 경로> :: <완료 조건>
```

## 상태 태그
- `open`: 수신자 착수 전
- `wip`: 작업 중 (`update_status="working"` 상태와 일치해야 함)
- `done`: 감마 검수 통과
- `blocked`: 에스컬레이션 필요, 해제 조건 1문장 명시

## 운영 책임
- **알파**: 지시 수신 즉시 본 아카이브에 HANDOFF 파일을 추가하고 해당 수신자의 인박스에 링크를 꽂는다.
- **수신자(베타·감마·디자이너)**: HANDOFF 파일을 열람 후 `docs/reports/` 에 대응 REPORT 생성. 파일명은 `YYYY-MM-DD-<slug>` 파트를 상속.
- **감마**: 매 틱 아카이브를 스캔해 상태 불일치(예: `update_status="working"` 인데 HANDOFF가 `open`)을 `docs/inbox/` 블록으로 역보고.

## 신규 HANDOFF 추가 체크리스트
1. 파일명에 `YYYY-MM-DD-<from>-to-<to>-<slug>` 규칙을 지켰는가?
2. 프런트매터에 `status`, `from`, `to`, `opened` 4개 필드를 모두 채웠는가?
3. `HANDOFF` 한 줄에 산출물 경로와 완료 조건이 명시되어 있는가?
4. 기대 산출물 체크리스트를 최소 1개 이상 작성했는가?
5. 대응 수신자의 `docs/inbox/<팀원>.md` 에 해당 HANDOFF 링크를 추가했는가?
6. `docs/handoffs/README.md` 말미 색인 표(있다면)에 1행 추가했는가?

세부 규약이 갱신되면 본 문서가 아니라 `docs/handoffs/README.md` 또는 `docs/collab-protocol.md` 를 먼저 고치고, 요약 불일치 시 본 문서를 맞춥니다.
