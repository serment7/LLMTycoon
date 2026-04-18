---
purpose: regression-scenarios
scope: git-credential × DB-stored token × auto-auth × push-prompt × encryption
ticket: 65646bf6
owner: 개발자 에이전트 (6940336c-c26d-46cb-9054-f4803030c898)
written-at: 2026-04-18
report-to: 리더 Kai (7efcca3d-9d2e-4c46-9df0-c6b01352048c)
related-code:
  - server.ts (POST/DELETE /api/integrations, redactIntegration, integrationsCol)
  - src/types.ts (SourceIntegration.accessToken, UserPreferences)
  - src/components/GitAutomationPanel.tsx (자동 push 트리거 UI)
  - src/components/GitAutomationPanel.test.ts (UI 단위 테스트, 토큰 미보유 분기 검증)
  - src/utils/gitAutomation.ts (buildRunPlan — push 단계 인증 의존)
  - src/server/taskRunner.ts (handleWorkerTaskComplete → executeGitAutomation 진입)
sibling-docs:
  - tests/manual-git-automation-regression.md (M2 push 축 — 본 문서가 인증 축으로 결합)
  - tests/git-automation-failure-scenarios.md (F2 non-fast-forward, F4 권한 실패)
  - tests/git-automation/single-branch-leader-merge-regression.md (단일 브랜치 push 통합)
---

# Git 토큰 DB 저장·자동 인증 회귀 테스트 (지시 #65646bf6)

저장소 자동 푸시 경로에서 사용되는 인증 토큰의 **저장 위치·전송 경로·삭제 후 잔존 여부·
저장 시 암호화 여부·잘못된 입력 처리** 를 회귀 케이스로 잠근다. 본 문서는 5개 시나리오
(T1~T5) 와 각 케이스의 절차·기대값·회귀 시그널·복구 절차를 포함한다.

## 현재 구현 상태 (작성 시점 관측)

본 회귀 테스트가 가정하는 시스템 동작을 정확히 기록한다 — 일부 항목은 **현시점 미구현
이며 본 문서는 향후 구현 후 검증을 위한 골격** 이다.

| 축 | 구현 위치 | 현 상태 |
| --- | --------- | ------- |
| 토큰 저장 | `server.ts:717` `POST /api/integrations` → MongoDB `integrationsCol` | **평문 저장** (`accessToken: String(accessToken)`) |
| 토큰 응답 | `server.ts:698` `redactIntegration` | 응답 시 `accessToken: ''` 으로 마스킹 |
| 토큰 삭제 | `server.ts:740` `DELETE /api/integrations/:id` | 단일 문서 즉시 삭제 |
| 토큰 사용처 | `server.ts:754` GitHub API `Authorization: token <…>` / `server.ts:779` GitLab `PRIVATE-TOKEN` | **저장소 fetch 전용 — `git push` 인증에는 사용되지 않음** |
| `git push` 인증 | `src/utils/gitAutomation.ts` 의 `buildRunPlan` → `git push -u origin <branch>` | git CLI 의 자체 credential helper(OS 키체인/`gh auth`)에 위임 |
| localStorage 토큰 | `src` 전역 grep 결과 `localStorage` 내 토큰 키 0건 | **저장 없음(정상)** |
| DB 컬럼 암호화 | 없음 | **미구현** — T4 는 향후 도입 후 검증 골격 |

핵심 함의:
- "토큰 저장 후 push 시 인증 프롬프트 미발생" 은 **현재 코드의 `accessToken` 으로는 해결되지
  않는다**. `git push` 는 OS 인증 헬퍼에 의존하므로, 본 회귀 시나리오는 향후 토큰을 git
  credential helper 로 흘려보내거나 `https://<token>@github.com/<repo>` 로 원격 URL 을
  주입하는 인증 자동화 경로가 도입된 뒤에 의미가 있다. 현재는 "**기대 동작**" 으로 기술하고,
  실 검증은 해당 경로 도입 PR 의 회귀 게이트로 사용한다.

---

## T1 — 토큰 저장 후 `git push` 시 인증 프롬프트 미발생

