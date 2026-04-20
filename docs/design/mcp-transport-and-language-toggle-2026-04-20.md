---
date: 2026-04-20
owner: Designer (LLMTycoon)
trigger-directive: "지시 #a2698a11 — MCP 전송 선택 UI + 언어 모드 토글 배치·피드백·폴백"
prior-context:
  - src/stores/projectMcpServersStore.ts (validateMcpServerInput · stdio/http/streamable-http 검증 로직 권위)
  - src/components/ProjectMcpServersPanel.tsx (현행 stdio 전용 폼 — 확장 대상)
  - src/i18n/index.ts (Joker 완료 — useLocale · translate · persistLocale)
  - locales/en.json · locales/ko.json (키 스키마 — locale.label / locale.en / locale.ko 등 확정)
  - src/components/SettingsDrawer.tsx (설정 패널 — 언어 토글 합류 지점)
  - src/components/OnboardingTour.tsx (온보딩 3스텝 — 언어 전환 상단 스트립 합류 지점)
  - docs/design/skills-mcp-settings-spec.md (스킬·MCP 탭 구조 선례)
  - docs/design/design-system-consistency-round2.md (토큰·간격·포커스 기준)
  - docs/design/project-creation-agent-recommendation-2026-04-20.md (모달 내 언어 토글 세션 한정 원칙 — 본 시안과 경계 분리)
  - tests/multimediaTypes.unit.test.ts (우선 검토 파일 — 어댑터 오류 계약 회귀 축, 본 시안의 에러 메시지 레이어가 공유)
report-to: Joker (dfce6d78-c2c8-4263-b189-6dfe1a3a1f23)
scope:
  - "ProjectMcpServersPanel 의 transport 3종 분기 와이어프레임 · 필드 가시성 규칙 · 유효성 에러 메시지 한/영 카피"
  - "언어 모드 토글의 노출 위치(SettingsDrawer · OnboardingTour · 헤더) · 전환 피드백 · 미번역 키 폴백 표시 가이드라인"
---

# MCP 전송 선택 UI + 언어 모드 토글 — 통합 시안 (2026-04-20)

본 시안은 **두 축을 한 페이지로 묶어** 기존 디자인 시스템 토큰(`src/styles/tokens.css`) 위에 확정한다. Figma 소스가 없는 현 레포 정책(`docs/design/project-creation-agent-recommendation-2026-04-20.md` §0 의 P-05 각주) 상 **Figma 1페이지 = 본 .md 1파일** 의 등가 규약을 따른다. Figma 도입이 결정되면 본 시안의 §3 토큰 표·§9 토큰 표를 그대로 Variables 로 이식한다.

선행 시안(`skills-mcp-settings-spec.md` §K-01~K-08) 의 **탭 구조 · 마스킹 규약 · 검증 실패 위치 원칙** 은 본 시안의 기반이다. 본 시안이 덮어쓰는 결정은 §K-03(마스킹 5초 자동 복귀) 를 **`authToken` 축으로 확장** 하고, §K-04(검증 실패 필드 하단 고정) 를 **transport 분기별 에러 그룹핑** 으로 정교화한 것이다.

> 우선 검토 파일 `tests/multimediaTypes.unit.test.ts` 는 `MediaAdapterError` 의 `cause` · `details` 불변 계약을 잠근다 — 본 시안의 §2.4 검증 에러 카피 테이블은 **그 계약과 직접 연결되지 않지만**, 어댑터 호출 경로에서 MCP 원인을 `cause` 로 감싸 주면 UI 카피가 원인 문자열을 원본 그대로 표기할 수 있어야 한다는 원칙을 공유한다(§2.4 주석 참조).

---

## 0. 설계 원칙 (M-01 ~ M-12)

### 0.1 MCP 전송 선택(M-01 ~ M-06)

| ID   | 원칙 |
| ---- | ---- |
| M-01 | **transport 는 폼 최상단 세그먼티드 컨트롤**: `[ stdio ] [ http ] [ streamable-http ]` 3탭. 선택에 따라 하단 필드가 `stdio 그룹` ↔ `http 그룹` 으로 **즉시 교체**. 라디오 버튼 나열 금지 — 탭만 한 눈에 들어온다. |
| M-02 | **필드 가시성 = 선택 transport 에 정확히 필요한 것만**: stdio → command · args · env. http/streamable-http → url · headers · authToken. 공통: name. 전환 시 숨겨지는 쪽 값은 **메모리에 유지** 하되 제출 시에는 현재 transport 필드만 전송(사용자가 되돌렸을 때 복원 편의, §2.2). |
| M-03 | **authToken 은 입력 즉시 마스킹**: `password` 타입 + 우측 `[👁️ 보기]` 토글(`aria-pressed`). `skills-mcp-settings-spec.md` §K-03 의 5초 자동 복귀 규약을 authToken 축으로도 적용. 로그·onLog 콜백에도 **원문 절대 기록 금지**. |
| M-04 | **url 은 `https` 선호 · `http` 는 경고 배지**: `http://localhost` 는 허용하되 "로컬 네트워크 외에서는 https 권장" 경고 배지 표시. 검증 에러가 아니라 힌트(`color-warning`) — 사용자 선택권 보장. |
| M-05 | **headers 는 key=value 배열 위젯**: stdio 의 env 가 `textarea` 로 한 줄씩 받는 방식과 달리, http 헤더는 **편집이 빈번** 하므로 동적 행 추가/삭제 위젯. 각 행 `name` 입력(폭 30%) + `value` 입력(폭 60%) + `✕` (폭 10%). |
| M-06 | **검증 실패는 transport 그룹 아래 1 블록**: 에러가 분기 필드 안에 섞여 보이면 "무엇을 바꾸면 되는지" 가 흐려진다. 그룹 하단에 **에러 2–3줄** 을 고정 — 3줄 넘으면 "외 N건" 접기. `aria-live="polite"`. |

