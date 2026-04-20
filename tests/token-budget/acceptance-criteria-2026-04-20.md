# 초기 수용 기준(Acceptance Criteria) 초안 — 2026-04-20

지시 #1d6c9ff4 (QA) 에 따라 아래 3종 기능에 대한 회귀 수락 기준을 선정의한다.
본 문서는 **구현 전 잠금 문서** 로, 각 항목은 `tests/token-budget/*.spec.ts` 또는
후속 스펙에서 검증 가능한 형태로 옮겨져야 한다(각 AC 마다 "검증 위치" 명시).

---

## 1. MCP HTTP 전송(Streamable HTTP / SSE)

기존 stdio 전송만 지원하던 MCP 채널을 HTTP 기반으로 확장하는 작업. 장기 세션에서
재연결·부분 재전송 비용을 줄이는 것이 핵심 목표.

### AC-1.1 연결 수립
- Given 서버가 `/mcp` 엔드포인트를 노출하고 있을 때
- When 클라이언트가 `POST /mcp` 로 `initialize` JSON-RPC 를 전송하면
- Then 2 초 이내에 `200 OK` 응답과 `serverInfo.capabilities` 를 포함한 본문을 받는다.
- **검증 위치**: `tests/token-budget/mcpHttpTransport.spec.ts`(신규)

### AC-1.2 스트리밍 이벤트 수신
- Given 초기화가 성공하고 세션 id 가 할당되었을 때
- When 서버가 `notifications/progress` 를 SSE 로 푸시하면
- Then 클라이언트는 수신 이벤트의 순서(ordering) 와 `progressToken` 을 보존한다.
- 중간에 연결이 끊기면 `Last-Event-ID` 로 끊긴 지점부터 재개되어야 한다.

### AC-1.3 토큰 절약 — 재연결 비용
- 세션 재개 시 이미 전송된 리소스 스냅샷을 재전송하지 않는다.
  - 측정: 동일 세션의 2회차 연결 후 `cache_creation_input_tokens` 증가분이
    최초 연결 대비 10% 이하.
- **검증 위치**: `tests/token-budget/contextCompression.spec.ts` 의 B 축 연장.

### AC-1.4 오류 분류
- 5xx 는 `MediaAdapterErrorCode: 'NETWORK_ERROR'` 또는 자체 MCP 오류 코드로 매핑.
- 401/403 은 `PERMISSION_DENIED` 로 번역.
- 오류는 usage 누적에 영향을 주지 않는다(실패 호출의 input/output 은 0 처리).

---

## 2. i18n(다국어) 모드

UI 가 한국어/영어 2개 언어를 전환하는 기능. 프롬프트 템플릿에 언어 지시를 포함해
에이전트 응답 언어를 일관시키는 것이 목표.

### AC-2.1 전환 즉시 반영
- Given `LANG=ko` 상태에서 UI 를 렌더링한 후
- When 사용자가 언어 드롭다운에서 English 를 선택하면
- Then 500ms 이내에 모든 공개 문자열(버튼·툴팁·에이전트 카드 라벨) 이 영어로 교체된다.
- **검증 위치**: 신규 `tests/i18n/i18nSwitch.unit.test.tsx`.

### AC-2.2 프롬프트 언어 일관성
- Claude 호출 프롬프트에 현재 UI 언어가 `[LANGUAGE: ko]` 같은 메타 블록으로 삽입된다.
- 에이전트 응답 샘플 50건 중 45건 이상이 동일 언어로 응답(정확 매칭 90%+).

### AC-2.3 캐시 무효화
- 언어 전환은 **프롬프트 헤더** 변경을 의미 → 이전 캐시는 읽기 불가해야 한다.
- 전환 직후 첫 호출의 `cache_read_input_tokens` 는 0, `cache_creation_input_tokens` 는 양수.
- **검증 위치**: `tests/token-budget/contextCompression.spec.ts` 재웜업 테스트 패턴 재사용.

### AC-2.4 폴백
- 번역 키 누락 시 키 자체(예: `label.save`) 대신 기본 언어(ko) 문자열로 폴백.
- 콘솔에 1회성 warning 만 출력, 에러는 throw 하지 않는다.

---

## 3. 에이전트 추천(Agent Recommendation) 기능

공동 목표를 입력하면 팀 리더가 적합한 에이전트 조합을 제안하는 기능.

### AC-3.1 추천 정확도 — 기본 5케이스
- 시나리오 매트릭스(5건: 프론트엔드/백엔드/데이터/디자인/QA 중심) 각각에 대해
  추천 결과의 상위 3명 중 2명이 "정답 셋" 에 포함.
- **검증 위치**: `tests/agent-recommendation/matrix.unit.test.ts`(신규).

### AC-3.2 추천 응답 시간
- 팀 크기 ≤ 10 일 때 추천 함수 호출부터 결과 반환까지 300ms 이내.
- Claude 호출을 포함한 전체 경로는 5초 이내(p95).

### AC-3.3 빈 팀 · 단일 멤버 경계
- 팀이 비었을 때: 빈 배열을 돌려주고, `MediaAdapterError` 를 던지지 않는다.
- 팀이 1명일 때: 그 1명을 무조건 반환하고 score 는 0 이상.

### AC-3.4 토큰 절약 — 추천 재계산 차단
- 같은 (goalText, teamIds) 쌍에 대한 연속 호출은 5분 이내 캐시 히트.
  - 측정: 2회차 호출의 `input_tokens` 가 0(또는 미호출).
- **검증 위치**: `tests/token-budget/redundantRequest.spec.ts` 의 detectRedundantCalls
  판정식을 추천 모듈에서 재사용한다.

### AC-3.5 응답 형식
- `{ suggestions: Array<{ agentId: string; score: number; reason: string }> }`
- score 는 0~1 범위 소수, reason 은 1~2 문장 한국어.
- UI 는 최대 5건까지만 렌더링하므로 서버는 5건 이하로 잘라 반환한다.

---

## 공통 회귀 기준
- 모든 AC 는 `node:test` + `tsx` 로 실행 가능해야 하며, CI 가
  `tests/token-budget/` · `tests/i18n/` · `tests/agent-recommendation/` 하위를
  glob 으로 수집한다.
- 토큰 소비는 `estimateCostUsd` 로 환산 시 기능별 일일 예산(임계값 패널) 의
  20% 를 초과하지 않는다.
- 실패 시 회귀 원인을 짧게 남기는 `[원인]` 라인을 한국어로 append 한다.
