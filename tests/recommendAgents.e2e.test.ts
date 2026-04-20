// Run with: npx tsx --test tests/recommendAgents.e2e.test.ts
//
// 지시 #d345a120 (QA · E2E 스케치) · 추천 에이전트 팀 시나리오 초안.
//
// 본 파일은 **사전 설계 스캐폴드**. 모든 테스트가 `{ skip: true }` 로 비활성화되어
// 있으며, 구현이 마무리되면 TODO 를 채우고 skip 을 해제한다.
//
// TODO — 활성화 전 필요한 의존성
//   · 런타임: `@playwright/test` devDependency 설치.
//   · 소스:
//       - src/ui/NewProjectWizard.tsx(이미 구현) — description 입력 → review → apply.
//       - src/server/api/recommendAgents.ts 라우트(아직 미구현) — POST /api/project/recommend
//         에 description/locale 을 받아 Anthropic 을 호출하고 items 반환.
//       - src/project/api.ts 의 applyRecommendedTeam(이미 구현) — POST /api/agents/hire +
//         /api/projects/:id/agents 순차 호출.
//       - src/llm/tokenBudget.ts 의 maybeCompact — 장기 세션에서 호출 입력 축소.
//   · 테스트 픽스처: seeded user + 새 프로젝트 id, Anthropic 응답 녹화본(mock server).
//   · 네트워크 장애 시나리오: MSW 또는 Playwright route mocking 으로 500/timeout 주입.

import { describe, test } from 'node:test';

// ────────────────────────────────────────────────────────────────────────────
// 골든 패스 — 설명 입력 → 추천 렌더 → 모두 추가 → 팀 반영
// ────────────────────────────────────────────────────────────────────────────

describe('recommendAgents.e2e — 골든 패스', () => {
  test('G1. 설명 입력 → 400ms 디바운스 후 POST /api/project/recommend 1회만 호출', { skip: 'pending-playwright' }, async () => {
    // TODO:
    //  const requests: string[] = [];
    //  await page.route('**/api/project/recommend', (route) => {
    //    requests.push(route.request().postData() ?? '');
    //    route.fulfill({ json: { items: RECORDED_KO_ITEMS } });
    //  });
    //  await page.goto('/new-project');
    //  const textarea = page.getByLabel('프로젝트 설명');
    //  await textarea.fill('블로그 CMS');
    //  await textarea.fill('블로그 CMS — 사용자 인증');
    //  await textarea.fill('블로그 CMS — 사용자 인증, 게시글 CRUD');
    //  await page.waitForTimeout(500);  // 디바운스 통과.
    //  expect(requests).toHaveLength(1);
  });

  test('G2. 3~5개 추천 카드 렌더 — role="option" 이 해당 범위 내', { skip: 'pending-playwright' }, async () => {
    // TODO:
    //  const listbox = page.getByRole('listbox');
    //  const options = listbox.getByRole('option');
    //  const count = await options.count();
    //  expect(count).toBeGreaterThanOrEqual(3);
    //  expect(count).toBeLessThanOrEqual(5);
    //  // 첫 카드는 Leader 역할.
    //  await expect(options.first().locator('.npw-role')).toHaveText('Leader');
  });

  test('G3. "모두 추가" 버튼 클릭 → applyRecommendedTeam hire+attach 체인이 전원 성공', { skip: 'pending-playwright' }, async () => {
    // TODO:
    //  const hires: unknown[] = [];
    //  const attaches: unknown[] = [];
    //  await page.route('**/api/agents/hire', (r) => { hires.push(r.request().postDataJSON()); r.fulfill({ json: { id: `agent-${hires.length}` } }); });
    //  await page.route('**/api/projects/*/agents', (r) => { attaches.push(r.request().postDataJSON()); r.fulfill({ json: {} }); });
    //  await page.getByRole('button', { name: '모두 추가' }).click();
    //  // 토스트 노출.
    //  await expect(page.getByRole('status')).toContainText(/추가했습니다/);
    //  expect(hires.length).toBe(attaches.length);
    //  expect(hires.length).toBeGreaterThanOrEqual(3);
  });

  test('G4. 팀 반영 검증 — 프로젝트 상세 페이지에 추가된 에이전트 이름 노출', { skip: 'pending-playwright' }, async () => {
    // TODO:
    //  await page.goto(`/projects/${PROJECT_ID}`);
    //  const roster = page.getByRole('region', { name: '팀원' });
    //  await expect(roster).toContainText('Kai');
    //  await expect(roster).toContainText('Dev');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 에지 케이스 — 토큰 초과 / 네트워크 실패
// ────────────────────────────────────────────────────────────────────────────

describe('recommendAgents.e2e — 에지 케이스', () => {
  test('E1. 토큰 초과 — 서버가 429 응답 시 UI 가 재시도 버튼을 노출하고 자동 compact 유도 문구 표시', { skip: 'pending-playwright' }, async () => {
    // TODO:
    //  await page.route('**/api/project/recommend', (r) => r.fulfill({ status: 429, json: { error: 'token_exhausted' } }));
    //  await page.getByLabel('프로젝트 설명').fill('블로그 CMS');
    //  await page.waitForTimeout(500);
    //  await expect(page.getByRole('alert')).toContainText(/토큰.*초과|limit/i);
    //  await expect(page.getByRole('button', { name: /다시 시도|Retry/i })).toBeVisible();
    //  // 자동 컨텍스트 압축 안내(tokenUsage.toast.compacted 문구) 가 토스트로 노출되는지 확인.
    //  await expect(page.getByRole('status')).toContainText(/자동 압축|auto-compacted/i);
  });

  test('E2. 네트워크 실패 — fetch timeout/offline 시 UI 는 heuristic 폴백 카드를 보여주고 배너로 알림', { skip: 'pending-playwright' }, async () => {
    // TODO:
    //  await page.route('**/api/project/recommend', (r) => r.abort('timedout'));
    //  await page.getByLabel('프로젝트 설명').fill('블로그 CMS');
    //  await page.waitForTimeout(500);
    //  // UI 는 비어있지 않고 heuristic 카드(최소 Leader+Developer) 를 보여준다.
    //  const options = page.getByRole('listbox').getByRole('option');
    //  expect(await options.count()).toBeGreaterThanOrEqual(2);
    //  await expect(page.getByRole('alert')).toContainText(/오프라인|offline|네트워크/i);
    //  // 복구 후 자동 재요청 또는 수동 재시도 버튼 중 하나는 동작.
  });

  test('E3. 긴 설명(>4k 문자) — 서버가 413 또는 400 을 돌려주면 안내 메시지', { skip: 'pending-playwright' }, async () => {
    // TODO: tokenBudget.maybeCompact 가 긴 histort 에서 호출 비용을 줄이도록 작동하는지
    //       별도 스펙(tests/recommendAgents.unit.test.ts X2) 이 잠금. 본 E2E 는 UI 노출만.
  });
});