### 0.2 언어 모드 토글(M-07 ~ M-12)

| ID   | 원칙 |
| ---- | ---- |
| M-07 | **1차 노출은 SettingsDrawer**: 톱니바퀴 → 설정 패널 최상단 "언어" 섹션. 전역·영속. 단일 진실의 원천(단 하나의 저장 지점 = `user_preferences.language`). |
| M-08 | **2차 노출은 온보딩 1스텝 상단 스트립**: OnboardingTour 의 3스텝 위에 `[🌐 한국어 ▾]` 얇은 스트립(높이 32px) 을 고정. 튜토리얼 문구가 읽기 어려우면 즉시 바꾸도록 — 보이지 않으면 "설정 어디 있지?" 로 새어 나간다. |
| M-09 | **3차(세션 한정)** 는 `NewProjectAgentModal` 같은 개별 모달 헤더(선행 시안 §3). 본 시안의 대상 아님 — 경계만 명시. |
| M-10 | **전환 피드백은 토스트 1회 + 타이틀 업데이트**: 스피너/블로킹 금지. 언어 리소스는 JSON 정적 import 라 지연 거의 0. 토스트 "언어를 한국어로 전환했습니다" 를 2초간, `aria-live="polite"`. 문서 `<html lang>` 속성도 동기화. |
| M-11 | **미번역 키 폴백은 3단 계단**: 현재 locale 누락 → 기본 locale(en) 사용 → 그래도 없으면 **key 원문 + 개발 경고 배지(개발 빌드만)**. 프로덕션에서는 key 원문만(회색 body). `translate()` 구현(`src/i18n/index.ts:148-157`) 과 1:1. |
| M-12 | **언어 바꿈 = 저장된 사용자 콘텐츠 변환 금지**: 프로젝트 설명 · 파일 이름 · 커밋 메시지 등 사용자 입력물은 현지화 대상 아님. 번역은 **라벨 · 버튼 · 시스템 메시지** 에만. (모달 세션 토글도 이 규칙 공유 — 선행 시안 §3.4 계승.) |

---

## 1. MCP 연결 설정 — 와이어프레임 (transport 3 상태)

폭 기준: Desktop 960px 이상에서 **2-column 그리드**(왼쪽: 메타 · 오른쪽: 전송 상세). 768px 이하에서 **1-column 누적**. 모든 폭에서 transport 선택은 맨 위 1행.

### 1.1 상태 A · `transport=stdio` (기본값, schemaVersion=1 레거시 포함)

```
┌ ProjectMcpServersPanel ─────────────────────────────────────── MCP 서버 설정 · 프로젝트 전용 ┐
│                                                                                              │
│  전송 방식                                                                                    │
│  ┌──────────┬──────────┬───────────────────┐   ← 세그먼티드 컨트롤, 선택은 accent 배경        │
│  │ ▶ stdio  │   http   │ streamable-http   │     [Tab] 순환 · [←/→] 이동 · [Enter/Space]     │
│  └──────────┴──────────┴───────────────────┘                                                 │
│                                                                                              │
│  ┌─ 메타(col 1) ────────────────────┐   ┌─ 전송 상세(col 2) ────────────────────────────┐    │
│  │ 이름 *                            │   │ command *                                      │    │
│  │ [ llm-tycoon                   ]  │   │ [ npx                                     ]    │    │
│  │ 영숫자/._- 만, 48자 이하            │   │ 쉘 메타(; & | ` $ < >) 금지, 256자 이하       │    │
│  │                                   │   │                                                │    │
│  │                                   │   │ args (공백 구분)                                │    │
│  │                                   │   │ [ -y @modelcontextprotocol/server-llm-tycoon ] │    │
│  │                                   │   │ 각 항목 512자 이하, 제어문자 금지                │    │
│  │                                   │   │                                                │    │
│  │                                   │   │ env (한 줄에 KEY=VALUE)                         │    │
│  │                                   │   │ ┌──────────────────────────────────────────┐   │    │
│  │                                   │   │ │ API_URL=http://localhost:3000            │   │    │
│  │                                   │   │ │ AGENT_TOKEN=<토큰>                       │   │    │
│  │                                   │   │ └──────────────────────────────────────────┘   │    │
│  │                                   │   │ 키는 POSIX(영숫자/_만, 숫자 시작 금지), 4096자  │    │
│  └───────────────────────────────────┘   └────────────────────────────────────────────────┘    │
│                                                                                              │
│  ⚠ (검증 실패 시) · 에러 블록 — 최대 3줄 + "외 N건" 접기 (§2.4 카피 공급)                       │
│                                                                                              │
│                                                          [ 취소 ]     [ + MCP 서버 추가 ]    │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 상태 B · `transport=http`

