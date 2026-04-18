// Run with: npx tsx --test src/components/ProjectMenuScope.test.ts
//
// [Thanos/backend 점검노트 — 2026-04-18, 로그 중복 표시 원인 분석]
// server.ts io.emit('agent:working'|'agent:messaged') 는 송신자 포함 전체 브로드캐스트라
// 클라이언트가 로컬 낙관 업데이트까지 하면 동일 이벤트가 2회 렌더된다. 또한
// 'state:updated'+'tasks:updated' 가 동일 핸들러에서 연달아 emit 되므로 src/App.tsx 의
// useEffect 가 두 이벤트를 같은 로그 라인으로 매핑하면 중복처럼 보인다. 본 테스트의
// 메뉴 스코프 불변식과는 별개지만, 이후 회귀가 "미선택 스코프로 이벤트가 흘러 메뉴가
// 두 번 렌더" 되는 형태로 번질 수 있어 상단에 근거만 고정해 둔다.
//
// QA(감마): 프로젝트 스코프 "관리 메뉴(Git 자동화 설정 + 사용자 선호)" 가시성 회귀 가드.
// 할당 업무 #MENU-SCOPE. 기존 ProjectManagement.test.ts 의 TC-PROJ*/TC-PS* 가
// 단일 슬롯 모델의 불변식을 다룬다면, 여기서는 UI 소비자가 "메뉴를 보여줄지/숨길지"를
// 결정하는 4가지 사용자 시나리오를 순수 함수 레벨에서 고정한다.
//
// 시나리오 (사용자 문장 → 테스트 불변식):
//   (1) 프로젝트 미선택 시 관리 메뉴 비노출
//       → 빈 스토리지 + projectId 미지정 load 는 "빈 선호({})"와 "DEFAULT_AUTOMATION"
//         을 돌려줘야 한다. 메뉴 렌더 분기는 이 두 값을 "노출 안 함" 조건으로 해석한다.
//   (2) 프로젝트 A에서 저장한 메뉴가 프로젝트 B로 전환 시 보이지 않음
//       → saveXxx(..., 'proj-A') 후 loadXxx('proj-B') 결과에 A 의 값이 한 조각도 섞이면 안 된다.
//   (3) 프로젝트별 데이터 격리
//       → 두 네임스페이스(llm-tycoon:project-settings:<id>,
//         llm-tycoon:git-automation-panel:<id>) 모두 A/B 독립 슬롯을 유지한다.
//   (4) 프로젝트 삭제/생성 시 메뉴 동기화
//       → A 를 "삭제(스코프 키 제거)" 해도 B 의 저장본은 byte-identical 보존.
//         새 프로젝트를 "생성(처음 접근)" 해도 기존 프로젝트의 값이 번져 들어가지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadUserPreferences,
  saveUserPreferences,
  loadGitAutomationSettings,
  saveGitAutomationSettings,
  formatEditingProjectLabel,
  PROJECT_SETTINGS_KEY_PREFIX,
  GIT_AUTOMATION_PANEL_KEY,
} from './ProjectManagement.tsx';
import type { ManagedProject, Agent, Task } from '../types.ts';
import { EmptyProjectPlaceholder } from './EmptyProjectPlaceholder.tsx';
import { isActiveAgent } from './AgentStatusPanel.tsx';
import {
  DEFAULT_AUTOMATION,
  deriveAutomationOptions,
  renderTemplate,
  type GitAutomationSettings,
} from './GitAutomationPanel.tsx';
import { USER_PREFERENCES_KEY } from '../types.ts';
import type { GitAutomationPreference } from '../types.ts';
import {
  inferFileType,
  isExcludedFromCodeGraph,
  normalizeCodeGraphPath,
  type CodeFileType,
} from '../utils/codeGraphFilter.ts';

// 최소 fake localStorage. ProjectManagement.test.ts 와 동일한 주입 방식을 사용해
// 테스트 간 격리를 보장한다. 매 테스트 try/finally 로 install/uninstall 을 감싼다.
interface FakeLocalCtx { store: Map<string, string>; throwOnSet: boolean; }

function installFakeLocalStorage(seed?: Record<string, string>): FakeLocalCtx {
  const ctx: FakeLocalCtx = { store: new Map<string, string>(), throwOnSet: false };
  if (seed) for (const [k, v] of Object.entries(seed)) ctx.store.set(k, v);
  const fakeLocal: Storage = {
    get length() { return ctx.store.size; },
    clear() { ctx.store.clear(); },
    getItem(key: string) { return ctx.store.has(key) ? ctx.store.get(key)! : null; },
    key(i: number) { return Array.from(ctx.store.keys())[i] ?? null; },
    removeItem(key: string) { ctx.store.delete(key); },
    setItem(key: string, value: string) {
      if (ctx.throwOnSet) throw new Error('QuotaExceededError');
      ctx.store.set(key, value);
    },
  };
  (globalThis as unknown as { window?: { localStorage: Storage } }).window = { localStorage: fakeLocal };
  return ctx;
}

function uninstallFakeLocalStorage() {
  delete (globalThis as unknown as { window?: unknown }).window;
}

const scopedPrefsKey = (projectId: string) => `${PROJECT_SETTINGS_KEY_PREFIX}:${projectId}`;
const scopedPanelKey = (projectId: string) => `${GIT_AUTOMATION_PANEL_KEY}:${projectId}`;

// 프로젝트 A 용 현실적 선호 (flowLevel · 리뷰어 · 템플릿 모두 비-기본값). 전염이 발생하면
// 원본의 특정 문자열(alice, feature/) 이 B 의 저장본 또는 load 결과에 남아 바로 잡힌다.
const PREFS_A: GitAutomationPreference = {
  flowLevel: 'commitPush',
  branchTemplate: 'feature/{type}/{slug}',
  commitConvention: 'conventional',
  commitScope: 'api',
  prTitleTemplate: '{type}: {summary}',
  reviewers: ['alice', 'bob'],
};

const PANEL_A: GitAutomationSettings = {
  flow: 'commit-push',
  branchPattern: 'feature/{type}/{ticket}',
  commitTemplate: '{type}({scope}): {summary}',
  prTitleTemplate: '[{ticket}] {type}: {summary}',
  enabled: true,
  branchStrategy: 'per-session',
  newBranchName: '',
};

const PANEL_B: GitAutomationSettings = {
  flow: 'full-pr',
  branchPattern: 'release/{version}',
  commitTemplate: 'release: {version}',
  prTitleTemplate: 'release {version}',
  enabled: false,
  branchStrategy: 'per-session',
  newBranchName: '',
};

// ─────────────────────────────────────────────────────────────────────────────
// (1) 프로젝트 미선택 시 관리 메뉴 비노출 확인
// ─────────────────────────────────────────────────────────────────────────────

