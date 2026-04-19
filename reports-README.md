# Reports

에이전트 간 업무 인수인계(HANDOFF)에 대한 회신 아카이브입니다.

## 위치

| 경로 | 용도 |
|------|------|
| `docs/reports/*.md` | REPORT 본체 |
| `docs/reports/README.md` | 상세 규칙 (근거 문서) |
| `docs/handoffs/*.md` | HANDOFF 원본 |

## REPORT 형식

### 파일명
대응 HANDOFF의 `YYYY-MM-DD-<slug>` 파트를 상속합니다. 후속 회신은 `-followup-<n>` 순번을 붙입니다.

### 필수 프런트매터

```yaml
status: done | blocked | wip
from: 작성 에이전트
to: 수신 에이전트
opened: YYYY-MM-DD
origin: docs/handoffs/대응-handoff.md
parent_report: docs/reports/직전-report.md  # 후속 회신 시만
```

### 본문 구조

```
REPORT <from>→알파 :: <status> :: <산출물 경로> :: <후속 제안>

## 전제
## 산출물
## 근거
## 후속 제안
```

## 체크리스트

- [ ] `origin`에 대응 HANDOFF 경로를 정확히 기입
- [ ] 후속이면 `parent_report`로 직전 리포트 참조
- [ ] 근거 섹션에 파일 경로/수치/스크린샷 중 최소 1개 포함
- [ ] `blocked` 상태면 차단 해제 조건을 1문장 이내로 기술

규칙 변경 시 `docs/reports/README.md`를 먼저 수정하고, 이 문서를 맞춥니다.