```
┌ ProjectMcpServersPanel ───── MCP 서버 설정 · 프로젝트 전용 ────────────────────────── ┐
│                                                                                         │
│  전송 방식                                                                              │
│  ┌──────────┬──────────┬───────────────────┐                                            │
│  │   stdio  │ ▶ http   │ streamable-http   │                                            │
│  └──────────┴──────────┴───────────────────┘                                            │
│                                                                                         │
│  ┌─ 메타 ───────────────────┐   ┌─ 전송 상세(http) ────────────────────────────────┐    │
│  │ 이름 *                   │   │ url *                                              │    │
│  │ [ api-proxy         ]    │   │ [ https://mcp.example.com/invoke              ]    │    │
│  │                          │   │ http/https 스킴만, 2048자 이하                      │    │
│  │                          │   │                                                    │    │
│  │                          │   │ headers (선택)                                     │    │
│  │                          │   │ ┌──────────────┬──────────────────────┬─────┐    │    │
│  │                          │   │ │ X-Request-Id │ dashboard-2026       │ ✕   │    │    │
│  │                          │   │ ├──────────────┼──────────────────────┼─────┤    │    │
│  │                          │   │ │ Accept       │ application/json     │ ✕   │    │    │
│  │                          │   │ └──────────────┴──────────────────────┴─────┘    │    │
│  │                          │   │ [ + 헤더 추가 ]                                     │    │
│  │                          │   │                                                    │    │
│  │                          │   │ authToken (선택) · Bearer 인증                      │    │
│  │                          │   │ [ ••••••••••••••••••••••••  ]  [👁️ 보기]           │    │
│  │                          │   │ 마스킹 기본 · 5초 후 자동 복귀 · 로그 금지(M-03)     │    │
│  │                          │   │ ⚠ http:// 는 로컬 외 환경에서 https 권장(M-04)      │    │
│  └──────────────────────────┘   └────────────────────────────────────────────────────┘    │
│                                                                                         │
│  ⚠ 검증 실패 블록                                                                       │
│                                                                                         │
│                                                         [ 취소 ]   [ + MCP 서버 추가 ]  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.3 상태 C · `transport=streamable-http`

```
┌ ProjectMcpServersPanel ───── MCP 서버 설정 · 프로젝트 전용 ────────────────────────── ┐
│                                                                                         │
│  전송 방식                                                                              │
│  ┌──────────┬──────────┬───────────────────┐                                            │
│  │   stdio  │   http   │ ▶ streamable-http │                                            │
│  └──────────┴──────────┴───────────────────┘                                            │
│                                                                                         │
│  (필드는 상태 B 와 동일 — url · headers · authToken)                                    │
│  💡 SSE(server-sent events) 스트림을 소비합니다. 연결 타임아웃은 에이전트 설정에서 조절. │
│     (info 배지 — `--color-info-surface`)                                                │
│                                                                                         │
│  ⚠ 검증 실패 블록 (http 와 동일 카피, 키만 다름)                                         │
│                                                                                         │
│                                                         [ 취소 ]   [ + MCP 서버 추가 ]  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

> 상태 B·C 의 차이는 **info 배지 1줄** 만. 사용자 입장에서 의미 차이가 크지 않으므로 **폼 모양은 동일**, 배지 문구로만 분기(§2.3 카피 표).

### 1.4 전환 규칙 — 값 보존과 초기화

사용자가 `stdio → http → stdio` 로 왔다 갔다 할 때 입력한 값이 날아가면 좌절한다. 동시에 "숨겨진 필드 값이 저장된다" 는 혼동도 방지해야 한다.

| 동작                              | 처리                                                                     |
| --------------------------------- | ------------------------------------------------------------------------ |
| transport 전환                     | 메모리 안에 양쪽 그룹 값을 **유지**(입력 state 두 벌). UI 는 현재 그룹만 보임. |
| 폼 제출                            | 현재 transport 에 해당하는 그룹만 백엔드로 전송. 숨겨진 그룹은 무시.        |
| 모달/패널 닫기                     | 입력 state 폐기. 재오픈 시 초기값.                                         |
| 편집 모드 진입(기존 레코드)         | 저장된 transport 의 그룹만 복원. 다른 그룹 빈 상태로 유지.                  |
| 레거시(schemaVersion=1)             | `normalizeLoadedRecord` 가 `stdio` 로 해석(이미 구현, 스토어 §1). UI 는 A. |

---

## 2. 유효성 · 에러 메시지 카피 (한/영)

### 2.1 카피 원칙