**목표**: `POST /api/integrations` 로 토큰을 저장한 직후 자동화가 트리거한 `git push` 가
사용자 인증 프롬프트(`Username for 'https://github.com':`)를 띄우지 않고 통과하는지 확인.

### 사전 조건

- 워크스테이션의 git credential helper 가 비활성화 또는 미설정 상태
  (`git config --global --unset credential.helper` 후 캐시 비움).
- 환경 변수 `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=Never` 설정 (프롬프트 시 즉시 실패).
- 테스트 원격: 권한이 부여된 private 저장소(`https://github.com/<owner>/<repo>.git`).

### 절차

1. ⬜ `POST /api/integrations` 로 GitHub PAT 저장 (`provider:'github'`, `accessToken:'ghp_…'`,
   `projectId:<대상>`).
2. ⬜ 응답 본문에서 `accessToken` 이 빈 문자열로 반환되는지 확인 (`redactIntegration` 계약).
3. ⬜ MongoDB `integrations` 컬렉션을 직접 조회해 `accessToken` 이 평문으로 저장되어 있는지
   기록 (T4 와 교차).
4. ⬜ 자동 개발 ON, Git 자동화 `enabled:true, flowLevel:'commitPush'` 로 합성 태스크 1건 dispatch.
5. ⬜ 워커 done → 자동화 push 단계까지 진입 → **사용자 입력 없이** push 성공.

### 기대값

- `git-automation:ran` `results.length === 4`, `results[3].label === 'push'`, `ok === true`.
- 워커 stderr 에 `terminal prompts disabled` 또는 `could not read Username` 문자열 부재.
- 원격 SHA 와 로컬 HEAD SHA 일치.
- `GitAutomationPanel` 의 push 배지 `success`, 푸터에 새 commit SHA 노출.

### 회귀 시그널

| 코드 | 신호 | 의심 위치 |
| ---- | ---- | --------- |
| T1-a | push 가 `terminal prompts disabled` stderr 로 실패 | git credential helper 미주입 — `accessToken` → `git credential approve` 경로 누수 |
| T1-b | push 는 성공했으나 OS 키체인의 기존 자격으로 통과 | DB 토큰 자체가 사용되지 않음 — 본 회귀 테스트의 변별력이 없음(헬퍼 비활성화 확인 필수) |
| T1-c | `accessToken` 응답이 평문으로 노출 | `redactIntegration` 누락 또는 코드 회귀 |

---

## T2 — 토큰 삭제 후 push 시 실패/프롬프트 복귀

**목표**: `DELETE /api/integrations/:id` 호출 후 다음 자동화 사이클의 `git push` 가
프롬프트(또는 `GIT_TERMINAL_PROMPT=0` 환경에서는 즉시 실패) 로 떨어지는지 확인.

### 절차

1. ⬜ T1 절차로 토큰 저장 + 1회 push 성공 확인.
2. ⬜ `DELETE /api/integrations/<id>` 호출 → 200 응답.
3. ⬜ MongoDB `integrations` 컬렉션에서 해당 문서 삭제 확인.
4. ⬜ git credential helper 가 캐시한 자격이 있다면 `git credential reject` 또는 키체인
   삭제로 깨끗이 비움 (T1-b 와 같은 false positive 방지).
5. ⬜ 새 합성 태스크 dispatch → 자동화 push 단계 도달.
6. ⬜ push 가 인증 실패로 종료되는지 확인.

### 기대값

- `git-automation:failed` 1회, `failedStep === 'push'`.
- `results[3].stderr` 에 다음 중 하나 포함:
  - `fatal: could not read Username for 'https://github.com': terminal prompts disabled`
  - `fatal: Authentication failed for 'https://github.com/<owner>/<repo>.git/'`
  - `remote: Invalid username or password.`
- 워커 로그: `task=<id> branch=<name> [push] exit=<128 or 1> — <stderr 400자>`.
- 로컬 commit 은 남고 원격은 변경 없음(`localSha !== remoteSha`).
- `GitAutomationPanel` 의 push 배지 `failed`, 빨간 배너 + 사유 라인 노출.

### 회귀 시그널

