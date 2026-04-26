# Locale Style Guide — LLMTycoon

본 문서는 `locales/ko.json` 과 `locales/en.json` 의 카피 톤·일관성을 잠그는 단일 진입점이다. 신규 키 추가·번역 갱신 시 본 가이드를 먼저 확인하고, 화면별 톤이 어긋나면 본 가이드의 매트릭스를 우선한다.

작성: 2026-04-26 / 적용 범위: `locales/en.json`, `locales/ko.json`

---

## 1. 톤 매트릭스 (영역별)

| 키 영역 | 영문 톤 | 한국어 톤 | 비고 |
|---|---|---|---|
| `common.*` | 명사형 동사(`Save`, `Cancel`) | 명사형 동사(`저장`, `취소`) | 마침표 없음. Title Case 또는 Sentence case 1 단어 |
| `auth.login.*` / `auth.signup.*` 라벨·버튼 | Sentence case, 명령형(`Sign in`, `Create account`) | 명사형(`로그인`, `계정 만들기`) | 버튼 라벨에는 마침표 없음 |
| `auth.*.errors.*` | 명령형 또는 평서문, 마침표로 종료(`Enter a valid email address.`) | 평서문 + 존댓말(`이메일 형식이 올바르지 않습니다.`) | 사용자 행동을 안내할 수 있으면 명령형 우선 |
| `*.placeholder` | `e.g., …` 접두 + 구체 예시 | `예: …` 또는 `예) …` 접두 | 마침표 없음. 한 줄로 끝 |
| 본문/설명(`intro`, `body`, `*Description`) | 평서문, 마침표로 종료, 1~2 문장 | 존댓말 평서문, 마침표로 종료 | 사용자 행동 가이드는 명령형 1 문장 추가 가능 |
| 토스트(`*Toast`, `*.toast.*`) | 결과 보고 평서문(`Added {count} teammates.`) | 결과 보고 평서문(`{count}명을 팀에 추가했습니다.`) | 1 문장. 마침표 종료 |
| 배지(`*Badge`) | 짧은 명사 1~2 단어(`Saved`, `Unsaved`, `No goal yet`) | 짧은 명사(`저장됨`, `미저장`, `목표 미입력`) | 마침표 없음 |
| ARIA 라벨(`*Aria`, `aria.*`) | 동사 + 명사(`Open settings`) | 동사 + 명사(`설정 열기`) | 시각적 컨텍스트 없이 단독으로 의미가 통해야 함 |
| 로그(`log.*`) | 행위자 없이 사실만(`Git credentials saved: {provider} · {username}`) | 동일 톤(`Git 자격증명 저장: {provider} · {username}`) | 콜론 뒤 변수 1 개 |

---

## 2. 대문자·구두점 규칙 (영문)

- **버튼·메뉴·배지**: Sentence case (`Sign in`, `Add all`, `Create account`). Title Case 는 사용하지 않는다(예외: 고유명사·브랜드).
- **문장**: 끝에 마침표 1 개. 다중 문장은 마침표로 구분. 자유 종결(`…`/`!`/`?`)은 토스트·온보딩 문구의 의도된 곳에서만.
- **줄임표**: 진행 중 상태는 영문도 `…` (U+2026) 1 자(예: `Loading…`, `Saving…`). ASCII `...` 금지.
- **단위·숫자**: 숫자와 단위 사이 공백 없음(`8 characters` → 형용사 단위는 공백 1, `80%` 는 공백 없음).
- **콜론(`:`) 후 공백 1 개**: `Last saved: {datetime}`.
- **인용 부호**: 문장 안 인용은 큰따옴표 `"…"` 1 단계만. JSON 안에서는 `\"…\"` 로 이스케이프.
- **하이픈/대시**:
  - `—` (U+2014) 은 부연 설명 분리(`stderr is empty — likely no changes to commit.`).
  - `-` 는 키보드 단축키나 식별자 일부(`P1-Urgent`).
- **약어**: 모두 대문자 유지(`USD`, `HTTP`, `MCP`, `OAuth`, `URL`, `PCI`, `localStorage` 는 그대로 카멜).
- **마침표 없음 영역**: 버튼 라벨, 배지, 짧은 메뉴 항목, ARIA 라벨, 플레이스홀더.

---

## 3. 한국어 규칙