- **한 문장 · 행동 지시형**: "A 해주세요", "B 를 B 로 바꾸세요". 수동태 금지.
- **필드 고유명은 코드 그대로**: `command` · `args` · `env` · `url` · `headers` · `authToken` — 번역하지 않음(코드 식별자이므로 언어 무관).
- **숫자는 템플릿**: `{max}` 같은 자리표시자. 한/영이 동일 자리표시자를 공유.

### 2.2 공통 · 메타 검증

| 키                             | 한국어                                                        | English                                                         |
| ------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------- |
| `mcp.err.name.empty`            | MCP 서버 이름을 입력해 주세요.                                   | Enter a name for this MCP server.                                |
| `mcp.err.name.tooLong`          | 이름은 {max}자 이하만 허용됩니다.                                | Name must be {max} characters or fewer.                          |
| `mcp.err.name.pattern`          | 이름은 영숫자/._- 만 사용할 수 있어요.                            | Name may only contain letters, digits, and ._-                   |
| `mcp.err.name.duplicate`        | 동일한 이름("{name}") 의 MCP 서버가 이미 있습니다. 다른 이름을 써주세요. | An MCP server named "{name}" already exists. Please pick another name. |
| `mcp.err.transport.invalid`     | transport 는 stdio / http / streamable-http 중 하나여야 합니다.   | Transport must be one of stdio, http, or streamable-http.         |

### 2.3 stdio · http 그룹 검증

| 키                              | 한국어                                                          | English                                                             |
| ------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| `mcp.err.command.empty`          | 실행 명령(command) 을 입력해 주세요.                               | Enter an executable for `command`.                                   |
| `mcp.err.command.tooLong`        | command 는 {max}자 이하만 허용됩니다.                             | `command` must be {max} characters or fewer.                         |
| `mcp.err.command.shellMeta`      | command 에 쉘 메타문자(; & \| ` $ < >) 를 쓸 수 없어요. 인자는 args 에 나눠서 넣어 주세요. | `command` cannot contain shell meta characters (; & \| ` $ < >). Put arguments in `args` instead. |
| `mcp.err.args.notArray`          | args 는 문자열 배열이어야 합니다. 공백 구분으로 다시 입력해 주세요.   | `args` must be an array of strings — separate arguments with spaces.  |
| `mcp.err.args.tooLong`           | args[{index}] 가 {max}자를 넘었어요. 더 짧게 줄여 주세요.           | `args[{index}]` exceeds {max} characters — please shorten it.         |
| `mcp.err.args.control`           | args[{index}] 에 제어문자가 있어요. 일반 문자만 써주세요.            | `args[{index}]` contains control characters — please use printable chars only. |
| `mcp.err.env.notObject`          | env 는 key→value 객체 형식이어야 합니다.                           | `env` must be a key→value object.                                     |
| `mcp.err.env.key.invalid`        | env 키 "{key}" 가 POSIX 규칙에 맞지 않아요(영숫자/_ 만, 숫자로 시작 금지). | env key "{key}" breaks POSIX rules (letters/digits/_ only, no leading digit). |
| `mcp.err.env.value.tooLong`      | env["{key}"] 값이 {max}자를 넘었어요.                              | env["{key}"] value exceeds {max} characters.                          |
| `mcp.err.env.value.nul`          | env["{key}"] 에 NUL 문자가 포함돼 있어요. 삭제 후 다시 입력해 주세요.  | env["{key}"] contains a NUL byte — please remove it.                  |
| `mcp.err.url.empty`              | url 을 입력해 주세요. http 전송에는 url 이 필수예요.                 | `url` is required for HTTP transports.                                |
| `mcp.err.url.tooLong`            | url 은 {max}자 이하만 허용됩니다.                                  | `url` must be {max} characters or fewer.                              |
| `mcp.err.url.whitespace`         | url 에 공백이나 제어문자가 있어요. 복붙 시 끝의 개행을 확인해 주세요.  | `url` contains whitespace or control chars — check for trailing newlines. |
| `mcp.err.url.scheme`             | url 은 http 또는 https 로 시작해야 해요.                            | `url` must start with http or https.                                   |
| `mcp.err.url.malformed`          | url 형식이 올바르지 않아요. 예: https://host/path                    | `url` is malformed. Example: https://host/path                          |
| `mcp.err.headers.notObject`      | headers 는 key→value 객체 형식이어야 합니다.                         | `headers` must be a key→value object.                                  |
| `mcp.err.headers.key.tooLong`    | 헤더 키 "{keyPreview}…" 가 {max}자를 넘었어요.                       | Header key "{keyPreview}…" exceeds {max} characters.                    |
| `mcp.err.headers.key.pattern`    | 헤더 키 "{key}" 에 허용되지 않은 문자가 있어요(영숫자/._+- 만 허용).    | Header key "{key}" has invalid characters (letters/digits/._+- only).    |
| `mcp.err.headers.value.tooLong`  | headers["{key}"] 값이 {max}자를 넘었어요.                            | headers["{key}"] value exceeds {max} characters.                        |
| `mcp.err.headers.value.control`  | headers["{key}"] 에 제어문자(줄바꿈 포함) 가 있어요. HTTP 헤더 주입 방지를 위해 차단돼요. | headers["{key}"] contains control chars (incl. newlines) — blocked to prevent header smuggling. |
| `mcp.err.authToken.type`         | authToken 은 문자열이어야 해요.                                     | `authToken` must be a string.                                           |
| `mcp.err.authToken.tooLong`      | authToken 은 {max}자 이하만 허용됩니다.                             | `authToken` must be {max} characters or fewer.                          |
| `mcp.err.authToken.control`      | authToken 에 제어문자가 있어요. 따옴표나 개행이 함께 복사되진 않았나요? | `authToken` has control chars — did a newline get copied with it?       |