| 코드 | 신호 | 의심 위치 |
| ---- | ---- | --------- |
| T2-a | 토큰 삭제 후에도 push 가 성공 | OS 키체인 잔존 자격 사용(테스트 절차 4 누락) — 회귀가 아닐 수 있음 |
| T2-b | DELETE 응답은 200 인데 DB 문서가 남아 있음 | `integrationsCol.deleteOne({id})` 의 매칭 실패 — id 정규화 누수 |
| T2-c | 삭제 후 push 실패 시 UI 가 commit 단계까지 success 표시를 유지하지 못함 | `pushStatus` 전이가 commit 결과를 함께 덮어씀 |
| T2-d | 삭제 후에도 다른 프로젝트의 통합이 영향받음 | `deleteOne` 의 필터에 `projectId` 격리 누락 |

---

## T3 — `localStorage` 에 토큰 미저장 검증

**목표**: 브라우저 단말의 `localStorage` / `sessionStorage` 어디에도 토큰 평문이 저장되지
않는지 확인. 현재 구현은 토큰을 서버 DB 에만 저장하므로 본 시나리오는 **회귀 방지** 가
주된 목적.

### 절차

1. ⬜ 브라우저 깨끗한 프로필로 앱 진입 → 개발자 도구 Application 탭에서 `localStorage`,
   `sessionStorage`, IndexedDB 모두 비어 있음 확인.
2. ⬜ 통합 추가 UI 에서 토큰 입력 → 저장 버튼 클릭.
3. ⬜ 저장 직후 다시 Application 탭 검사:
   - `localStorage` 키 전체 출력에서 `ghp_`, `glpat-`, `Bearer`, `accessToken`, `token`
     문자열 grep → **0건** 이어야 한다.
   - `sessionStorage` 동일 검사.
   - IndexedDB 의 모든 store 도 동일 검사.
4. ⬜ 페이지 새로고침 후에도 (3) 의 검사 결과 변동 없음 확인.
5. ⬜ 통합 목록을 다시 fetch → `accessToken` 빈 문자열 응답 확인.

### 자동화 가능 — Playwright/Vitest 기반 단위 테스트 골격

```ts
// tests/git-credentials/no-localstorage-token.test.ts (작성 권장)
import { test, expect } from '@playwright/test';

test('통합 토큰 저장 후 localStorage 에 토큰 평문이 남지 않는다', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '통합 추가' }).click();
  await page.getByLabel('Access Token').fill('ghp_TEST_TOKEN_DO_NOT_LEAK');
  await page.getByRole('button', { name: '저장' }).click();

  const dump = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
  const flat = JSON.stringify(dump);
  expect(flat).not.toContain('ghp_TEST_TOKEN_DO_NOT_LEAK');
  expect(flat).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
  expect(flat).not.toMatch(/glpat-[A-Za-z0-9_-]{10,}/);
});
```

### 회귀 시그널

| 코드 | 신호 | 의심 위치 |
| ---- | ---- | --------- |
| T3-a | `localStorage` 에 입력값이 남음 | 폼 컴포넌트가 디버그 용도로 입력값을 캐시 — 즉시 제거 |
| T3-b | 통합 목록 fetch 응답이 캐시되어 `accessToken` 평문이 메모리/스토리지에 남음 | `redactIntegration` 통과 응답을 그대로 사용해야 함 |
| T3-c | `UserPreferences`(localStorage) 에 토큰 키가 추가 | `src/types.ts:108` `UserPreferences` 인터페이스에 토큰 필드 도입 시도 즉시 차단 |

### 주의 — false negative 방지

- 토큰 문자열이 base64/url-encoded 형태로 보관될 가능성도 검사. 입력값을 base64 인코딩한
  버전과 URL 인코딩 버전도 grep 대상에 포함.
- 서비스 워커 캐시(`caches.keys()`)와 IndexedDB 의 store 가 SDK 에 의해 자동 생성될 수
  있으므로 함께 점검.

---

## T4 — 암호화된 DB 컬럼의 평문 노출 검사