- **존댓말 일관성**: 본문·에러·토스트는 모두 `~합니다 / ~하세요` 의 합쇼체. `~해요 / ~돼요` 의 해요체와 섞지 않는다.
- **명령형 vs 명사형**: 버튼은 명사형(`로그인`, `저장`, `계정 만들기`), 도움말 끝의 행동 유도는 명령형(`다시 시도해 주세요`).
- **사이시옷·외래어**: 외래어는 국립국어원 표기 우선(`토큰`, `아이디`, `이메일`, `프리필`은 가독성 우선 유지). 기술 용어(`stderr`, `localStorage`, `OAuth`)는 원어 유지 + 필요 시 괄호 병기.
- **구두점**: 마침표 `.` 사용. 한국어 마침표(`。`) 금지. 줄임표는 `…`(U+2026) 1 자.
- **숫자·단위**: 숫자와 한국어 단위 사이 공백 없음(`3자`, `80자`, `5명`). 영문 단위는 공백 1 개(`8 characters`).
- **물음표·느낌표**: 정말 의문/감탄일 때만(`이미 계정이 있어요?` 보다 `이미 계정이 있어요` 가 톤상 자연스럽지만, 현재 사용된 `계정이 없으신가요?` 는 의문이므로 유지).

---

## 4. 변수·플레이스홀더 규칙

- **표기**: `{name}` 중괄호 1 단계. `{{…}}`·`%s` 는 사용하지 않는다.
- **양국 공통 변수명**: 영문 키 그대로(`{count}`, `{min}`, `{max}`, `{current}`, `{percent}`, `{provider}`, `{datetime}`, `{message}`, `{status}`, `{title}`, `{username}`, `{mask}`, `{label}`, `{applied}`, `{total}`, `{failed}`).
- **순서·개수**: 두 언어에서 동일 키는 변수 개수와 이름이 정확히 일치해야 한다(다국어 패리티 회귀 잠금).
- **수 단위 일치**: 영문 `Added {count} teammates.` ↔ 한국어 `{count}명을 팀에 추가했습니다.`. 한국어는 `명/건/개` 단위 명사를 변수 직후에 붙이고 영문은 변수 뒤 공백 + 영어 단어.

---

## 5. 동의어 통일표 (자주 흔들린 단어)

| 의미 | 영문(권장) | 영문(금지) | 한국어(권장) |
|---|---|---|---|
| 인증 진입 | Sign in | Login, Log in | 로그인 |
| 계정 생성 | Create account, Sign up | Register | 계정 만들기, 회원가입 |
| 사용자 식별자 | Username | User ID, ID | 아이디 |
| 토큰 마스킹 | masked | hidden, redacted | 마스킹 |
| 자동 반영(생성 시) | Add when project is created | Seed on create | 프로젝트 생성 시 자동 반영 |
| 재번역(소스 라벨) | Re-translated | Translated | 재번역 |
| 추정 비용 | estimated cost | rough cost, approx cost | 대략 비용 |
| 변경 / 토글 | changes to | switches to | 전환되다 |
| 다시 채움 | prefilled | autofilled, filled in | 프리필 |
| 에러 폴백 메시지 | Couldn't load …, Failed to … | Error: …, Cannot … | …을(를) 불러오지 못했습니다 |

> Git 자동화 도메인의 전용 용어 사전(예: Auto-commit·Auto-push·Branch protection·Commit message template)은 §10 에서 별도로 정의한다. 본 표는 범용 동의어만 다룬다.

---

## 6. 동등키 패리티 체크리스트

신규 키 추가·번역 갱신 시 다음을 모두 충족해야 한다.

- [ ] 두 파일에 **같은 경로의 키**가 모두 존재(누락 금지).
- [ ] 변수 자리 표시자의 **이름·개수**가 두 언어에서 동일.
- [ ] 단위(자/명/건/% 등)는 한국어/영문 각각의 자연스러운 위치에 배치.
- [ ] 마침표 정책(§2·§3)을 위반하지 않는다(버튼/배지/ARIA 는 마침표 없음).
- [ ] 동의어 통일표(§5)에 등재된 단어를 사용했다면 권장 표기를 따른다.
- [ ] **Git 자동화 도메인** 키(`gitAutomation.*`, `gitCredentials.*`)는 §10 용어 사전을 우선 참조한다.
- [ ] 새로운 톤이 필요하면 **§1 매트릭스를 먼저 갱신**하고 카피를 작성한다.

---

## 7. 신규 카피 작성 워크플로우