### 2.4 에러 블록 머리말 · 카운트 카피

| 키                         | 한국어                                                         | English                                                         |
| -------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------- |
| `mcp.err.heading`           | 입력을 확인해 주세요 ({count}건)                                 | Please check your input ({count})                                |
| `mcp.err.moreCollapse`       | 외 {n}건 더 보기                                                 | Show {n} more                                                    |
| `mcp.err.moreExpanded`       | 접기                                                            | Collapse                                                         |
| `mcp.hint.httpWarning`       | http:// 는 로컬 네트워크 외에서는 https 권장                      | http:// is only safe on local networks — prefer https elsewhere |
| `mcp.hint.streamableInfo`    | SSE 스트림을 소비합니다. 연결 타임아웃은 에이전트 설정에서 조절하세요. | Consumes an SSE stream. Tune the connection timeout in the agent settings. |

> 본 카피 블록은 `validateMcpServerInput` 의 현행 한글 문자열을 **i18n 키로 치환** 하는 후속 PR 의 데이터다. 어댑터 호출 경로에서 `MediaAdapterError` 의 `cause` 로 원본 메시지를 감싸면(`tests/multimediaTypes.unit.test.ts` T1) UI 가 원본과 현지화 문구를 모두 표현할 수 있다.

---

## 3. 컴포넌트 트리 · 토큰 매핑(MCP)

```
ProjectMcpServersPanel                    (기존, 확장)
├─ PanelHeading                           ("MCP 서버 설정 · 프로젝트 전용")
├─ TransportSegmentedControl              (신규 · 3탭)
│  └─ TransportTab × 3                    (stdio / http / streamable-http)
├─ FormGrid                               (2-col → 1-col @ ≤768px)
│  ├─ MetaColumn
│  │  └─ NameInput
│  ├─ StdioColumn                         (transport=stdio 일 때만 렌더)
│  │  ├─ CommandInput
│  │  ├─ ArgsInput
│  │  └─ EnvTextarea
│  └─ HttpColumn                          (transport=http | streamable-http)
│     ├─ UrlInput
│     ├─ HeadersRowList                   (신규 · 동적 행 위젯)
│     │  └─ HeaderRow × N
│     ├─ AuthTokenMaskedInput             (신규 · 마스킹 + 5초 복귀)
│     └─ TransportHintBadge               (http 경고 · streamable info)
├─ ErrorBlock                             (aria-live="polite", 3줄 + 접기)
├─ FooterActions                          (취소 · [+ MCP 서버 추가])
└─ McpServerList                          (기존)
```

### 3.1 토큰 매핑(MCP)

| 영역                               | 속성                 | 토큰                                     |
| ---------------------------------- | -------------------- | ---------------------------------------- |
| 세그먼티드 컨트롤 컨테이너         | 배경                 | `var(--color-surface-elevated)`           |
| 세그먼트(선택)                      | 배경 / 글자           | `var(--color-accent)` / `var(--color-accent-contrast)` |
| 세그먼트(기본)                      | 글자 / 호버 배경       | `var(--color-text)` / rgba(흰 8%)          |
| 입력 필드                           | 배경 / 테두리 / 라운드 | rgba(0,0,0,.30) / `var(--color-border)` / `var(--radius-sm)` |
| 에러 블록                           | 배경 / 테두리 / 글자   | `var(--color-danger-surface)` / `var(--color-danger)` / `var(--color-danger)` |
| http 경고 배지                      | 배경 / 글자           | `var(--color-warning-surface)` / `var(--color-warning)` |
| streamable info 배지                | 배경 / 글자           | `var(--color-info-surface)` / `var(--color-info)` |
| 마스킹 토글 버튼                    | 포커스 ring           | `var(--color-focus-ring)` (기존 규약 재사용) |
| 헤더 행 삭제(✕)                     | 배경 호버             | `var(--color-danger-surface)`             |
| 폼 그리드 gap                       | —                     | `var(--space-lg)` (16px)                  |
| 섹션 사이 수직 간격                 | —                     | `var(--space-xl)` (24px)                  |
| 세그먼티드 전환 모션                 | duration / easing    | `var(--motion-duration-sm)` / `var(--motion-ease-out)` |

신규 토큰은 **추가하지 않는다** — 전부 `tokens.css` 의 의미 토큰 재사용(라운드 2 §1 일관성).

---

## 4. MCP 접근성 · 키보드