**목표**: MongoDB `integrations` 컬렉션의 `accessToken` 필드가 향후 암호화 도입 후
평문으로 직접 노출되지 않는지 확인. **현재 미구현 — 본 시나리오는 암호화 도입 PR 의
회귀 게이트로 사용**.

### 현재 상태

- `server.ts:732` `accessToken: String(accessToken)` → 평문 그대로 저장.
- 백업/덤프(`mongodump`) 시 토큰이 평문으로 노출됨.
- 운영자 권한으로 DB 직접 조회 가능 → 토큰 탈취 위험.

### 도입 후 기대값

암호화가 도입되면 다음 계약을 만족해야 한다:

1. ⬜ `accessToken` 컬럼이 사라지고 `accessTokenCipher` (Base64) + `accessTokenIv` (Base64)
   + `accessTokenKeyVersion` (number) 3개 필드로 분리.
2. ⬜ 마이그레이션 스크립트가 기존 평문 문서를 모두 새 스키마로 변환 후 평문 필드 삭제.
3. ⬜ `mongo` 셸에서 `db.integrations.find({})` 결과에 `ghp_` / `glpat-` / `Bearer`
   접두 문자열이 0건.
4. ⬜ 서버 재기동 시 키가 환경변수 또는 KMS 에서 로드되며, 키가 없으면 서버가 기동 거부.
5. ⬜ `redactIntegration` 은 평문이 메모리에 풀린 직후의 객체에도 적용되어, 클라이언트
   응답에는 절대 평문이 포함되지 않음 (T1-c 와 결합).

### 절차 (도입 후)

1. ⬜ `POST /api/integrations` 로 토큰 저장.
2. ⬜ MongoDB 직접 조회로 평문 검사:
   ```bash
   mongosh --eval 'db.integrations.find({}, {accessToken:1, accessTokenCipher:1}).toArray()'
   ```
   - `accessToken` 필드가 결과에 존재하지 않아야 한다.
   - `accessTokenCipher` 가 Base64 문자열로 존재.
3. ⬜ `mongodump` 후 BSON 덤프 파일을 `strings | grep -E 'ghp_|glpat-'` → 0건.
4. ⬜ 서버 재기동 → 통합 목록 fetch 가 정상 동작 (복호화 경로 확인).
5. ⬜ 키 회전(`accessTokenKeyVersion` bump) 후 기존 토큰이 자동 재암호화되는지 확인.

### 회귀 시그널

| 코드 | 신호 | 의심 위치 |
| ---- | ---- | --------- |
| T4-a | DB 에 `accessToken` 평문 필드가 여전히 존재 | 마이그레이션 스크립트 실행 누락 또는 신규 insert 경로가 평문 분기 사용 |
| T4-b | `mongodump` 결과에 `ghp_` 문자열 검출 | 암호화 라우터 우회 — 직접 컬렉션 update 코드 잔존 |
| T4-c | 키 미설정 상태로 서버 기동 성공 | startup guard 누수 — 키 검증 실패 시 process.exit 미호출 |
| T4-d | 응답 본문에 평문 토큰 포함 | `redactIntegration` 미적용 분기 (특히 `/api/integrations/:id/import` 응답) |
| T4-e | 로그 파일에 평문 토큰 노출 | 디버그 로그가 SourceIntegration 객체 전체를 직렬화 — `redactIntegration` 또는 `serialize-error` 가드 필요 |

### 임시 보호 (암호화 도입 전)

- MongoDB 사용자 계정에 `integrations` 컬렉션 read 권한 최소화.
- 백업 덤프는 디스크 암호화 볼륨에만 저장.
- 서버 로그에서 `accessToken` 직렬화 금지 — `JSON.stringify(integration)` 호출 모두
  점검 (현재 server.ts 에서는 `redactIntegration` 적용된 객체만 반환됨을 확인).

---

## T5 — 잘못된 토큰 입력 시 에러 처리

**목표**: 토큰 입력값이 잘못된 경우(누락/형식 오류/만료/권한 부족) 서버와 UI 가
사용자에게 명확한 오류 메시지를 노출하고 비정상 상태로 빠지지 않는지 확인.

### 5-1. 누락/타입 오류 — `POST /api/integrations`