1. **역할 분류**: 버튼/본문/에러/토스트/배지/ARIA 중 어디인지 §1 매트릭스에서 행 선택.
2. **한국어 먼저**: 합쇼체로 1 차 작성. 마침표·존댓말 일관성 점검.
3. **영문 번역**: §2 대문자·구두점 규칙으로 작성. §5 동의어 통일표 우선.
4. **변수 동기화**: 두 언어의 변수 이름·개수·순서 일치 확인.
5. **검증**: `node -e "JSON.parse(require('fs').readFileSync('locales/en.json','utf8'))"` 와 동일하게 ko 도 확인.
6. **회귀 테스트**: 언어 토글·플레이스홀더 노출 spec 이 있는 경우 `npx tsx --test tests/<spec>.ts` 로 영향 범위 확인.

---

## 8. 한 번에 다듬는 체크 명령

```sh
# 양 파일 JSON 무결성 확인
node -e "JSON.parse(require('fs').readFileSync('locales/en.json','utf8'));JSON.parse(require('fs').readFileSync('locales/ko.json','utf8'));console.log('OK');"

# 두 언어의 키 누락(다국어 패리티) 검사 — 한쪽에만 존재하는 키를 빠르게 발견
node -e "const a=Object.keys(require('./locales/en.json')),b=Object.keys(require('./locales/ko.json'));const d=[...a.filter(x=>!b.includes(x)),...b.filter(x=>!a.includes(x))];console.log(d.length?d:'parity OK');"
```

(중첩 키 차이까지 잡으려면 별도 스크립트가 필요하다 — 별도 PR 에서 추가.)

---

## 9. 본 가이드 갱신 절차

- 새 톤이 필요하면 §1 표에 행을 추가한 다음 카피를 작성한다.
- 동의어 충돌이 발견되면 §5 표에 합의 결과를 등재한 다음 두 파일을 일괄 갱신한다.
- Git 자동화 도메인 용어가 새로 등장하면 §10 의 용어 사전 표에 먼저 등재하고, 두 파일을 일괄 갱신한다.
- 가이드 변경은 `locales/STYLE.md` 단일 파일 수정 + `docs/reports/` 리포트 1 건으로 잠근다.

---

## 10. Git 자동화 도메인 카피 — 용어 사전 (Glossary)

본 섹션은 `gitAutomation.*` / `gitCredentials.*` / 향후 `GitAutomationPanel.tsx` 의 i18n 이주 대상 카피가 일관된 영어 표현을 갖도록 잠그는 단일 진입점이다. 한국어 도메인 용어는 다음 영어 표기로 통일한다.

### 10.1 핵심 용어 사전 (Glossary)

