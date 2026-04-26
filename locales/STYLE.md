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

---

## 6. 동등키 패리티 체크리스트

신규 키 추가·번역 갱신 시 다음을 모두 충족해야 한다.

- [ ] 두 파일에 **같은 경로의 키**가 모두 존재(누락 금지).
- [ ] 변수 자리 표시자의 **이름·개수**가 두 언어에서 동일.
- [ ] 단위(자/명/건/% 등)는 한국어/영문 각각의 자연스러운 위치에 배치.
- [ ] 마침표 정책(§2·§3)을 위반하지 않는다(버튼/배지/ARIA 는 마침표 없음).
- [ ] 동의어 통일표(§5)에 등재된 단어를 사용했다면 권장 표기를 따른다.
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
- 가이드 변경은 `locales/STYLE.md` 단일 파일 수정 + `docs/reports/` 리포트 1 건으로 잠근다.