| 항목                              | 동작                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| 세그먼티드 컨트롤                  | `role="tablist"` + `aria-label="전송 방식"` / 각 탭 `role="tab"` · `aria-selected` · `aria-controls` |
| 화살표 ←/→                          | 세그먼트 순환 포커스 이동                                                                 |
| Enter/Space                        | 포커스된 세그먼트 활성화                                                                  |
| Tab 순서                            | 세그먼티드 → 이름 → 분기 필드(순차) → 에러 블록 요약 → 취소 → 추가                        |
| 필드 에러 연결                      | 각 input 의 `aria-describedby=<field>-error` — 에러 블록의 해당 줄 `id` 와 1:1             |
| 마스킹 토글                         | `aria-pressed` · 상태 변경 시 `aria-live="polite"` 로 "토큰 마스킹 해제" / "마스킹 적용" 알림 |
| 헤더 동적 추가                      | `[+ 헤더 추가]` 클릭 시 새 행 name 필드로 자동 포커스                                      |
| 헤더 삭제                           | `✕` 클릭/Enter → 이전 행의 value 필드로 포커스 복귀(마지막 행이면 [+ 헤더 추가] 로)         |
| 스크린리더 그룹 이름                | `<fieldset>` + `<legend>` 로 "stdio 설정" / "HTTP 설정" 네이밍                              |
| 에러 요약 표기                      | "입력을 확인해 주세요 (3건)" 1문장을 `aria-live="polite"` 영역에 일관 표기                    |

---

## 5. 언어 모드 토글 — 배치안

### 5.1 1차 진입: SettingsDrawer 최상단 "언어" 섹션

```
┌ SettingsDrawer (폭 360px, 오른쪽 슬라이드) ─────────────────────┐
│ 설정                                             [✕]             │
│─────────────────────────────────────────────────────────────────│
│ 🌐 언어                                                          │
│ ┌──────────────────────────────────────────────────────────┐    │
│ │  현재 언어:  한국어                                       │    │
│ │                                                           │    │
│ │  ┌────────────────┬────────────────┐                       │    │
│ │  │ ✓ 한국어        │    English     │  ← 세그먼티드 2탭     │    │
│ │  └────────────────┴────────────────┘                       │    │
│ │                                                           │    │
│ │  💡 언어 설정은 이 브라우저에 저장됩니다.                   │    │
│ └──────────────────────────────────────────────────────────┘    │
│─────────────────────────────────────────────────────────────────│
│ 🎨 테마                                                          │
│ ...                                                              │
│ 🔔 토큰 경고 임계                                                │
│ ...                                                              │
└─────────────────────────────────────────────────────────────────┘
```

- **위치**: SettingsDrawer 의 섹션 순서를 재정비 — 새 순서는 `언어 → 테마 → 토큰 경고 → 모션 → 단축키`. 언어를 1번으로 올리는 근거: 영문 UI 가 전제 이해를 어렵게 만들면 다른 설정을 건드릴 수조차 없기 때문에 "정보 접근성" 우선순위가 가장 높다.
- **동기화**: `setLocale(next)` 호출 → `persistLocale` 이 `user_preferences.language` 로 저장 → `<html lang>` 동기화(신규 side-effect, `src/i18n/index.ts` `setLocale` 내부로 편입) → 토스트.
- **Joker 의 i18n 인프라와 직결**: 본 섹션은 `useLocale()` 훅을 바인딩하는 1차 소비자. `locales/{en,ko}.json` 의 `locale.*` 키가 이미 확정(`locale.label/en/ko`).

### 5.2 2차 진입: OnboardingTour 1스텝 상단 스트립