| 한국어(권장) | 영문(권장) | 영문(금지) | 비고 / 적용 영역 |
|---|---|---|---|
| Git 자동화 | Git automation | git automation, GIT Automation | `Git` 은 항상 첫 글자 대문자 고유명사. 문장 시작 외에도 동일. |
| 자동화 파이프라인 | Automation pipeline | Auto pipeline | `gitAutomation.*` 패널 전반의 상위 개념. |
| 자동 커밋 | Auto-commit | auto commit, autocommit, AutoCommit | 명사·동사 동일. 동사형: `Auto-commits each task`. |
| 자동 푸시 | Auto-push | auto push, autopush | 명사·동사 동일. |
| 자동 커밋 + 푸시 | Auto-commit + push | auto commit and push | UI 마지막 실행 시각 라벨에서 사용. `+` 양옆 공백. |
| 수동 커밋 | Manual commit | manual auto-commit | `commitStrategy: 'manual'` 라벨. |
| 태스크 경계 커밋 | Per-task commit | task boundary commit | 사용자 노출 라벨. 코드 식별자 `per-task` 와 1:1. |
| 공동 목표 커밋 | Per-goal commit | goal-boundary commit | `commitStrategy: 'per-goal'` 라벨. |
| 커밋 메시지 | Commit message | commit msg | 단수 형태 우선. 복수는 `commit messages`. |
| 커밋 메시지 템플릿 | Commit message template | commit-message template | 명사구. 변수 자리표시자(`{branch}` 등) 노출 시 `template variable` 로 부른다. |
| 커밋 메시지 접두어 | Commit message prefix | commit prefix | 기본값 `auto: ` 의 사용자 노출 라벨. |
| 템플릿 변수 | Template variable | template token | `{branch}`, `{type}`, `{ticket}` 등의 자리표시자. |
| 브랜치 | Branch | branch line | 단일 문자열로 통일. |
| 브랜치명 | Branch name | branch identifier | 사용자 입력 필드 라벨. |
| 브랜치 전략 | Branch strategy | branching policy | `branchStrategy` 직역. |
| 고정 브랜치 | Fixed branch | static branch | `branchStrategy: 'fixed-branch'`. |
| 새 브랜치 / 현재 브랜치 | New branch / Current branch | fresh branch | 2모드 시안(`branchMode: 'new' | 'current'`). |
| 세션당 브랜치 | Per-session branch | session branch | `branchStrategy: 'per-session'`. |
| 태스크당 브랜치 | Per-task branch | task branch | `branchStrategy: 'per-task'`. |
| 커밋당 브랜치 | Per-commit branch | commit branch | `branchStrategy: 'per-commit'`. |
| 브랜치 보호 | Branch protection | branch lock | GitHub/GitLab 의 `branch protection rules` 기능을 가리킨다. 한국어 단독 사용 금지 — 항상 `브랜치 보호(branch protection)` 로 1 회 병기. |
| 풀 리퀘스트 | Pull request, PR | pull-request, MR(GitLab 명칭) | 본문 첫 등장 시 `Pull request (PR)`, 이후 `PR`. |
| PR 생성 | Open a PR | Create PR, Make a PR | 동사구. 명사구는 `PR creation`. |
| PR 리뷰어 | PR reviewer | reviewer person | 단순 `reviewer` 는 다른 도메인과 혼동되므로 `PR reviewer` 로 명시. |
| 원격 반영 | Push to remote | sync to remote | "원격에 변경을 보낸다" 의미. |
| 원격 브랜치 | Remote branch | remote ref | 단순 노출 라벨. |
| 강제 푸시 | Force-push | hard push | 명사·동사 동일. 하이픈 1 개. |
| 자격증명 | Credentials | secret, auth info | `gitCredentials.*` 와 동일. 단수 `credential` 사용 금지(항상 복수형). |
| 개인 액세스 토큰 | Personal access token (PAT) | personal token | 첫 등장 시 풀네임 + `(PAT)` 약어. 약어 단독 노출은 두 번째부터. |
| 종료 코드 | Exit code | exit status, return code | `gitAutomation.failure.exitCode`. |
| 표준 출력 | Standard output (stdout) | std out | 첫 등장 시 풀네임 + `(stdout)`. 변수·라벨에서는 `stdout` 단독 허용. |
| 오류 출력 | Error output (stderr) | err out | 위와 동일 정책. |
| 진단 출력 | Diagnostic output | debug output | 자동화 실패 패널의 fallback 메시지에서 사용. |
| 자동화 실패 | Automation failed | Automation failure(제목으로는 동사형) | 패널 제목은 동사 + 형용사 형태(`Automation failed`). |
| 마지막 실행 시각 | Last run | last fired, last triggered | 상대 시각(방금/분/시간/일) 노출 단위. |
| 자동 압축(컨텍스트) | Auto-compaction | auto compaction(명사 단수) | 단수 명사형은 하이픈 포함. 복수 이벤트 카운트는 `Auto compactions`(공백) 으로 카운트 표기. |

### 10.2 영문 케이스 규칙(Git 도메인 한정)

- **`Git` 은 항상 첫 글자 대문자**. 문장 중간이라도 `Git` (예: `Couldn't start the Git process.`). 단, 명령어/실행 파일 식별자는 소문자 `git` 그대로(예: 코드/모노스페이스 안의 `git commit`).
- **`Auto-X` 패턴은 하이픈 1 개**: `Auto-commit`, `Auto-push`, `Auto-compaction`. 단, 라벨에서 동작이 명사구(이벤트)로 변할 때만 공백 허용(예: `Auto compactions` = 자동 압축 이벤트 카운트).
- **`Per-X` 패턴은 하이픈 1 개**: `Per-task`, `Per-goal`, `Per-session`, `Per-commit`. 코드 식별자(`per-task`)와 형태가 일치하므로 변환 비용이 낮다.
- **`PR` 약어**: 첫 등장 시 `Pull request (PR)` 로 풀어 쓴 뒤 같은 카피 안에서는 `PR` 유지. 본문에서는 `pull request` 소문자도 허용(문장 흐름 우선), 라벨/배지에서는 `PR` 우선.
- **약어 케이스**: `PAT`, `PR`, `MR`(금지), `CI`, `URL` 모두 대문자.

### 10.3 Git 자동화 카피의 톤 매트릭스 (§1 의 Git 도메인 보강)