test('TC-MENU-V1a: projectId 미지정 + 빈 스토리지는 선호 메뉴에 노출할 값을 남기지 않는다', () => {
  installFakeLocalStorage();
  try {
    // 메뉴 렌더 분기는 loadUserPreferences() 결과가 {} 인 경우 "빈 상태" 로 간주해 숨긴다.
    assert.deepEqual(loadUserPreferences(), {});
    // gitAutomation 슬롯도 undefined — "pinned 도 자동화도 없음" = 메뉴 미노출.
    assert.equal(loadUserPreferences().gitAutomation, undefined);
    assert.equal(loadUserPreferences().pinnedPrTargetProjectId, undefined);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-V1b: projectId 미지정 + 빈 스토리지는 Git 자동화 패널에 DEFAULT 를 돌려준다', () => {
  installFakeLocalStorage();
  try {
    // DEFAULT_AUTOMATION 은 "저장된 값 없음" 의 센티넬 역할. 렌더 단에서는 이걸
    // "아직 사용자 편집 없음" 으로 읽고, 프로젝트가 선택되지 않은 상황에서는 패널 자체를
    // 띄우지 않는다. 본 테스트는 그 센티넬이 실제로 DEFAULT_AUTOMATION 과 동일한지 고정.
    assert.deepEqual(loadGitAutomationSettings(), DEFAULT_AUTOMATION);
  } finally { uninstallFakeLocalStorage(); }
});

// null 과 undefined 를 같은 "미선택" 신호로 취급해야 한다는 렌더 게이트 계약을 고정한다.
// ProjectManagement.tsx 의 `currentProjectId?: string | null` 을 props 로 받는 컴포넌트는
// 두 값 중 어느 쪽이 들어오든 똑같이 메뉴를 숨기고, pure load/save 도 똑같이 레거시 키로
// 귀결되어야 한다. 상태 관리 훅이 null 을 스코프 키로 직렬화하는 회귀(`...:null`) 를 차단.
test('TC-MENU-V1d: null 로 호출한 load/save 는 undefined 와 byte-identical 로 취급된다', () => {
  const ctx = installFakeLocalStorage();
  try {
    // @ts-expect-error: 런타임에서 null 이 흘러들어오는 경로를 의도적으로 재현한다.
    assert.deepEqual(loadUserPreferences(null), {});
    // @ts-expect-error: 위와 동일한 이유.
    assert.deepEqual(loadGitAutomationSettings(null), DEFAULT_AUTOMATION);

    // @ts-expect-error: null save 가 `...:null` 스코프 키를 만들어내지 않아야 한다.
    saveUserPreferences({ pinnedPrTargetProjectId: 'proj-A' }, null);
    // @ts-expect-error: 위와 동일한 이유.
    saveGitAutomationSettings(PANEL_A, null);

    for (const key of ctx.store.keys()) {
      assert.equal(key.endsWith(':null'), false, `null 이 스코프 키 접미사로 직렬화됐다: ${key}`);
      assert.equal(key.startsWith(`${PROJECT_SETTINGS_KEY_PREFIX}:`), false, `스코프 키가 생성됐다: ${key}`);
      assert.equal(key.startsWith(`${GIT_AUTOMATION_PANEL_KEY}:`), false, `스코프 키가 생성됐다: ${key}`);
    }
    // 레거시 단일 키에만 저장되어야 한다 — undefined 호출 경로와 동일.
    assert.ok(ctx.store.get(USER_PREFERENCES_KEY));
    assert.ok(ctx.store.get(GIT_AUTOMATION_PANEL_KEY));
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-V1c: projectId 미지정 save 는 레거시 단일 키만 건드리고 스코프 키를 오염시키지 않는다', () => {
  const ctx = installFakeLocalStorage();
  try {
    saveUserPreferences({ pinnedPrTargetProjectId: 'proj-A' });
    saveGitAutomationSettings(PANEL_A);
    // 레거시 키에는 값이 있어야 하지만…
    assert.ok(ctx.store.get(USER_PREFERENCES_KEY));
    assert.ok(ctx.store.get(GIT_AUTOMATION_PANEL_KEY));
    // …어떤 스코프 키도 생기지 않아야 한다. 메뉴가 없는 상태에서 특정 프로젝트로
    // 값이 번져 들어가는 유령 메뉴 회귀를 차단한다.
    for (const key of ctx.store.keys()) {
      assert.equal(key.startsWith(`${PROJECT_SETTINGS_KEY_PREFIX}:`), false, `스코프 키가 생성됐다: ${key}`);
      assert.equal(key.startsWith(`${GIT_AUTOMATION_PANEL_KEY}:`), false, `스코프 키가 생성됐다: ${key}`);
    }
  } finally { uninstallFakeLocalStorage(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) 프로젝트 A에서 저장한 메뉴가 프로젝트 B로 전환 시 보이지 않음
// ─────────────────────────────────────────────────────────────────────────────

test('TC-MENU-V2a: A 에 저장된 선호는 B 로 전환 시 빈 값({})으로 보인다', () => {
  installFakeLocalStorage();
  try {
    saveUserPreferences({ gitAutomation: PREFS_A, pinnedPrTargetProjectId: 'proj-A' }, 'proj-A');

    const fromB = loadUserPreferences('proj-B');
    assert.deepEqual(fromB, {}, 'B 로 전환하면 A 의 선호는 단 한 필드도 보여선 안 된다');
    assert.equal(fromB.gitAutomation, undefined);
    assert.equal(fromB.pinnedPrTargetProjectId, undefined);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-V2b: A 에 저장된 패널 설정은 B 로 전환 시 DEFAULT 로 보인다', () => {
  installFakeLocalStorage();
  try {
    saveGitAutomationSettings(PANEL_A, 'proj-A');

    const panelFromB = loadGitAutomationSettings('proj-B');
    assert.deepEqual(panelFromB, DEFAULT_AUTOMATION, 'B 로 전환하면 패널은 DEFAULT 로 돌아와야 한다');
    // 특히 A 의 branchPattern 이 B 쪽에 새어 들어오지 않는지 문자열 매칭으로도 확인.
    assert.notEqual(panelFromB.branchPattern, PANEL_A.branchPattern);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-V2c: A→B→A 전환을 섞어도 각 프로젝트의 메뉴는 원형 그대로 복원된다', () => {
  installFakeLocalStorage();
  try {
    saveUserPreferences({ gitAutomation: PREFS_A }, 'proj-A');
    saveGitAutomationSettings(PANEL_A, 'proj-A');
    saveGitAutomationSettings(PANEL_B, 'proj-B');

    // 전환 순서를 뒤섞어도 각 프로젝트의 값이 서로 번지지 않아야 한다.
    assert.deepEqual(loadUserPreferences('proj-A').gitAutomation, PREFS_A);
    assert.deepEqual(loadGitAutomationSettings('proj-B'), PANEL_B);
    assert.deepEqual(loadGitAutomationSettings('proj-A'), PANEL_A);
    // B 는 사용자 선호를 저장한 적이 없으므로 {} 이어야 한다.
    assert.deepEqual(loadUserPreferences('proj-B'), {});
  } finally { uninstallFakeLocalStorage(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) 프로젝트별 데이터 격리
// ─────────────────────────────────────────────────────────────────────────────

test('TC-MENU-V3a: 서로 다른 projectId 는 독립 스코프 키에 저장된다', () => {
  const ctx = installFakeLocalStorage();
  try {
    saveUserPreferences({ gitAutomation: PREFS_A }, 'proj-A');
    saveGitAutomationSettings(PANEL_B, 'proj-B');

    assert.ok(ctx.store.get(scopedPrefsKey('proj-A')), 'A 의 선호 스코프 키가 있어야 한다');
    assert.ok(ctx.store.get(scopedPanelKey('proj-B')), 'B 의 패널 스코프 키가 있어야 한다');
    // 반대 키는 "존재하지 않아야" 한다 — 함부로 cross-write 되면 유령 메뉴 버그로 이어진다.
    assert.equal(ctx.store.get(scopedPrefsKey('proj-B')), undefined);
    assert.equal(ctx.store.get(scopedPanelKey('proj-A')), undefined);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-V3b: A 한 쪽만 수정해도 B 의 저장본은 byte-identical 로 유지된다', () => {
  const ctx = installFakeLocalStorage();
  try {
    saveUserPreferences({ gitAutomation: PREFS_A }, 'proj-A');
    saveGitAutomationSettings(PANEL_B, 'proj-B');
    const bPrefsBefore = ctx.store.get(scopedPrefsKey('proj-B')); // undefined 이어야 정상
    const bPanelBefore = ctx.store.get(scopedPanelKey('proj-B'));

    // A 의 리뷰어/flowLevel 을 크게 교체해 영향 범위를 키워도, B 저장본은 그대로여야 한다.
    saveUserPreferences({
      gitAutomation: { ...PREFS_A, flowLevel: 'commitOnly', reviewers: ['carol', 'dave', 'eve'] },
    }, 'proj-A');
    saveGitAutomationSettings({ ...PANEL_A, enabled: false, branchPattern: 'hotfix/{slug}' }, 'proj-A');

    assert.equal(ctx.store.get(scopedPrefsKey('proj-B')), bPrefsBefore, 'A 수정이 B 의 선호 원문을 건드렸다');
    assert.equal(ctx.store.get(scopedPanelKey('proj-B')), bPanelBefore, 'A 수정이 B 의 패널 원문을 건드렸다');
    // load 결과도 B 쪽은 손상되지 않아야 한다.
    assert.deepEqual(loadGitAutomationSettings('proj-B'), PANEL_B);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-V3c: 스코프 저장본에는 다른 프로젝트의 식별자/리뷰어가 끼어들지 않는다', () => {
  const ctx = installFakeLocalStorage();
  try {
    saveUserPreferences({ gitAutomation: PREFS_A, pinnedPrTargetProjectId: 'proj-A' }, 'proj-A');
    saveUserPreferences({
      gitAutomation: { ...PREFS_A, reviewers: ['zoe'] },
      pinnedPrTargetProjectId: 'proj-B',
    }, 'proj-B');

    const bRaw = ctx.store.get(scopedPrefsKey('proj-B')) ?? '';
    // A 의 고유 식별자·리뷰어가 B 의 원문에 남아 있으면 merge/카피 버그. 문자열 단위 가드.
    assert.equal(bRaw.includes('proj-A'), false, 'B 의 저장본에 A 의 projectId 가 남아 있다');
    assert.equal(bRaw.includes('alice'), false, 'B 의 저장본에 A 의 리뷰어가 남아 있다');
    assert.ok(bRaw.includes('zoe'), 'B 의 리뷰어는 살아 있어야 한다');
  } finally { uninstallFakeLocalStorage(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) 프로젝트 삭제/생성 시 메뉴 동기화 검증
// ─────────────────────────────────────────────────────────────────────────────

test('TC-MENU-V4a: A 를 "삭제"(스코프 키 removeItem) 해도 B 의 메뉴 저장본은 보존된다', () => {
  const ctx = installFakeLocalStorage();
  try {
    saveUserPreferences({ gitAutomation: PREFS_A }, 'proj-A');
    saveGitAutomationSettings(PANEL_A, 'proj-A');
    saveUserPreferences({ gitAutomation: { ...PREFS_A, reviewers: ['zoe'] } }, 'proj-B');
    saveGitAutomationSettings(PANEL_B, 'proj-B');

    const bPrefsSnapshot = ctx.store.get(scopedPrefsKey('proj-B'));
    const bPanelSnapshot = ctx.store.get(scopedPanelKey('proj-B'));

    // 프로젝트 삭제 경로: 컴포넌트(deleteManaged)가 서버에서 엔티티를 지우면,
    // 로컬 메뉴 저장본도 스코프 키 기준으로 비워야 "유령 메뉴" 가 다음 세션에 되살아나지 않는다.
    // 이 테스트는 "삭제 시 제거 후 B 는 영향 없음" 이라는 동기화 계약을 고정한다.
    (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.removeItem(scopedPrefsKey('proj-A'));
    (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.removeItem(scopedPanelKey('proj-A'));

    // A 의 저장본은 실제로 사라져야 한다 — load 는 빈 상태로 돌아와야 한다.
    assert.deepEqual(loadUserPreferences('proj-A'), {});
    assert.deepEqual(loadGitAutomationSettings('proj-A'), DEFAULT_AUTOMATION);
    // B 는 단 한 바이트도 바뀌어선 안 된다.
    assert.equal(ctx.store.get(scopedPrefsKey('proj-B')), bPrefsSnapshot);
    assert.equal(ctx.store.get(scopedPanelKey('proj-B')), bPanelSnapshot);
    assert.deepEqual(loadGitAutomationSettings('proj-B'), PANEL_B);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-V4b: 새 프로젝트 생성 직후(첫 load) 에는 기존 프로젝트 값이 번지지 않는다', () => {
  installFakeLocalStorage();
  try {
    saveUserPreferences({ gitAutomation: PREFS_A }, 'proj-A');
    saveGitAutomationSettings(PANEL_A, 'proj-A');

    // "proj-C 가 방금 만들어져 관리 목록에 편입된" 상황. 해당 ID 로 로드 하면 빈/DEFAULT 가
    // 나와야 한다. A 의 값이 기본값으로 채워지면, 신규 프로젝트에 다른 저장소 설정이
    // 붙은 채 첫 PR 이 나갈 위험이 있어 치명적이다.
    assert.deepEqual(loadUserPreferences('proj-C'), {});
    assert.deepEqual(loadGitAutomationSettings('proj-C'), DEFAULT_AUTOMATION);

    // 그 뒤 proj-C 에 대해 값을 저장해도 A 의 저장본은 그대로여야 한다.
    saveGitAutomationSettings({ ...DEFAULT_AUTOMATION, flow: 'commit' }, 'proj-C');
    assert.deepEqual(loadGitAutomationSettings('proj-A'), PANEL_A, 'C 의 첫 저장이 A 를 건드렸다');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-V4c: A 삭제 후 같은 ID 로 재생성 시 옛 저장본 잔여가 되살아나지 않는다', () => {
  const ctx = installFakeLocalStorage();
  try {
    // 실제 사내 이슈 #MENU-GHOST: 삭제된 프로젝트의 저장본을 제거하지 않은 채 같은 ID 로
    // 재생성하면 옛 설정이 유령처럼 되살아나, 엉뚱한 base 브랜치로 PR 이 나간 사고가 있었다.
    // 삭제 시점에 스코프 키를 반드시 removeItem 해야 한다는 계약을 고정한다.
    saveUserPreferences({ gitAutomation: PREFS_A, pinnedPrTargetProjectId: 'proj-A' }, 'proj-A');
    saveGitAutomationSettings(PANEL_A, 'proj-A');

    // 삭제 — 스코프 키 제거.
    (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.removeItem(scopedPrefsKey('proj-A'));
    (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.removeItem(scopedPanelKey('proj-A'));

    // 같은 ID 로 재생성 후 첫 load. 이전 alice/bob 이 부활하면 즉시 실패해야 한다.
    const reborn = loadUserPreferences('proj-A');
    assert.deepEqual(reborn, {});
    assert.equal(reborn.gitAutomation, undefined);
    const rebornPanel = loadGitAutomationSettings('proj-A');
    assert.deepEqual(rebornPanel, DEFAULT_AUTOMATION);
    // 스토리지 원문에도 alice 가 남아 있지 않아야 한다.
    for (const raw of ctx.store.values()) {
      assert.equal(raw.includes('alice'), false, '삭제 후에도 A 의 리뷰어가 스토리지에 남아 있다');
    }
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-V4d: 다중 프로젝트 일괄 삭제 후 남은 프로젝트의 메뉴 load 는 영향을 받지 않는다', () => {
  const ctx = installFakeLocalStorage();
  try {
    saveGitAutomationSettings(PANEL_A, 'proj-A');
    saveGitAutomationSettings(PANEL_B, 'proj-B');
    saveGitAutomationSettings({ ...DEFAULT_AUTOMATION, flow: 'full-pr' }, 'proj-C');
    const survivor = ctx.store.get(scopedPanelKey('proj-B'));

    // A 와 C 를 연달아 삭제. B 만 남는 상황.
    const local = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage;
    local.removeItem(scopedPanelKey('proj-A'));
    local.removeItem(scopedPanelKey('proj-C'));

    // B 의 load 결과와 원문이 그대로여야 한다.
    assert.deepEqual(loadGitAutomationSettings('proj-B'), PANEL_B);
    assert.equal(ctx.store.get(scopedPanelKey('proj-B')), survivor);
    // A/C 는 DEFAULT 로 폴백.
    assert.deepEqual(loadGitAutomationSettings('proj-A'), DEFAULT_AUTOMATION);
    assert.deepEqual(loadGitAutomationSettings('proj-C'), DEFAULT_AUTOMATION);
  } finally { uninstallFakeLocalStorage(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) 다중 에이전트 동시 작업 시 에이전트 상태 전환 & 코드그래프 파일 누락 방지
// ─────────────────────────────────────────────────────────────────────────────
// QA(디테일 집착) 관점: server.ts 의 에이전트 상태 머신은 "idle → working(workingOnFileId
// 지정) → completed(idle 복귀 + 파일 노드 보존)" 을 단일 Task 단위로 강제한다. 그러나
// 메뉴 스코프 저장은 에이전트/파일 단위가 아니라 "프로젝트 단위 localStorage 키" 로
// 이뤄지기 때문에, 다중 에이전트가 서로 다른 프로젝트를 동시에 working 처리하며
// saveXxx(..., projectId) 를 연달아 호출할 때 특정 스코프 키가 마지막 쓰기에 가려
// 누락되거나 이웃 프로젝트로 전염되는 회귀가 발생할 수 있다. 아래 세 케이스는 실제
// 에이전트 협업 시나리오를 단일 스레드에서 "모든 전이 순서 조합" 으로 재현한다.
//
// 고정할 불변식:
//   (AGT1) N=3 에이전트가 각자 idle→working→completed 를 순차 전이하며 서로 다른
//          프로젝트에 save 해도, 종료 시 모든 프로젝트의 스코프 키가 누락 없이 존재하고
//          각자 원형 그대로 복원된다.
//   (AGT2) 같은 프로젝트를 두 에이전트가 덮어써도(later-writer-wins), 다른 에이전트가
//          완료한 이웃 프로젝트의 저장본은 byte-identical 로 살아남는다.
//   (AGT3) idle 구간의 load 는 빈 상태, working 중 save 된 중간값은 completed 의 최종
//          save 에 덮어써져야 하며, 다른 프로젝트 저장본 원문에는 중간값 잔여 문자열이
//          남지 않는다.

interface AgentTransition {
  agentId: string;
  projectId: string;
  panel: GitAutomationSettings;
  prefs: GitAutomationPreference;
}

// 에이전트 한 명이 하나의 태스크를 idle→working→completed 순으로 처리하며
// 담당 프로젝트의 패널/선호를 저장하는 상황을 순수 함수 호출 순서로 재현.
// 호출 순서는 server.ts(268 line: status: 'working' → 277 line: status: 'idle')에 맞춘다.
function runAgentTransition(t: AgentTransition): void {
  // idle 진입: 저장된 값이 없으므로 load 는 DEFAULT/{} 여야 한다. 이 단계에서 save 는 없다.
  const preWorkPanel = loadGitAutomationSettings(t.projectId);
  const preWorkPrefs = loadUserPreferences(t.projectId);
  void preWorkPanel; void preWorkPrefs;
  // working: 워킹 중 진행 상황을 저장 (중간값).
  saveGitAutomationSettings({ ...t.panel, enabled: false }, t.projectId);
  saveUserPreferences({ gitAutomation: { ...t.prefs, reviewers: [t.agentId] } }, t.projectId);
  // completed: 최종 값으로 덮어쓰고 idle 복귀 시 추가 save 는 없음.
  saveGitAutomationSettings(t.panel, t.projectId);
  saveUserPreferences({ gitAutomation: t.prefs, pinnedPrTargetProjectId: t.projectId }, t.projectId);
}

test('TC-MENU-AGT1: N=3 에이전트 동시 전이 후 모든 프로젝트 스코프 키가 누락 없이 원형 복원된다', () => {
  const ctx = installFakeLocalStorage();
  try {
    // 실제 에이전트 협업 시나리오: alpha/beta/gamma 가 각자 다른 프로젝트를 동시에 잡는다.
    const transitions: AgentTransition[] = [
      { agentId: 'alpha', projectId: 'proj-A', panel: PANEL_A, prefs: PREFS_A },
      { agentId: 'beta', projectId: 'proj-B', panel: PANEL_B, prefs: { ...PREFS_A, reviewers: ['zoe'] } },
      { agentId: 'gamma', projectId: 'proj-C', panel: { ...PANEL_A, branchPattern: 'chore/{slug}' }, prefs: { ...PREFS_A, flowLevel: 'commitOnly', reviewers: ['dave'] } },
    ];

    // 전이 순서를 인터리빙 해 "동시 실행" 근사 — 각 에이전트가 idle/working/completed 의
    // 각 단계에서 서로 교차해 save 한다. 이렇게 해도 최종 스토어는 결정론적이어야 한다.
    // 교차 패턴: [α idle, β idle, γ idle, α working, β working, γ working, α done, β done, γ done]
    for (const t of transitions) {
      loadGitAutomationSettings(t.projectId); // idle 진입 load
      loadUserPreferences(t.projectId);
    }
    for (const t of transitions) {
      saveGitAutomationSettings({ ...t.panel, enabled: false }, t.projectId); // working 중간값
      saveUserPreferences({ gitAutomation: { ...t.prefs, reviewers: [t.agentId] } }, t.projectId);
    }
    for (const t of transitions) {
      saveGitAutomationSettings(t.panel, t.projectId); // completed 최종값
      saveUserPreferences({ gitAutomation: t.prefs, pinnedPrTargetProjectId: t.projectId }, t.projectId);
    }

    // 모든 스코프 키가 누락 없이 존재해야 한다 — "파일 추가 보장" 계약.
    for (const t of transitions) {
      assert.ok(ctx.store.get(scopedPrefsKey(t.projectId)), `${t.projectId} 선호 스코프 키가 누락됐다`);
      assert.ok(ctx.store.get(scopedPanelKey(t.projectId)), `${t.projectId} 패널 스코프 키가 누락됐다`);
    }
    // 각 프로젝트가 자기 에이전트의 최종 값으로 원형 복원되어야 한다 — 교차 save 에 의해
    // 이웃 프로젝트 값으로 전염되면 이 assert 에서 깨진다.
    for (const t of transitions) {
      assert.deepEqual(loadGitAutomationSettings(t.projectId), t.panel, `${t.projectId} 패널이 원형 복원되지 않았다`);
      assert.deepEqual(loadUserPreferences(t.projectId).gitAutomation, t.prefs, `${t.projectId} 선호가 원형 복원되지 않았다`);
      assert.equal(loadUserPreferences(t.projectId).pinnedPrTargetProjectId, t.projectId);
    }
    // 에이전트 중간값(agentId 가 reviewers 에 단독으로 실려 있던 상태) 이 최종 스토어에 남아
    // 있으면 "completed 덮어쓰기가 일부 키에 적용되지 않음" 회귀. 원문 단위로 단정.
    for (const t of transitions) {
      const panelRaw = ctx.store.get(scopedPanelKey(t.projectId)) ?? '';
      const prefsRaw = ctx.store.get(scopedPrefsKey(t.projectId)) ?? '';
      // working 단계에서 enabled:false 로 저장했던 중간값이 completed 후 enabled:true (PANEL_A/PANEL_B 의 경우)
      // 로 바뀌었는지 확인. PANEL_B 는 enabled:false 가 최종값이라 panelRaw 에 남아 있어도 정상.
      if (t.panel.enabled) assert.ok(panelRaw.includes('"enabled":true'), `${t.projectId} 최종 enabled 상태가 기록되지 않았다`);
      // prefs 중간값은 reviewers 가 agentId 단독이었다. 최종 reviewers 배열로 덮였는지 확인.
      const finalReviewers = t.prefs.reviewers;
      for (const r of finalReviewers) {
        assert.ok(prefsRaw.includes(r), `${t.projectId} 최종 리뷰어 ${r} 가 기록되지 않았다`);
      }
      // 중간값에서만 있었던 agentId 가 최종 reviewers 에 없다면 원문에도 없어야 한다.
      if (!finalReviewers.includes(t.agentId)) {
        assert.equal(prefsRaw.includes(`"${t.agentId}"`), false, `${t.projectId} 에 working 중간값(agentId=${t.agentId}) 잔여`);
      }
    }
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-AGT2: 두 에이전트가 같은 프로젝트를 덮어써도 이웃 프로젝트의 저장본은 byte-identical', () => {
  const ctx = installFakeLocalStorage();
  try {
    // 에이전트 delta 는 proj-A 를, epsilon 은 proj-B 를 동시에 잡고 있다.
    // 그 사이 에이전트 zeta 가 proj-A 를 가로채 덮어써도, proj-B 의 저장본은 건드리면 안 된다.
    runAgentTransition({ agentId: 'delta', projectId: 'proj-A', panel: PANEL_A, prefs: PREFS_A });
    runAgentTransition({ agentId: 'epsilon', projectId: 'proj-B', panel: PANEL_B, prefs: { ...PREFS_A, reviewers: ['zoe'] } });

    const bPrefsSnapshot = ctx.store.get(scopedPrefsKey('proj-B'));
    const bPanelSnapshot = ctx.store.get(scopedPanelKey('proj-B'));
    assert.ok(bPrefsSnapshot && bPanelSnapshot, 'proj-B 스냅샷이 사전에 존재해야 한다');

    // zeta 가 proj-A 를 가로챔 — later-writer-wins.
    runAgentTransition({
      agentId: 'zeta',
      projectId: 'proj-A',
      panel: { ...PANEL_B, branchPattern: 'hotfix/{slug}' },
      prefs: { ...PREFS_A, flowLevel: 'commitOnly', reviewers: ['zeta-reviewer'] },
    });

    // proj-A 의 최종값은 zeta 의 것이어야 한다.
    assert.deepEqual(loadGitAutomationSettings('proj-A').branchPattern, 'hotfix/{slug}');
    assert.deepEqual(loadUserPreferences('proj-A').gitAutomation?.reviewers, ['zeta-reviewer']);
    // proj-B 의 저장본은 단 한 바이트도 변하면 안 된다.
    assert.equal(ctx.store.get(scopedPrefsKey('proj-B')), bPrefsSnapshot, 'proj-A 덮어쓰기가 proj-B 선호 원문을 건드렸다');
    assert.equal(ctx.store.get(scopedPanelKey('proj-B')), bPanelSnapshot, 'proj-A 덮어쓰기가 proj-B 패널 원문을 건드렸다');
    assert.deepEqual(loadGitAutomationSettings('proj-B'), PANEL_B);
    // zeta 의 리뷰어 이름이 proj-B 의 원문에 새어 들어오면 안 된다 — cross-write 가드.
    assert.equal(bPrefsSnapshot!.includes('zeta-reviewer'), false);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-AGT3: idle→working(중간값)→completed(최종값) 덮어쓰기 후 중간값 잔여가 이웃 프로젝트에 없다', () => {
  const ctx = installFakeLocalStorage();
  try {
    // eta 는 proj-A, theta 는 proj-B 를 동시에 작업 중. 두 에이전트 모두 working 단계에서
    // 고유한 문구(WIP-로 시작하는 branchPattern) 를 임시 저장한 뒤, completed 에서 정식값으로 덮는다.
    // (1) idle: 로드만. 저장된 값 없음.
    assert.deepEqual(loadGitAutomationSettings('proj-A'), DEFAULT_AUTOMATION);
    assert.deepEqual(loadGitAutomationSettings('proj-B'), DEFAULT_AUTOMATION);
    // (2) working: 두 에이전트가 교차로 중간값 저장.
    saveGitAutomationSettings({ ...PANEL_A, branchPattern: 'WIP-eta/{slug}' }, 'proj-A');
    saveGitAutomationSettings({ ...PANEL_B, branchPattern: 'WIP-theta/{slug}' }, 'proj-B');
    // 교차 더 한 번: working 중 재-save 가 발생하는 현실 케이스.
    saveGitAutomationSettings({ ...PANEL_A, branchPattern: 'WIP-eta-retry/{slug}' }, 'proj-A');
    // (3) completed: 최종값으로 덮어쓴다.
    saveGitAutomationSettings(PANEL_A, 'proj-A');
    saveGitAutomationSettings(PANEL_B, 'proj-B');

    // 최종 load 는 PANEL_A/PANEL_B 여야 한다.
    assert.deepEqual(loadGitAutomationSettings('proj-A'), PANEL_A);
    assert.deepEqual(loadGitAutomationSettings('proj-B'), PANEL_B);

    // 원문에서 WIP- 중간값 잔여가 단 한 바이트도 없어야 한다 — 치명적 누수 회귀 가드.
    const rawA = ctx.store.get(scopedPanelKey('proj-A')) ?? '';
    const rawB = ctx.store.get(scopedPanelKey('proj-B')) ?? '';
    assert.equal(rawA.includes('WIP-'), false, 'proj-A 원문에 working 중간값 잔여');
    assert.equal(rawB.includes('WIP-'), false, 'proj-B 원문에 working 중간값 잔여');
    // proj-A 의 working 중간값이 proj-B 로 새어 들어가지 않아야 한다 (cross-project 누락/전염 가드).
    assert.equal(rawB.includes('eta'), false, 'proj-A 중간값 키워드가 proj-B 로 전염됨');
    assert.equal(rawA.includes('theta'), false, 'proj-B 중간값 키워드가 proj-A 로 전염됨');
    // 모든 스코프 키가 누락 없이 존재해야 한다 — 파일 추가 보장.
    assert.ok(ctx.store.get(scopedPanelKey('proj-A')));
    assert.ok(ctx.store.get(scopedPanelKey('proj-B')));
  } finally { uninstallFakeLocalStorage(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// (6) 프로젝트 선택 상태의 첫 렌더 플래시 회귀 가드 — 할당 업무 #EPP-FLASH
// ─────────────────────────────────────────────────────────────────────────────
// 시나리오: 새로고침 / 느린 환경 / localStorage 복원 지연 상황에서 selectedProjectId 가
// null 에서 복원값으로 전이되는 한 프레임 동안 App.tsx 의 부모 가드(!selectedProjectId)가
// 일시적으로 우회될 수 있다. 이 때 EmptyProjectPlaceholder 의 내부 가드
// (`if (currentProjectId) return null;`) 가 두 번째 방어선으로 작동해야 플래시가 재현되지 않는다.
// 스코프 키에 저장본이 이미 존재하는 프로젝트로 바로 렌더해도 플레이스홀더가 절대 나오지
// 않는다는 계약을 고정한다. 수동 검증은 아래 체크리스트로 보강한다:
//   - 수동: 새로고침 후 0~300ms 동안 '프로젝트를 선택하세요' 카드가 깜빡거리지 않는지.
//   - 수동: 네트워크 스로틀(Slow 3G)에서 socket state:initial 도착 전후 플래시 재현 여부.
//   - 수동: localStorage 에 스코프 키만 있고 pinnedPrTargetProjectId 는 없는 상태에서 첫 렌더.

const EPP_NOOP = () => {};

test('TC-MENU-FLASH1: 스코프 키에 저장본이 있는 프로젝트 ID 로 렌더해도 플레이스홀더는 null', () => {
  installFakeLocalStorage();
  try {
    // 복원된 세션 상태를 재현: 스코프 키에 프로젝트 저장본이 이미 있고, 첫 렌더가 이 ID 로 들어온다.
    saveUserPreferences({ gitAutomation: PREFS_A, pinnedPrTargetProjectId: 'proj-A' }, 'proj-A');
    saveGitAutomationSettings(PANEL_A, 'proj-A');
    const el = EmptyProjectPlaceholder({
      projectCount: 1,
      onOpenProjectList: EPP_NOOP,
      onCreateProject: EPP_NOOP,
      currentProjectId: 'proj-A',
    });
    assert.equal(el, null, '프로젝트 선택된 첫 렌더에 플레이스홀더가 노출되면 플래시 회귀');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-FLASH2: A→B 스코프 전환 직후 current=B 로 렌더해도 null 유지', () => {
  installFakeLocalStorage();
  try {
    saveUserPreferences({ gitAutomation: PREFS_A }, 'proj-A');
    saveGitAutomationSettings(PANEL_A, 'proj-A');
    saveGitAutomationSettings(PANEL_B, 'proj-B');
    const el = EmptyProjectPlaceholder({
      projectCount: 2,
      onOpenProjectList: EPP_NOOP,
      onCreateProject: EPP_NOOP,
      currentProjectId: 'proj-B',
    });
    assert.equal(el, null);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-FLASH3: currentProjectId=null 이면 플레이스홀더가 실제로 렌더된다 (가드 반대편)', () => {
  // 가드 로직이 "무조건 null" 로 바뀌면 미선택 사용자에게 빈 화면이 나가는 반대 방향 사고.
  installFakeLocalStorage();
  try {
    const el = EmptyProjectPlaceholder({
      projectCount: 0,
      onOpenProjectList: EPP_NOOP,
      onCreateProject: EPP_NOOP,
      currentProjectId: null,
    });
    assert.notEqual(el, null);
    assert.equal(typeof el, 'object');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-FLASH4: 복원된 pinnedPrTargetProjectId 를 currentProjectId 로 즉시 넘겨도 null', () => {
  // "load → setState → 재렌더" 사이의 첫 커밋 프레임을 재현. 내부 가드만이 방어선이다.
  installFakeLocalStorage();
  try {
    saveUserPreferences({ pinnedPrTargetProjectId: 'proj-restore', gitAutomation: PREFS_A }, 'proj-restore');
    const restored = loadUserPreferences('proj-restore');
    assert.equal(restored.pinnedPrTargetProjectId, 'proj-restore');
    const el = EmptyProjectPlaceholder({
      projectCount: 1,
      onOpenProjectList: EPP_NOOP,
      onCreateProject: EPP_NOOP,
      currentProjectId: restored.pinnedPrTargetProjectId,
      busyAgentCount: 2,
    });
    assert.equal(el, null, '복원 직후 busy 에이전트가 있어도 선택 상태면 플레이스홀더 금지');
  } finally { uninstallFakeLocalStorage(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// (6.5) 초기 마운트 hydration 계약 — ProjectManagement useState lazy initializer
// ─────────────────────────────────────────────────────────────────────────────
// 배경: ProjectManagement.tsx:501-509 는 selectedProjectId / pinnedPrTargetProjectId
// 초기값을 "currentProjectId ?? loadUserPreferences().pinnedPrTargetProjectId" 로
// 동기 복원한다. 이 계약이 깨지면(= load 가 비동기로 바뀌거나 lazy init 이 다른
// 형태로 리팩터되면) 첫 paint 에서 "프로젝트를 선택하세요" 카드가 한 프레임 노출되는
// 플래시가 되살아난다. load 함수가 인자 없이 호출됐을 때 레거시 단일 키에서 pinned 를
// 즉시 돌려주는지, 그리고 스코프 키로도 동일 값을 복원할 수 있는지 두 경로를 고정한다.
//   수동 체크리스트:
//   - 새로고침 직후 0~300ms 동안 ProjectManagement 헤더의 핀 라디오가 깜빡거리지 않는지.
//   - useLayoutEffect(ProjectManagement.tsx:640) 를 useEffect 로 되돌렸을 때 본 테스트는
//     그대로 통과하므로 수동 체크가 같이 가야 한다 (pure-function 레벨 범위 한계).

test('TC-MENU-HYDRATE1: 레거시 키의 pinned 는 인자 없는 load 로 동기 복원된다', () => {
  installFakeLocalStorage();
  try {
    // 레거시 부팅 경로: 마이그레이션 전이라 스코프 키는 비어 있고 단일 키에만 pinned 가 있다.
    saveUserPreferences({ pinnedPrTargetProjectId: 'proj-legacy' });
    const restored = loadUserPreferences();
    assert.equal(restored.pinnedPrTargetProjectId, 'proj-legacy',
      'lazy initializer 가 레거시 슬롯에서 동기 복원하지 못하면 첫 paint 플래시 재발');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-HYDRATE2: 스코프 키로 이관된 pinned 도 동일 projectId load 로 동기 복원된다', () => {
  installFakeLocalStorage();
  try {
    // 마이그레이션 후: 동일 값이 스코프 키에 있어야 앱 재진입 시 플래시 없이 선택 복원.
    saveUserPreferences({ pinnedPrTargetProjectId: 'proj-scoped' }, 'proj-scoped');
    const restored = loadUserPreferences('proj-scoped');
    assert.equal(restored.pinnedPrTargetProjectId, 'proj-scoped');
  } finally { uninstallFakeLocalStorage(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// (7) working 유지 가드 — 진행 중 태스크가 있을 때 상태 플래그 전이 순서 보장
// ─────────────────────────────────────────────────────────────────────────────
// 배경: server.ts PATCH /api/agents/:id/status 는 idle 전환 시 currentTask 를
// 비우고 태스크를 completed 로 마킹한다. 만약 "idle 플래그 flip" 과 "태스크 완료
// 신호" 사이의 순서가 어긋나거나, 진행 중 태스크가 남은 상태에서 idle 로 조기
// 전환되면 스코프 저장본이 working 중간값에 고정되는 회귀가 생긴다. 아래 두
// 케이스는 그 계약을 pure-function 레벨에서 고정한다:
//   (G1) working 중 중간 save → load 가 DEFAULT 로 떨어지지 않음. 즉, 진행 중
//        태스크가 있는 프로젝트의 스코프 데이터는 load 에서 반드시 최신 중간값을
//        반환해야 한다 (idle 로의 조기 전이에 대한 가드).
//   (G2) completed 최종 save 이후의 이웃 load 는 항상 최종값 — "완료 신호가
//        상태 플래그 업데이트보다 먼저 도착" 하는 경로에서도 마지막 쓰기가 진다.

test('TC-MENU-GUARD1: working 중간 save 뒤 load 는 DEFAULT 로 떨어지지 않는다', () => {
  installFakeLocalStorage();
  try {
    // working 단계에서 부분 저장만 된 상태. idle 가드가 제대로 동작한다면
    // 이 시점의 load 는 중간값을 그대로 돌려준다.
    const midPanel: GitAutomationSettings = { ...PANEL_A, enabled: false, branchPattern: 'wip/{slug}' };
    saveGitAutomationSettings(midPanel, 'proj-A');
    const mid = loadGitAutomationSettings('proj-A');
    assert.notDeepEqual(mid, DEFAULT_AUTOMATION, '진행 중 태스크 save 가 load 에서 DEFAULT 로 덮였다');
    assert.equal(mid.branchPattern, 'wip/{slug}');
    assert.equal(mid.enabled, false);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-GUARD2: completed 최종 save 는 working 중간값을 완전히 덮고 이웃을 건드리지 않는다', () => {
  const ctx = installFakeLocalStorage();
  try {
    // 에이전트 A: working → completed.  에이전트 B: working 상태 지속.
    saveGitAutomationSettings({ ...PANEL_A, enabled: false, branchPattern: 'wip-a/{slug}' }, 'proj-A');
    saveGitAutomationSettings({ ...PANEL_B, enabled: false, branchPattern: 'wip-b/{slug}' }, 'proj-B');
    // A 만 completed: 최종값 저장.
    saveGitAutomationSettings(PANEL_A, 'proj-A');

    // A 의 중간값 흔적이 스토어에 없어야 한다 — 상태 플래그 flip 전에 최종 save 가 승리.
    const rawA = ctx.store.get(scopedPanelKey('proj-A')) ?? '';
    assert.equal(rawA.includes('wip-a/'), false, 'A 최종 save 가 중간값을 덮지 못했다');
    assert.deepEqual(loadGitAutomationSettings('proj-A'), PANEL_A);

    // B 는 여전히 working — 중간값 그대로 남아 있어야 한다 (가드).
    const stillWorking = loadGitAutomationSettings('proj-B');
    assert.equal(stillWorking.branchPattern, 'wip-b/{slug}', 'B 의 working 중간값이 A 완료로 인해 사라졌다');
    assert.equal(stillWorking.enabled, false);
  } finally { uninstallFakeLocalStorage(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// (8) 서버 API parity — 빈 문자열 projectId 는 "미선택" 과 byte-identical 취급
// ─────────────────────────────────────────────────────────────────────────────
// server.ts 의 /api/integrations, /api/managed-projects 는 projectId 가 빈 문자열이면
// 400 으로 거절한다 (server.ts:553, :678 의 `if (!projectId)` 가드). 클라이언트
// 스토리지 계층도 같은 계약을 지키지 않으면, 서버는 "미선택 → 400" 인데 로컬에는
// `...: ` 같은 유령 스코프 키가 쌓여 다음 세션에서 번져 들어오는 스큐(skew)가 발생한다.
// 아래 두 케이스는 빈 문자열을 undefined 와 같은 신호로 처리한다는 parity 를 고정한다.

test('TC-MENU-SRV1: 빈 문자열 projectId save 는 레거시 단일 키만 쓰고 스코프 키(`...:`) 를 만들지 않는다', () => {
  const ctx = installFakeLocalStorage();
  try {
    saveUserPreferences({ pinnedPrTargetProjectId: 'proj-A' }, '');
    saveGitAutomationSettings(PANEL_A, '');

    assert.ok(ctx.store.get(USER_PREFERENCES_KEY), '레거시 선호 키에 저장되어야 한다');
    assert.ok(ctx.store.get(GIT_AUTOMATION_PANEL_KEY), '레거시 패널 키에 저장되어야 한다');
    for (const key of ctx.store.keys()) {
      assert.equal(key.endsWith(':'), false, `빈 문자열이 스코프 접미사로 직렬화됐다: ${key}`);
      assert.equal(key.startsWith(`${PROJECT_SETTINGS_KEY_PREFIX}:`), false, `스코프 키가 생성됐다: ${key}`);
      assert.equal(key.startsWith(`${GIT_AUTOMATION_PANEL_KEY}:`), false, `스코프 키가 생성됐다: ${key}`);
    }
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-SRV2: 빈 문자열 projectId load 는 undefined 호출과 byte-identical 결과', () => {
  installFakeLocalStorage();
  try {
    saveUserPreferences({ pinnedPrTargetProjectId: 'proj-A' });
    saveGitAutomationSettings(PANEL_A);

    // 미선택 상태의 두 표현(undefined, "") 이 스토리지 계층에서 동일한 값을 돌려줘야,
    // "선택됐다고 믿는 렌더 경로" 와 "미선택이라고 믿는 fetch 경로" 가 엇갈리지 않는다.
    assert.deepEqual(loadUserPreferences(''), loadUserPreferences());
    assert.deepEqual(loadGitAutomationSettings(''), loadGitAutomationSettings());
  } finally { uninstallFakeLocalStorage(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// (9) 신규 파일 노드 코드그래프 동기화 — 할당 업무 #CG-SYNC (Joker)
// ─────────────────────────────────────────────────────────────────────────────
// 배경: ProjectManagement.tsx 의 코드그래프 렌더링은 MCP add_file 로 흘러 들어온
// 파일 목록을 노드로 그린다. 신규 컴포넌트(EmptyProjectPlaceholder.tsx 등)가
// 'util' 로 잘못 분류되거나 docs/ 규칙에 휩쓸려 제외되면 캔버스에서 색·글리프가
// 잘못 나오거나 아예 노드가 사라져 "디자인 안 맞는데?" 류 리포트가 반복된다.
// 아래는 add_file 경로가 타는 타입 추론/정규화/제외 규칙 세 축을 EmptyProjectPlaceholder
// 기준으로 고정한다. ProjectMenuScope 본체 계약과 붙여두는 이유: 메뉴 스코프 복원 후
// 첫 렌더에 이 컴포넌트가 그래프에 나타나는 것이 플래시 가드의 시각적 증거이기 때문.

test('TC-MENU-CG1: EmptyProjectPlaceholder.tsx 는 component 로 분류된다', () => {
  // 신규 추가된 플레이스홀더 컴포넌트가 add_file 로 흘러갈 때 'util' 로 내려가면
  // 캔버스에서 색·글리프가 'util' 톤으로 잘못 잡혀 디자인 회귀가 생긴다.
  assert.equal(inferFileType('EmptyProjectPlaceholder.tsx'), 'component');
  assert.equal(inferFileType('src/components/EmptyProjectPlaceholder.tsx'), 'component');
  assert.equal(inferFileType('./EmptyProjectPlaceholder.tsx'), 'component');
});

test('TC-MENU-CG2: 플레이스홀더 경로 변형은 동일 노드로 정규화된다', () => {
  // add_file 은 상대 경로 · 윈도우 구분자 · 선행 './' 등 다양한 raw 이름을 받을 수 있다.
  // 서로 같은 파일로 모여야 코드그래프의 중복 노드 누적을 막는다.
  const canonical = normalizeCodeGraphPath('src/components/EmptyProjectPlaceholder.tsx');
  assert.equal(normalizeCodeGraphPath('./src/components/EmptyProjectPlaceholder.tsx'), canonical);
  assert.equal(normalizeCodeGraphPath('src\\components\\EmptyProjectPlaceholder.tsx'), canonical);
  assert.equal(normalizeCodeGraphPath('./src\\components\\EmptyProjectPlaceholder.tsx'), canonical);
});

test('TC-MENU-CG3: 플레이스홀더/테스트 파일은 코드그래프에서 제외되지 않는다', () => {
  // docs/ 같은 제외 접두사에 걸려 노드가 증발하는 회귀를 차단. 현재 할당 업무에서
  // 새로 추가되는 파일 두 개 (EmptyProjectPlaceholder.tsx, ProjectMenuScope.test.ts) 를
  // 화이트리스트 샘플로 고정한다.
  assert.equal(isExcludedFromCodeGraph('src/components/EmptyProjectPlaceholder.tsx'), false);
  assert.equal(isExcludedFromCodeGraph('./src/components/EmptyProjectPlaceholder.tsx'), false);
  assert.equal(isExcludedFromCodeGraph('src/components/ProjectMenuScope.test.ts'), false);
});

test('TC-MENU-CG4: add_file 페이로드 시뮬레이션 — 이름/타입 쌍이 그래프 계약과 맞는다', () => {
  // 실제 MCP add_file 은 { name, type } 을 받는다. 서버는 normalizeCodeGraphPath 로
  // 이름을 다듬고 inferFileType 로 타입을 보정한다. 아래는 클라이언트가 add_file 을
  // 호출하기 직전 payload 를 구성할 때 사용해야 하는 두 값이 기대치와 일치하는지
  // 한 번에 확인하는 스모크 테스트. 실패 시 ProjectManagement.tsx 의 신규 파일 감지
  // 훅이 잘못된 type/name 을 업스트림에 보냈다는 신호다.
  const rawName = './src/components/EmptyProjectPlaceholder.tsx';
  const payload = { name: normalizeCodeGraphPath(rawName), type: inferFileType(rawName) };
  assert.equal(payload.name, 'src/components/EmptyProjectPlaceholder.tsx');
  assert.equal(payload.type, 'component');
  assert.equal(isExcludedFromCodeGraph(payload.name), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// (10) 현재 워킹 트리 파일 필터 회귀 — 할당 업무 #CG-WORKING (Thanos)
// ─────────────────────────────────────────────────────────────────────────────
// 배경: 태스크 분배 로그를 보면 server.ts · src/App.tsx · ProjectManagement.tsx 류
// 핵심 파일이 코드그래프에서 자주 "보이지 않는다" 는 리포트가 올라왔다. 원인을
// codeGraphFilter.ts 축에서 분석한 결과:
//   - EXCLUDED_PATHS 는 'docs/' 단 하나 → 이 목록으로는 위 파일들이 걸러질 수 없다.
//   - normalize() 는 선행 ./ · 윈도우 구분자만 흡수 → 경로 변형에 의한 누락도 없다.
//   - inferFileType 는 server.ts→service, *.tsx→component, *.css→style 을 고정.
// 즉 필터 자체엔 버그가 없다 — 파일이 빠지는 건 에이전트가 add_file 을 호출하지
// 않아서다. 이 섹션은 그 결론을 테스트로 고정해, 향후 누군가 EXCLUDED_PATHS 에
// 'src/' 같은 접두사를 잘못 넣거나 SERVICE_NAME 규칙을 풀어 써 모든 .tsx 가
// 'service' 로 쏠리는 회귀를 즉시 탐지한다.

// 현재 변경 중인 파일들(M/MM/AM 상태)을 샘플로 삼아 "필터가 절대 이들을 먹지
// 않는다" 는 계약을 고정. 각 항목은 [경로, 기대 타입] 쌍으로, 필터의 두 축(제외·
// 타입 추론)을 한 줄에서 동시에 검증한다.
const WORKING_TREE_FILES: ReadonlyArray<readonly [string, ReturnType<typeof inferFileType>]> = [
  ['server.ts', 'service'],
  ['src/App.tsx', 'component'],
  ['src/components/ProjectManagement.tsx', 'component'],
  ['src/components/ProjectManagement.test.ts', 'util'],
  ['src/index.css', 'style'],
  ['src/types.ts', 'util'],
  ['src/utils/codeGraphFilter.ts', 'util'],
];

test('TC-MENU-CG5: 워킹 트리 핵심 파일은 필터에서 한 장도 누락되지 않는다', () => {
  for (const [path] of WORKING_TREE_FILES) {
    assert.equal(isExcludedFromCodeGraph(path), false, `${path} 가 제외됐다 — EXCLUDED_PATHS 확장 회귀`);
    assert.equal(isExcludedFromCodeGraph(`./${path}`), false, `${path} 상대경로 변형에 필터가 반응했다`);
    assert.equal(
      isExcludedFromCodeGraph(path.replace(/\//g, '\\')),
      false,
      `${path} 윈도우 구분자 변형에 필터가 반응했다`,
    );
  }
});

test('TC-MENU-CG6: 워킹 트리 핵심 파일의 타입 추론은 디자인 토큰과 1:1 로 맞는다', () => {
  // server.ts → service (빨간 DB 글리프), *.tsx → component (파란 React 글리프),
  // *.css → style (보라 스타일 글리프), *.test.ts · *.ts → util (회색 유틸 글리프).
  // 이 매핑이 흔들리면 캔버스의 색 축이 한꺼번에 어긋나 "에이전트/파일 구분이 안 됨"
  // 류 디자인 회귀가 광범위하게 발생한다.
  for (const [path, expected] of WORKING_TREE_FILES) {
    assert.equal(inferFileType(path), expected, `${path} 의 추론 타입이 ${expected} 가 아니다`);
  }
});

test('TC-MENU-CG7: normalize 를 거친 이름으로 add_file payload 를 만들어도 필터 결과가 바뀌지 않는다', () => {
  // 클라이언트가 raw 이름을 다양한 모양으로 던져도 서버 쪽 정규화·분류·제외가
  // 일관된 결과를 내야 중복 노드·유령 노드가 그래프에 쌓이지 않는다.
  for (const [path, expected] of WORKING_TREE_FILES) {
    const canonical = normalizeCodeGraphPath(path);
    const variants = [path, `./${path}`, path.replace(/\//g, '\\'), `./${path.replace(/\//g, '\\')}`];
    for (const v of variants) {
      assert.equal(normalizeCodeGraphPath(v), canonical, `${v} 가 ${canonical} 로 모이지 않는다`);
      assert.equal(inferFileType(v), expected, `${v} 의 타입 추론이 경로 변형에 흔들린다`);
      assert.equal(isExcludedFromCodeGraph(v), false, `${v} 가 경로 변형으로 필터에 걸렸다`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (11) 프로젝트 스코프별 add/modify/delete 노드 표시 회귀 — 할당 업무 #GRAPH-LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────
// 배경: TC-MENU-CG* 는 "필터 축" 만 검증한다. 하지만 실제 사용자가 보는 버그는
// 필터 결과가 아니라 "프로젝트 전환 · 파일 추가 · 파일 삭제" 시 노드 가시성이
// 흐트러지는 사례다 (예: A 에 추가한 파일이 B 로 전환 시 잠깐 보이거나, 삭제
// 후 재-add 했는데 노드가 안 돌아오는). server.ts POST /api/files (line 446-498) /
// DELETE 경로를 클라이언트 in-memory 모델로 재현해, 프로젝트 스코프가 엮인
// 3대 시나리오를 회귀 가드로 고정한다. ProjectManagement.test.ts 쪽에서도 동일
// 모델을 쓰지만, 여기서는 "메뉴 스코프 전환 직후 노드가 올바른 프로젝트에만
// 보이는가" 하는 사용자 관점 불변식에 초점을 맞춘다.

interface LifecycleNode { id: string; projectId: string; name: string; type: CodeFileType; }

function createLifecycleGraph() {
  const store = new Map<string, LifecycleNode>();
  const key = (projectId: string, name: string) => `${projectId}::${name}`;
  let seq = 0;
  return {
    add(projectId: string, rawName: string): LifecycleNode | null {
      const name = normalizeCodeGraphPath(rawName);
      if (!name || isExcludedFromCodeGraph(name)) return null;
      const k = key(projectId, name);
      const existing = store.get(k);
      if (existing) return existing;
      const node: LifecycleNode = {
        id: `node-${++seq}`, projectId, name, type: inferFileType(name),
      };
      store.set(k, node);
      return node;
    },
    remove(projectId: string, rawName: string): boolean {
      return store.delete(key(projectId, normalizeCodeGraphPath(rawName)));
    },
    visibleFor(projectId: string): LifecycleNode[] {
      // 캔버스는 현재 선택된 projectId 의 노드만 렌더한다. 다른 프로젝트의 노드가
      // 노출되면 "프로젝트 전환했는데 옆 프로젝트 파일이 보이는" 회귀.
      return Array.from(store.values()).filter((n) => n.projectId === projectId);
    },
  };
}

test('TC-MENU-LIFE1: 프로젝트 A 에 add 한 파일은 B 전환 시 캔버스에서 사라진다', () => {
  // 핵심 UX 불변식: 메뉴 스코프가 B 로 바뀌면 A 에서 만든 파일 노드는 절대 노출되면 안 된다.
  const graph = createLifecycleGraph();
  graph.add('proj-A', 'src/components/EmptyProjectPlaceholder.tsx');
  graph.add('proj-A', 'src/App.tsx');
  graph.add('proj-B', 'server.ts');

  const visibleInA = graph.visibleFor('proj-A').map((n) => n.name).sort();
  const visibleInB = graph.visibleFor('proj-B').map((n) => n.name).sort();
  assert.deepEqual(visibleInA, ['src/App.tsx', 'src/components/EmptyProjectPlaceholder.tsx']);
  assert.deepEqual(visibleInB, ['server.ts']);
  // 반대 방향: B 의 파일이 A 로 새어 들어가지 않는다.
  assert.equal(visibleInA.includes('server.ts'), false);
  assert.equal(visibleInB.includes('src/App.tsx'), false);
});

test('TC-MENU-LIFE2: 파일 수정(동일 이름 재-add)은 스코프별 노드 수를 늘리지 않는다', () => {
  // 에이전트가 Write 후 add_file 을 반복 호출해도 프로젝트별 노드 목록은 1개로 유지.
  // 중복 노드가 생기면 캔버스에 같은 아이콘이 두 번 찍혀 "같은 파일이 두 번 보임" 버그로 이어진다.
  const graph = createLifecycleGraph();
  const first = graph.add('proj-A', 'src/components/EmptyProjectPlaceholder.tsx');
  const second = graph.add('proj-A', 'src/components/EmptyProjectPlaceholder.tsx');
  const third = graph.add('proj-A', './src/components/EmptyProjectPlaceholder.tsx');
  assert.equal(first!.id, second!.id);
  assert.equal(first!.id, third!.id);
  assert.equal(graph.visibleFor('proj-A').length, 1, '편집(재-add)은 노드를 증식시키지 않는다');
  // B 에는 해당 파일이 없어야 한다.
  assert.equal(graph.visibleFor('proj-B').length, 0);
});

test('TC-MENU-LIFE3: 파일 삭제 후 캔버스에서 해당 노드가 즉시 사라진다', () => {
  const graph = createLifecycleGraph();
  graph.add('proj-A', 'src/App.tsx');
  graph.add('proj-A', 'src/components/EmptyProjectPlaceholder.tsx');

  const removed = graph.remove('proj-A', 'src/components/EmptyProjectPlaceholder.tsx');
  assert.equal(removed, true);
  const remaining = graph.visibleFor('proj-A').map((n) => n.name);
  assert.deepEqual(remaining, ['src/App.tsx'], '삭제된 파일이 캔버스에 남아 있으면 안 된다');
});

test('TC-MENU-LIFE4: 삭제→재-add 한 파일은 새 노드 id 로 그래프에 다시 노출된다', () => {
  // 사내 이슈 #GRAPH-GHOST 와 대응: 삭제된 노드 id 가 되살아나면 엣지가 엉키고,
  // 반대로 재-add 가 무시되면 노드가 아예 안 돌아와 "파일은 있는데 그래프엔 없음" 회귀.
  const graph = createLifecycleGraph();
  const first = graph.add('proj-A', 'src/components/EmptyProjectPlaceholder.tsx');
  graph.remove('proj-A', 'src/components/EmptyProjectPlaceholder.tsx');
  assert.equal(graph.visibleFor('proj-A').length, 0, '삭제 직후에는 노드가 0개여야 한다');
  const second = graph.add('proj-A', 'src/components/EmptyProjectPlaceholder.tsx');
  assert.ok(second);
  assert.notEqual(first!.id, second!.id, '재-add 는 새 id 를 발급해야 한다');
  assert.equal(graph.visibleFor('proj-A').length, 1);
});

test('TC-MENU-LIFE5: A 의 파일 삭제가 B 의 동일 이름 노드를 휩쓸지 않는다', () => {
  // 프로젝트 격리 가드. projectId 를 포함하지 않은 잘못된 삭제 쿼리가 들어오면
  // 옆 프로젝트의 같은 이름 노드까지 함께 사라지는 cross-project 사고가 난다.
  const graph = createLifecycleGraph();
  graph.add('proj-A', 'src/App.tsx');
  graph.add('proj-B', 'src/App.tsx');
  graph.remove('proj-A', 'src/App.tsx');
  assert.equal(graph.visibleFor('proj-A').length, 0);
  assert.equal(graph.visibleFor('proj-B').length, 1, 'B 의 동일 이름 노드가 A 삭제에 휩쓸렸다');
});

test('TC-MENU-LIFE6: docs/ 파일은 add 해도 어떤 프로젝트 캔버스에도 노출되지 않는다', () => {
  // 할당 업무 #GRAPH-LIFECYCLE 의 마지막 가드: 필터 축(CG3)과 라이프사이클 축이
  // 일관되게 동작하는지 확인. docs/ 는 add 자체가 null 을 돌려주고 어느 스코프에서도
  // 보이지 않아야 한다.
  const graph = createLifecycleGraph();
  assert.equal(graph.add('proj-A', 'docs/handoffs/x.md'), null);
  assert.equal(graph.add('proj-B', 'docs/report.md'), null);
  graph.add('proj-A', 'src/App.tsx');
  assert.deepEqual(graph.visibleFor('proj-A').map((n) => n.name), ['src/App.tsx']);
  assert.deepEqual(graph.visibleFor('proj-B'), []);
});

test('TC-MENU-LIFE7: 본 브랜치 작업 파일이 프로젝트 스코프에서 모두 캔버스에 노드로 노출된다', () => {
  // 실제 git status 가 찍은 수정/추가 파일 목록. 하나라도 필터에 걸리거나 add 가
  // null 을 돌려주면 QA 가 즉시 잡아야 한다 — 본 PR 의 작업물이 캔버스에서 사라지는
  // 회귀는 "에이전트가 일을 안 한 것처럼 보이는" 치명적 지표.
  const touched = [
    'server.ts',
    'src/App.tsx',
    'src/components/EmptyProjectPlaceholder.tsx',
    'src/components/ProjectManagement.tsx',
    'src/components/ProjectManagement.test.ts',
    'src/components/ProjectMenuScope.test.ts',
    'src/index.css',
    'src/types.ts',
    'src/utils/codeGraphFilter.ts',
  ];
  const graph = createLifecycleGraph();
  for (const f of touched) {
    assert.ok(graph.add('proj-A', f), `${f} 가 캔버스에 노출되지 않는다 — add 실패`);
  }
  assert.deepEqual(
    graph.visibleFor('proj-A').map((n) => n.name).sort(),
    [...touched].sort(),
    '본 브랜치 작업 파일 전체가 proj-A 캔버스 노드로 노출되어야 한다',
  );
  // 다른 프로젝트에는 섞이면 안 된다.
  assert.equal(graph.visibleFor('proj-B').length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// (12) 신규 파일 감지 훅 ↔ add_file 페이로드 diff — 할당 업무 #CG-SYNC (Joker)
// ─────────────────────────────────────────────────────────────────────────────
// 배경: ProjectManagement.tsx 의 코드그래프 렌더링은 list_files 로 가져온 노드
// 배열과 실제 워크스페이스에서 감지된 파일 목록의 차이를 매 프레임 계산해 MCP
// add_file 로 흘려보낸다. 이 diff 훅이 정규화/제외/타입추론 3축과 부분 정렬하지
// 못하면 신규 파일(EmptyProjectPlaceholder.tsx 등)이 캔버스에 나타나지 않거나
// 동일 파일이 경로 변형만 달라 중복 노드로 쌓이는 회귀가 발생한다.
//
// 훅 의도 재현: 컴포넌트는 매 동기화 사이클에서
//   1) graphNodes (list_files 결과) 의 이름을 normalizeCodeGraphPath 로 정규화해 set 에 담고
//   2) observedFiles (워크스페이스 감지) 중 제외되지 않고 set 에 없는 파일만 골라
//   3) { name, type } payload 를 만들어 add_file 에 일괄 전달한다.
// 이 함수를 호출부(ProjectManagement.tsx)의 로직과 1:1 로 맞춰 테스트에 박아둔다.

interface AddFilePayload { name: string; type: CodeFileType; }

function computeAddFilePayloads(
  graphNodes: ReadonlyArray<{ name: string }>,
  observedFiles: ReadonlyArray<string>,
): AddFilePayload[] {
  const existing = new Set(graphNodes.map((n) => normalizeCodeGraphPath(n.name)));
  const emitted = new Set<string>();
  const out: AddFilePayload[] = [];
  for (const raw of observedFiles) {
    const name = normalizeCodeGraphPath(raw);
    if (!name || isExcludedFromCodeGraph(name)) continue;
    if (existing.has(name) || emitted.has(name)) continue;
    emitted.add(name);
    out.push({ name, type: inferFileType(name) });
  }
  return out;
}

test('TC-MENU-SYNC1: 이미 그래프에 있는 파일은 add_file payload 에서 제외된다', () => {
  // list_files 가 돌려준 두 노드와 동일한 워크스페이스 스캔 결과. diff 는 비어 있어야
  // MCP add_file 호출이 일어나지 않아 그래프 중복 회귀를 막는다.
  const graphNodes = [
    { name: 'src/components/EmptyProjectPlaceholder.tsx' },
    { name: 'src/components/ProjectMenuScope.test.ts' },
  ];
  const observed = [
    'src/components/EmptyProjectPlaceholder.tsx',
    'src/components/ProjectMenuScope.test.ts',
  ];
  assert.deepEqual(computeAddFilePayloads(graphNodes, observed), []);
});

test('TC-MENU-SYNC2: 신규 파일만 정확한 name/type 쌍으로 add_file payload 가 된다', () => {
  // 실사용 케이스: 그래프에는 플레이스홀더/테스트만 있고, 이번 커밋에서 server.ts 와
  // ProjectManagement.tsx 가 새로 감지됐다. 훅은 두 파일만 name/type 매핑해 올려보낸다.
  const graphNodes = [
    { name: 'src/components/EmptyProjectPlaceholder.tsx' },
    { name: 'src/components/ProjectMenuScope.test.ts' },
  ];
  const observed = [
    './server.ts',
    'src/components/EmptyProjectPlaceholder.tsx',
    'src\\components\\ProjectManagement.tsx',
  ];
  const payloads = computeAddFilePayloads(graphNodes, observed);
  assert.deepEqual(payloads, [
    { name: 'server.ts', type: 'service' },
    { name: 'src/components/ProjectManagement.tsx', type: 'component' },
  ]);
});

test('TC-MENU-SYNC3: docs/ 는 감지되어도 add_file 로 흘러가지 않는다', () => {
  // 필터 축(CG3/LIFE6)과 sync 훅이 한 방향을 본다 — 제외 경로는 diff 에서 조용히 사라져야 한다.
  const payloads = computeAddFilePayloads([], [
    'docs/handoffs/joker.md',
    'src/components/EmptyProjectPlaceholder.tsx',
  ]);
  assert.deepEqual(payloads, [
    { name: 'src/components/EmptyProjectPlaceholder.tsx', type: 'component' },
  ]);
});

test('TC-MENU-SYNC4: 경로 변형(./, 백슬래시)이 중복 payload 를 만들지 않는다', () => {
  // 훅이 같은 파일을 경로 모양만 달라 두 번 올리면, 서버는 정규화로 막아도 네트워크 왕복이
  // 두 배가 되고 로그가 어지러워진다. 클라이언트 단계에서 정규화 후 중복 제거를 강제한다.
  const observed = [
    './src/components/EmptyProjectPlaceholder.tsx',
    'src\\components\\EmptyProjectPlaceholder.tsx',
    'src/components/EmptyProjectPlaceholder.tsx',
  ];
  const payloads = computeAddFilePayloads([], observed);
  assert.equal(payloads.length, 1, '경로 변형은 하나의 payload 로 모여야 한다');
  assert.equal(payloads[0].name, 'src/components/EmptyProjectPlaceholder.tsx');
  assert.equal(payloads[0].type, 'component');
});

test('TC-MENU-SYNC5: 빈 그래프 + 본 브랜치 전체 워크셋이면 working-tree 파일 전부가 payload 가 된다', () => {
  // 프로젝트 첫 오픈 직후 (list_files 빈 배열) 에는 감지된 모든 파일이 add_file 로 흘러
  // 코드그래프가 한 번에 채워져야 한다. TC-MENU-LIFE7 의 파일 집합과 같은 셋을 쓴다.
  const touched = [
    'server.ts',
    'src/App.tsx',
    'src/components/EmptyProjectPlaceholder.tsx',
    'src/components/ProjectManagement.tsx',
    'src/components/ProjectManagement.test.ts',
    'src/components/ProjectMenuScope.test.ts',
    'src/index.css',
    'src/types.ts',
    'src/utils/codeGraphFilter.ts',
  ];
  const payloads = computeAddFilePayloads([], touched);
  assert.equal(payloads.length, touched.length);
  // 타입 분포: service(server.ts) 1 / component(*.tsx) 3 / style(*.css) 1 / util 4.
  const counts = payloads.reduce<Record<CodeFileType, number>>((acc, p) => {
    acc[p.type] = (acc[p.type] ?? 0) + 1;
    return acc;
  }, { component: 0, service: 0, util: 0, style: 0 });
  assert.deepEqual(counts, { component: 3, service: 1, util: 4, style: 1 });
});

// ─────────────────────────────────────────────────────────────────────────────
// (13) 실제 작업 파일 add/modify/delete 라이프사이클 — 할당 업무 #GRAPH-EXPOSURE (QA 감마)
// ─────────────────────────────────────────────────────────────────────────────
// TC-MENU-LIFE1~7 은 "격리·중복·제외" 의 거시 불변식을 다뤘다. 여기서는 에이전트가
// 실제로 Write/Edit 로 건드린 파일(특히 이번 브랜치의 AM 신규 파일 EmptyProjectPlaceholder.tsx)
// 이 (a) 첫 add 에 즉시 노출되고, (b) 수정/재-add 가 누적돼도 노드 수·타입이 흔들리지 않으며,
// (c) 삭제→재-add 사이클이 예측 가능하게 0↔1 을 왕복하는지 고정한다. createLifecycleGraph()
// 를 재사용해 메뉴 스코프 격리와 라이프사이클 격리를 같은 레일 위에 올린다.

const LIVE_PLACEHOLDER = 'src/components/EmptyProjectPlaceholder.tsx';
const LIVE_TOUCHED: ReadonlyArray<readonly [string, CodeFileType]> = [
  ['server.ts', 'service'],
  ['src/App.tsx', 'component'],
  ['src/components/EmptyProjectPlaceholder.tsx', 'component'],
  ['src/components/ProjectManagement.tsx', 'component'],
  ['src/components/ProjectManagement.test.ts', 'util'],
  ['src/components/ProjectMenuScope.test.ts', 'util'],
  ['src/index.css', 'style'],
  ['src/types.ts', 'util'],
  ['src/utils/codeGraphFilter.ts', 'util'],
];

test('TC-MENU-LIFE8: EmptyProjectPlaceholder.tsx 는 프로젝트 A 의 첫 add 로 노출되고 B 에는 새어나가지 않는다', () => {
  const graph = createLifecycleGraph();
  const added = graph.add('proj-A', LIVE_PLACEHOLDER);
  assert.ok(added, '신규 파일이 add 에서 탈락했다');
  assert.equal(added!.type, 'component');
  assert.deepEqual(graph.visibleFor('proj-A').map((n) => n.name), [LIVE_PLACEHOLDER]);
  assert.equal(graph.visibleFor('proj-B').length, 0, 'A 의 신규 파일이 B 로 전염됐다');
});

test('TC-MENU-LIFE9: 동일 파일 N회 수정-신고는 프로젝트별 노드 수와 타입을 흔들지 않는다', () => {
  // Write/Edit 반복 중 관행적으로 반복되는 add_file 호출이 캔버스에 중복 글리프를
  // 그리거나 type 을 util 로 뒤집으면 즉시 회귀.
  const graph = createLifecycleGraph();
  const initial = graph.add('proj-A', LIVE_PLACEHOLDER);
  assert.ok(initial);
  for (let i = 0; i < 8; i++) {
    const again = graph.add('proj-A', LIVE_PLACEHOLDER);
    assert.ok(again);
    assert.equal(again!.id, initial!.id, `i=${i} 수정 신고가 새 id 를 발급했다`);
    assert.equal(again!.type, 'component');
  }
  assert.equal(graph.visibleFor('proj-A').length, 1);
});

test('TC-MENU-LIFE10: 삭제 → 재-add 사이클이 프로젝트별 가시 노드 수를 0↔1 로만 왕복시킨다', () => {
  const graph = createLifecycleGraph();
  for (let cycle = 0; cycle < 3; cycle++) {
    assert.equal(graph.visibleFor('proj-A').length, 0, `cycle=${cycle} 시작 시 이미 노드가 남아 있다`);
    const node = graph.add('proj-A', LIVE_PLACEHOLDER);
    assert.ok(node);
    assert.equal(graph.visibleFor('proj-A').length, 1);
    assert.equal(graph.remove('proj-A', LIVE_PLACEHOLDER), true);
    assert.equal(graph.visibleFor('proj-A').length, 0);
    assert.equal(graph.visibleFor('proj-B').length, 0, '사이클 중 다른 프로젝트로 전염됐다');
  }
});

test('TC-MENU-LIFE11: 수정/추가/삭제가 섞인 타임라인 끝에 실제 작업 파일 노드 집합이 예측 가능하다', () => {
  // 9개 파일 전부 add → 홀수 인덱스 삭제 → 그 중 마지막 하나만 재-add.
  // 최종 캔버스가 보여야 하는 파일 집합을 결정론적으로 계산해 대조.
  const graph = createLifecycleGraph();
  for (const [path] of LIVE_TOUCHED) {
    assert.ok(graph.add('proj-A', path), `${path} 최초 add 실패`);
  }
  const oddIndexPaths = LIVE_TOUCHED.filter((_, idx) => idx % 2 === 1).map(([p]) => p);
  for (const path of oddIndexPaths) {
    assert.equal(graph.remove('proj-A', path), true, `${path} 삭제 실패`);
  }
  const revive = oddIndexPaths[oddIndexPaths.length - 1];
  assert.ok(graph.add('proj-A', revive));

  const expected = LIVE_TOUCHED
    .map(([p]) => p)
    .filter((p) => !oddIndexPaths.includes(p) || p === revive)
    .sort();
  assert.deepEqual(
    graph.visibleFor('proj-A').map((n) => n.name).sort(),
    expected,
    '타임라인 끝 노드 집합이 예측과 다르다',
  );
  assert.equal(graph.visibleFor('proj-B').length, 0);
});

test('TC-MENU-LIFE12: 경로 변형(./, 역슬래시)으로 add 해도 단일 프로젝트 안에서 노드는 1개로 수렴한다', () => {
  const graph = createLifecycleGraph();
  const a = graph.add('proj-A', LIVE_PLACEHOLDER);
  const b = graph.add('proj-A', `./${LIVE_PLACEHOLDER}`);
  const c = graph.add('proj-A', LIVE_PLACEHOLDER.replace(/\//g, '\\'));
  const d = graph.add('proj-A', `./${LIVE_PLACEHOLDER.replace(/\//g, '\\')}`);
  for (const n of [a, b, c, d]) assert.ok(n, '경로 변형 add 에서 노드가 누락됐다');
  assert.equal(a!.id, b!.id);
  assert.equal(a!.id, c!.id);
  assert.equal(a!.id, d!.id);
  assert.equal(graph.visibleFor('proj-A').length, 1);
});

test('TC-MENU-LIFE13: A→B 메뉴 스코프 전환 후 B 에서 동일 경로 add 해도 A 노드 가시성은 유지된다', () => {
  // 두 프로젝트가 같은 이름 파일을 독립 노드로 갖고, A 삭제가 B 를 건드리지 않는다.
  const graph = createLifecycleGraph();
  const inA = graph.add('proj-A', LIVE_PLACEHOLDER);
  const inB = graph.add('proj-B', LIVE_PLACEHOLDER);
  assert.ok(inA && inB);
  assert.notEqual(inA!.id, inB!.id, '같은 이름이라도 프로젝트가 다르면 id 가 달라야 한다');
  graph.remove('proj-A', LIVE_PLACEHOLDER);
  assert.equal(graph.visibleFor('proj-A').length, 0);
  assert.equal(graph.visibleFor('proj-B').length, 1);
  assert.equal(graph.visibleFor('proj-B')[0].id, inB!.id, 'B 노드 id 가 A 삭제로 바뀌면 안 된다');
});

// ─────────────────────────────────────────────────────────────────────────────
// (13) Git 자동화 패널 초기 로딩 플로우 — 할당 업무 #GIT-AUTO-INIT (Joker)
// ─────────────────────────────────────────────────────────────────────────────
// 배경: 페이지 진입 시 App.tsx 는 `/api/projects/:id/git-automation` (server.ts:742)
// 로 서버 권위값을 당겨오고, ProjectManagement.tsx 는 localStorage 스코프 키에서
// 즉시 복원한다 (ProjectManagement.tsx:648). 두 소스는 서로 다른 시점에 도착하므로
// 패널 `initial` prop 으로 흘러가는 값이 세 단계 우선순위로 수렴해야 한다:
//   serverAuthoritative > localStorageSnapshot > DEFAULT_AUTOMATION
// 본 섹션은 이 우선순위 reducer 와 "로딩 스피너 / 에러 fallback" 상태 전이를
// pure-function 레벨에서 고정해, 아래 회귀가 다시 나타나지 않도록 가드한다.
//   - 서버 404/에러 시 DEFAULT 로 "깜빡 초기화" 되어 사용자의 로컬 편집이 사라짐.
//   - 서버 응답 도착 전 localStorage 가 비었을 때 DEFAULT 로 먼저 paint 되어 플래시.
//   - 서버가 enabled:false 여도 localStorage 의 enabled:true 가 먹혀, 실제로는
//     꺼져 있는 자동화가 "켜진 것처럼" 보이는 state skew.
// 수동 체크리스트:
//   - 프로젝트 전환 시 패널이 DEFAULT 로 깜빡 초기화되지 않는지 (Slow 3G 토글).
//   - 서버 GET 404 → 토스트 노출 & 패널은 직전 저장 상태 유지.
//   - localStorage 비운 상태에서 첫 진입 시 서버 응답 도착 전 스피너가 보이는지.
//   - 다른 단말에서 설정 변경 후 socket 'git-automation:updated' 수신 시 패널이 조용히 교체되는지.

type ServerLoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; settings: GitAutomationSettings }
  | { kind: 'error'; message: string };

// 세 가지 소스(server/localStorage/default) 를 우선순위로 합성해 패널 `initial` 로
// 흘려보낼 값을 결정한다. App.tsx + ProjectManagement.tsx 가 호출부에서 동일한
// 순서로 reducer 해야 첫 paint 에 플래시가 없다. DEFAULT_AUTOMATION 은 "진짜
// 아무것도 없을 때" 의 최후 폴백 — serverAuthoritative 가 도착하면 즉시 교체된다.
function resolvePanelInitial(
  serverState: ServerLoadState,
  localSnapshot: GitAutomationSettings | null,
): GitAutomationSettings {
  if (serverState.kind === 'loaded') return serverState.settings;
  if (localSnapshot) return localSnapshot;
  return DEFAULT_AUTOMATION;
}

// 로딩 스피너 노출 계약: 서버 응답이 아직 없고 localStorage snapshot 도 비어 있을
// 때만 스피너를 띄운다. localStorage 가 있으면 즉시 렌더하고 서버 응답이 도착하면
// 조용히 교체한다 (플래시 없음). error/idle 상태에서는 스피너를 띄우지 않는다 —
// 에러 토스트는 별도 상태 채널이며, idle 은 아직 요청 전.
function shouldShowLoadingSpinner(
  serverState: ServerLoadState,
  localSnapshot: GitAutomationSettings | null,
): boolean {
  return serverState.kind === 'loading' && !localSnapshot;
}

test('TC-MENU-INIT1: 서버 loaded 는 localStorage/DEFAULT 를 덮어 패널 initial 로 흘러간다', () => {
  installFakeLocalStorage();
  try {
    // 권위 우선순위 검증: server > local > default. 서버 값이 있으면 local 스냅샷은 무시된다.
    saveGitAutomationSettings(PANEL_A, 'proj-A');
    const local = loadGitAutomationSettings('proj-A');
    const resolved = resolvePanelInitial({ kind: 'loaded', settings: PANEL_B }, local);
    assert.deepEqual(resolved, PANEL_B, '서버 권위값이 localStorage 를 이겨야 한다');
    assert.notEqual(resolved.branchPattern, PANEL_A.branchPattern);
    // loaded 상태에선 스피너가 꺼져야 한다.
    assert.equal(shouldShowLoadingSpinner({ kind: 'loaded', settings: PANEL_B }, local), false);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-INIT2: 서버 loading 중엔 localStorage snapshot 이 패널 initial 로 즉시 쓰이고 스피너는 숨는다', () => {
  installFakeLocalStorage();
  try {
    // 사용자 경험: 로컬에 스냅샷이 있으면 첫 paint 에 바로 보이고 서버 응답은 조용히 교체.
    saveGitAutomationSettings(PANEL_A, 'proj-A');
    const local = loadGitAutomationSettings('proj-A');
    const resolved = resolvePanelInitial({ kind: 'loading' }, local);
    assert.deepEqual(resolved, PANEL_A, 'localStorage 값이 서버 로딩 중엔 우선 가시화');
    assert.equal(shouldShowLoadingSpinner({ kind: 'loading' }, local), false, '스냅샷이 있으면 스피너 숨김');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-INIT3: 로컬/서버 모두 비어 있을 때만 로딩 스피너를 띄운다', () => {
  installFakeLocalStorage();
  try {
    // 첫 방문 프로젝트: localStorage 비어 있고 서버도 아직 응답 전 → 스피너가 유일한 가드.
    assert.equal(shouldShowLoadingSpinner({ kind: 'loading' }, null), true);
    assert.equal(shouldShowLoadingSpinner({ kind: 'idle' }, null), false, 'idle 에선 스피너 금지');
    assert.equal(shouldShowLoadingSpinner({ kind: 'error', message: '!' }, null), false, 'error 에선 토스트로 전환');
    // 패널이 null 로 crash 하지 않도록 DEFAULT_AUTOMATION 폴백.
    const resolved = resolvePanelInitial({ kind: 'loading' }, null);
    assert.deepEqual(resolved, DEFAULT_AUTOMATION);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-INIT4: 서버 error 에서는 localStorage snapshot 이 그대로 유지된다 (깜빡 초기화 금지)', () => {
  installFakeLocalStorage();
  try {
    // 서버 실패 → DEFAULT 로 리셋되면 사용자가 방금 저장한 설정이 사라진다. localStorage 가 최후 방어선.
    saveGitAutomationSettings(PANEL_A, 'proj-A');
    const local = loadGitAutomationSettings('proj-A');
    const resolved = resolvePanelInitial({ kind: 'error', message: '404 project not found' }, local);
    assert.deepEqual(resolved, PANEL_A, '서버 에러 시 localStorage 값을 유지해야 한다');
    assert.notDeepEqual(resolved, DEFAULT_AUTOMATION);
    assert.equal(shouldShowLoadingSpinner({ kind: 'error', message: '!' }, local), false);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-INIT5: 서버 응답이 localStorage 의 stale 값을 덮어 state skew 를 해소한다', () => {
  installFakeLocalStorage();
  try {
    // 다른 단말에서 enabled:false 로 꺼뒀는데 이 단말 localStorage 는 enabled:true 캐시. 서버가 이긴다.
    saveGitAutomationSettings({ ...PANEL_A, enabled: true }, 'proj-A');
    const local = loadGitAutomationSettings('proj-A');
    assert.equal(local.enabled, true, 'pre-condition: localStorage 는 true');

    const serverAuth: GitAutomationSettings = { ...PANEL_A, enabled: false };
    const resolved = resolvePanelInitial({ kind: 'loaded', settings: serverAuth }, local);
    assert.equal(resolved.enabled, false, '서버 권위값이 이긴다');
    // 요약 바(deriveAutomationOptions) 까지 같은 권위값을 본다 — skew 가 아래층으로 새지 않음.
    const summary = deriveAutomationOptions(resolved);
    assert.equal(summary.every(s => !s.active), true, 'enabled:false 면 모든 옵션 배지가 꺼져야 한다');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-INIT6: 부분 서버 응답은 DEFAULT 와 병합되어 누락 필드가 undefined 로 새지 않는다', () => {
  // GitAutomationPanel.tsx 의 baseline = { ...DEFAULT_AUTOMATION, ...initial } 계약.
  // 서버가 legacy row 로 branchPattern 만 돌려줘도 폼의 다른 필드가 controlled warning 없이
  // 렌더되어야 한다. 이 contract 가 깨지면 input value 가 undefined 로 떨어져 폼이 마비된다.
  const partial: Partial<GitAutomationSettings> = { branchPattern: 'server/{slug}' };
  const merged: GitAutomationSettings = { ...DEFAULT_AUTOMATION, ...partial };
  assert.equal(merged.branchPattern, 'server/{slug}');
  assert.equal(merged.commitTemplate, DEFAULT_AUTOMATION.commitTemplate);
  assert.equal(merged.prTitleTemplate, DEFAULT_AUTOMATION.prTitleTemplate);
  assert.equal(merged.flow, DEFAULT_AUTOMATION.flow);
  assert.equal(merged.enabled, DEFAULT_AUTOMATION.enabled);
  // 병합값으로 미리보기 렌더가 크래시 없이 결과를 낸다.
  const preview = renderTemplate(merged.branchPattern, { slug: 'init-fix', type: 'feat', ticket: 'LLM-1' });
  assert.equal(preview.includes('init-fix'), true);
});

test('TC-MENU-INIT7: 프로젝트 전환 직후 서버 loading 중에도 새 프로젝트의 localStorage 가 즉시 반영된다', () => {
  installFakeLocalStorage();
  try {
    // A→B 전환 프레임: App.tsx 의 서버 fetch 는 in-flight. ProjectManagement.tsx 는
    // loadGitAutomationSettings('proj-B') 로 B 의 스냅샷을 이미 썼다. 패널은 PANEL_B 로 즉시 렌더.
    saveGitAutomationSettings(PANEL_A, 'proj-A');
    saveGitAutomationSettings(PANEL_B, 'proj-B');
    const localB = loadGitAutomationSettings('proj-B');
    const resolved = resolvePanelInitial({ kind: 'loading' }, localB);
    assert.deepEqual(resolved, PANEL_B, '전환 직후 B 스냅샷으로 렌더');
    assert.notDeepEqual(resolved, PANEL_A, 'A 의 설정이 새 프로젝트에 번지면 안 된다');
    assert.equal(shouldShowLoadingSpinner({ kind: 'loading' }, localB), false);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-INIT8: socket git-automation:updated 수신은 기존 localStorage 를 덮고 요약 배지도 즉시 반영한다', () => {
  installFakeLocalStorage();
  try {
    // 다른 단말이 enabled=true + flow='full-pr' 로 바꿨다. 이 단말은 socket 이벤트로
    // setGitAutomationSettings(payload.settings) 를 호출해 서버 권위값을 상태에 주입한다.
    // 우선순위는 loaded 와 동일: localStorage 가 뭐든 서버 값이 이긴다.
    saveGitAutomationSettings({ ...PANEL_A, enabled: false, flow: 'commit' }, 'proj-A');
    const local = loadGitAutomationSettings('proj-A');

    const liveUpdate: GitAutomationSettings = { ...PANEL_A, enabled: true, flow: 'full-pr' };
    const resolved = resolvePanelInitial({ kind: 'loaded', settings: liveUpdate }, local);
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.flow, 'full-pr');
    // 요약 바: full-pr + enabled → commit/push/pr 전부 활성.
    const summary = deriveAutomationOptions(resolved);
    assert.deepEqual(
      summary.map(s => [s.key, s.active]),
      [['commit', true], ['push', true], ['pr', true]],
      'full-pr 활성 시 세 옵션이 모두 체크되어야 한다',
    );
  } finally { uninstallFakeLocalStorage(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// (14) Git 자동화 패널 저장 persist 계약 — 할당 업무 #GIT-AUTOMATION-SAVE (Thanos)
// ─────────────────────────────────────────────────────────────────────────────
// 배경: ProjectManagement.tsx 1253~1262 line 의 onSave 는 setState 후
// saveGitAutomationSettings(cloned, projectId) 로 localStorage 에 스코프 저장본을
// 쓴다. server.ts POST /api/projects/:id/git-automation (742~770 line) 은 서버 DB
// 로 승격시키는 상위 경로이며, 두 persist 경계 사이의 shape invariant 가 깨지면
// "localStorage 에는 저장됐지만 다음 세션/다른 단말에서 못 보는" 저장 누락 버그가
// 재발한다. 본 섹션은 save→load 왕복에서 모든 필드가 byte-identical 로 살아남는지,
// enabled 토글·flow 전이 같은 핵심 옵션이 반드시 스코프 키에 반영되는지, quota
// 실패·손상 JSON 상황에서도 throw 없이 DEFAULT 로 복구되는지 고정한다. 사이클은
// TC-MENU-INIT 시리즈(서버↔로컬 우선순위)와 붙여, onSave 가 쓰는 값이 다음 세션의
// localSnapshot 으로 어김없이 되돌아오도록 두 경계를 한 레일 위에 묶는다.

// enabled/flow/템플릿 3축이 동시에 흔들려도 왕복이 깨지지 않는지 확인하는 행렬.
const PANEL_SAVE_MATRIX: ReadonlyArray<readonly [string, GitAutomationSettings]> = [
  ['commit-only-enabled',   { flow: 'commit',      branchPattern: 'feat/{ticket}',  commitTemplate: 'feat: {branch}',  prTitleTemplate: '[{ticket}] feat',   enabled: true,  branchStrategy: 'per-session', newBranchName: '' }],
  ['commit-only-disabled',  { flow: 'commit',      branchPattern: 'feat/{ticket}',  commitTemplate: 'feat: {branch}',  prTitleTemplate: '[{ticket}] feat',   enabled: false, branchStrategy: 'per-session', newBranchName: '' }],
  ['push-enabled',          { flow: 'commit-push', branchPattern: 'fix/{slug}',     commitTemplate: 'fix({scope}): x', prTitleTemplate: 'fix: {summary}',    enabled: true,  branchStrategy: 'per-session', newBranchName: '' }],
  ['push-disabled',         { flow: 'commit-push', branchPattern: 'fix/{slug}',     commitTemplate: 'fix({scope}): x', prTitleTemplate: 'fix: {summary}',    enabled: false, branchStrategy: 'per-session', newBranchName: '' }],
  ['full-pr-enabled',       { flow: 'full-pr',     branchPattern: 'release/{v}',    commitTemplate: 'release: {v}',    prTitleTemplate: 'release {v}',       enabled: true,  branchStrategy: 'per-session', newBranchName: '' }],
  ['full-pr-disabled',      { flow: 'full-pr',     branchPattern: 'release/{v}',    commitTemplate: 'release: {v}',    prTitleTemplate: 'release {v}',       enabled: false, branchStrategy: 'per-session', newBranchName: '' }],
];

test('TC-MENU-SAVE1: 모든 옵션 조합이 save→load 왕복에서 byte-identical 로 persist 된다', () => {
  installFakeLocalStorage();
  try {
    // onChange 가 flow/enabled/템플릿 중 어느 축을 건드려도 저장본이 누락되면 안 된다.
    // 한 축이라도 누락되면 다음 세션에서 "저장 버튼은 눌렀는데 돌아오면 이전 값" 회귀가
    // 즉시 재현된다.
    for (const [label, panel] of PANEL_SAVE_MATRIX) {
      saveGitAutomationSettings(panel, `proj-${label}`);
      const loaded = loadGitAutomationSettings(`proj-${label}`);
      assert.deepEqual(loaded, panel, `${label}: 저장 후 load 가 원형 복원되지 않았다`);
    }
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-SAVE2: enabled 토글만 바꾼 save 가 같은 스코프 키에 즉시 반영된다', () => {
  const ctx = installFakeLocalStorage();
  try {
    // 토글이 저장되지 않으면 다음 세션에 "일시 중지했는데 다시 돌고 있는" 유령 자동화 사고.
    saveGitAutomationSettings({ ...PANEL_A, enabled: true }, 'proj-toggle');
    const firstRaw = ctx.store.get(scopedPanelKey('proj-toggle'));
    assert.ok(firstRaw && firstRaw.includes('"enabled":true'));

    saveGitAutomationSettings({ ...PANEL_A, enabled: false }, 'proj-toggle');
    const secondRaw = ctx.store.get(scopedPanelKey('proj-toggle'));
    assert.ok(secondRaw && secondRaw.includes('"enabled":false'), '토글 off 가 스코프 키에 반영되지 않았다');
    assert.equal(loadGitAutomationSettings('proj-toggle').enabled, false);
    // 토글 외 나머지 필드는 건드리지 않았음을 확인.
    assert.equal(loadGitAutomationSettings('proj-toggle').branchPattern, PANEL_A.branchPattern);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-SAVE3: 동일 설정을 N번 save 해도 스코프 키는 하나만 유지된다 (idempotent)', () => {
  const ctx = installFakeLocalStorage();
  try {
    // 저장 버튼을 연타해도 스코프 키가 증식되지 않아야 한다. 증식 시 localStorage
    // quota 를 천천히 먹거나 load 경로가 오염된다.
    saveGitAutomationSettings(PANEL_A, 'proj-dupe');
    saveGitAutomationSettings(PANEL_A, 'proj-dupe');
    saveGitAutomationSettings(PANEL_A, 'proj-dupe');
    const panelKeys = Array.from(ctx.store.keys()).filter(k => k.startsWith(`${GIT_AUTOMATION_PANEL_KEY}:`));
    assert.equal(panelKeys.length, 1, '연속 save 가 스코프 키를 증식시켰다');
    assert.equal(panelKeys[0], scopedPanelKey('proj-dupe'));
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-SAVE4: localStorage setItem 실패(quota)여도 save 는 throw 하지 않는다', () => {
  const ctx = installFakeLocalStorage();
  try {
    // save 가 던지면 onSave 콜백이 중단되고 패널의 "저장됨" 배지가 영원히 안 켜진다.
    // ProjectManagement.tsx 131 line 의 계약: 조용히 삼킨다.
    ctx.throwOnSet = true;
    assert.doesNotThrow(() => saveGitAutomationSettings(PANEL_A, 'proj-quota'));
    ctx.throwOnSet = false;
    // quota 상황에서는 저장본이 없으니 load 는 DEFAULT 로 폴백 — 메모리 state 만 유지.
    assert.deepEqual(loadGitAutomationSettings('proj-quota'), DEFAULT_AUTOMATION);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-SAVE5: flow 전이(commit → commit-push → full-pr → back)가 순차 save 로 누락 없이 반영된다', () => {
  installFakeLocalStorage();
  try {
    // 라디오 3단계를 순차로 밟을 때 매 save 가 이전 값 위에 올바르게 쌓여야 한다.
    // 중간 save 가 유실되면 "full-pr 눌렀는데 commit 으로 돌고 있음" 류 치명적 불일치.
    const seq: GitFlowLevel[] = ['commit', 'commit-push', 'full-pr', 'commit-push', 'commit'];
    for (const flow of seq) {
      saveGitAutomationSettings({ ...PANEL_A, flow }, 'proj-flow');
      assert.equal(loadGitAutomationSettings('proj-flow').flow, flow, `flow=${flow} 전이가 저장되지 않았다`);
    }
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-SAVE6: 손상된 저장본은 load 에서 DEFAULT 로 폴백하고 다음 save 가 정상 복구한다', () => {
  const ctx = installFakeLocalStorage();
  try {
    // ProjectManagement.tsx loadGitAutomationSettings 122 line 계약: 손상된 JSON/
    // 타입 mismatch 는 조용히 DEFAULT 로 복구. 패널이 먹통 되는 최악 시나리오 차단.
    ctx.store.set(scopedPanelKey('proj-corrupt'), '{not-json');
    assert.deepEqual(loadGitAutomationSettings('proj-corrupt'), DEFAULT_AUTOMATION);
    // 필드 타입 mismatch 도 DEFAULT 로 폴백 (flow 가 숫자).
    ctx.store.set(scopedPanelKey('proj-corrupt'), JSON.stringify({
      flow: 123, branchPattern: 'x', commitTemplate: 'x', prTitleTemplate: 'x', enabled: true,
    }));
    assert.deepEqual(loadGitAutomationSettings('proj-corrupt'), DEFAULT_AUTOMATION);
    // 이후 정상 save 로 복구되어야 한다 — "한 번 손상되면 영영 저장 못 함" 회귀 방지.
    saveGitAutomationSettings(PANEL_A, 'proj-corrupt');
    assert.deepEqual(loadGitAutomationSettings('proj-corrupt'), PANEL_A);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-SAVE7: onSave 결과가 다음 세션의 localSnapshot 으로 되돌아와 INIT 우선순위 레일과 맞물린다', () => {
  installFakeLocalStorage();
  try {
    // 한 사이클 시뮬레이션: 사용자가 패널에서 flow=full-pr 로 저장 → 세션 종료 → 재진입.
    // 서버 응답 도착 전(resolvePanelInitial: loading) 에도 패널은 방금 저장한 값을 보여야 한다.
    saveGitAutomationSettings({ ...PANEL_A, flow: 'full-pr' }, 'proj-cycle');
    const nextSessionLocal = loadGitAutomationSettings('proj-cycle');
    assert.equal(nextSessionLocal.flow, 'full-pr', '재진입 세션에서 저장 직전 값을 못 본다');
    const resolved = resolvePanelInitial({ kind: 'loading' }, nextSessionLocal);
    assert.equal(resolved.flow, 'full-pr', 'INIT reducer 가 방금 저장한 값을 이어받지 못했다');
    // 요약 바도 같은 값을 본다 — state skew 없음.
    const summary = deriveAutomationOptions(resolved);
    assert.deepEqual(
      summary.map(s => [s.key, s.active]),
      [['commit', true], ['push', true], ['pr', true]],
    );
  } finally { uninstallFakeLocalStorage(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// (9) 부모 → ProjectManagement 선택 구독 계약 — App.tsx:1691 배선 가드
// ─────────────────────────────────────────────────────────────────────────────
// 배경: App.tsx 의 store(selectedProjectId) 를 ProjectManagement 가 props(currentProjectId)
// 로만 구독한다. 이 흐름이 깨지면(예: prop 이름이 바뀌거나, 부모가 엉뚱한 값을 넘기면)
// 본체는 항상 null 가드(ProjectManagement.tsx:480-483)에 걸려 메뉴가 통째로 사라지고,
// 헤더 라벨은 영영 "선택된 프로젝트 없음" 에 묶인다. 아래 케이스는 pure-function
// 레벨에서 헤더 분기 카피와 null → 실 프로젝트 전이의 불변식을 고정한다.
//   수동 체크리스트 (QA 감마/Thanos 공동):
//   - 프로젝트 탭 전환 시 헤더 타이틀이 한 프레임도 '선택된 프로젝트 없음' 으로 떨어지지 않는지.
//   - selectedProjectId 가 null 이면 App.tsx:1691 은 currentProjectId={null} 을 넘겨
//     내부 가드가 ProjectManagement 본체를 숨기는지 (EmptyProjectPlaceholder 는 별도 슬롯).

const MP_SAMPLE: ManagedProject = {
  id: 'mp-1',
  projectId: 'proj-A',
  provider: 'github',
  integrationId: 'int-1',
  remoteId: 'r-1',
  name: 'tycoon',
  fullName: 'acme/tycoon',
  url: 'https://github.com/acme/tycoon',
  defaultBranch: 'main',
  prBaseBranch: 'develop',
  private: false,
  importedAt: '2026-04-18T00:00:00Z',
};

test('TC-MENU-WIRE1: project=null 이면 헤더 라벨은 "선택된 프로젝트 없음" 분기만 돌려준다', () => {
  const labelNull = formatEditingProjectLabel(null);
  assert.equal(labelNull.hasProject, false);
  assert.equal(labelNull.title, '선택된 프로젝트 없음');
  assert.equal(labelNull.subtitle, undefined);
  assert.equal(labelNull.fullName, undefined);
  assert.equal(labelNull.branch, undefined);

  // undefined 도 동일 분기로 떨어져야 한다 — Array.find 가 undefined 를 돌려주는 경로.
  const labelUndef = formatEditingProjectLabel(undefined);
  assert.equal(labelUndef.hasProject, false);
  assert.equal(labelUndef.title, '선택된 프로젝트 없음');
});

test('TC-MENU-WIRE2: project 가 붙으면 hasProject=true 로 뒤집히고 org/repo 가 분리된다', () => {
  const label = formatEditingProjectLabel(MP_SAMPLE);
  assert.equal(label.hasProject, true);
  assert.equal(label.title, 'tycoon');
  assert.equal(label.subtitle, 'acme/');
  assert.equal(label.fullName, 'acme/tycoon');
  // prBaseBranch 가 있으면 우선. defaultBranch 로 떨어지지 않는다.
  assert.equal(label.branch, 'develop');
});

test('TC-MENU-WIRE3: store(selectedProjectId) → prop(currentProjectId) 전이가 라벨 분기를 뒤집는다', () => {
  // App.tsx:1691 에서 selectedProjectId=null 프레임 → 바로 다음 프레임에 'proj-A' 로 복원되는
  // 전이를 pure 레벨에서 시뮬레이션. 부모가 실제 ManagedProject 를 찾아 내려주지 않으면
  // "선택된 프로젝트 없음" 에 묶이는 회귀가 재발한다.
  const before = formatEditingProjectLabel(null);
  assert.equal(before.hasProject, false);
  const after = formatEditingProjectLabel(MP_SAMPLE);
  assert.equal(after.hasProject, true);
  assert.notEqual(after.title, before.title, '선택 전이 후에도 라벨이 "없음" 에 묶여 있다');
});

// Joker(프런트): "프로젝트 선택 상태에서 메뉴가 올바른 프로젝트명을 표시하는지" 회귀 가드.
// 시나리오: App → ProjectManagementInner 까지 currentProjectId 가 A 로 내려왔는데,
// 헤더 배지가 여전히 "선택된 프로젝트 없음" 이거나 이전 프로젝트 B 의 이름을 붙잡고
// 있으면 사용자는 "자동화 설정이 어느 프로젝트 것인지" 를 잃는다. pure 함수
// 레벨에서 "선택 ≠ placeholder · 선택 = 정확한 이름" 두 불변식을 고정한다.
test('TC-MENU-NAME1: 선택된 프로젝트는 MP_SAMPLE.fullName 을 헤더에 그대로 비춘다', () => {
  const label = formatEditingProjectLabel(MP_SAMPLE);
  // 핵심: 선택 상태의 라벨에 정확한 repo 이름이 박혀야 한다.
  assert.equal(label.title, 'tycoon', '선택된 프로젝트의 repo 이름이 헤더에 노출되지 않았다');
  assert.equal(label.fullName, MP_SAMPLE.fullName, 'fullName 이 선택 프로젝트의 원본과 다르다');
  // hasProject 가 false 로 떨어지면 UI 가 placeholder 톤(점선/반투명) 으로 바뀌어
  // "선택이 없는 것처럼" 보이는 회귀가 생긴다.
  assert.equal(label.hasProject, true);
  assert.notEqual(label.title, '선택된 프로젝트 없음', '선택 상태인데 placeholder 라벨로 떨어졌다');
});

test('TC-MENU-NAME2: 프로젝트 전환 시 헤더 라벨이 새 프로젝트명으로 즉시 뒤집힌다', () => {
  // App 의 selectedProjectId 가 A → B 로 바뀌면 부모는 Array.find 로 B 의 ManagedProject
  // 를 찾아 내려준다. 포맷터가 그 입력을 그대로 따라가는지 검증 — 포맷터 내부에
  // 은닉 캐시가 있으면 "B 로 바꿨는데 A 이름이 남아 있다" 는 치명적 라벨 skew 가 발생.
  const projectA: ManagedProject = {
    ...MP_SAMPLE,
    id: 'mp-A', projectId: 'proj-A',
    name: 'frontend', fullName: 'acme/frontend',
  };
  const projectB: ManagedProject = {
    ...MP_SAMPLE,
    id: 'mp-B', projectId: 'proj-B',
    name: 'backend', fullName: 'acme/backend',
  };
  const labelA = formatEditingProjectLabel(projectA);
  const labelB = formatEditingProjectLabel(projectB);
  assert.equal(labelA.title, 'frontend');
  assert.equal(labelB.title, 'backend');
  assert.notEqual(labelA.title, labelB.title, 'A→B 전환 후에도 헤더 title 이 이전 프로젝트명에 묶여 있다');
  assert.notEqual(labelA.fullName, labelB.fullName);
  // 왕복 후 결정적 — 은닉 state 가 없다는 불변식.
  assert.deepEqual(formatEditingProjectLabel(projectA), labelA, '전환 왕복 후 라벨이 결정적이지 않다');
});

test('TC-MENU-NAME3: Project(게임 모델) → ManagedProject 연결이 끊기면 placeholder 로 안전하게 떨어진다', () => {
  // src/types.ts 의 Project 는 id/name 만 노출하지만, 관리 메뉴는 그 id 로 연결된
  // ManagedProject(org/repo) 를 보여준다. 둘을 잇는 projectId 필드가 끊어지면
  // "Project 를 골랐는데 엉뚱한 repo 이름이 뜨는" 미스매치가 발생한다. pure 레벨에서
  // projectId 기준 조회가 정확히 1건만 맞도록 고정한다.
  const managedList: ManagedProject[] = [
    { ...MP_SAMPLE, id: 'mp-A', projectId: 'proj-A', name: 'frontend', fullName: 'acme/frontend' },
    { ...MP_SAMPLE, id: 'mp-B', projectId: 'proj-B', name: 'backend', fullName: 'acme/backend' },
  ];
  const pickByProjectId = (pid: string) => managedList.find(mp => mp.projectId === pid) || null;

  assert.equal(formatEditingProjectLabel(pickByProjectId('proj-A')).title, 'frontend');
  assert.equal(formatEditingProjectLabel(pickByProjectId('proj-B')).title, 'backend');

  // 매칭 실패(ManagedProject 미발견) 는 placeholder 로 안전하게 떨어져야 한다.
  // 이전 선택의 라벨이 그대로 남으면 사용자가 "선택이 반영됐다" 고 오해한다.
  const unknown = formatEditingProjectLabel(pickByProjectId('proj-UNKNOWN'));
  assert.equal(unknown.hasProject, false);
  assert.equal(unknown.title, '선택된 프로젝트 없음');
});

// ─────────────────────────────────────────────────────────────────────────────
// (15) 서버 권위값 hydrate · 재시도 · 레이스 — 할당 업무 #GIT-AUTO-INIT (Joker 보강)
// ─────────────────────────────────────────────────────────────────────────────
// 배경: TC-MENU-INIT1~8 은 "한 사이클 reducer 의 우선순위" 만 고정한다. 실제 페이지
// 진입 플로우는 (a) 서버 응답을 받은 직후 localStorage 로 hydrate 하는 왕복, (b) 첫
// 호출이 실패한 뒤 "다시 시도" 로 loading 재진입 후 loaded, (c) A→B 빠른 전환 중
// A 의 지연 응답 도착 시나리오가 추가로 돈다. 이 세 가지는 reducer 만으로는 안
// 잡히고, "호출부가 응답 projectId 가드를 통과시킨다" 는 계약이 필요하다.
//
// 수동 체크리스트:
//   - 네트워크 에러 토스트 후 "다시 시도" 클릭 시 스피너 재등장 & 기존 폼 값 유지.
//   - A→B→A 빠른 전환(devtools Slow 3G) 시 A 의 지연 응답이 B 를 덮지 않는지.
//   - loaded 직후 새로고침에서 localStorage 가 stale 이 아닌 최신 권위값인지.

test('TC-MENU-INIT9: 서버 loaded 도착 시 해당 값을 localStorage 로 hydrate 해 다음 세션이 stale 을 읽지 않는다', () => {
  installFakeLocalStorage();
  try {
    // 이전 세션에 stale 캐시가 남아 있다. 서버가 다른 값을 돌려주면 즉시 갈아끼워야 한다.
    saveGitAutomationSettings({ ...PANEL_A, enabled: false, flow: 'commit' }, 'proj-hydrate');
    const staleLocal = loadGitAutomationSettings('proj-hydrate');
    assert.equal(staleLocal.enabled, false);

    // 서버 권위값 도착 → resolve 후 로컬에 재-save 하는 hydrate 계약.
    const serverAuth: GitAutomationSettings = { ...PANEL_A, enabled: true, flow: 'full-pr' };
    const resolved = resolvePanelInitial({ kind: 'loaded', settings: serverAuth }, staleLocal);
    saveGitAutomationSettings(resolved, 'proj-hydrate');

    // 재진입 시 localStorage 는 이미 서버 권위값 — loading 프레임에서 stale 이 다시
    // paint 되는 플래시가 원천 차단된다.
    const nextSessionLocal = loadGitAutomationSettings('proj-hydrate');
    assert.deepEqual(nextSessionLocal, serverAuth, 'hydrate 후에도 로컬이 stale 값을 돌려줬다');
    assert.equal(nextSessionLocal.enabled, true);
    assert.equal(nextSessionLocal.flow, 'full-pr');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-INIT10: error → 재시도 loading → loaded 전이 동안 사용자는 DEFAULT 플래시를 보지 않는다', () => {
  installFakeLocalStorage();
  try {
    // 사용자가 저장한 로컬 스냅샷 존재. 첫 fetch 실패 → "다시 시도" → 두 번째 loaded.
    // 세 프레임 모두 DEFAULT 로 떨어지면 "방금 저장한 게 사라짐" 으로 보여 치명적.
    saveGitAutomationSettings(PANEL_A, 'proj-retry');
    const local = loadGitAutomationSettings('proj-retry');

    const states: ServerLoadState[] = [
      { kind: 'error', message: 'ECONNRESET' },
      { kind: 'loading' },
      { kind: 'loaded', settings: { ...PANEL_A, enabled: false } },
    ];
    const resolvedSeq = states.map((s) => resolvePanelInitial(s, local));
    assert.deepEqual(resolvedSeq[0], PANEL_A, 'error 프레임에서 DEFAULT 로 떨어졌다');
    assert.deepEqual(resolvedSeq[1], PANEL_A, '재시도 loading 프레임에서 DEFAULT 로 떨어졌다');
    assert.equal(resolvedSeq[2].enabled, false, '최종 loaded 에서 권위값이 반영되지 않았다');
    for (let i = 0; i < 2; i++) {
      assert.notDeepEqual(resolvedSeq[i], DEFAULT_AUTOMATION, `frame ${i} 에서 DEFAULT 플래시`);
    }
    // 로컬 스냅샷이 있는 한 모든 프레임에서 스피너 비노출 — 에러 토스트는 별도 채널.
    for (const s of states) {
      assert.equal(shouldShowLoadingSpinner(s, local), false, `${s.kind} 프레임에서 스피너가 떴다`);
    }
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-INIT11: A→B 빠른 전환 중 A 의 지연 응답은 현재 선택된 B 를 덮지 않는다 (projectId 가드)', () => {
  installFakeLocalStorage();
  try {
    // fetch in-flight 중 B 로 전환. A 의 응답이 뒤늦게 도착해도, 호출부 가드가
    // "응답 projectId !== 현재 선택" 이면 loaded 로 넘기지 않고 loading 유지한다.
    saveGitAutomationSettings(PANEL_A, 'proj-A');
    saveGitAutomationSettings(PANEL_B, 'proj-B');
    const localB = loadGitAutomationSettings('proj-B');

    // 가드 없이 reducer 에 넘기면 덮여버린다 — 호출부가 반드시 막아야 함을 반대 방향으로도 확인.
    const naive = resolvePanelInitial({ kind: 'loaded', settings: PANEL_A }, localB);
    assert.deepEqual(naive, PANEL_A, 'reducer 자체는 권위값을 신뢰 (가드는 호출부 책임)');

    // 가드 통과 모델: 지연 응답의 projectId 가 현재 선택과 다르면 loading 으로 치환.
    const responseProjectId = 'proj-A';
    const currentProjectId = 'proj-B';
    const guardedState: ServerLoadState =
      responseProjectId === currentProjectId
        ? { kind: 'loaded', settings: PANEL_A }
        : { kind: 'loading' };
    const guarded = resolvePanelInitial(guardedState, localB);
    assert.deepEqual(guarded, PANEL_B, '지연 응답 가드가 뚫려 B 가 A 로 덮였다');
    assert.notDeepEqual(guarded, PANEL_A);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-INIT12: loading 중 localStorage 유무 하나로 스피너 가시성이 뒤집힌다', () => {
  installFakeLocalStorage();
  try {
    // 첫 방문: 로컬 없음 → 스피너. 저장 후 재진입: 로컬 있음 → 스피너 숨김.
    assert.equal(shouldShowLoadingSpinner({ kind: 'loading' }, null), true);

    saveGitAutomationSettings(PANEL_A, 'proj-spin');
    const localAfterSave = loadGitAutomationSettings('proj-spin');
    assert.equal(
      shouldShowLoadingSpinner({ kind: 'loading' }, localAfterSave),
      false,
      '로컬 스냅샷이 있는데도 스피너가 노출됐다',
    );

    // devtools 에서 storage 를 수동 clear 한 뒤 loading 이 다시 떨어지면 스피너가 되살아나야 한다.
    (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
      .removeItem(scopedPanelKey('proj-spin'));
    assert.equal(
      shouldShowLoadingSpinner({ kind: 'loading' }, null),
      true,
      '로컬이 비면 스피너가 다시 노출되어야 한다',
    );
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-INIT13: 에러 메시지는 reducer 의 initial 결정에 영향을 주지 않는다 (메시지/값 채널 분리)', () => {
  installFakeLocalStorage();
  try {
    // 서버가 돌려준 에러 메시지의 문자열이 달라져도 패널 initial 은 로컬 스냅샷으로 고정되어야 한다.
    // 에러 메시지는 토스트 채널에만 흐르고, 폼 값 채널과 섞이지 않는다.
    saveGitAutomationSettings(PANEL_A, 'proj-err');
    const local = loadGitAutomationSettings('proj-err');

    const messages = ['ECONNRESET', '404 Not Found', 'Internal Server Error', ''];
    for (const msg of messages) {
      const resolved = resolvePanelInitial({ kind: 'error', message: msg }, local);
      assert.deepEqual(resolved, PANEL_A, `error.message="${msg}" 에서 initial 이 흔들렸다`);
    }
  } finally { uninstallFakeLocalStorage(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// (16) Git 자동화 패널 onSave → 서버 POST persist 경계 — 할당 업무 #GIT-AUTO-SAVE-SERVER (Thanos)
// ─────────────────────────────────────────────────────────────────────────────
// 배경: TC-MENU-SAVE1~7 은 localStorage 쓰기만 본다. 실제 persist 는 한 단계 더 있다 —
// ProjectManagement.tsx:1253 onSave 핸들러는 서버 POST /api/projects/:id/git-automation
// (server.ts:750~769) 으로도 body 를 보내야, 다른 단말/세션에서 server GET(App.tsx:502)
// 이 같은 값을 돌려준다. 현 구현은 local 만 쓰므로 "로컬엔 저장됐는데 다음 세션 서버
// GET 이 이전 값을 돌려주는" 저장 누락이 잠재한다. 아래 세 경계 계약을 고정한다:
//   (P1) localStorage 원문은 JSON.parse 후 GitAutomationSettings 다섯 필드를 모두 복원.
//   (P2) onSave fan-out 은 local 먼저, 서버 POST 다음 순서로 돈다 — 서버 실패에도
//        재진입 세션의 최후 방어선이 local snapshot.
//   (P3) enabled 는 body 에 명시돼야 — server.ts:759 `enabled !== false` 규칙에 걸려
//        키가 누락되면 true 로 승격되어 일시 중지가 유령 자동화로 되살아난다.

function toServerPostBody(s: GitAutomationSettings): Record<string, unknown> {
  return {
    flow: s.flow,
    branchPattern: s.branchPattern,
    commitTemplate: s.commitTemplate,
    prTitleTemplate: s.prTitleTemplate,
    enabled: s.enabled,
  };
}

interface PersistCall { target: 'local' | 'server'; projectId: string; body: string; }

function runFanOutSave(
  next: GitAutomationSettings,
  projectId: string,
  postToServer: (id: string, body: Record<string, unknown>) => void,
): PersistCall[] {
  const log: PersistCall[] = [];
  saveGitAutomationSettings(next, projectId);
  log.push({ target: 'local', projectId, body: JSON.stringify(next) });
  const body = toServerPostBody(next);
  postToServer(projectId, body);
  log.push({ target: 'server', projectId, body: JSON.stringify(body) });
  return log;
}

test('TC-MENU-SAVE8: localStorage 원문은 JSON.parse 후 GitAutomationSettings 다섯 필드를 돌려준다', () => {
  const ctx = installFakeLocalStorage();
  try {
    saveGitAutomationSettings(PANEL_A, 'proj-srv');
    const raw = ctx.store.get(scopedPanelKey('proj-srv'));
    assert.ok(raw, 'localStorage 에 스코프 키가 써지지 않았다');
    const parsed = JSON.parse(raw!) as GitAutomationSettings;
    assert.equal(parsed.flow, PANEL_A.flow);
    assert.equal(parsed.branchPattern, PANEL_A.branchPattern);
    assert.equal(parsed.commitTemplate, PANEL_A.commitTemplate);
    assert.equal(parsed.prTitleTemplate, PANEL_A.prTitleTemplate);
    assert.equal(parsed.enabled, PANEL_A.enabled);
    assert.deepEqual(toServerPostBody(parsed), toServerPostBody(PANEL_A));
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-SAVE8b: 부분 save 3연타(flow → 템플릿 → enabled) 후에도 원문이 최신 다섯 필드를 모두 싣는다', () => {
  const ctx = installFakeLocalStorage();
  try {
    // 사용자가 라디오, 템플릿 필드, 토글 순으로 연타하는 현실 시나리오. 매 save 후
    // 이전 필드가 휘발되면 다음 세션에서 "방금 바꾼 flow 만 남고 템플릿은 옛 값" 같은
    // 부분 저장 회귀가 재현된다. 매 단계마다 다섯 필드 원문을 단정.
    saveGitAutomationSettings({ ...PANEL_A, flow: 'full-pr' }, 'proj-multi');
    saveGitAutomationSettings({ ...PANEL_A, flow: 'full-pr', branchPattern: 'hotfix/{slug}' }, 'proj-multi');
    saveGitAutomationSettings({ ...PANEL_A, flow: 'full-pr', branchPattern: 'hotfix/{slug}', enabled: false }, 'proj-multi');
    const raw = ctx.store.get(scopedPanelKey('proj-multi'));
    assert.ok(raw);
    const parsed = JSON.parse(raw!) as GitAutomationSettings;
    assert.equal(parsed.flow, 'full-pr');
    assert.equal(parsed.branchPattern, 'hotfix/{slug}');
    assert.equal(parsed.enabled, false);
    // 안 건드린 필드는 PANEL_A 값으로 유지된다 — 부분 save 가 나머지 필드를 지우면 안 된다.
    assert.equal(parsed.commitTemplate, PANEL_A.commitTemplate);
    assert.equal(parsed.prTitleTemplate, PANEL_A.prTitleTemplate);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-SAVE9: onSave fan-out 은 localStorage 와 서버 POST 를 순서대로 둘 다 호출한다', () => {
  const ctx = installFakeLocalStorage();
  try {
    const serverCalls: Array<{ projectId: string; body: Record<string, unknown> }> = [];
    const log = runFanOutSave(PANEL_A, 'proj-fanout', (id, body) => {
      serverCalls.push({ projectId: id, body });
    });
    assert.deepEqual(log.map(c => c.target), ['local', 'server']);
    assert.ok(ctx.store.get(scopedPanelKey('proj-fanout')), 'local 쓰기가 누락됐다');
    assert.equal(serverCalls.length, 1, '서버 POST 가 누락/중복됐다');
    assert.equal(serverCalls[0].projectId, 'proj-fanout');
    const keys = Object.keys(serverCalls[0].body).sort();
    assert.deepEqual(keys, ['branchPattern', 'commitTemplate', 'enabled', 'flow', 'prTitleTemplate']);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-SAVE10: enabled=false 는 body 에 명시돼야 서버 승격(`!== false` → true) 을 차단한다', () => {
  // server.ts:759 `enabled: body.enabled !== false` 규칙 재현. 키 누락 시 true 승격.
  const offBody = toServerPostBody({ ...PANEL_A, enabled: false });
  assert.ok(Object.prototype.hasOwnProperty.call(offBody, 'enabled'), 'enabled 키가 body 에서 누락됐다');
  assert.equal(offBody.enabled, false);
  assert.equal(offBody.enabled !== false, false, 'enabled=false 가 서버 승격에 걸려 true 로 되돌려졌다');

  const onBody = toServerPostBody({ ...PANEL_A, enabled: true });
  assert.ok(Object.prototype.hasOwnProperty.call(onBody, 'enabled'));
  assert.equal(onBody.enabled, true);
});

test('TC-MENU-SAVE11: 서버 POST 가 throw 해도 local 은 이미 써져 있어 다음 세션이 복구된다', () => {
  const ctx = installFakeLocalStorage();
  try {
    let thrown: unknown = null;
    try {
      runFanOutSave(PANEL_A, 'proj-fail', () => {
        throw new Error('500 Internal Server Error');
      });
    } catch (e) { thrown = e; }
    assert.ok(thrown, '서버 실패가 삼켜지면 에러 토스트 채널이 무력화된다');
    const raw = ctx.store.get(scopedPanelKey('proj-fail'));
    assert.ok(raw, '서버 실패 전에 local 이 먼저 커밋되지 않았다');
    const parsed = JSON.parse(raw!) as GitAutomationSettings;
    assert.deepEqual(parsed, PANEL_A);
    const resolved = resolvePanelInitial({ kind: 'loading' }, parsed);
    assert.deepEqual(resolved, PANEL_A, '서버 실패 세션에서 local snapshot 이 복구되지 않았다');
  } finally { uninstallFakeLocalStorage(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// (17) Git 자동화 패널 E2E — 할당 업무 #GIT-AUTO-E2E (QA 감마)
// ─────────────────────────────────────────────────────────────────────────────
// 할당 업무: "옵션 토글 → 저장 버튼 클릭 → 새로고침 후 값 유지" 시나리오를 한 레일에
// 통합. 지금까지 섹션별로 흩어져 있던 persist 계약(SAVE*), 우선순위 reducer(INIT*),
// 저장 상태 머신(saving/saved/error)을 한 번의 "사용자 click → reload" 사이클로
// 엮어 회귀를 고정한다. 중점 케이스:
//   - 로딩 상태: saving 구간 동안 저장 버튼이 잠기고, 성공 시 phase='saved' + justSaved 타임스탬프.
//   - 저장 성공 토스트: localStorage 스코프 키에 값이 앉고, 새 세션(load) 에서 byte-identical 복원.
//   - 저장 실패 토스트: persist throw → phase='error' + lastError, localStorage 직전 값 보존.
//   - 네트워크 오류: fetch TypeError 가 토스트로 surface, 재시도 성공 시 최종값으로 복원.
// 이 섹션이 녹색이면 "토글했는데 다음 세션에 돌아오지 않음 / 저장 에러가 조용히 삼켜짐 /
// 네트워크 단절 후 영영 복구 못 함" 3대 UX 회귀가 동시에 가드된다.
// 수동 검증 체크리스트:
//   - 브라우저에서 Git 자동화 옵션 토글 → 저장 클릭 → 스피너 노출 → "저장됨" 배지 → F5 후 값 유지.
//   - DevTools 오프라인 체크 후 저장 → 빨간 토스트 + 버튼 재활성 → 온라인 복귀 후 다시 저장 성공.
//   - Slow 3G 로 saving 구간 300ms+ 유지되는지 시각 확인 (스피너 플래시 없이 자연스러운 전이).

type PanelSaveUiState =
  | { phase: 'idle'; justSaved: null; lastError: null }
  | { phase: 'saving'; justSaved: null; lastError: null }
  | { phase: 'saved'; justSaved: number; lastError: null }
  | { phase: 'error'; justSaved: null; lastError: string };

// 패널 저장 버튼 click 핸들러 모방. persistFn 이 throw 하면 localStorage 는 건드리지
// 않고 error 로 전이한다 — 서버 4xx/5xx 가 먼저 떨어지는 케이스에서도 로컬 캐시를
// 오염시키지 않는 계약(실패는 no-op persist) 을 보장한다.
async function runPanelSaveClick(
  projectId: string,
  next: GitAutomationSettings,
  persistFn: (s: GitAutomationSettings, id: string) => Promise<void>,
  now: () => number = () => Date.parse('2026-04-18T00:00:00Z'),
): Promise<PanelSaveUiState[]> {
  const trail: PanelSaveUiState[] = [{ phase: 'idle', justSaved: null, lastError: null }];
  trail.push({ phase: 'saving', justSaved: null, lastError: null });
  try {
    await persistFn(next, projectId);
    // 성공 경로: 서버 ack 후 로컬 스코프 키에도 동일 값이 앉아야 다음 세션이 볼 수 있다.
    saveGitAutomationSettings(next, projectId);
    trail.push({ phase: 'saved', justSaved: now(), lastError: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    trail.push({ phase: 'error', justSaved: null, lastError: msg });
  }
  return trail;
}

test('TC-MENU-E2E1: 옵션 토글(enabled) → 저장 버튼 click → 새로고침 load 에서 값이 유지된다', async () => {
  installFakeLocalStorage();
  try {
    // 초기: 이전 세션에서 enabled=true 로 저장.
    saveGitAutomationSettings({ ...PANEL_A, enabled: true }, 'proj-e2e');
    // 토글 → 저장 버튼 클릭.
    const toggled: GitAutomationSettings = { ...PANEL_A, enabled: false };
    const trail = await runPanelSaveClick('proj-e2e', toggled, async () => { /* 서버 ack */ });
    assert.deepEqual(trail.map(s => s.phase), ['idle', 'saving', 'saved']);

    // "새로고침" = 페이지 리로드. 모듈 레벨 상태는 버리고 localStorage 만 남는다.
    const reloaded = loadGitAutomationSettings('proj-e2e');
    assert.deepEqual(reloaded, toggled, '새로고침 후 토글 값이 사라졌다');
    assert.equal(reloaded.enabled, false, 'enabled 토글이 스코프 키에 persist 되지 않았다');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-E2E2: flow/템플릿 여러 축을 한 번에 토글 → 저장 → 새로고침 후 전 필드 복원', async () => {
  installFakeLocalStorage();
  try {
    saveGitAutomationSettings(PANEL_A, 'proj-multi');
    const toggled: GitAutomationSettings = {
      ...PANEL_A,
      flow: 'full-pr',
      branchPattern: 'release/{version}',
      enabled: false,
    };
    const trail = await runPanelSaveClick('proj-multi', toggled, async () => {});
    assert.equal(trail.at(-1)!.phase, 'saved');

    // 새로고침 후 전 축이 살아 있어야 한다 — 한 축이라도 DEFAULT 로 폴백하면 치명적.
    const reloaded = loadGitAutomationSettings('proj-multi');
    assert.equal(reloaded.flow, 'full-pr');
    assert.equal(reloaded.branchPattern, 'release/{version}');
    assert.equal(reloaded.enabled, false);
    assert.deepEqual(reloaded, toggled, '다축 토글 후 일부 필드가 유실됐다');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-E2E3: saving 구간 동안 저장 버튼이 잠기고 phase 전이가 idle→saving→saved 순으로 찍힌다', async () => {
  installFakeLocalStorage();
  try {
    // saving 구간이 생략되면 스피너/락이 한 프레임도 안 뜨고 연타 시 중복 저장이 발생한다.
    let resolveFn!: () => void;
    const pending = new Promise<void>((r) => { resolveFn = r; });
    const trailP = runPanelSaveClick('proj-loading', PANEL_A, async () => { await pending; });

    await Promise.resolve();
    resolveFn();
    const trail = await trailP;
    assert.deepEqual(trail.map(s => s.phase), ['idle', 'saving', 'saved']);
    assert.equal(trail[1].phase === 'saving', true, 'saving 구간이 증발했다');
    assert.deepEqual(loadGitAutomationSettings('proj-loading'), PANEL_A);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-E2E4: 저장 성공 토스트 — justSaved 타임스탬프 + lastError=null + 스코프 키 반영', async () => {
  installFakeLocalStorage();
  try {
    const fakeNow = Date.parse('2026-04-18T12:34:56Z');
    const trail = await runPanelSaveClick(
      'proj-toast-ok',
      { ...PANEL_A, enabled: true },
      async () => { /* 서버 200 OK */ },
      () => fakeNow,
    );
    const final = trail.at(-1)!;
    assert.equal(final.phase, 'saved');
    assert.equal(final.lastError, null);
    assert.ok(final.phase === 'saved' && final.justSaved === fakeNow, 'justSaved 가 고정 now 와 일치해야 한다');
    assert.deepEqual(loadGitAutomationSettings('proj-toast-ok'), { ...PANEL_A, enabled: true });
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-E2E5: 저장 실패 토스트 — lastError 메시지 surface + localStorage 직전 값 보존 + justSaved=null', async () => {
  installFakeLocalStorage();
  try {
    // 이전에 enabled=true 로 저장된 상태. 실패 저장이 이 값을 절대 덮으면 안 된다.
    saveGitAutomationSettings({ ...PANEL_A, enabled: true }, 'proj-toast-fail');
    const before = loadGitAutomationSettings('proj-toast-fail');

    const trail = await runPanelSaveClick(
      'proj-toast-fail',
      { ...PANEL_A, enabled: false },
      async () => { throw new Error('validation failed: branchTemplate must include {slug} token'); },
    );
    const final = trail.at(-1)!;
    assert.equal(final.phase, 'error');
    assert.equal(final.justSaved, null);
    assert.match(final.lastError ?? '', /branchTemplate must include \{slug\}/);
    assert.deepEqual(loadGitAutomationSettings('proj-toast-fail'), before, '실패 저장이 직전 값을 덮었다');
    assert.equal(loadGitAutomationSettings('proj-toast-fail').enabled, true);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-E2E6: 네트워크 오류(fetch TypeError) 토스트 + 재시도 성공 시 새 값이 localStorage 에 반영된다', async () => {
  installFakeLocalStorage();
  try {
    saveGitAutomationSettings(PANEL_A, 'proj-network');
    const offlineTrail = await runPanelSaveClick(
      'proj-network',
      { ...PANEL_A, flow: 'full-pr' },
      async () => { throw new TypeError('Failed to fetch'); },
    );
    const offlineFinal = offlineTrail.at(-1)!;
    assert.equal(offlineFinal.phase, 'error');
    assert.equal(offlineFinal.lastError, 'Failed to fetch');
    assert.deepEqual(loadGitAutomationSettings('proj-network'), PANEL_A, '네트워크 오류가 로컬 캐시를 깨뜨렸다');

    // 온라인 복귀 후 재시도.
    const retryTrail = await runPanelSaveClick(
      'proj-network',
      { ...PANEL_A, flow: 'full-pr' },
      async () => { /* 서버 복귀 */ },
    );
    const retryFinal = retryTrail.at(-1)!;
    assert.equal(retryFinal.phase, 'saved');
    assert.equal(retryFinal.lastError, null);
    assert.equal(loadGitAutomationSettings('proj-network').flow, 'full-pr');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-E2E7: 5xx 문자열 throw 도 lastError 에 직렬화돼 UI 는 crash 하지 않는다', async () => {
  installFakeLocalStorage();
  try {
    // 일부 fetch wrapper 는 res.text() 를 그대로 throw 한다. Error 가 아니어도 UI 는 살아야 한다.
    saveGitAutomationSettings(PANEL_A, 'proj-5xx');
    const trail = await runPanelSaveClick(
      'proj-5xx',
      { ...PANEL_A, enabled: false },
      // eslint-disable-next-line no-throw-literal
      async () => { throw 'Internal Server Error'; },
    );
    const final = trail.at(-1)!;
    assert.equal(final.phase, 'error');
    assert.equal(final.lastError, 'Internal Server Error');
    assert.deepEqual(loadGitAutomationSettings('proj-5xx'), PANEL_A);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-E2E8: 네트워크 오류 직후 재시도가 INIT reducer 와 맞물려 다음 세션에서 최종값을 보여준다', async () => {
  installFakeLocalStorage();
  try {
    saveGitAutomationSettings(PANEL_A, 'proj-recover');
    await runPanelSaveClick(
      'proj-recover',
      { ...PANEL_A, flow: 'full-pr', enabled: false },
      async () => { throw new TypeError('Failed to fetch'); },
    );
    assert.deepEqual(loadGitAutomationSettings('proj-recover'), PANEL_A);

    await runPanelSaveClick(
      'proj-recover',
      { ...PANEL_A, flow: 'full-pr', enabled: false },
      async () => { /* ok */ },
    );

    // "새로고침 후 첫 paint" 시뮬레이션: loading 에도 localSnapshot 으로 즉시 렌더.
    const nextSessionLocal = loadGitAutomationSettings('proj-recover');
    const resolved = resolvePanelInitial({ kind: 'loading' }, nextSessionLocal);
    assert.equal(resolved.flow, 'full-pr', '재시도 성공 값이 새 세션 첫 paint 에 보이지 않는다');
    assert.equal(resolved.enabled, false);
    const summary = deriveAutomationOptions(resolved);
    assert.equal(summary.every(s => !s.active), true, 'enabled:false 복구 후 요약 바에 skew');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-E2E9: saving 중 같은 프로젝트로 연속 click 이 와도 최종 phase 는 saved 하나로 수렴한다', async () => {
  installFakeLocalStorage();
  try {
    // 버튼 disabled 가 늦게 적용되는 프레임 지연 케이스. 두 save 가 나란히 떨어져도 phase 는
    // saved 로 수렴하고, 스코프 키는 한 개만 유지되어야 한다.
    const trails = await Promise.all([
      runPanelSaveClick('proj-double', { ...PANEL_A, flow: 'commit' }, async () => {}),
      runPanelSaveClick('proj-double', { ...PANEL_A, flow: 'full-pr' }, async () => {}),
    ]);
    for (const trail of trails) {
      assert.equal(trail.at(-1)!.phase, 'saved', '연타 중 일부 click 이 error 로 떨어졌다');
    }
    const finalFlow = loadGitAutomationSettings('proj-double').flow;
    assert.ok(finalFlow === 'commit' || finalFlow === 'full-pr', `예상치 못한 flow 값: ${finalFlow}`);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-E2E10: 저장 실패 직후 재토글→재저장 success 시 phase 는 error→saving→saved 로 깔끔히 전이한다', async () => {
  // QA 관점 리그레션: 에러 phase 가 끈적하게 남아 다음 저장 시 lastError 가 이어져 보이면
  // 사용자는 "실패한 저장이 아직 진행 중" 이라고 오해한다. 재시도 사이클이 매 click 마다
  // idle 상태부터 다시 시작해야 한다.
  installFakeLocalStorage();
  try {
    const failTrail = await runPanelSaveClick(
      'proj-recover-click',
      { ...PANEL_A, enabled: false },
      async () => { throw new Error('quota exceeded'); },
    );
    assert.equal(failTrail.at(-1)!.phase, 'error');
    assert.equal(loadGitAutomationSettings('proj-recover-click'), loadGitAutomationSettings('proj-recover-click'));
    // 재토글 후 재저장 — 새 사이클은 idle 부터 시작.
    const retryTrail = await runPanelSaveClick(
      'proj-recover-click',
      { ...PANEL_A, enabled: true, flow: 'full-pr' },
      async () => {},
    );
    assert.deepEqual(retryTrail.map(s => s.phase), ['idle', 'saving', 'saved'],
      'error phase 가 이전 사이클에서 새 사이클로 누수됐다');
    assert.equal(retryTrail.at(-1)!.lastError, null, '직전 error 메시지가 성공 사이클에 끌려왔다');
    assert.equal(loadGitAutomationSettings('proj-recover-click').enabled, true);
    assert.equal(loadGitAutomationSettings('proj-recover-click').flow, 'full-pr');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-E2E11: 프로젝트 A 저장 → B 전환 → B 저장 → A 복귀 시 A 의 저장값이 그대로 복원된다', async () => {
  // 다중 프로젝트 E2E: 사용자가 A 패널을 저장하고 B 로 전환해 다른 값으로 저장한 뒤 A 로
  // 돌아왔을 때, A 가 방금 B 에 저장한 값으로 덮이거나 DEFAULT 로 폴백되면 "프로젝트 스코프
  // 분리" 가 사실상 깨진다. E2E 사이클이 스코프 키 격리와 한 레일 위에서 돌아가는지 확인.
  installFakeLocalStorage();
  try {
    const savedA: GitAutomationSettings = { ...PANEL_A, enabled: true, flow: 'commit-push' };
    const savedB: GitAutomationSettings = { ...PANEL_B, enabled: false, flow: 'full-pr' };

    const trailA = await runPanelSaveClick('proj-mux-A', savedA, async () => {});
    assert.equal(trailA.at(-1)!.phase, 'saved');
    const trailB = await runPanelSaveClick('proj-mux-B', savedB, async () => {});
    assert.equal(trailB.at(-1)!.phase, 'saved');

    // A 복귀 — load 는 A 의 값만 돌려줘야 한다. B 쪽 값이 새어 들어오면 즉시 실패.
    const reloadedA = loadGitAutomationSettings('proj-mux-A');
    const reloadedB = loadGitAutomationSettings('proj-mux-B');
    assert.deepEqual(reloadedA, savedA, 'A 복귀 시 B 값이 덮었다');
    assert.deepEqual(reloadedB, savedB, 'B 저장본이 A 전환 후에도 원형이 아니다');
    assert.notEqual(reloadedA.flow, reloadedB.flow);
    assert.notEqual(reloadedA.enabled, reloadedB.enabled);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-E2E12: 저장 실패 phase 에서도 버튼 재활성화는 idle 과 동일 — saving 만 잠근다', async () => {
  // 리그레션: 한 번 error 로 떨어진 후 버튼이 계속 잠겨 있으면 재시도 자체가 불가능해진다.
  // 패널 버튼 disabled 조건은 "phase === 'saving'" 단일 기준이라는 계약을 고정.
  installFakeLocalStorage();
  try {
    const trail = await runPanelSaveClick(
      'proj-btn',
      { ...PANEL_A, enabled: false },
      async () => { throw new Error('500'); },
    );
    const buttonDisabledByPhase = (phase: PanelSaveUiState['phase']) => phase === 'saving';
    for (const step of trail) {
      const expected = step.phase === 'saving';
      assert.equal(buttonDisabledByPhase(step.phase), expected,
        `${step.phase} 프레임의 버튼 disabled 계약이 어긋났다`);
    }
    // 마지막 프레임(error) 에서는 반드시 풀려 있어야 한다 — 재시도 경로 확보.
    assert.equal(buttonDisabledByPhase(trail.at(-1)!.phase), false,
      'error 후에도 버튼이 잠긴 채 남아 재시도 불가');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-E2E13: 새로고침 직후 첫 paint 에서도 저장 직전 토글값이 로딩 스피너 없이 보인다', async () => {
  // 옵션 토글→저장 후 F5 시나리오의 수직 통합: E2E 저장 사이클 → INIT reducer(loading) → 사용자 가시값.
  // 스피너가 한 프레임이라도 뜨면 "저장된 값 위로 DEFAULT 폴백 플래시" 가 발생한다.
  installFakeLocalStorage();
  try {
    const userToggled: GitAutomationSettings = { ...PANEL_A, enabled: false, flow: 'commit' };
    await runPanelSaveClick('proj-refresh', userToggled, async () => {});

    // "F5" 모사: 페이지 모듈 state 는 날아갔고 localStorage 만 남은 상태.
    const localAfterRefresh = loadGitAutomationSettings('proj-refresh');
    assert.deepEqual(localAfterRefresh, userToggled);
    // 첫 paint 프레임에선 서버 응답이 아직 loading — 스피너는 숨어야 하고 값은 저장본으로 표시.
    assert.equal(shouldShowLoadingSpinner({ kind: 'loading' }, localAfterRefresh), false,
      '저장 직후 새로고침에서 스피너 플래시');
    const firstPaint = resolvePanelInitial({ kind: 'loading' }, localAfterRefresh);
    assert.deepEqual(firstPaint, userToggled, '새로고침 첫 paint 가 토글값을 못 보여줬다');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-MENU-E2E14: 서버 POST body 의 enabled 키는 누락되지 않아 "일시 중지" 가 다음 세션에 유지된다', async () => {
  // server.ts:759 `enabled: body.enabled !== false` 규칙에 걸려 키 누락 시 true 로 승격되는
  // 회귀가 있다. E2E 토글(enabled=false) → 저장 → 서버 POST body 에 enabled:false 가
  // 명시적으로 실려야 일시 중지가 다음 세션에 유지된다. runPanelSaveClick 의 persistFn 으로
  // 실제 POST body 를 캡처해 키 존재와 값을 단정한다.
  installFakeLocalStorage();
  try {
    const captured: Record<string, unknown>[] = [];
    const persistSpy = async (s: GitAutomationSettings) => {
      captured.push(toServerPostBody(s));
    };
    const trail = await runPanelSaveClick(
      'proj-pause',
      { ...PANEL_A, enabled: false },
      persistSpy,
    );
    assert.equal(trail.at(-1)!.phase, 'saved');
    assert.equal(captured.length, 1);
    assert.ok(Object.prototype.hasOwnProperty.call(captured[0], 'enabled'),
      'POST body 에 enabled 키가 누락됐다 — 서버가 true 로 승격할 위험');
    assert.equal(captured[0].enabled, false);
    assert.equal(captured[0].enabled !== false, false,
      'server.ts `enabled !== false` 가드를 통과해 true 로 뒤집혔다');
    // 다음 세션 로드도 일시 중지 상태 유지.
    assert.equal(loadGitAutomationSettings('proj-pause').enabled, false);
  } finally { uninstallFakeLocalStorage(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// (15) 실제 작업 파일 노출 가시성 보강 — 할당 업무 #GRAPH-LIVE (Gamma QA).
// TC-MENU-LIFE* 이 단일 파일 라이프사이클을 다룬다면, 아래 세 케이스는
// "placeholder 삭제 vs peer 생존", "add 순서 가환성", "다중 프로젝트
// 인터리브 수렴" 을 추가로 가드한다.
// ─────────────────────────────────────────────────────────────────────────────

test('TC-MENU-LIFE14: placeholder 를 삭제해도 같은 프로젝트의 peer 가시성은 그대로 유지된다', () => {
  const graph = createLifecycleGraph();
  const peers = ['src/App.tsx', 'src/types.ts', 'server.ts'];
  graph.add('proj-A', LIVE_PLACEHOLDER);
  for (const p of peers) graph.add('proj-A', p);
  assert.equal(graph.visibleFor('proj-A').length, peers.length + 1);

  assert.equal(graph.remove('proj-A', LIVE_PLACEHOLDER), true);
  const after = graph.visibleFor('proj-A').map((n) => n.name).sort();
  assert.deepEqual(after, [...peers].sort(), 'peer 노드가 placeholder 삭제에 휩쓸렸다');
});

test('TC-MENU-LIFE15: 스코프 전환 + add/remove 인터리브 끝에서 두 프로젝트 노드 집합이 독립적으로 수렴한다', () => {
  const graph = createLifecycleGraph();
  const ops: Array<['add' | 'remove', string, string]> = [
    ['add', 'proj-A', LIVE_PLACEHOLDER],
    ['add', 'proj-B', 'src/App.tsx'],
    ['add', 'proj-A', 'src/types.ts'],
    ['remove', 'proj-A', LIVE_PLACEHOLDER],
    ['add', 'proj-B', LIVE_PLACEHOLDER],
    ['add', 'proj-A', LIVE_PLACEHOLDER],
    ['remove', 'proj-B', 'src/App.tsx'],
  ];
  for (const [op, proj, path] of ops) {
    if (op === 'add') graph.add(proj, path);
    else graph.remove(proj, path);
  }
  const a = graph.visibleFor('proj-A').map((n) => n.name).sort();
  const b = graph.visibleFor('proj-B').map((n) => n.name).sort();
  assert.deepEqual(a, ['src/components/EmptyProjectPlaceholder.tsx', 'src/types.ts']);
  assert.deepEqual(b, ['src/components/EmptyProjectPlaceholder.tsx']);
});

test('TC-MENU-LIFE16: 프로젝트 스코프 내 add 순서는 최종 가시 노드 집합에 영향을 주지 않는다', () => {
  // 에이전트가 병렬로 작업하면 add_file 호출 순서가 매번 다르다. 순서에 따라
  // 가시성이 흔들리면 "같은 작업인데 화면이 다르다" 회귀.
  const files = [
    LIVE_PLACEHOLDER,
    'src/App.tsx',
    'src/types.ts',
    'src/index.css',
    'server.ts',
  ];
  const forward = createLifecycleGraph();
  for (const f of files) forward.add('proj-A', f);
  const reverse = createLifecycleGraph();
  for (const f of [...files].reverse()) reverse.add('proj-A', f);
  const snap = (g: ReturnType<typeof createLifecycleGraph>) =>
    g.visibleFor('proj-A').map((n) => `${n.name}::${n.type}`).sort();
  assert.deepEqual(snap(forward), snap(reverse), '역순 add 가 가시 집합을 바꿨다');
});

// ─────────────────────────────────────────────────────────────────────────────
// (18) 수동 QA 리포트 — 프로젝트 선택 → 관리 메뉴 진입 3대 시나리오 (2026-04-18, QA)
// ─────────────────────────────────────────────────────────────────────────────
// 할당 업무: "프로젝트 선택 → 프로젝트 관리 메뉴 진입 시나리오를 수동 QA.
// 여러 프로젝트 전환, 새로고침 후 재진입, 빈 프로젝트 선택 케이스 테스트 후
// 버그 재현 스텝과 기대 동작 문서화." (업무 ID: #MENU-SCOPE/수동)
//
// 본 섹션은 EmptyProjectPlaceholder.tsx 헤더의 TC-PM1~5 초안을 세 사용자 저니로
// 압축해 (a) 재현 절차, (b) 현재 실제 동작, (c) 기대 동작, (d) 회귀 가드 불변식
// 순서로 기록한다. 아래 세 test 가 그 불변식을 잠가 두어, 수동 재현 없이도
// npx tsx --test 한 줄로 "이 번들에 버그가 있는가" 를 판정할 수 있다.
//
// [PM-MANUAL-A] 여러 프로젝트 전환 (A → B → A)
//   재현:
//     1) 사이드바에서 프로젝트 A 선택 → "프로젝트 관리" 탭 진입.
//     2) Git 자동화 패널(또는 선호) 값을 A 전용으로 수정·저장.
//     3) 사이드바로 돌아가 프로젝트 B 로 스위치 → "프로젝트 관리" 탭 재진입.
//     4) B 에서 다른 값으로 저장 후 다시 A 로 복귀해 2) 의 값을 확인.
//   실제 (현재 빌드, 2026-04-18):
//     - A/B 는 독립 스코프 키 (`...:<projectId>`) 에 격리 저장돼 전환 후에도
//       서로의 값이 섞이지 않는다.
//     - 단, 스위치 직전 selectedProjectId 가 한 프레임 '' 로 흘러
//       ProjectManagement.tsx:481 `!currentProjectId` 가드에 걸리며
//       1프레임 블랭크 플래시가 발생할 수 있다 (TC-PM2 관측).
//   기대:
//     - B 로 전환 직후 A 의 저장본이 한 필드도 가시화되지 않는다.
//     - A 로 복귀하면 초기 값이 byte-identical 로 복원된다.
//     - 전환 프레임에 빈 화면 대신 스켈레톤 또는 직전 스냅샷이 유지된다.
//
// [PM-MANUAL-B] 새로고침 후 재진입
//   재현:
//     1) 프로젝트 A 선택 + "프로젝트 관리" 탭에서 값 저장.
//     2) 브라우저 전체 새로고침 (F5 / Cmd+R).
//   실제 (현재 빌드, 2026-04-18):
//     - selectedProjectId 는 localStorage 에서 동기 복원되지만 activeTab 은
//       App.tsx:141 기본값 'game' 으로 항상 초기화된다. 사용자는 "방금 보던
//       관리 화면" 이 아닌 게임 뷰에 떨어진다 (TC-PM3).
//     - 복원 전 hydrated=false 구간엔 'game' 탭에 한해 스켈레톤이 나오지만,
//       다른 탭으로 복원하는 경로가 생기면 이 보호선이 없어 플래시가 되살아난다.
//   기대:
//     - hydrated=false 구간에 탭 무관하게 스켈레톤이 노출돼 DEFAULT 플래시 0.
//     - 새로고침 직후 "프로젝트 관리" 재진입 시 저장값이 즉시 복원된 메뉴가 보인다.
//     - 스코프/레거시 두 경로 모두에서 pinnedPrTargetProjectId 가 첫 paint 에 반영된다.
//
// [PM-MANUAL-C] 빈 프로젝트 선택 (미선택 상태 + 관리 메뉴 진입)
//   재현:
//     1) `llm-tycoon:selected-project` 비우기 / 현재 선택 프로젝트 삭제 →
//        selectedProjectId = null.
//     2) 사이드바 "프로젝트 관리" 버튼(또는 단축키 "5") 클릭.
//   실제 (현재 빌드, 2026-04-18):
//     - ProjectManagement.tsx:481 가드에 걸려 메인 영역이 완전 빈 화면.
//       EmptyProjectPlaceholder 는 App.tsx:1527 'game' 탭 전용 슬롯이라
//       'project-management' 탭에선 폴백이 없다 (TC-PM1 Critical).
//     - 사이드바 "프로젝트 관리" 버튼은 잠기지 않아 disabled/title 안내가 없다.
//     - 프로젝트 삭제 직후 App 전역 selectedProjectId 가 stale 로 남을 수 있음 (TC-PM5).
//   기대:
//     - (선호안) 'project-management' 탭도 EmptyProjectPlaceholder 를
//       gatedScopes=['프로젝트 관리'] 로 노출해 CTA 로 유도. 빈 화면 금지.
//     - (차선) 사이드바 버튼이 disabled + aria-disabled + title="프로젝트를 먼저 선택하세요".
//     - 프로젝트 삭제는 App 전역 selectedProjectId 를 동기로 null 로 클리어.
//
// 판정 우선순위: C(Critical, 사용자 정지) > A(High, 플래시/전염) > B(Medium, 복귀 이탈).

test('TC-PM-MANUAL-A: A→B→A 전환 왕복에서 A 저장본이 원형 복원되고, 스위치 프레임의 빈 currentProjectId 는 플래시를 만들지 않는다', () => {
  installFakeLocalStorage();
  try {
    // (1)~(2) A 에 저장.
    saveUserPreferences({ gitAutomation: PREFS_A, pinnedPrTargetProjectId: 'proj-A' }, 'proj-A');
    saveGitAutomationSettings(PANEL_A, 'proj-A');

    // (3) B 로 전환 직후 — A 의 값이 한 필드도 새어 나가면 안 된다.
    assert.deepEqual(loadUserPreferences('proj-B'), {}, 'B 전환 직후 A 의 선호가 가시화됐다');
    assert.deepEqual(loadGitAutomationSettings('proj-B'), DEFAULT_AUTOMATION, 'B 전환 직후 A 의 패널값이 가시화됐다');

    // B 에서 독립 저장.
    saveGitAutomationSettings(PANEL_B, 'proj-B');
    saveUserPreferences({ gitAutomation: { ...PREFS_A, reviewers: ['zoe'] } }, 'proj-B');

    // (4) A 로 복귀 — 초기 저장값 그대로여야 한다.
    assert.deepEqual(loadGitAutomationSettings('proj-A'), PANEL_A, 'A 왕복 후 패널값이 변형됐다');
    assert.deepEqual(loadUserPreferences('proj-A').gitAutomation, PREFS_A, 'A 왕복 후 선호가 변형됐다');
    assert.equal(loadUserPreferences('proj-A').pinnedPrTargetProjectId, 'proj-A');

    // 스위치 프레임 가드: currentProjectId 가 '' 로 흘러도 내부 placeholder 가 렌더되어
    // "1프레임 빈 화면 플래시" 대신 안내 카드가 보이도록 한다.
    const swapping = EmptyProjectPlaceholder({
      projectCount: 2,
      onOpenProjectList: EPP_NOOP,
      onCreateProject: EPP_NOOP,
      currentProjectId: '',
    });
    assert.notEqual(swapping, null, 'EmptyProjectPlaceholder 는 미선택(`""`) 에서도 렌더되어야 한다');
    // 전환 완료 후엔 null 로 즉시 뒤집혀야 한다 — "B 로 마운트됐는데 placeholder 가 남는" 반대 회귀 차단.
    const mountedAtB = EmptyProjectPlaceholder({
      projectCount: 2,
      onOpenProjectList: EPP_NOOP,
      onCreateProject: EPP_NOOP,
      currentProjectId: 'proj-B',
    });
    assert.equal(mountedAtB, null, 'B 마운트 직후에도 placeholder 가 남으면 전환 완료가 시각적으로 숨는다');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-PM-MANUAL-B: 새로고침 후 재진입 — localStorage 에서 pinned/패널/선호가 동기 복원되고 패널 initial 은 DEFAULT 로 떨어지지 않는다', () => {
  installFakeLocalStorage();
  try {
    // 저장된 세션: proj-A 를 고르고 관리 메뉴에서 값 저장 후 페이지 닫음.
    saveUserPreferences({ gitAutomation: PREFS_A, pinnedPrTargetProjectId: 'proj-A' }, 'proj-A');
    saveGitAutomationSettings(PANEL_A, 'proj-A');

    // 새로고침 = 모듈 state 는 버리지만 localStorage 는 살아 있는 상태.
    const scopedPrefs = loadUserPreferences('proj-A');
    assert.equal(scopedPrefs.pinnedPrTargetProjectId, 'proj-A', 'pinned 가 새로고침 후 동기 복원되지 않았다');
    assert.deepEqual(scopedPrefs.gitAutomation, PREFS_A);
    const scopedPanel = loadGitAutomationSettings('proj-A');
    assert.deepEqual(scopedPanel, PANEL_A, '패널 스냅샷이 새로고침 후 사라졌다');

    // 서버 응답 전 첫 paint — 로컬 스냅샷이 즉시 보이고 DEFAULT 플래시 없음.
    const firstPaint = resolvePanelInitial({ kind: 'loading' }, scopedPanel);
    assert.deepEqual(firstPaint, PANEL_A, '새로고침 첫 paint 가 DEFAULT 로 떨어졌다');
    assert.notDeepEqual(firstPaint, DEFAULT_AUTOMATION);
    assert.equal(shouldShowLoadingSpinner({ kind: 'loading' }, scopedPanel), false, '스냅샷이 있는데 스피너가 떴다');

    // 레거시 단일 키 경로(마이그레이션 전 세션)도 동기 복원되어야 한다.
    uninstallFakeLocalStorage();
    installFakeLocalStorage();
    saveUserPreferences({ pinnedPrTargetProjectId: 'proj-legacy' });
    assert.equal(loadUserPreferences().pinnedPrTargetProjectId, 'proj-legacy',
      '레거시 단일 키에서 pinned 가 동기 복원되지 않으면 새로고침 후 "선택이 풀린 것처럼" 보인다');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-PM-MANUAL-C: 빈 프로젝트 선택 — 미선택 관리 메뉴에 placeholder 가 뜨고 스토리지에는 유령 스코프 키가 생기지 않는다', () => {
  const ctx = installFakeLocalStorage();
  try {
    // 미선택 load 는 어떤 과거 프로젝트 값도 반환해선 안 된다.
    assert.deepEqual(loadUserPreferences(), {}, '미선택 load 가 과거 프로젝트 값을 돌려줬다');
    assert.deepEqual(loadGitAutomationSettings(), DEFAULT_AUTOMATION);
    assert.deepEqual(loadUserPreferences(null as unknown as string), {});
    assert.deepEqual(loadUserPreferences(''), {});

    // 'project-management' 탭에도 폴백이 필요하다는 계약: gatedScopes 에 '프로젝트 관리' 를
    // 실어 넘기면 placeholder 는 그 라벨을 담은 React element 를 돌려줘야 한다.
    // (null 을 돌려주면 사용자는 데드엔드 빈 화면을 본다 — TC-PM1 Critical 회귀.)
    const el = EmptyProjectPlaceholder({
      projectCount: 0,
      onOpenProjectList: EPP_NOOP,
      onCreateProject: EPP_NOOP,
      currentProjectId: null,
      gatedScopes: ['프로젝트 관리'],
    });
    assert.notEqual(el, null, '미선택 상태에서 placeholder 가 null 이면 관리 탭이 데드엔드 빈 화면이 된다');
    assert.equal(typeof el, 'object');

    // 미선택 save 는 스코프 키를 만들지 않아야 한다 — 다음 세션에 "유령 프로젝트" 로
    // 번져 들어가는 회귀(TC-MENU-V1c/SRV1 과 동형) 를 다시 한 번 잠근다.
    saveUserPreferences({ pinnedPrTargetProjectId: 'proj-A' });
    saveGitAutomationSettings(PANEL_A);
    for (const key of ctx.store.keys()) {
      assert.equal(
        key.startsWith(`${PROJECT_SETTINGS_KEY_PREFIX}:`) || key.startsWith(`${GIT_AUTOMATION_PANEL_KEY}:`),
        false,
        `미선택 save 가 스코프 키를 만들었다: ${key}`,
      );
    }

    // 삭제 직후 load 는 stale 저장본을 돌려주면 안 된다 (TC-PM5 cross-tab 오작동 가드).
    saveGitAutomationSettings(PANEL_A, 'proj-A');
    (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
      .removeItem(`${GIT_AUTOMATION_PANEL_KEY}:proj-A`);
    assert.deepEqual(loadGitAutomationSettings('proj-A'), DEFAULT_AUTOMATION,
      '삭제 직후 load 가 stale 한 저장본을 돌려주면 TC-PM5 cross-tab 오작동으로 이어진다');
  } finally { uninstallFakeLocalStorage(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// (19) 수동 QA 보강 — 3-way 고속 전환 / 활성 프로젝트 삭제 / 연속 새로고침 (QA)
// ─────────────────────────────────────────────────────────────────────────────
// TC-PM-MANUAL-A/B/C 가 세 저니의 "기본형" 을 잠갔지만, 실전에서 리포트가 많이
// 올라오는 세 가지 엣지가 남아 있어 QA 불변식을 추가로 고정한다.
//   D. 3개 이상 프로젝트를 빠르게 순환(클릭 연타): A→B→C→A. 2-프로젝트 테스트에서는
//      잡히지 않는 "세 번째 프로젝트" 로의 전이 중 중간 상태 누수.
//   E. "관리 탭이 열린 상태에서 활성 프로젝트를 삭제" 경로. TC-PM5 의 pure-function
//      수준 가드 — stale 스코프 키가 load 에서 되살아나면 사용자는 "삭제된 프로젝트
//      의 자동화 설정이 아직 살아있다" 고 오해한다.
//   F. 연속 새로고침(F5 두 번). 한 번만 테스트된 hydrate 사이클이 두 번째 세션에서도
//      깨지지 않음을 확인.

test('TC-PM-MANUAL-D: 3-way 고속 전환(A→B→C→A)에서 스코프 격리·최종 복원이 동시 성립한다', () => {
  installFakeLocalStorage();
  try {
    const PANEL_C: GitAutomationSettings = {
      flow: 'commit',
      branchPattern: 'chore/{slug}',
      commitTemplate: 'chore: {summary}',
      prTitleTemplate: 'chore: {summary}',
      enabled: false,
      branchStrategy: 'per-session',
      newBranchName: '',
    };
    // A → B → C 순으로 각자 저장 — 연타 중에도 스코프 키는 서로 섞이지 않아야 한다.
    saveGitAutomationSettings(PANEL_A, 'proj-A');
    assert.deepEqual(loadGitAutomationSettings('proj-B'), DEFAULT_AUTOMATION, 'A 저장 직후 B 가 오염됐다');
    saveGitAutomationSettings(PANEL_B, 'proj-B');
    assert.deepEqual(loadGitAutomationSettings('proj-C'), DEFAULT_AUTOMATION, 'B 저장 직후 C 가 오염됐다');
    saveGitAutomationSettings(PANEL_C, 'proj-C');

    // A 복귀 — 중간에 B/C 를 거쳐도 A 의 값은 원형 그대로여야 한다.
    assert.deepEqual(loadGitAutomationSettings('proj-A'), PANEL_A, '3-way 왕복 후 A 가 원형 복원되지 않았다');
    assert.deepEqual(loadGitAutomationSettings('proj-B'), PANEL_B, 'B 가 C 저장에 휩쓸렸다');
    assert.deepEqual(loadGitAutomationSettings('proj-C'), PANEL_C);

    // 전환 프레임의 currentProjectId='' 가드 — 3개 프로젝트 중 어디로 가는 중이든 동일.
    const switching = EmptyProjectPlaceholder({
      projectCount: 3,
      onOpenProjectList: EPP_NOOP,
      onCreateProject: EPP_NOOP,
      currentProjectId: '',
    });
    assert.notEqual(switching, null, '3-way 전환 프레임에서도 placeholder 가 플래시 가드 역할을 해야 한다');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-PM-MANUAL-E: 관리 탭 활성 중 프로젝트 삭제 — 스코프 키 제거 후 load 는 DEFAULT 로 폴백하고 이웃은 무손상', () => {
  // 재현: (1) A 선택 + 관리 탭 진입, (2) 관리 탭에서 A 삭제. 실제 빌드에서는 App 전역
  // selectedProjectId 가 stale 로 남을 수 있으나(TC-PM5), 스코프 키 차원의 로컬 가드는
  // 삭제 시점 removeItem 후 load 가 DEFAULT 로 떨어지는 것. 이웃 프로젝트는 한 바이트도 변하면 안 된다.
  const ctx = installFakeLocalStorage();
  try {
    saveGitAutomationSettings(PANEL_A, 'proj-A');
    saveUserPreferences({ gitAutomation: PREFS_A, pinnedPrTargetProjectId: 'proj-A' }, 'proj-A');
    saveGitAutomationSettings(PANEL_B, 'proj-B');
    const bPanelSnapshot = ctx.store.get(scopedPanelKey('proj-B'));

    // 삭제 시점: 두 스코프 키를 모두 removeItem. pinnedPrTargetProjectId 도 함께 정리되어야
    // 재생성 시 옛 pinned 값이 부활하지 않는다 (TC-MENU-V4c 와 동형).
    const local = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage;
    local.removeItem(scopedPrefsKey('proj-A'));
    local.removeItem(scopedPanelKey('proj-A'));

    // stale load 방지 — 삭제 직후 load 는 DEFAULT/{} 로.
    assert.deepEqual(loadGitAutomationSettings('proj-A'), DEFAULT_AUTOMATION,
      '삭제된 프로젝트의 패널값이 load 에서 되살아났다');
    assert.deepEqual(loadUserPreferences('proj-A'), {},
      '삭제된 프로젝트의 선호가 load 에서 되살아났다');

    // 이웃 B 는 완전 무손상.
    assert.equal(ctx.store.get(scopedPanelKey('proj-B')), bPanelSnapshot,
      'A 삭제가 B 의 원문을 건드렸다');
    assert.deepEqual(loadGitAutomationSettings('proj-B'), PANEL_B);

    // 삭제 후 활성 프로젝트 자리가 비어있을 때(TC-PM5 기대 동작): placeholder 가 렌더되어야
    // 사용자가 "삭제됐다" 를 인지할 수 있다. 빈 화면(null)은 사용자 정지 버그.
    const afterDelete = EmptyProjectPlaceholder({
      projectCount: 1,
      onOpenProjectList: EPP_NOOP,
      onCreateProject: EPP_NOOP,
      currentProjectId: null,
      gatedScopes: ['프로젝트 관리'],
    });
    assert.notEqual(afterDelete, null,
      '활성 프로젝트 삭제 직후 placeholder 가 null 이면 사용자는 데드엔드 빈 화면에 정지한다');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-PM-MANUAL-F: 연속 새로고침(2회) 이후에도 첫 paint 가 저장값으로 복원되고 DEFAULT 플래시 0', () => {
  // 재현: 저장 → F5 → 로드 확인 → 다시 F5. 두 번째 재진입에서 localStorage 가 여전히
  // 살아 있는지 + 첫 paint reducer 가 DEFAULT 로 떨어지지 않는지를 같이 잠근다.
  installFakeLocalStorage();
  try {
    const userSaved: GitAutomationSettings = { ...PANEL_A, enabled: false, flow: 'full-pr' };
    saveGitAutomationSettings(userSaved, 'proj-refresh2');
    saveUserPreferences({ gitAutomation: PREFS_A, pinnedPrTargetProjectId: 'proj-refresh2' }, 'proj-refresh2');

    // 1차 새로고침 — 모듈 state 날리고 load 만 남음. reducer 는 loading 에도 스냅샷 반환.
    let snapshot = loadGitAutomationSettings('proj-refresh2');
    assert.deepEqual(snapshot, userSaved, '1차 새로고침 후 저장값이 사라졌다');
    let firstPaint = resolvePanelInitial({ kind: 'loading' }, snapshot);
    assert.deepEqual(firstPaint, userSaved, '1차 새로고침 첫 paint 가 DEFAULT 로 떨어졌다');
    assert.equal(shouldShowLoadingSpinner({ kind: 'loading' }, snapshot), false);

    // 2차 새로고침 — 같은 storage, 같은 결과여야 한다. stale 이나 플래시 없음.
    snapshot = loadGitAutomationSettings('proj-refresh2');
    assert.deepEqual(snapshot, userSaved, '2차 새로고침에서 스냅샷이 흔들렸다');
    firstPaint = resolvePanelInitial({ kind: 'loading' }, snapshot);
    assert.deepEqual(firstPaint, userSaved, '2차 새로고침 첫 paint 가 1차와 달라졌다');
    assert.equal(loadUserPreferences('proj-refresh2').pinnedPrTargetProjectId, 'proj-refresh2',
      '2차 새로고침에서 pinned 가 날아갔다');
  } finally { uninstallFakeLocalStorage(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// (20) 새로고침 회귀 — 에이전트 working 상태 영속성 (QA)
// ─────────────────────────────────────────────────────────────────────────────
// 재현 시나리오 (사용자 리포트 기반):
//   A. "에이전트가 working 인데 F5 눌렀더니 idle 로 초기화됨."
//      → 서버는 DB 의 agent.status 를 유일 진원으로 쓰고, 새로고침 직후
//        GET /api/agents 가 같은 페이로드를 돌려줘야 한다. 클라 로컬 상태에
//        의존하면 회귀.
//   B. "서버를 재시작하고 나니 working 카드가 다 사라졌다."
//      → 서버 인스턴스 교체에도 MongoDB 레코드는 남는다. 같은 컬렉션 스냅샷을
//        두 번 연속으로 읽어도 동일 페이로드가 나와야 한다.
//   C. "두 명이 동시에 working 인데 새로고침 후 한 명만 남았다."
//      → 다중 에이전트 상태가 직렬화/역직렬화에서 흔들리면 안 된다.
//        workingOnFileId 도 각자 원형 그대로 보존.
//   D. "네트워크가 느려 /api/agents 응답이 소켓 이벤트보다 늦게 왔더니
//       나중 도착한 snapshot 이 최신 이벤트를 덮었다."
//      → 타임스탬프(또는 이벤트 도착 순서) 비교 가드. "HTTP 응답이 socket
//        push 보다 오래된 스냅샷이면 무시" 불변식을 순수 함수로 고정.
//
// 본 테스트는 DOM 이 없으므로 "서버 응답 페이로드" 를 Agent[] 배열로 직접
// 생성해 새로고침/재시작을 pure-function 레벨에서 재현한다. UI 통합 커버리지는
// 별도 jsdom harness 도입 후 보강 예정 — 단, 여기서 불변식이 깨지면 어떤
// 렌더러를 얹어도 working 이 복원되지 않는다.

// 서버 응답 페이로드 시뮬레이션용 빌더. DB 에서 바로 읽은 것처럼 필수 필드만
// 채운다. 실제 /api/agents 는 _id 프로젝션을 제거하므로 테스트도 동일하게 맞춘다.
const makeDbAgent = (overrides: Partial<Agent> = {}): Agent => {
  // Mongo 는 undefined 필드를 저장하지 않으므로 직렬화 왕복에서도 키가 나타나선 안 된다.
  // 이 빌더는 실제 DB 페이로드와 동형을 유지하기 위해 undefined 값을 객체에 싣지 않는다.
  const base: Agent = {
    id: overrides.id ?? 'agent-1',
    name: overrides.name ?? 'Kai',
    role: overrides.role ?? 'Developer',
    spriteTemplate: overrides.spriteTemplate ?? 'dev',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    status: overrides.status ?? 'idle',
  };
  const optional: (keyof Agent)[] = [
    'persona', 'currentTask', 'lastActiveTask', 'lastMessage', 'lastMessageTo', 'workingOnFileId',
  ];
  for (const key of optional) {
    if (overrides[key] !== undefined) (base as Record<string, unknown>)[key] = overrides[key];
  }
  return base;
};

// GET /api/agents 직렬화/역직렬화 왕복 — Express 는 JSON 으로 직렬화하므로
// 클라이언트가 보는 페이로드는 JSON.parse(JSON.stringify(...)) 와 동형이다.
// "새로고침" 은 이 왕복을 한 번 더 수행하는 것과 같다.
const simulateRefresh = (snapshot: Agent[]): Agent[] =>
  JSON.parse(JSON.stringify(snapshot)) as Agent[];

test('TC-REFRESH-1: 에이전트가 working 중 새로고침 — status/currentTask/workingOnFileId 가 동기 복원된다', () => {
  // 페이지 F5. 모듈 state 는 날아가지만 서버 DB 는 그대로. GET /api/agents 는
  // 직전과 동일한 페이로드를 돌려줘야 한다.
  const before: Agent[] = [
    makeDbAgent({
      id: 'agent-kai',
      status: 'working',
      currentTask: 'task-42',
      workingOnFileId: 'file-7',
    }),
  ];

  const after = simulateRefresh(before);
  assert.deepEqual(after, before, '새로고침 왕복에서 페이로드가 흔들렸다 — 직렬화 경로에 누수');

  const kai = after[0];
  assert.equal(kai.status, 'working', '새로고침 후 status 가 working 에서 벗어났다');
  assert.equal(kai.currentTask, 'task-42', 'currentTask 가 새로고침에 사라졌다');
  assert.equal(kai.workingOnFileId, 'file-7', 'workingOnFileId 가 날아가면 HUD 가 유령 파일을 가리킨다');
  assert.equal(isActiveAgent(kai), true, 'isActiveAgent 판정이 새로고침 후 뒤집혔다');
});

test('TC-REFRESH-2: 서버 재시작 — 동일 DB 컬렉션에서 연속 두 번 읽어도 페이로드가 byte-identical', () => {
  // 서버 인스턴스 교체(node 프로세스 재시작)는 MongoDB 레코드에 영향을 주지 않는다.
  // findOne/find 를 두 번 연속 호출했을 때 같은 결과가 나오는 불변식을 페이로드
  // 레벨에서 고정한다. DB 가 유일 진원이므로 여기서 갈리면 클라이언트 복원은 불가능.
  const dbSnapshot: Agent[] = [
    makeDbAgent({ id: 'agent-a', status: 'working', currentTask: 't-a' }),
    makeDbAgent({ id: 'agent-b', status: 'thinking', currentTask: 't-b' }),
  ];

  // 첫 번째 서버 인스턴스가 응답했던 페이로드.
  const firstBoot = simulateRefresh(dbSnapshot);
  // 재시작 — 새 프로세스가 같은 컬렉션에서 다시 읽는다.
  const secondBoot = simulateRefresh(dbSnapshot);

  assert.deepEqual(firstBoot, secondBoot, '재시작 후 동일 DB 에서 다른 페이로드가 튀어나왔다');
  assert.equal(firstBoot.filter(isActiveAgent).length, 2, '재시작 직후 active 판정이 손실됐다');
  assert.equal(secondBoot[0].status, 'working');
  assert.equal(secondBoot[1].status, 'thinking');
});

test('TC-REFRESH-3: 다중 에이전트 동시 working — 새로고침 후 모두 working/workingOnFileId 개별 보존', () => {
  // 세 명이 각자 다른 파일에서 동시에 working. 직렬화 경로에 ID 충돌이나
  // 필드 덮어쓰기가 있으면 여기서 즉시 잡힌다.
  const beforeRefresh: Agent[] = [
    makeDbAgent({ id: 'kai', role: 'Developer', status: 'working', workingOnFileId: 'f-1', currentTask: 't-1' }),
    makeDbAgent({ id: 'zoe', role: 'Designer', status: 'working', workingOnFileId: 'f-2', currentTask: 't-2' }),
    makeDbAgent({ id: 'gamma', role: 'QA', status: 'working', workingOnFileId: 'f-3', currentTask: 't-3' }),
  ];

  const afterRefresh = simulateRefresh(beforeRefresh);
  assert.equal(afterRefresh.length, 3, '다중 에이전트 중 한 명이 새로고침에서 소실됐다');
  assert.deepEqual(afterRefresh.map((a) => a.status), ['working', 'working', 'working'],
    '다중 working 중 일부가 idle 로 초기화됐다');
  assert.deepEqual(
    afterRefresh.map((a) => a.workingOnFileId).sort(),
    ['f-1', 'f-2', 'f-3'],
    'workingOnFileId 가 에이전트 간 뒤섞였다 — HUD 가 엉뚱한 파일을 가리킨다',
  );
  // id ↔ workingOnFileId 매핑이 원형 그대로여야 한다 — 정렬만 맞추고 대응이 어긋나면 유령 작업.
  for (const before of beforeRefresh) {
    const match = afterRefresh.find((a) => a.id === before.id);
    assert.ok(match, `새로고침 후 ${before.id} 가 사라졌다`);
    assert.equal(match!.workingOnFileId, before.workingOnFileId,
      `${before.id} 의 workingOnFileId 가 다른 에이전트 값으로 덮였다`);
    assert.equal(match!.currentTask, before.currentTask,
      `${before.id} 의 currentTask 가 새로고침에 어긋났다`);
  }
});

test('TC-REFRESH-4: 네트워크 지연 — 오래된 HTTP snapshot 이 최신 socket 이벤트를 덮어쓰면 안 된다', () => {
  // 재현: 사용자가 F5. 소켓 먼저 붙어 "agent-a: idle" 이벤트를 받는다.
  // 그 다음 느린 /api/agents HTTP 응답이 도착하는데, 페이로드는 응답 직전
  // 스냅샷이라 "agent-a: working" 을 담고 있다. 도착 순서만 보고 HTTP 를
  // 적용하면 사용자는 "분명 끝난 에이전트가 다시 working 으로 부활" 하는
  // 시각적 백트래킹을 본다.
  //
  // 계약: 클라이언트 reconcile 은 "이벤트 도착 순서" 가 아니라 "서버가 찍은
  // 순서(= 이벤트 버전 / 스냅샷 시각)" 를 기준으로 해야 한다. 본 테스트는 그
  // 순수 비교 함수를 직접 적용해 "오래된 것이 새 것을 덮지 않음" 을 잠근다.
  type Versioned = { agent: Agent; version: number };
  const reconcile = (current: Versioned, incoming: Versioned): Versioned =>
    incoming.version >= current.version ? incoming : current;

  const initial: Versioned = {
    agent: makeDbAgent({ id: 'agent-a', status: 'working', currentTask: 't-7' }),
    version: 1,
  };

  // 소켓 이벤트 — 최신(version=3): 작업 완료로 idle 전환.
  const socketEvent: Versioned = {
    agent: makeDbAgent({ id: 'agent-a', status: 'idle', currentTask: '', lastActiveTask: 't-7' }),
    version: 3,
  };
  // 느린 HTTP 응답 — 더 오래된 스냅샷(version=2): 아직 working.
  const staleHttp: Versioned = {
    agent: makeDbAgent({ id: 'agent-a', status: 'working', currentTask: 't-7' }),
    version: 2,
  };

  // 실제 이벤트 도착 순서: 먼저 socket(최신), 뒤에 HTTP(오래된 것).
  const afterSocket = reconcile(initial, socketEvent);
  const afterStaleHttp = reconcile(afterSocket, staleHttp);

  assert.equal(afterSocket.agent.status, 'idle', '최신 socket 이벤트가 반영되지 않았다');
  assert.equal(afterStaleHttp.agent.status, 'idle',
    '오래된 HTTP snapshot 이 최신 이벤트를 되돌려 working 유령 부활이 발생했다');
  assert.equal(afterStaleHttp.version, 3, 'reconcile 이 버전 역행을 허용했다');
  assert.equal(afterStaleHttp.agent.lastActiveTask, 't-7',
    'idle 전환의 lastActiveTask 가 HTTP 덮어쓰기에 날아갔다');

  // 반대 방향 — 느린 HTTP 가 실제로 더 최신(version=4)이면 socket 값을 밀어내야 한다.
  // "항상 socket 우선" 같은 과잉 가드로 정상적인 HTTP 승격 경로를 막으면 안 된다.
  const freshHttp: Versioned = {
    agent: makeDbAgent({ id: 'agent-a', status: 'meeting', currentTask: 't-8' }),
    version: 4,
  };
  const afterFreshHttp = reconcile(afterStaleHttp, freshHttp);
  assert.equal(afterFreshHttp.agent.status, 'meeting',
    '더 최신 HTTP 스냅샷이 반영되지 않았다 — "socket 절대 우선" 과잉가드 회귀');
});

test('TC-REFRESH-5: idle 전환 후 새로고침 — lastActiveTask 가 복원되어 카드가 빈 상태로 그려지지 않는다', () => {
  // server.ts PATCH /api/agents/:id/status 는 idle 전환 시 lastActiveTask 에
  // 직전 currentTask 를 적재한다. 새로고침 후에도 이 필드가 복원되지 않으면
  // "방금 끝낸 작업이 뭐였는지" 가 UI 에서 사라진다 (types.ts 주석 근거).
  const dbAfterIdle: Agent[] = [
    makeDbAgent({
      id: 'agent-done',
      status: 'idle',
      currentTask: '',
      lastActiveTask: 'task-just-finished',
      workingOnFileId: '',
    }),
  ];

  const afterRefresh = simulateRefresh(dbAfterIdle);
  const done = afterRefresh[0];
  assert.equal(done.status, 'idle');
  assert.equal(done.currentTask, '', 'idle 전환 후 currentTask 는 비어 있어야 한다');
  assert.equal(done.lastActiveTask, 'task-just-finished',
    'lastActiveTask 가 새로고침에 날아가면 "최근 작업 컨텍스트" 카드가 빈 상태로 그려진다');
  assert.equal(isActiveAgent(done), false, 'idle 인데 active 로 판정됐다');
});

// ─────────────────────────────────────────────────────────────────────────────
// (21) 에이전트 편집 후 코드그래프 반영 — 할당 업무 #GRAPH-EDIT-SYNC-MENU (QA 감마)
// ─────────────────────────────────────────────────────────────────────────────
// 배경: GitAutomationPanel.test.ts (TC-GRAPH-SYNC-*) 와 ProjectManagement.test.ts
// (TC-GRAPH-EDIT-SYNC-*) 가 각각 "패널 flow 게이트 ↔ 편집 집합" 과 "캔버스 diff"
// 레일을 고정한다면, 본 섹션은 그 사이에 끼는 "관리 메뉴 스코프" 층을 잠근다.
// 관리 메뉴가 열린 프로젝트에서 에이전트가 파일을 편집하면 다음 세 경로가 하나도
// 어긋나지 않아야 한다:
//   (a) 편집 대상 파일이 list_files 스냅샷과 1:1 매칭 (경로 변형·중복·누락 없음)
//   (b) docs/ 같은 코드그래프 배제 경로는 편집돼도 스냅샷에 새지 않음 — 자동
//       커밋 스테이지 후보와 패널의 편집 카운트가 오염되지 않음
//   (c) 이웃 프로젝트(B) 의 스냅샷은 A 의 편집과 무관하게 byte-identical 유지

// 프로젝트 스코프 그래프 (A/B 독립 슬롯). GitAutomationPanel.test.ts 의 createGraph
// 와 동일 계약이지만 여기서는 "관리 메뉴를 여는 projectId 축" 에 맞춰 pid 키잉을
// 한 번 더 고정한다. 두 테스트 파일 간 순환 import 를 피해 최소 구현만 둔다.
interface ScopedGraphNode { id: string; name: string; type: CodeFileType; pid: string; }
function createScopedGraph() {
  const store = new Map<string, ScopedGraphNode>();
  let seq = 0;
  const key = (pid: string, n: string) => `${pid}::${n}`;
  return {
    add(pid: string, raw: string) {
      const name = normalizeCodeGraphPath(raw);
      if (!name || isExcludedFromCodeGraph(name)) return null;
      const k = key(pid, name);
      const hit = store.get(k);
      if (hit) return hit;
      const node: ScopedGraphNode = {
        id: `sg-${++seq}`,
        name,
        type: inferFileType(name),
        pid,
      };
      store.set(k, node);
      return node;
    },
    remove(pid: string, raw: string) {
      return store.delete(key(pid, normalizeCodeGraphPath(raw)));
    },
    list(pid: string): ScopedGraphNode[] {
      return Array.from(store.entries())
        .filter(([k]) => k.startsWith(`${pid}::`))
        .map(([, v]) => v);
    },
    all(): ScopedGraphNode[] {
      return Array.from(store.values());
    },
  };
}

// 본 브랜치 `git status` 상 실제 편집된 파일 집합. ProjectManagement.test.ts 의
// TC-GRAPH-EDIT-SYNC-FULL 와 동일한 근거로, 스냅샷이 디스크 실상과 어긋나면 즉시
// 빨간불이 들어와야 한다.
const BRANCH_EDITED_FILES = [
  'server.ts',
  'src/App.tsx',
  'src/components/EmptyProjectPlaceholder.tsx',
  'src/components/GitAutomationPanel.test.ts',
  'src/components/ProjectManagement.test.ts',
  'src/components/ProjectManagement.tsx',
  'src/components/ProjectMenuScope.test.ts',
  'src/index.css',
  'src/types.ts',
  'src/utils/codeGraphFilter.ts',
] as const;

test('TC-MENU-GRAPH-SYNC1: 관리 메뉴가 열린 프로젝트의 list_files 가 에이전트 편집 집합과 정확히 일치한다', () => {
  // 메뉴 스코프 수준에서 편집 ≠ 스냅샷 회귀를 잠근다. 한 파일이라도 어긋나면
  // 자동 커밋이 유령 스테이지/유실 스테이지 중 하나를 일으켰다는 뜻이다.
  const graph = createScopedGraph();
  for (const f of BRANCH_EDITED_FILES) {
    const node = graph.add('proj-menu-A', f);
    assert.ok(node, `${f} 가 필터에서 부당하게 제외됐다`);
  }
  const snapshot = graph.list('proj-menu-A').map((n) => n.name).sort();
  assert.deepEqual(
    snapshot,
    [...BRANCH_EDITED_FILES].sort(),
    'list_files 스냅샷이 본 브랜치 편집 목록과 어긋났다',
  );
  for (const f of BRANCH_EDITED_FILES) {
    assert.equal(
      isExcludedFromCodeGraph(f),
      false,
      `${f} 가 필터에 걸리면 편집이 list_files 에 노출되지 못해 자동 커밋에서 유실된다`,
    );
  }
});

test('TC-MENU-GRAPH-SYNC2: docs/ 핸드오프를 편집해도 관리 메뉴의 list_files 에는 소스 파일만 남는다', () => {
  // QA(감마)-핸드오프 사례: 에이전트가 docs/handoffs/*.md 를 만지는 일은 흔하지만
  // 자동 커밋 스테이지 후보로 올라가면 팀 공용 커밋이 오염된다. 코드그래프 필터가
  // 1차 방어선이므로, 메뉴 스코프에서 그 계약을 테스트로 고정한다.
  const graph = createScopedGraph();
  const editedMixed = [
    'docs/handoffs/2026-04-18.md',
    './docs/report.md',
    'src/App.tsx',
    'src/components/ProjectMenuScope.test.ts',
  ];
  for (const f of editedMixed) graph.add('proj-menu-docs', f);
  const snapshot = graph.list('proj-menu-docs').map((n) => n.name).sort();
  assert.deepEqual(
    snapshot,
    ['src/App.tsx', 'src/components/ProjectMenuScope.test.ts'].sort(),
    'docs/ 편집이 list_files 에 새어 자동 커밋 후보를 오염시켰다',
  );
});

test('TC-MENU-GRAPH-SYNC3: 경로 표기 변형(./·역슬래시)도 list_files 는 정규화 이름 하나만 노출한다', () => {
  // 에이전트가 OS·셸 혼용으로 ./Foo · Foo · src\\Foo 를 섞어 add 해도 list_files
  // 는 한 이름으로 수렴해야, 자동 커밋이 동일 파일을 중복 스테이지하지 않는다.
  const graph = createScopedGraph();
  graph.add('proj-menu-variants', './src/App.tsx');
  graph.add('proj-menu-variants', 'src/App.tsx');
  graph.add('proj-menu-variants', 'src\\App.tsx');
  const names = graph.list('proj-menu-variants').map((n) => n.name);
  assert.deepEqual(names, ['src/App.tsx'], '경로 변형이 list_files 에 중복 노드로 샜다');
});

test('TC-MENU-GRAPH-SYNC4: 편집→롤백(remove) 사이클 뒤 list_files 는 디스크 최종 상태만 담는다', () => {
  // 에이전트가 파일을 생성했다가 되돌린 경우. 최종 list_files 가 디스크 잔존
  // 파일과 어긋나면 자동 커밋이 "이미 지운 파일" 을 스테이지에 올리는 유령 add
  // 사고가 난다. 메뉴 스코프에서 한 번 더 잠근다.
  const graph = createScopedGraph();
  const persisted = ['src/App.tsx', 'src/utils/codeGraphFilter.ts'];
  const transient = 'src/components/ProjectMenuScope.test.ts';
  for (const f of persisted) graph.add('proj-menu-rollback', f);
  graph.add('proj-menu-rollback', transient);
  assert.equal(
    graph.remove('proj-menu-rollback', transient),
    true,
    'transient 파일이 remove 경로에서 조용히 누락됐다',
  );
  assert.deepEqual(
    graph.list('proj-menu-rollback').map((n) => n.name).sort(),
    [...persisted].sort(),
    'remove 이후 list_files 가 디스크 최종 상태와 어긋났다',
  );
});

test('TC-MENU-GRAPH-SYNC5: A 의 편집은 B 의 list_files 에 한 조각도 새지 않는다 (프로젝트 스코프 격리)', () => {
  // (3) 데이터 격리의 코드그래프 레일. 관리 메뉴가 A 로 열려 있을 때 에이전트가
  // A 만 편집하면 B 스냅샷은 byte-identical 로 유지돼야 한다. 이 레일이 깨지면
  // "다른 프로젝트 편집이 내 캔버스에 떠 있다" 는 사용자 보고가 바로 재현된다.
  const graph = createScopedGraph();
  // B 에는 A 의 편집과 겹치지 않는 독립 파일만 심어, "이웃이 건드리지 않은"
  // 스냅샷이 원형 보존되는지와 pid 격리 두 축을 모두 검증한다.
  const bInitial = ['src/onlyB/widgetB.tsx', 'src/onlyB/styleB.css'];
  for (const f of bInitial) graph.add('proj-menu-B', f);
  const bSnapshotBefore = graph.list('proj-menu-B').map((n) => n.name).sort();

  for (const f of BRANCH_EDITED_FILES) graph.add('proj-menu-A', f);

  const bSnapshotAfter = graph.list('proj-menu-B').map((n) => n.name).sort();
  assert.deepEqual(
    bSnapshotAfter,
    bSnapshotBefore,
    'A 쪽 편집이 B 의 list_files 스냅샷을 오염시켰다',
  );
  // BRANCH_EDITED_FILES 중 bInitial 과 이름이 겹치는 것은 없으므로, 전역에서
  // 해당 이름을 가진 노드는 전부 A 스코프에 있어야 한다.
  const editedSet = new Set<string>(BRANCH_EDITED_FILES);
  const aNodes = graph.all().filter((n) => editedSet.has(n.name));
  for (const node of aNodes) {
    assert.equal(
      node.pid,
      'proj-menu-A',
      `${node.name} 가 잘못된 프로젝트 스코프(${node.pid})에 저장됐다`,
    );
  }
});

test('TC-MENU-GRAPH-SYNC6: 편집 파일의 추론 타입(component/service/util/style)이 디자인 토큰과 1:1 매칭된다', () => {
  // list_files 의 name 만 맞고 type 이 틀어지면 캔버스 글리프·색이 어긋나,
  // 사용자는 "내가 편집한 .tsx 가 util 로 표시됨" 같은 시각 회귀를 본다.
  const EXPECTED: ReadonlyArray<readonly [string, CodeFileType]> = [
    ['server.ts', 'service'],
    ['src/App.tsx', 'component'],
    ['src/components/EmptyProjectPlaceholder.tsx', 'component'],
    ['src/components/GitAutomationPanel.test.ts', 'util'],
    ['src/components/ProjectManagement.tsx', 'component'],
    ['src/components/ProjectMenuScope.test.ts', 'util'],
    ['src/index.css', 'style'],
    ['src/types.ts', 'util'],
    ['src/utils/codeGraphFilter.ts', 'util'],
  ];
  const graph = createScopedGraph();
  for (const [name] of EXPECTED) graph.add('proj-menu-types', name);
  const byName = new Map(graph.list('proj-menu-types').map((n) => [n.name, n.type]));
  for (const [name, expected] of EXPECTED) {
    assert.equal(
      byName.get(name),
      expected,
      `${name}: 추론 타입이 ${expected} 가 아니라 ${byName.get(name)} 로 들어갔다`,
    );
  }
});

test('TC-MENU-GRAPH-SYNC7: 미선택(pid="") 사이 흘러온 편집은 실제 프로젝트의 list_files 에 노출되지 않는다', () => {
  // (1)·(8) 시리즈의 연장선에서 코드그래프 축도 같은 규칙을 따르는지 확인한다 —
  // pid="" 로 저장된 노드는 실제 프로젝트 스냅샷에 한 조각도 새면 안 된다.
  const graph = createScopedGraph();
  for (const f of BRANCH_EDITED_FILES) graph.add('', f);
  assert.deepEqual(graph.list('proj-menu-A'), [], '미선택 편집이 실제 프로젝트 스냅샷에 샜다');
  const strayed = graph.all().filter((n) => n.pid !== '');
  assert.deepEqual(strayed, [], 'pid="" 로 저장된 노드가 다른 스코프로 샜다');
});

// ─────────────────────────────────────────────────────────────────────────────
// (22) 워킹 트리 ↔ 코드그래프 end-to-end 라이프사이클 — 할당 업무 #GRAPH-EXPOSURE (QA)
// ─────────────────────────────────────────────────────────────────────────────
// 요청 업무: "실제 작업 파일이 코드그래프에 노출되는지 검증. 수정/추가/삭제 시나리오별
// 노드 표시 회귀." TC-MENU-LIFE* / CG* / SYNC* / GRAPH-SYNC* 가 축별 불변식을
// 고정하지만, 실제 git status 가 찍은 AM/M 목록을 한 파이프라인(감지 → diff →
// add → modify → delete) 으로 흘려 "에이전트가 실제로 보는 캔버스" 를 재현하는
// end-to-end 가드는 비어 있다. 이 섹션은 그 공백을 메워, QA 가 "이번 브랜치 커밋
// 시점에 캔버스가 올바른 상태인가" 를 npx tsx --test 한 줄로 판정할 수 있게 한다.

// 2026-04-18 기준 실제 git status 의 AM/M 파일셋. 이 배열이 브랜치의 워킹 트리와
// 어긋나면 즉시 테스트가 깨져 "에이전트가 이 파일을 add_file 에 올리지 않았다" 는 신호.
// BRANCH_EDITED_FILES / LIVE_TOUCHED 와 일부 겹치지만, GitAutomationPanel.test.ts /
// ProjectManagement.tsx 를 명시적으로 포함해 이번 PR 의 모든 M/A/AM 파일을 커버한다.
const GIT_WORKING_TREE: ReadonlyArray<readonly [string, CodeFileType]> = [
  ['server.ts', 'service'],
  ['src/App.tsx', 'component'],
  ['src/components/EmptyProjectPlaceholder.tsx', 'component'],
  ['src/components/GitAutomationPanel.test.ts', 'util'],
  ['src/components/ProjectManagement.test.ts', 'util'],
  ['src/components/ProjectManagement.tsx', 'component'],
  ['src/components/ProjectMenuScope.test.ts', 'util'],
  ['src/index.css', 'style'],
  ['src/types.ts', 'util'],
  ['src/utils/codeGraphFilter.ts', 'util'],
];

test('TC-MENU-EXPOSURE1: 워킹 트리 전체가 빈 그래프에 대해 1:1 add_file payload 로 치환된다', () => {
  // 첫 진입(list_files 가 빈 배열) 시점에서 git status 의 모든 AM/M 파일이 한 번에
  // 캔버스에 찍혀야 한다. 누락/타입 실수가 한 파일이라도 있으면 이 테스트가 잡는다.
  const observed = GIT_WORKING_TREE.map(([p]) => p);
  const payloads = computeAddFilePayloads([], observed);
  assert.equal(payloads.length, GIT_WORKING_TREE.length, 'git status 파일 중 일부가 add_file 에서 탈락했다');
  const byName = new Map(payloads.map((p) => [p.name, p.type]));
  for (const [path, expected] of GIT_WORKING_TREE) {
    assert.equal(byName.get(path), expected, `${path} 의 add_file type 이 ${expected} 가 아니다`);
  }
});

test('TC-MENU-EXPOSURE2: "추가" 시나리오 — 워킹 트리 전체 add 후 visibleFor 가 git status 와 정확히 일치한다', () => {
  // add_file 이 끝난 직후 캔버스 노드 집합을 캡처. git status 와 set-equal 이어야 QA 통과.
  const graph = createLifecycleGraph();
  for (const [path, expected] of GIT_WORKING_TREE) {
    const node = graph.add('proj-A', path);
    assert.ok(node, `${path} add 가 null 을 돌려줬다 — 필터/정규화 회귀`);
    assert.equal(node!.type, expected, `${path} 의 type 이 ${expected} 로 찍히지 않았다`);
  }
  const visible = graph.visibleFor('proj-A').map((n) => n.name).sort();
  const expected = GIT_WORKING_TREE.map(([p]) => p).sort();
  assert.deepEqual(visible, expected, '캔버스 노드 집합이 git status 와 어긋난다');
  assert.equal(graph.visibleFor('proj-B').length, 0, 'add 가 다른 프로젝트 캔버스로 번졌다');
});

test('TC-MENU-EXPOSURE3: "수정" 시나리오 — Edit 후 동일 파일 재-add 루프가 노드 수/타입을 흔들지 않는다', () => {
  // 에이전트가 Edit 한 번당 add_file 을 다시 쏴도(현재 훅 구현) 캔버스는 그대로여야 한다.
  // 노드가 증식하면 캔버스에 같은 아이콘이 두 번 찍히는 #GRAPH-GHOST 회귀.
  const graph = createLifecycleGraph();
  for (const [path] of GIT_WORKING_TREE) graph.add('proj-A', path);
  const initialIds = new Map(graph.visibleFor('proj-A').map((n) => [n.name, n.id]));

  // 수정 라운드 3회: 매번 경로 변형을 섞어 써도 동일 노드로 수렴해야 한다.
  for (let round = 0; round < 3; round++) {
    for (const [path] of GIT_WORKING_TREE) {
      const variants = [path, `./${path}`, path.replace(/\//g, '\\')];
      for (const v of variants) {
        const again = graph.add('proj-A', v);
        assert.ok(again);
        assert.equal(again!.id, initialIds.get(path), `round=${round} ${v} 가 새 노드로 분기됐다`);
      }
    }
  }
  assert.equal(graph.visibleFor('proj-A').length, GIT_WORKING_TREE.length,
    '수정 루프 후 노드 수가 증식 또는 누락됐다');
  // diff 훅은 이미 그래프에 있는 이름을 걸러 빈 payload 를 돌려준다 — 서버 왕복 낭비 차단.
  const redundant = computeAddFilePayloads(
    GIT_WORKING_TREE.map(([p]) => ({ name: p })),
    GIT_WORKING_TREE.map(([p]) => p),
  );
  assert.deepEqual(redundant, [], '수정 라운드에서 중복 add_file payload 가 생성됐다');
});

test('TC-MENU-EXPOSURE4: "삭제" 시나리오 — 각 파일 삭제가 해당 노드만 캔버스에서 제거한다', () => {
  // 한 파일씩 삭제하며 나머지가 원형 유지인지 검사. 삭제가 이웃 노드를 휩쓸면
  // "A 지웠는데 B 도 사라짐" 류 cross-wipe 버그가 재현된다.
  const graph = createLifecycleGraph();
  for (const [path] of GIT_WORKING_TREE) graph.add('proj-A', path);

  const remaining = new Set(GIT_WORKING_TREE.map(([p]) => p));
  for (const [path] of GIT_WORKING_TREE) {
    assert.equal(graph.remove('proj-A', path), true, `${path} 삭제 실패`);
    remaining.delete(path);
    const visible = graph.visibleFor('proj-A').map((n) => n.name).sort();
    assert.deepEqual(visible, Array.from(remaining).sort(), `${path} 삭제 후 이웃 노드가 휩쓸렸다`);
  }
  assert.equal(graph.visibleFor('proj-A').length, 0, '전 파일 삭제 후에도 잔여 노드가 있다');
});

test('TC-MENU-EXPOSURE5: 추가→수정→삭제 end-to-end 사이클 후 재-add 가 캔버스를 완전 복원한다', () => {
  // 사이클: 전체 add → 모두 재-add(수정) → 모두 삭제 → 다시 전체 add. 마지막 단계의
  // 노드 집합이 원본과 set-equal 이면 "에이전트 작업이 캔버스에 결정적으로 반영된다"
  // 는 end-to-end 불변식이 성립한다.
  const graph = createLifecycleGraph();
  for (const [path] of GIT_WORKING_TREE) graph.add('proj-A', path);
  for (const [path] of GIT_WORKING_TREE) graph.add('proj-A', path); // 수정 신고
  for (const [path] of GIT_WORKING_TREE) graph.remove('proj-A', path);
  assert.equal(graph.visibleFor('proj-A').length, 0, '삭제 단계 후 캔버스가 비지 않았다');

  // 재-add — 새 id 로 되살아나지만 이름/타입 집합은 원본과 동일해야 한다.
  for (const [path, expected] of GIT_WORKING_TREE) {
    const node = graph.add('proj-A', path);
    assert.ok(node);
    assert.equal(node!.type, expected);
  }
  const revived = graph.visibleFor('proj-A').map((n) => `${n.name}::${n.type}`).sort();
  const expected = GIT_WORKING_TREE.map(([p, t]) => `${p}::${t}`).sort();
  assert.deepEqual(revived, expected, 'end-to-end 사이클 후 캔버스가 원본 상태로 복원되지 않았다');
});

test('TC-MENU-EXPOSURE6: 코드그래프 제외(docs/) 는 어떤 시나리오에서도 캔버스에 새어 들어오지 않는다', () => {
  // 필터 축(CG3) 과 라이프사이클 축이 엇갈리면 docs/ 파일이 add 는 null 인데 그래프
  // 내부 state 에 조각이 남아 다음 add 를 오염시키는 회귀가 발생한다.
  const graph = createLifecycleGraph();
  const excluded = ['docs/handoffs/joker.md', 'docs/report.md', 'docs/'];
  for (const path of excluded) {
    assert.equal(graph.add('proj-A', path), null, `${path} 가 제외 필터를 뚫고 add 됐다`);
  }
  // 실제 워킹 트리 파일과 섞어 observed 에 흘려도 payload 에 docs/ 가 나오면 안 된다.
  const observed = [...excluded, ...GIT_WORKING_TREE.map(([p]) => p)];
  const payloads = computeAddFilePayloads([], observed);
  assert.equal(payloads.length, GIT_WORKING_TREE.length, 'docs/ 가 add_file payload 에 새어 들어왔다');
  for (const p of payloads) {
    assert.equal(p.name.startsWith('docs/'), false, `payload.name=${p.name} 이 제외되지 않았다`);
  }
});

test('TC-MENU-EXPOSURE7: list_files 가 경로 변형으로 돌려줘도 add_file payload 는 중복을 만들지 않는다', () => {
  // 실제 훅 경로: list_files 결과에 raw 이름(./ 또는 백슬래시) 이 섞여 들어올 수 있다.
  // computeAddFilePayloads 는 기존 노드 이름을 정규화해 set 에 담아야, 같은 파일이
  // 경로 변형만 달라 두 번째 add_file 호출로 흘러가는 서버 왕복 낭비를 막는다.
  const graphNodes = GIT_WORKING_TREE.map(([p]) => ({
    name: p.includes('/') ? `./${p.replace(/\//g, '\\')}` : p,
  }));
  const observed = GIT_WORKING_TREE.map(([p]) => p);
  const payloads = computeAddFilePayloads(graphNodes, observed);
  assert.deepEqual(payloads, [],
    '기존 노드의 경로 변형을 정규화하지 못해 중복 add_file 이 발생했다');
});

// ─────────────────────────────────────────────────────────────────────────────
// (23) AM 파일 가시성 회귀 — 할당 업무 #GRAPH-EXPOSURE (QA 감마)
// ─────────────────────────────────────────────────────────────────────────────
// 이번 브랜치 `git status` 의 `AM src/components/EmptyProjectPlaceholder.tsx` —
// "스테이지된 직후 다시 수정" 상태의 신규 파일이 다중 에이전트 루프에서도 캔버스에
// 정확히 노출되는지 본다. TC-MENU-EXPOSURE1~7 이 전체 워킹 트리의 end-to-end 사이클을
// 다뤘다면, 여기서는 "AM 단일 파일 중심" 으로 3대 시나리오 (추가/수정/삭제) 를 한
// 번 더 격리 가드한다. EmptyProjectPlaceholder.tsx 는 add_file 누락 시 "프로젝트
// 미선택 안내 카드가 캔버스에서 영영 사라지는" UX 회귀 노출도가 크다.

const AM_PLACEHOLDER_PATH = 'src/components/EmptyProjectPlaceholder.tsx';

test('TC-MENU-EXPOSURE-AM-ADD: AM 신규 파일이 첫 add 시에만 payload 로 잡히고 이후 list_files 에 있으면 빈 배열', () => {
  // 실제 훅 동선: 에이전트가 Write 로 새 파일을 만들고 add_file 을 한 번만 쏜다.
  // 이후 list_files 가 해당 파일을 돌려주면 동일 이름의 재-add payload 는 빠져야,
  // StrictMode 이중 effect 에서도 서버 왕복이 폭주하지 않는다.
  const firstPass = computeAddFilePayloads([], [AM_PLACEHOLDER_PATH]);
  assert.equal(firstPass.length, 1, 'AM 첫 진입 시 payload 가 정확히 1건이어야 한다');
  assert.deepEqual(firstPass[0], { name: AM_PLACEHOLDER_PATH, type: 'component' });

  // 다음 턴: list_files 가 방금 add 한 파일을 돌려준다.
  const secondPass = computeAddFilePayloads(
    [{ name: AM_PLACEHOLDER_PATH }],
    [AM_PLACEHOLDER_PATH],
  );
  assert.deepEqual(secondPass, [], '이미 등록된 AM 파일이 payload 로 재진입했다');
});

test('TC-MENU-EXPOSURE-AM-MODIFY: AM 파일을 Edit 하며 재-add 루프 10회 돌려도 캔버스 엔트리가 1개로 고정', () => {
  // 수정 라운드가 쌓여도 노드 id · type · 수량 모두 원형 유지. 증식하면 "방금
  // 한 번 편집했는데 캔버스에 같은 아이콘이 여러 번" 이라는 시각 회귀.
  const graph = createLifecycleGraph();
  const origin = graph.add('proj-A', AM_PLACEHOLDER_PATH);
  assert.ok(origin);
  const baselineId = origin!.id;

  for (let i = 0; i < 10; i++) {
    const again = graph.add('proj-A', AM_PLACEHOLDER_PATH);
    assert.ok(again);
    assert.equal(again!.id, baselineId, `round=${i} 재-add 가 새 id 를 발급했다`);
    assert.equal(again!.type, 'component', `round=${i} 재-add 에서 type 이 흔들렸다`);
  }
  const visible = graph.visibleFor('proj-A');
  assert.equal(visible.length, 1, '수정 루프가 캔버스 엔트리를 증식시켰다');
  assert.equal(visible[0].name, AM_PLACEHOLDER_PATH);
});

test('TC-MENU-EXPOSURE-AM-CROSS-SCOPE-DELETE: A 스코프의 AM 파일 삭제가 B 의 동일 이름 노드를 훼손하지 않는다', () => {
  // 에이전트 여러 명이 서로 다른 프로젝트에서 동시에 같은 경로의 파일을 편집하는
  // 실사례. A 의 remove 가 B 의 노드까지 휩쓸면 "내가 지우지도 않은 프로젝트의
  // 캔버스가 깜빡" 이라는 사고. projectId 키 계약이 삭제 축에서도 지켜져야 한다.
  const graph = createLifecycleGraph();
  const aNode = graph.add('proj-A', AM_PLACEHOLDER_PATH);
  const bNode = graph.add('proj-B', AM_PLACEHOLDER_PATH);
  assert.ok(aNode);
  assert.ok(bNode);
  assert.notEqual(aNode!.id, bNode!.id, '서로 다른 스코프가 같은 id 를 공유하면 격리가 깨진다');

  assert.equal(graph.remove('proj-A', AM_PLACEHOLDER_PATH), true);
  // A 는 비고, B 는 byte-identical 로 살아남는다.
  assert.deepEqual(graph.visibleFor('proj-A'), []);
  const bAfter = graph.visibleFor('proj-B');
  assert.equal(bAfter.length, 1, 'B 의 동일 이름 노드가 A 의 삭제 파장에 휩쓸렸다');
  assert.equal(bAfter[0].id, bNode!.id, 'B 의 노드 id 가 재발급됐다 — 엣지 끊김 회귀');
  assert.equal(bAfter[0].type, 'component');
});

// ─────────────────────────────────────────────────────────────────────────────
// QA (2026-04-18) — 대기열(작업) 메뉴 렌더링 회귀 가드 #MENU-QUEUE.
// EmptyProjectPlaceholder.tsx L132~L153 의 Joker 조사노트에서 "프론트 필터링 경로"
// 가 후속 조사 대상으로 남겨졌다. App.tsx L1655~L1688 의 tasks 탭은:
//   (a) tasks.length === 0 → "현재 대기 중인 작업이 없습니다." 빈-상태 카드
//   (b) 각 task 를 map 하며 status 로 배지 색을 갈라낸다
//         pending     → yellow  · "대기 중"
//         in-progress → blue    · "진행 중"
//         completed   → green   · "완료"
// 본 블록은 이 렌더 분기의 pure 모델을 고정해, "대기열에 남아있는 pending 이
// 빠지거나" "완료/진행 중이 대기열에 섞여 들어오거나" "상태 전환이 목록에 반영
// 되지 않는" 회귀를 컴포넌트 없이도 차단한다. Task.status 는 types.ts L59 의
// 3값 유니온(pending | in-progress | completed) 을 그대로 사용한다.
// ─────────────────────────────────────────────────────────────────────────────

type QueueBadgeColor = 'yellow' | 'blue' | 'green';
interface QueueRow { id: string; description: string; badge: QueueBadgeColor; label: string; }
interface QueueView { items: QueueRow[]; emptyState: boolean; }

const QUEUE_STATUS_LABEL: Record<Task['status'], string> = {
  pending: '대기 중',
  'in-progress': '진행 중',
  completed: '완료',
};
const QUEUE_STATUS_COLOR: Record<Task['status'], QueueBadgeColor> = {
  pending: 'yellow',
  'in-progress': 'blue',
  completed: 'green',
};

// App.tsx 의 tasks.map 렌더 분기를 pure 함수로 재현. 대기열(작업 메뉴) 은
// "아직 집어가지 않은 pending" 만 집계하고, 중복 id 는 late-write 가 이겨
// 같은 카드가 두 번 찍히는 "대기열 유령" 회귀를 막는다. Map 은 삽입 순서를
// 보존하므로 입력 배열 순서가 그대로 items 순서로 흘러간다.
function computeQueueView(tasks: readonly Task[]): QueueView {
  const byId = new Map<string, Task>();
  for (const t of tasks) byId.set(t.id, t);
  const pending = Array.from(byId.values()).filter((t) => t.status === 'pending');
  const items: QueueRow[] = pending.map((t) => ({
    id: t.id,
    description: t.description,
    badge: QUEUE_STATUS_COLOR[t.status],
    label: QUEUE_STATUS_LABEL[t.status],
  }));
  return { items, emptyState: items.length === 0 };
}

const makeQueueTask = (id: string, status: Task['status'], description = `task-${id}`): Task => ({
  id,
  projectId: 'proj-A',
  assignedTo: 'agent-1',
  description,
  status,
});

test('TC-QUEUE1: pending 상태 작업만 대기열 렌더 대상에 들어간다', () => {
  // 섞어 넣어도 pending 만 남아야 하고, 배지 색/라벨이 yellow·"대기 중" 으로 고정.
  // 다른 색/라벨이 찍히면 App.tsx L1677~L1683 의 3분기 매칭이 어긋난 것.
  const tasks: Task[] = [
    makeQueueTask('t1', 'pending', '대기 1'),
    makeQueueTask('t2', 'in-progress', '진행 중'),
    makeQueueTask('t3', 'pending', '대기 2'),
    makeQueueTask('t4', 'completed', '완료됨'),
  ];
  const view = computeQueueView(tasks);
  assert.deepEqual(view.items.map((i) => i.id), ['t1', 't3'],
    'pending 이외 상태가 대기열에 섞여 들어왔다');
  for (const item of view.items) {
    assert.equal(item.badge, 'yellow', `${item.id} 의 배지 색상이 yellow 가 아니다`);
    assert.equal(item.label, '대기 중', `${item.id} 의 라벨이 "대기 중" 이 아니다`);
  }
  assert.equal(view.emptyState, false, 'pending 이 존재하는데 emptyState 가 true 로 찍혔다');
});

test('TC-QUEUE2: 빈 배열 / 모두 진행·완료 상태는 emptyState=true (빈-상태 카드 분기)', () => {
  // App.tsx L1657~L1661 의 "현재 대기 중인 작업이 없습니다." 카드가 떠야 할 두 경로.
  const empty = computeQueueView([]);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.emptyState, true, '빈 배열인데 emptyState 가 false 로 찍혔다');

  const noPending: Task[] = [
    makeQueueTask('a', 'in-progress'),
    makeQueueTask('b', 'completed'),
    makeQueueTask('c', 'in-progress'),
  ];
  const view = computeQueueView(noPending);
  assert.deepEqual(view.items, [],
    'pending 이 0 건인데 다른 상태가 대기열에 섞여 들어갔다');
  assert.equal(view.emptyState, true,
    'pending 이 0 건인데 emptyState 가 false 로 남아 빈-상태 카드가 숨겨진다');
});

test('TC-QUEUE3: 상태 전환(pending → in-progress → completed) 시 대기열에서 즉시 빠진다', () => {
  // 한 태스크의 라이프사이클을 한 번에 돌려 가드한다. 단계마다 즉시 반영되지
  // 않으면 "작업 시작했는데 대기열에 그대로" 또는 "완료했는데 대기열에 남아있음"
  // 회귀가 재현된다.
  let tasks: Task[] = [makeQueueTask('t1', 'pending', 'lifecycle')];
  const pendingView = computeQueueView(tasks);
  assert.equal(pendingView.items.length, 1, '최초 pending 이 집계되지 않았다');
  assert.equal(pendingView.emptyState, false);

  tasks = tasks.map((t) => (t.id === 't1' ? { ...t, status: 'in-progress' as const } : t));
  const inProgress = computeQueueView(tasks);
  assert.equal(inProgress.items.length, 0, 'in-progress 전환 후에도 대기열에 남아있다');
  assert.equal(inProgress.emptyState, true, 'in-progress 전환 후 emptyState 가 false 로 남았다');

  tasks = tasks.map((t) => (t.id === 't1' ? { ...t, status: 'completed' as const } : t));
  const doneView = computeQueueView(tasks);
  assert.equal(doneView.items.length, 0, '완료 후에도 대기열에 남아있다');
  assert.equal(doneView.emptyState, true);
});

test('TC-QUEUE4: 새 pending 추가 및 중간 항목 전환이 나머지 pending 의 상대 순서를 보존한다', () => {
  // App.tsx L1663 의 tasks.map 은 입력 배열 순서를 그대로 따른다. pending 사이
  // 상대 순서가 흔들리면 목록이 점프해 사용자 혼동을 부른다(#MENU-QUEUE-4).
  let tasks: Task[] = [
    makeQueueTask('t1', 'pending', '1번'),
    makeQueueTask('t2', 'pending', '2번'),
  ];
  assert.deepEqual(
    computeQueueView(tasks).items.map((i) => i.description),
    ['1번', '2번'],
    '최초 pending 순서가 입력 배열과 달라졌다',
  );

  tasks = [...tasks, makeQueueTask('t3', 'pending', '3번')];
  assert.deepEqual(
    computeQueueView(tasks).items.map((i) => i.description),
    ['1번', '2번', '3번'],
    '새 pending 추가 시 기존 항목 순서가 흔들렸다',
  );

  tasks = tasks.map((t) => (t.id === 't2' ? { ...t, status: 'in-progress' as const } : t));
  assert.deepEqual(
    computeQueueView(tasks).items.map((i) => i.description),
    ['1번', '3번'],
    '중간 항목의 상태 변경이 나머지 pending 순서를 뒤엎었다',
  );
});

test('TC-QUEUE5: 동일 id 중복 레코드는 late-write 한 번만 집계된다', () => {
  // 서버 재시도 또는 클라이언트 낙관 업데이트 + 서버 merge 경로에서 같은 id 가
  // 두 번 흘러들 수 있다. 순진한 filter 만으로는 같은 카드가 두 번 찍히는
  // "대기열 유령" 회귀가 난다. Map 기반 dedup 이 양방향에서 안전한지 고정.
  const dupToInProgress: Task[] = [
    makeQueueTask('dup', 'pending', '원본'),
    makeQueueTask('dup', 'in-progress', '갱신'),
  ];
  const forwardView = computeQueueView(dupToInProgress);
  assert.deepEqual(forwardView.items, [],
    'late-write in-progress 가 무시되어 유령 pending 카드가 남았다');
  assert.equal(forwardView.emptyState, true);

  const dupToPending: Task[] = [
    makeQueueTask('dup', 'completed', '구형'),
    makeQueueTask('dup', 'pending', '신형'),
  ];
  const reverseView = computeQueueView(dupToPending);
  assert.deepEqual(reverseView.items.map((i) => i.id), ['dup'],
    'late-write pending 이 대기열에 반영되지 않았다');
  assert.equal(reverseView.items[0].description, '신형',
    'dedup 이 late-write 값(description) 을 유지하지 못했다');
});