```
┌ 화면(뷰포트) ─────────────────────────────────────────────────┐
│  ╔════════════════════════════════════════════════════════╗    │  ← 32px 스트립
│  ║ 🌐 한국어 ▾              이 튜토리얼은 언어를 바꿔도 OK ║    │     sticky top
│  ╚════════════════════════════════════════════════════════╝    │
│                                                                │
│   (기존 Onboarding 3스텝 spotlight + 카드)                     │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

- **가시 범위**: 튜토리얼이 `isOnboardingCompleted() === false` 인 동안에만 표시. 완료 후에는 SettingsDrawer 에서만 접근.
- **의도**: "튜토리얼을 읽는데 언어가 불편하면 즉시 전환" 을 지원. 설정을 찾으러 나가면 투어 상태가 끊기므로 **투어 내부에서 제자리 전환**.
- **스트립 ↔ 드로어 의 값은 같은 저장소**(`user_preferences.language`). 튜토리얼에서 바꾼 선택이 그대로 전역으로 적용.
- 스트립 폭: 뷰포트 전체, 높이 32px 고정, 배경 `var(--color-surface-elevated)` + 하단 1px `var(--color-border)`.

### 5.3 3차 진입(세션 한정): 개별 모달 헤더

- 본 시안의 대상 아님. 경계만: `NewProjectAgentModal` 같은 특정 모달이 **세션 한정** 으로 토글을 노출할 때는 `persistLocale` 을 호출하지 않는다(선행 시안 §3.1 의 P-05 계승).

### 5.4 모바일 · 협소 뷰포트

- 뷰포트 < 480px 에서 SettingsDrawer 의 "언어" 섹션은 그대로 유지(드로어 폭 100%).
- 온보딩 스트립은 아이콘만(`🌐`) 남기고 레이블(`한국어 ▾`) 은 숨김(`aria-label` 로 대체). 32px 유지.

---

## 6. 전환 피드백(토스트 · 스피너 · 타이틀)

### 6.1 원칙

| 축           | 결정                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------- |
| 스피너        | **없음**. JSON 정적 import 로 전환 지연이 사실상 0ms. 스피너는 사용자에게 "뭔가 느리다" 인상만 줘 역효과. |
| 블로킹 오버레이 | **없음**. 입력 중이어도 전환이 안전하도록 텍스트 content 만 교체. 키보드 포커스 위치 유지.        |
| 토스트          | 1회 · 2000ms · `aria-live="polite"`. 중앙 하단(`--z-toast`).                                  |
| 타이틀 동기화   | `document.title` 을 locale 별 `app.title` 로 업데이트(선언적 훅 `useDocumentTitle(t('app.title'))`). |
| `<html lang>`   | `setLocale` 호출 내부에서 `document.documentElement.lang = next` 수행. SR 이 언어를 올바르게 읽도록. |
| 모션 절감 대응 | `prefers-reduced-motion` 존중 — 토스트 fade 는 `var(--motion-duration-sm)` → 이미 reduced 시 0ms.  |

### 6.2 토스트 카피 테이블

| 키                                  | 한국어                             | English                                  |
| ----------------------------------- | ---------------------------------- | ---------------------------------------- |
| `locale.toast.switchedTo.ko`         | 언어를 한국어로 전환했습니다.         | Switched language to Korean.              |
| `locale.toast.switchedTo.en`         | 언어를 영어로 전환했습니다.           | Switched language to English.             |
| `locale.toast.persistFailed`         | 언어 설정 저장에 실패했어요. 이 세션에서는 바뀌어도 재접속 시 기본으로 돌아갑니다. | Could not save language preference. Changes apply this session only and reset on reconnect. |
| `locale.toast.applyingStripLabel`    | 튜토리얼 언어 변경 중…              | Changing tutorial language…              |

### 6.3 전환 순서(기술 구현 지침)

```
onLocaleClick(next):
  1. setLocale(next)                         ← 구독자들이 바로 리렌더
  2. document.documentElement.lang = next
  3. document.title = translate('app.title', next)
  4. toast.show(t(`locale.toast.switchedTo.${next}`), { duration: 2000, role: 'status' })
  5. if (persistFailed) toast.show(t('locale.toast.persistFailed'), { duration: 4000, role: 'alert' })
```

- 1·2·3 은 동기. 4 는 다음 tick 에서 렌더. 5 는 `persistLocale` 이 실패했을 때만.

---

## 7. 미번역 키 폴백 가이드라인

### 7.1 3단 계단(M-11 재상술)

```
translate("example.key", "ko")
    │
    ├─ RESOURCES.ko.example.key 문자열?  ─── YES ──▶ 반환
    │        NO
    ├─ RESOURCES.en.example.key 문자열?  ─── YES ──▶ 반환 (영어 폴백)
    │        NO
    └─ key 원문 반환 (개발 빌드에서는 `[MISSING] example.key`)