| 키 영역 | 영문 톤 | 한국어 톤 | 예시 |
|---|---|---|---|
| `gitAutomation.failure.title` | 동사 + 형용사 1 단어구 | 명사 + 평서 | `Automation failed` ↔ `자동화 실패` |
| `gitAutomation.failure.<labels>` | 명사구(`Exit code`, `Branch`) | 명사구(`종료 코드`, `브랜치`) | 마침표 없음 |
| `gitAutomation.failure.<errorBodies>` | 평서문, 마침표로 종료 | 합쇼체 평서문, 마침표로 종료 | `Couldn't start the Git process.` ↔ `git 실행 파일을 시작하지 못했습니다.` |
| `gitAutomation.flow.<level>.label` | 명사구 Title-case 허용(`Commit Only`, `Commit + Push`, `Full PR Flow`) | 명사구(`커밋만`, `커밋 + 푸시`, `풀 PR 흐름`) | 단계 라벨이 약어·고유명사 비중이 높아 Title Case 허용 — §2 예외. |
| `gitAutomation.flow.<level>.subLabel` | Sentence case(`Local only`, `Push to remote`, `Open PR + request review`) | 한국어는 짧은 명사형(`로컬만 기록`, `원격 브랜치 반영`, `PR 생성 + 리뷰 요청`) | subLabel 은 위험도 보조 라벨, 마침표 없음 |
| `gitAutomation.commitStrategy.<key>.label` | 명사구(`Per-task`, `Per-goal`, `Manual`) | 명사구(`태스크당`, `공동 목표당`, `수동`) | §10.2 하이픈 규칙 적용 |
| `gitAutomation.commitStrategy.<key>.hint` | 평서문, 마침표 종료 | 합쇼체, 마침표 종료 | 1 문장 권장 |
| `gitAutomation.template.<field>.label` | 명사구(`Commit message template`) | 명사구(`커밋 메시지 템플릿`) | §10.1 용어 사전 참조 |
| `gitAutomation.template.variables.<token>` | 영문 hint 는 명사구 1 줄 | 한국어 hint 는 합쇼체 1 줄 | `{branch}` 등의 hint 는 라벨 아래 노출되므로 마침표 없음 |
| `gitCredentials.*` (기존) | 명사구·평서문 혼합 | 명사구·합쇼체 혼합 | §10.1 의 `Personal access token (PAT)` / `Credentials` 표기 강제 |

### 10.4 Git 자동화 카피 작성 시 추가 검증

- [ ] §10.1 용어 사전에 등재된 한국어 단어가 포함됐다면 영문 권장 표기를 그대로 사용했다.
- [ ] `Auto-X` / `Per-X` 의 하이픈 정책(§10.2)을 위반하지 않았다.
- [ ] `Git` 첫 글자가 대문자다(코드 식별자 제외).
- [ ] `Pull request (PR)` 의 첫 등장 풀네임 정책을 같은 카피 영역 안에서 지켰다.
- [ ] `브랜치 보호` 가 본문에 등장하면 `브랜치 보호(branch protection)` 로 1 회 병기했다.
- [ ] `commitStrategy` / `branchStrategy` 의 코드 식별자(예: `per-task`, `fixed-branch`) 와 노출 라벨(`Per-task`, `Fixed branch`) 의 카멜·하이픈 변환을 일관되게 적용했다.

### 10.5 우선 적용 대상 (이주 로드맵)

본 §10 은 향후 `GitAutomationPanel.tsx` 의 한국어 인라인 문구를 i18n 으로 분리할 때 영문 카피를 결정하는 1 차 출처다. 이주 PR 분리 단위 권고:

1. `gitAutomation.flow.{commit|commit-push|full-pr}.{label,subLabel,description}` — 위험도 3 단계 라벨/설명.
2. `gitAutomation.commitStrategy.{per-task|per-goal|manual}.{label,hint}` — 태스크 경계 커밋.
3. `gitAutomation.template.{commit|prTitle|branch}.{label,placeholder,help}` — 템플릿 + 변수 칩.
4. `gitAutomation.lastRun.{label,empty,relative}` — 마지막 실행 시각 표시.
5. `gitAutomation.branchStrategy.{per-session|per-task|per-commit|fixed-branch}.{label,hint}` — 4 전략 라디오.
6. `gitAutomation.branchMode.{new|current}.{label,hint}` — 2 모드 시안.

각 PR 은 추가되는 키 묶음 단위로 §10.1 사전과의 정합성을 검증해야 한다.
