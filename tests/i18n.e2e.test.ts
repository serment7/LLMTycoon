// Run with: npx tsx --test tests/i18n.e2e.test.ts
//
// 지시 #d345a120 (QA · E2E 스케치) · 언어 모드 E2E 시나리오 초안.
//
// 본 파일은 **사전 설계 스캐폴드** 로, 모든 케이스가 `{ skip: true }` 로 비활성화
// 되어 있다. Playwright 와 통합 엔드포인트가 준비되면 각 TODO 를 채우고 skip 을
// 해제하면 된다.
//
// TODO — 활성화 전 필요한 의존성
//   · 런타임: `@playwright/test` devDependency 설치.
//   · 소스:
//       - src/i18n/index.ts (이미 구현: detectLocale · setLocale · persistLocale).
//       - src/ui/onboarding/OnboardingTour.tsx locale-picker 또는 별도 언어 토글 UI.
//       - src/server/api/userPreferences.ts(또는 상위 어댑터) — 로그인 사용자의
//         user_preferences.language 를 upsert 하는 REST 경로.
//   · 테스트 데이터: seeded 사용자 1명(u-journey-1) + 빈 localStorage 스냅샷.
//   · 런처: `vite preview` 또는 `npm run dev` 로 띄운 뒤 Playwright fixture 가
//     ${BASE_URL} 을 주입.
//
// 실행 의도
//   기능 구현이 끝난 뒤 본 파일을 Playwright 러너에서 구동하도록 `playwright.config`
//   에 `testDir: 'tests'` · `testMatch: '*.e2e.test.ts'` 를 추가한다.

import { describe, test } from 'node:test';

// ────────────────────────────────────────────────────────────────────────────
// 공용 스케치 — Playwright API 를 모의 타입으로 선언. 실제 설치 후 import 로 교체.
// ────────────────────────────────────────────────────────────────────────────

type Page = unknown; // TODO: import { Page } from '@playwright/test';
type BrowserContext = unknown; // TODO: 위와 동일.

// 타입 체커를 만족시키는 no-op 자리. 실제 구동 시 playwright fixture 주입.
async function openApp(_url: string): Promise<{ page: Page; context: BrowserContext }> {
  throw new Error('Playwright fixture 가 필요합니다 — describe.skip 을 해제하려면 의존성 설치');
}

// ────────────────────────────────────────────────────────────────────────────
// 4단계 E2E — 영어 디폴트 → ko 전환 → 새 세션 ko 유지 → 미지 locale 폴백
// ────────────────────────────────────────────────────────────────────────────

describe('i18n.e2e — 언어 모드 4단계 시나리오', () => {
  test('S1. 영어 디폴트 진입 — 첫 렌더의 app.title 이 "LLM Tycoon"', { skip: 'pending-playwright' }, async () => {
    // TODO: const { page } = await openApp(BASE_URL);
    //  await page.goto('/');
    //  await expect(page.getByRole('heading', { name: 'LLM Tycoon' })).toBeVisible();
    //  const stored = await page.evaluate(() => localStorage.getItem('user_preferences.language'));
    //  expect(stored).toBeNull();
  });

  test('S2. 한국어 전환 — locale 토글 클릭 후 app.title 이 "LLM 타이쿤" 으로 교체', { skip: 'pending-playwright' }, async () => {
    // TODO:
    //  await page.getByRole('group', { name: '언어' }).getByRole('button', { name: '한국어' }).click();
    //  await expect(page.getByRole('heading', { name: 'LLM 타이쿤' })).toBeVisible();
    //  const stored = await page.evaluate(() => localStorage.getItem('user_preferences.language'));
    //  expect(stored).toBe('ko');
    //  // 로그인 사용자라면 POST /api/user/preferences 서버 기록도 확인.
    //  const res = await request.get('/api/user/preferences/u-journey-1');
    //  expect(await res.json()).toMatchObject({ language: 'ko' });
  });

  test('S3. 새 세션 로그인 — 재접속 후에도 ko 유지', { skip: 'pending-playwright' }, async () => {
    // TODO:
    //  await context.close();                                // 브라우저 컨텍스트 종료.
    //  const fresh = await browser.newContext({ storageState: undefined });
    //  const page2 = await fresh.newPage();
    //  await page2.goto('/');
    //  await page2.getByTestId('login').fill('u-journey-1').press('Enter');
    //  await expect(page2.getByRole('heading', { name: 'LLM 타이쿤' })).toBeVisible();
    //  // 서버 user_preferences 에 저장된 ko 가 복원 경로임을 검증.
  });

  test('S4. 미지 locale 폴백 — storage 의 "jp" 값은 무시하고 en 으로 폴백', { skip: 'pending-playwright' }, async () => {
    // TODO:
    //  await page.evaluate(() => localStorage.setItem('user_preferences.language', 'jp'));
    //  await page.reload();
    //  await expect(page.getByRole('heading', { name: 'LLM Tycoon' })).toBeVisible();
    //  const stored = await page.evaluate(() => localStorage.getItem('user_preferences.language'));
    //  expect(stored).toBe('jp'); // storage 자체는 유지(뷰만 폴백).
  });
});

// 자동 참조 제거 방지 — lint 가 openApp 을 미사용으로 판단하지 않도록 가짜 사용.
void openApp;