```

- **현행 `translate()` 구현(`src/i18n/index.ts:148-157`) 와 1:1 일치**. 본 시안은 UI 표시 측면만 추가 제안.

### 7.2 개발 빌드 배지 노출

- `import.meta.env.DEV === true` 일 때만 적용(프로덕션 사용자에겐 비노출).
- key 만 반환된 경우 UI 에서 **옅은 빨간 underline + title 툴팁** 으로 강조:
  - `<span data-i18n-missing class="i18n-missing" title="누락된 키: example.key">example.key</span>`
  - CSS: `.i18n-missing { text-decoration: underline wavy var(--color-danger); }`
- 프로덕션에서는 이 클래스/속성 자체가 붙지 않음 — 사용자에겐 key 원문이 평범한 텍스트로 보임.

### 7.3 폴백 품질 표시(선택 기능 — 후속 PR 제안)

- 영어 폴백으로 돌아간 값을 한국어 UI 에서 보이면 **미세 배지** `· en` 를 텍스트 옆에 표기(접근성: `aria-label="English fallback"`).
- 폴백 사용 횟수를 세션 단위로 집계(`window.dispatchEvent(new CustomEvent('i18n:fallback', { detail: { key, locale } }))`) 해 QA 가 누락 키 목록을 수집.
- 본 후속 구현은 Joker 판단.

---

## 8. 언어 토글 접근성 · 키보드

| 항목                           | 동작                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| SettingsDrawer 세그먼티드      | `role="tablist"` · `aria-label="언어"` / 각 탭 `role="tab"` + `aria-selected`          |
| ←/→                             | 세그먼트 포커스 순환                                                                   |
| Enter/Space                     | 포커스된 세그먼트 활성화 → `setLocale`                                                 |
| 온보딩 스트립 드롭다운          | `role="combobox"` + `aria-haspopup="listbox"` + `aria-expanded` + `aria-controls`       |
| 단축키                           | 전역 `Alt+Shift+L` — 열린 드로어 안의 토글에 포커스. 드로어 닫힌 상태면 드로어를 연다.   |
| `<html lang>` 동기화              | SR 이 문서를 다시 읽는 계기 제공. 변경 직후 `aria-live="polite"` 로 토스트가 읽힘.       |
| 토스트 라벨                     | `role="status"` · `aria-live="polite"` (비차단 전환이므로 assertive 금지)              |
| 포커스 복귀                     | 전환 후 포커스는 원래 트리거(세그먼트 또는 스트립 드롭다운) 에 유지. 블러되지 않음.      |
| 고대비 테마                     | 배지/글자 WCAG AA 보장(`--color-text-muted` rgba 0.72 기준) — QA 실측 대기(§10 R-L1). |

---

## 9. 통합 토큰 표(MCP + 언어 토글)

| 의도                 | 토큰                                  | 값(다크 기본)            |
| -------------------- | ------------------------------------- | ------------------------ |
| 강조 배경/글자        | `--color-accent` / `--color-accent-contrast` | `#00d2ff` / `#000000` |
| 위험                  | `--color-danger` / `--color-danger-surface`   | `#e94560` / rgba 0.12 |
| 경고                  | `--color-warning` / `--color-warning-surface` | `#f59e0b` / rgba 0.12 |
| 정보                  | `--color-info` / `--color-info-surface`       | `#7fd4ff` / rgba 0.12 |
| 서피스 · 상승 서피스   | `--color-surface` / `--color-surface-elevated` | `#16213e` / `#0f3460` |
| 본문 / 보조 / 미묘     | `--color-text` / `--color-text-muted` / `--color-text-subtle` | 100% / 72% / 56% |
| 라운드                 | `--radius-sm` · `--radius-md` · `--radius-lg` | 2 · 4 · 8px |
| 공백                   | `--space-xs` ~ `--space-xl`                   | 4 · 8 · 12 · 16 · 24px |
| 모션 duration          | `--motion-duration-sm` · `--motion-duration-md` | 140ms · 220ms |
| 포커스 링              | `--color-focus-ring` / `--focus-ring-width` / `--focus-ring-offset` | cyan / 2px / 2px |
| 토스트 층               | `--z-toast` · `--z-toast-error`               | 1000 · 1100 |

---

## 10. 결정 대기(Joker · QA 확인 필요)

| ID    | 질문                                                                       | 대상  |
| ----- | -------------------------------------------------------------------------- | ----- |
| R-M1  | 세그먼티드 전환 애니메이션 유지(140ms slide) vs 즉시 교체 — 전환 시 레이아웃 shift 체감  | QA    |
| R-M2  | authToken 마스킹 해제 5초 규약을 "커서 이탈 시 즉시" 로 바꿀지 여부            | Joker · QA |
| R-M3  | http 경고 배지를 검증 에러로 승격해야 하는 환경(기업 정책 등) 이 있는지         | Kai   |
| R-M4  | 동적 헤더 위젯의 최대 행 수 제한(현재 무제한) — 50줄 정도로 상한?             | Joker |
| R-L1  | `--color-text-muted` rgba(.72) 의 AA 대비 실측 — 배지/토스트 배경에서 안전한지  | QA    |
| R-L2  | 전역 단축키 `Alt+Shift+L` 충돌 여부(스크린리더/브라우저)                     | QA    |
| R-L3  | 개발 빌드 `[MISSING]` 배지 노출 규약을 `?i18n-debug=1` 쿼리 플래그로도 토글 허용?  | Joker |
| R-L4  | 폴백 품질 배지(§7.3) 범위 — 1.0 범위에 포함 vs 후속 PR                        | Kai   |

---

## 11. 파일 배치(구현 지침, 참고)

```
src/components/
  LanguageToggle.tsx                      (신규 · 세그먼티드 2탭 + 드롭다운 2형태 export)
  SettingsDrawer.tsx                       (기존 · §5.1 섹션 1번째로 LanguageToggle 삽입)
  OnboardingTour.tsx                       (기존 · §5.2 상단 스트립 래퍼 추가)
  ProjectMcpServersPanel.tsx               (기존 · 전면 개편 — transport 분기)

src/components/McpServerForm/              (신규 디렉터리 — 패널 분할 권장)
  TransportSegmentedControl.tsx
  StdioFieldset.tsx
  HttpFieldset.tsx
  HeadersRowList.tsx
  AuthTokenMaskedInput.tsx
  ErrorBlock.tsx

src/i18n/
  index.ts                                 (기존 · setLocale 내부에 <html lang> 동기화 + 토스트 fire 훅)
  useDocumentTitle.ts                      (신규 · t('app.title') 반응형 동기화)

locales/
  en.json · ko.json                        (기존 · §2 · §6.2 · §5 카피 키 병합)
```

- 모든 변경은 기존 토큰 재사용. 새 토큰은 §10 결정 이후에만.

---

끝.