| 입력 | 기대 응답 | 검증 |
| ---- | --------- | ---- |
| `accessToken` 없음 | 400 `{error:'provider (github\\|gitlab) and accessToken required'}` | server.ts:723 |
| `provider` 가 `github`/`gitlab` 외 | 400 동일 메시지 | server.ts:723 |
| `projectId` 없음 | 400 `{error:'projectId required'}` | server.ts:719 |
| `accessToken` 빈 문자열 | 400 동일 메시지 (truthy 검사) | server.ts:723 |
| `accessToken` 비문자열(숫자/객체) | `String(accessToken)` 강제 변환 — **회귀 신호 — 거부해야 함** | server.ts:732 |

T5-1 의 마지막 행은 현재 구현이 **타입 검증 없이 강제 변환** 하는 분기이므로 회귀 케이스로
잠가둔다. 타입이 string 이 아니면 400 으로 거부하는 것이 안전하다.

### 5-2. 형식 검증 — 자동화 도입 후 권장

`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` 접두 또는 fine-grained PAT 의 `github_pat_` 접두를
정규식으로 검증해 사용자 오타(예: `gho` 실수로 `ghp` 누락) 를 즉시 잡는다.

```ts
// 자동화 권장 위치: src/utils/integrations.ts (신설)
const GITHUB_TOKEN_RE = /^(gh[oprsu]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{30,})$/;
const GITLAB_TOKEN_RE = /^glpat-[A-Za-z0-9_-]{20,}$/;
```

### 5-3. 만료/권한 부족 — `/api/integrations/:id/import`

| 시나리오 | 기대 응답 | UI 동작 |
| -------- | --------- | ------- |
| GitHub 401 (토큰 만료) | `fetchRepos` throw → server.ts:802 catch → 500 + 메시지 `github 401: …` | 에러 토스트 노출 + "토큰 재발급" 안내 |
| GitHub 403 (rate limit / scope 부족) | 동일 패턴, 메시지 `github 403: …` | scope 안내 추가 |
| GitLab 401 | `gitlab 401: …` | 동일 |
| 네트워크 오류 (DNS / timeout) | `fetch` throw | 500 + `network` 키워드 |

### 5-4. 자동화 push 인증 실패 결합 (T2 와 차별)

T2 는 "삭제 후 토큰 부재" 를 다루고, T5-4 는 "토큰은 존재하나 잘못됨" 을 다룬다.

| 입력 | 기대 push 결과 | 회귀 시그널 |
| ---- | -------------- | ----------- |
| 만료된 토큰 | `failedStep='push'`, stderr `Authentication failed` | UI 배너 사유 라인이 stderr 400자 슬라이스를 표시 |
| scope 가 `repo` 누락된 토큰 | `failedStep='push'`, stderr `403 Forbidden` 또는 `permission denied` | 사용자에게 scope 안내(향후 UI 강화) |
| 다른 저장소용 토큰 | `failedStep='push'`, stderr `Repository not found` | 통합 ID 와 워크스페이스 원격 매칭 검증 |

### 5-5. UI 컴포넌트 회귀 — `GitAutomationPanel.test.ts` 결합

본 문서가 우선 검토 파일로 지정한 `src/components/GitAutomationPanel.test.ts` 에는 현재
토큰 분기 케이스가 없다(`grep -i token` 결과 `branchTemplate slug token` 만 매칭). 향후
`GitAutomationPanel` 이 토큰 미보유 상태에서 push 토글을 disable 하거나 안내 배너를
띄우는 동작을 추가하면, 본 시나리오와 짝이 되는 단위 테스트를 같은 파일에 추가한다.

권장 단위 테스트 (작성 후 본 문서의 T5 와 1:1 매핑):

```ts
// src/components/GitAutomationPanel.test.ts 추가 권장
test('통합 토큰 미보유 상태에서 push 토글이 비활성화된다', () => {
  // integrations 비어 있을 때 flowLevel=commitPush 라디오가 disabled + tooltip 안내
});

test('잘못된 토큰으로 push 실패 시 사유 배너가 stderr 사유를 노출한다', () => {
  // git-automation:failed 이벤트 → firstFailedStage.errorMessage 렌더 검증
});
```

### 회귀 시그널 종합

| 코드 | 신호 | 의심 위치 |
| ---- | ---- | --------- |
| T5-a | 누락 입력에 200 응답 | server.ts:719/723 가드 회귀 |
| T5-b | 비문자열 토큰이 `String(...)` 강제 변환으로 통과 | 명시적 typeof 가드 도입 필요 |
| T5-c | `/import` 401 응답이 클라이언트에 stack trace 노출 | server.ts:817 catch 의 메시지 슬라이스(200자) 누수 |
| T5-d | UI 가 push 실패 사유를 표시하지 않음 | `GitAutomationStageRow::firstFailedStage.errorMessage` 렌더 회귀 |
| T5-e | 잘못된 토큰을 입력해도 입력 폼이 토큰을 캐시 | T3-a 와 결합 |

---

## 시나리오 매트릭스 요약

| 번호 | 축 | 현 구현 검증 가능? | 자동화 가능 위치 |
| ---- | --- | ----------------- | ---------------- |
| T1   | 토큰 저장 후 push 자동 인증 | ❌ (인증 자동 주입 경로 미구현) | 도입 후 server.ts + e2e |
| T2   | 토큰 삭제 후 push 실패/프롬프트 | △ (현재 토큰 미사용이라 helper 캐시 의존) | 도입 후 e2e |
| T3   | localStorage 미저장 | ✅ 즉시 가능 | Playwright (위 코드 골격 참고) |
| T4   | DB 평문 노출 | ❌ 암호화 미도입 | 암호화 PR 도입 시 mongosh + dump 검사 자동화 |
| T5-1 | 입력 누락/타입 오류 | ✅ 즉시 가능 | supertest 단위 테스트 |
| T5-3 | 만료/권한 401·403 | ✅ 즉시 가능 (토큰을 의도적으로 무효화) | nock 모킹 단위 테스트 |
| T5-5 | UI 회귀 | △ UI 자체에 토큰 분기 미구현 | GitAutomationPanel.test.ts 확장 |

자동화 우선순위: **T3 → T5-1 → T5-3 → T2 → T1 → T4**.

---

## 결과 보고 템플릿

T1~T5 검증 후 리더 Kai 에게 다음 7줄을 보고한다.

```
검증자: <에이전트 이름>
검증 시각: YYYY-MM-DD HH:MM KST
T1 결과: [pass/fail/skip-no-impl] — 인증 프롬프트 발생=<y/n>
T2 결과: [pass/fail/skip-no-impl] — 삭제 후 push 실패=<y/n>, stderr=<발췌>
T3 결과: [pass/fail] — localStorage 평문 검출=<y/n>, sessionStorage=<y/n>, IndexedDB=<y/n>
T4 결과: [pass/fail/skip-no-impl] — accessToken 평문 컬럼 잔존=<y/n>, mongodump grep=<건수>
T5 결과: [pass/fail] — 누락 입력 400=<y/n>, 타입 가드=<y/n>, 401 메시지 노출=<y/n>
```

## 미구현 축 — 후속 작업 메모

- **인증 자동 주입**: 토큰을 git credential helper 또는 `https://x-access-token:<token>@…`
  원격 URL 로 흘려보내는 경로가 도입되면 T1·T2 의 실 검증이 가능해진다. 도입 위치는
  `src/utils/gitAutomation.ts::buildRunPlan` 의 push 단계 전 주입이 자연스럽다.
- **DB 컬럼 암호화**: `node:crypto` AES-256-GCM + 환경변수 키 + 키 회전 스키마. 마이그레이션
  스크립트는 `scripts/encrypt-integrations.ts` 에 신설 권장. 도입 PR 에서 본 문서 T4 를
  PR 본문에 첨부.
- **GitAutomationPanel UI 토큰 분기**: 통합 목록이 비었을 때 push/PR 라디오 옵션을
  disabled + tooltip "통합 토큰을 먼저 등록하세요" 로 안내. 본 문서 T5-5 와 짝이 되는
  단위 테스트를 `src/components/GitAutomationPanel.test.ts` 에 추가.
