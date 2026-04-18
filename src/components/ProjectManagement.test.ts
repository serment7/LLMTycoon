// Run with: npx tsx --test src/components/ProjectManagement.test.ts
//
// 감마(QA): PR 대상 고정 선택(핀) 영속성 테스트.
// loadUserPreferences/saveUserPreferences 만 단위 테스트 대상으로 삼는다 —
// 컴포넌트 렌더링은 별도 JSDOM harness 도입 후 통합 테스트로 보강 예정.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadUserPreferences,
  saveUserPreferences,
  migrateUserPreferencesToProject,
  formatEditingProjectLabel,
  describeProjectScope,
  PROJECT_SCOPE_LABEL,
  PROJECT_SCOPE_TOOLTIP,
} from './ProjectManagement.tsx';
import { EmptyProjectPlaceholder } from './EmptyProjectPlaceholder.tsx';
import { isActiveAgent } from './AgentStatusPanel.tsx';
import { USER_PREFERENCES_KEY } from '../types.ts';
import type { Agent, GitAutomationPreference, ManagedProject } from '../types.ts';
import { shouldAutoCommit, shouldAutoPush } from '../utils/gitAutomation.ts';
import {
  inferFileType,
  isExcludedFromCodeGraph,
  normalizeCodeGraphPath,
  type CodeFileType,
} from '../utils/codeGraphFilter.ts';

// 최소 fake localStorage. Node 기본 환경엔 window 가 없으므로 globalThis 에 주입한다.
// 각 케이스마다 새로 세팅해 테스트 간 격리를 보장한다.
interface FakeLocalCtx { store: Map<string, string>; throwOnSet: boolean; }

function installFakeLocalStorage(initial?: string): FakeLocalCtx {
  const ctx: FakeLocalCtx = { store: new Map<string, string>(), throwOnSet: false };
  if (initial !== undefined) ctx.store.set(USER_PREFERENCES_KEY, initial);
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

test('TC-01: 최초 선택 직후 saveUserPreferences 가 JSON 을 기록한다', () => {
  const ctx = installFakeLocalStorage();
  try {
    saveUserPreferences({ pinnedPrTargetProjectId: 'proj-A' });
    const raw = ctx.store.get(USER_PREFERENCES_KEY);
    assert.equal(raw, JSON.stringify({ pinnedPrTargetProjectId: 'proj-A' }));
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-02: 새로고침(재로드) 시 loadUserPreferences 가 저장값을 복원한다', () => {
  installFakeLocalStorage(JSON.stringify({ pinnedPrTargetProjectId: 'proj-B' }));
  try {
    const prefs = loadUserPreferences();
    assert.deepEqual(prefs, { pinnedPrTargetProjectId: 'proj-B' });
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-03: 다른 ID 로 저장하면 localStorage 가 덮어써진다', () => {
  const ctx = installFakeLocalStorage(JSON.stringify({ pinnedPrTargetProjectId: 'proj-A' }));
  try {
    saveUserPreferences({ pinnedPrTargetProjectId: 'proj-C' });
    assert.equal(ctx.store.get(USER_PREFERENCES_KEY), JSON.stringify({ pinnedPrTargetProjectId: 'proj-C' }));
    assert.deepEqual(loadUserPreferences(), { pinnedPrTargetProjectId: 'proj-C' });
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-04: localStorage 미존재 시 기본 동작 ({}) 반환', () => {
  installFakeLocalStorage();
  try {
    assert.deepEqual(loadUserPreferences(), {});
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-E1: 손상된 JSON 은 {} 로 폴백', () => {
  installFakeLocalStorage('{broken-json');
  try {
    assert.deepEqual(loadUserPreferences(), {});
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-E2: 비-문자열 pinnedPrTargetProjectId 는 {} 로 폴백', () => {
  installFakeLocalStorage(JSON.stringify({ pinnedPrTargetProjectId: 42 }));
  try {
    assert.deepEqual(loadUserPreferences(), {});
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-E3: 빈 문자열 id 는 {} 로 폴백 (length 가드)', () => {
  installFakeLocalStorage(JSON.stringify({ pinnedPrTargetProjectId: '' }));
  try {
    assert.deepEqual(loadUserPreferences(), {});
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-E4: 루트가 배열이면 {} 로 폴백', () => {
  installFakeLocalStorage(JSON.stringify([1, 2, 3]));
  try {
    // 배열도 typeof === 'object' 이지만 pinnedPrTargetProjectId 키가 없어 결과적으로 {}.
    assert.deepEqual(loadUserPreferences(), {});
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-E5: 루트가 null 이면 {} 로 폴백', () => {
  installFakeLocalStorage(JSON.stringify(null));
  try {
    assert.deepEqual(loadUserPreferences(), {});
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-E6: setItem 이 throw 해도 saveUserPreferences 는 조용히 실패', () => {
  const ctx = installFakeLocalStorage();
  ctx.throwOnSet = true;
  try {
    assert.doesNotThrow(() => saveUserPreferences({ pinnedPrTargetProjectId: 'proj-Z' }));
    // 저장은 실패했으므로 스토어는 비어 있어야 한다.
    assert.equal(ctx.store.size, 0);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-E8: window 미정의(SSR 유사) 환경에서 load/save 모두 안전', () => {
  // install 하지 않은 채 시작
  delete (globalThis as unknown as { window?: unknown }).window;
  assert.deepEqual(loadUserPreferences(), {});
  assert.doesNotThrow(() => saveUserPreferences({ pinnedPrTargetProjectId: 'proj-X' }));
});

// 감마(QA): Git 자동화 회귀 테스트.
// "한 번 고른 flowLevel 을 매 세션 다시 고르게 만드는" 회귀는 사용자 신뢰를
// 즉시 훼손한다. 저장→재마운트(재-load) 시 설정이 동일하게 돌아오는지 고정한다.
const COMMIT_PUSH_PREFERENCE: GitAutomationPreference = {
  flowLevel: 'commitPush',
  branchTemplate: 'feature/{type}/{slug}',
  commitConvention: 'conventional',
  commitScope: 'api',
  prTitleTemplate: '{type}: {summary}',
  reviewers: ['alice', 'bob'],
};

test('TC-GA1: commit+push 설정 저장 후 재마운트 시 설정값이 그대로 유지된다', () => {
  const ctx = installFakeLocalStorage();
  try {
    // 1) 저장 (첫 마운트)
    saveUserPreferences({ gitAutomation: COMMIT_PUSH_PREFERENCE });
    // 저장된 원문이 GitAutomationPreference 전체를 포함해야 한다.
    const raw = ctx.store.get(USER_PREFERENCES_KEY);
    assert.ok(raw, 'localStorage 에 저장되어야 한다');
    // 2) 재마운트: 새로 load 했을 때 동일한 객체가 복원되어야 한다.
    const restored = loadUserPreferences();
    assert.deepEqual(restored.gitAutomation, COMMIT_PUSH_PREFERENCE);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-GA2: 재마운트 후 복원된 설정이 활성 상태이면 자동 commit+push 가 트리거된다', () => {
  installFakeLocalStorage(JSON.stringify({ gitAutomation: COMMIT_PUSH_PREFERENCE }));
  try {
    const restored = loadUserPreferences();
    assert.ok(restored.gitAutomation, '자동화 설정이 복원되어야 한다');
    // 복원된 설정이 자동 실행 분기(commit/push)를 활성화해야 한다.
    assert.equal(shouldAutoCommit(restored.gitAutomation!), true);
    assert.equal(shouldAutoPush(restored.gitAutomation!), true);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-GA3: 손상된 gitAutomation 필드는 무시하고 나머지 선호는 유지된다', () => {
  // flowLevel 이 허용 목록 밖이면 전체 자동화 블록을 drop 하고,
  // 같이 저장된 pinnedPrTargetProjectId 는 살아남아야 한다.
  installFakeLocalStorage(JSON.stringify({
    pinnedPrTargetProjectId: 'proj-A',
    gitAutomation: { ...COMMIT_PUSH_PREFERENCE, flowLevel: 'yolo' },
  }));
  try {
    const restored = loadUserPreferences();
    assert.equal(restored.pinnedPrTargetProjectId, 'proj-A');
    assert.equal(restored.gitAutomation, undefined);
  } finally { uninstallFakeLocalStorage(); }
});

// 감마(QA): 프로젝트별 설정 격리 테스트.
// 현재 UserPreferences 는 localStorage 단일 키(전역)지만, pinnedPrTargetProjectId 와
// gitAutomation 은 독립 슬롯이어야 한다. 한 쪽 변경이 다른 쪽을 훼손하면, "프로젝트
// 바꾸니 Git 설정이 초기화됐다"는 치명적 회귀로 이어진다. 네 개의 격리 불변식을 고정:
//  - (ISO1) 프로젝트 A 의 핀 변경이 동시에 저장된 gitAutomation 을 훼손하지 않는다.
//  - (ISO2) gitAutomation 교체가 pinnedPrTargetProjectId 를 훼손하지 않는다.
//  - (ISO3) 프로젝트 핀을 A→B 로 전환하면 재로드 결과가 정확히 B 만 남긴다 (A 잔여 없음).
//  - (ISO4) SQLite 마이그레이션 이전 레거시(pinned 없음, gitAutomation 만) 저장본도
//          forward-compatible 하게 그대로 로드된다. 마이그레이션 스크립트가 돌기 전
//          구 버전이 만든 localStorage 를 신규 클라이언트가 지워버리는 사고를 막는다.

test('TC-ISO1: pinnedPrTargetProjectId 교체가 gitAutomation 슬롯을 훼손하지 않는다', () => {
  installFakeLocalStorage();
  try {
    // 프로젝트 A 컨텍스트에서 Git 자동화 선호를 저장한다.
    saveUserPreferences({
      pinnedPrTargetProjectId: 'proj-A',
      gitAutomation: COMMIT_PUSH_PREFERENCE,
    });
    // 이후 사용자가 프로젝트 B 로 핀을 바꾼다 — 두 슬롯을 함께 기록해야 한다.
    const prev = loadUserPreferences();
    saveUserPreferences({
      pinnedPrTargetProjectId: 'proj-B',
      gitAutomation: prev.gitAutomation,
    });
    const restored = loadUserPreferences();
    assert.equal(restored.pinnedPrTargetProjectId, 'proj-B');
    assert.deepEqual(restored.gitAutomation, COMMIT_PUSH_PREFERENCE);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-ISO2: gitAutomation 교체가 pinnedPrTargetProjectId 를 훼손하지 않는다', () => {
  installFakeLocalStorage();
  try {
    saveUserPreferences({
      pinnedPrTargetProjectId: 'proj-A',
      gitAutomation: COMMIT_PUSH_PREFERENCE,
    });
    const prev = loadUserPreferences();
    const nextAutomation: GitAutomationPreference = {
      ...COMMIT_PUSH_PREFERENCE,
      flowLevel: 'commitOnly',
      reviewers: ['carol'],
    };
    saveUserPreferences({
      pinnedPrTargetProjectId: prev.pinnedPrTargetProjectId,
      gitAutomation: nextAutomation,
    });
    const restored = loadUserPreferences();
    assert.equal(restored.pinnedPrTargetProjectId, 'proj-A');
    assert.deepEqual(restored.gitAutomation, nextAutomation);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-ISO3: 프로젝트 핀 A→B 전환 시 A 잔여물이 남지 않는다', () => {
  const ctx = installFakeLocalStorage();
  try {
    saveUserPreferences({ pinnedPrTargetProjectId: 'proj-A' });
    saveUserPreferences({ pinnedPrTargetProjectId: 'proj-B' });
    // 저장된 원문을 직접 파싱해 A 의 흔적이 없는지 확인. 문자열 매칭으로 잔여 키까지 잡는다.
    const raw = ctx.store.get(USER_PREFERENCES_KEY) ?? '';
    assert.equal(raw.includes('proj-A'), false, 'A 의 id 문자열이 저장본에 남아 있으면 안 된다');
    const restored = loadUserPreferences();
    assert.equal(restored.pinnedPrTargetProjectId, 'proj-B');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-ISO4: 레거시 저장본(pinned 없음·gitAutomation 만) 도 로드된다', () => {
  // SQLite 마이그레이션 이전 빌드가 기록해둔 형태. pinnedPrTargetProjectId 가 없어도
  // gitAutomation 필드는 그대로 복원되어야 한다. 마이그레이션이 "이관" 단계에서 구버전
  // 저장본을 버리지 않는다는 불변식을 고정한다.
  installFakeLocalStorage(JSON.stringify({ gitAutomation: COMMIT_PUSH_PREFERENCE }));
  try {
    const restored = loadUserPreferences();
    assert.equal(restored.pinnedPrTargetProjectId, undefined);
    assert.deepEqual(restored.gitAutomation, COMMIT_PUSH_PREFERENCE);
    // 복원된 설정은 활성 플로우여야 한다 — "마이그레이션 후 자동화가 먹통"이라는
    // 지원 사례가 반복된 적이 있어 회귀 가드를 겸한다.
    assert.equal(shouldAutoCommit(restored.gitAutomation!), true);
    assert.equal(shouldAutoPush(restored.gitAutomation!), true);
  } finally { uninstallFakeLocalStorage(); }
});

// 감마(QA): 프로젝트 전환 / 새로고침 / 삭제 라이프사이클 격리 테스트.
// 사용자가 여러 프로젝트를 오가며 설정을 바꿀 때, 한 프로젝트의 상태가 다른
// 프로젝트로 번지거나 이전 잔여물이 되살아나는 회귀는 "설정 소실" 보고로 직결된다.
// 단일 전역 슬롯 모델이지만 "마지막 저장이 곧 활성 프로젝트의 설정"이라는 불변식을
// 명시적으로 고정해, 향후 per-project 분리 리팩토링에도 회귀 안전망이 유지되게 한다.
const COMMIT_ONLY_PREFERENCE: GitAutomationPreference = {
  flowLevel: 'commitOnly',
  branchTemplate: 'chore/{slug}',
  commitConvention: 'conventional',
  commitScope: 'infra',
  prTitleTemplate: 'chore: {summary}',
  reviewers: ['dave'],
};

test('TC-PROJ1: 프로젝트 A 설정 변경 후 B 전환 시 A/B 설정이 섞이지 않는다', () => {
  const ctx = installFakeLocalStorage();
  try {
    // 프로젝트 A 활성 상태에서 commit+push 자동화 설정을 저장.
    saveUserPreferences({
      pinnedPrTargetProjectId: 'proj-A',
      gitAutomation: COMMIT_PUSH_PREFERENCE,
    });
    // 프로젝트 B 로 전환하면서 B 전용 설정(commitOnly, 다른 리뷰어)으로 덮어쓴다.
    saveUserPreferences({
      pinnedPrTargetProjectId: 'proj-B',
      gitAutomation: COMMIT_ONLY_PREFERENCE,
    });
    const restored = loadUserPreferences();
    // 핀은 B 로 이동했어야 한다.
    assert.equal(restored.pinnedPrTargetProjectId, 'proj-B');
    // gitAutomation 은 B 의 값이어야 하고, A 의 commit+push/alice,bob 가 잔존하면 안 된다.
    assert.deepEqual(restored.gitAutomation, COMMIT_ONLY_PREFERENCE);
    // 원문에서도 A 의 식별자/리뷰어 잔여 문자열이 없어야 한다 — merge 버그 가드.
    const raw = ctx.store.get(USER_PREFERENCES_KEY) ?? '';
    assert.equal(raw.includes('proj-A'), false, 'A 의 프로젝트 ID 가 남아 있으면 안 된다');
    assert.equal(raw.includes('alice'), false, 'A 의 리뷰어가 남아 있으면 안 된다');
    assert.equal(raw.includes('commitPush'), false, 'A 의 flowLevel 이 남아 있으면 안 된다');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-PROJ2: 새로고침(재로드) 후에도 활성 프로젝트의 설정이 유지된다', () => {
  installFakeLocalStorage();
  try {
    // 1) 프로젝트 A 컨텍스트 저장 후 "새로고침" — load 가 동일한 값을 돌려줘야 한다.
    saveUserPreferences({
      pinnedPrTargetProjectId: 'proj-A',
      gitAutomation: COMMIT_PUSH_PREFERENCE,
    });
    const afterRefreshA = loadUserPreferences();
    assert.equal(afterRefreshA.pinnedPrTargetProjectId, 'proj-A');
    assert.deepEqual(afterRefreshA.gitAutomation, COMMIT_PUSH_PREFERENCE);

    // 2) 프로젝트 B 로 전환 후 다시 "새로고침" — B 의 설정으로 복원되어야 한다.
    saveUserPreferences({
      pinnedPrTargetProjectId: 'proj-B',
      gitAutomation: COMMIT_ONLY_PREFERENCE,
    });
    const afterRefreshB = loadUserPreferences();
    assert.equal(afterRefreshB.pinnedPrTargetProjectId, 'proj-B');
    assert.deepEqual(afterRefreshB.gitAutomation, COMMIT_ONLY_PREFERENCE);

    // 3) 연속 load 는 멱등이어야 한다 — 이전엔 재-load 시 부분 필드가 날아가는 버그가 있었음.
    const secondLoad = loadUserPreferences();
    assert.deepEqual(secondLoad, afterRefreshB);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-PROJ3: 프로젝트 삭제 시 해당 프로젝트의 저장된 설정도 함께 제거된다', () => {
  const ctx = installFakeLocalStorage();
  try {
    // 프로젝트 A 에 핀·자동화 설정이 저장된 상태로 시작.
    saveUserPreferences({
      pinnedPrTargetProjectId: 'proj-A',
      gitAutomation: COMMIT_PUSH_PREFERENCE,
    });
    // ProjectManagement.tsx 는 관리 목록에서 pinned 대상이 사라지면
    // saveUserPreferences({}) 로 전역 슬롯을 비운다 (line 494-498).
    // 이 시나리오를 그대로 재현한다.
    saveUserPreferences({});

    const restored = loadUserPreferences();
    // 핀·자동화 모두 사라져야 한다 — "삭제된 프로젝트 설정이 유령처럼 다음 세션에
    // 되살아나 엉뚱한 저장소로 PR 이 나가는" 사고를 차단하는 회귀 가드.
    assert.equal(restored.pinnedPrTargetProjectId, undefined);
    assert.equal(restored.gitAutomation, undefined);
    // 저장본에도 A 의 식별자 잔여 없음.
    const raw = ctx.store.get(USER_PREFERENCES_KEY) ?? '';
    assert.equal(raw.includes('proj-A'), false, '삭제 후 A 의 ID 가 저장본에 남아 있으면 안 된다');
    assert.equal(raw.includes('alice'), false, '삭제 후 A 의 리뷰어가 남아 있으면 안 된다');
  } finally { uninstallFakeLocalStorage(); }
});

// 디자이너: "현재 편집 중인 프로젝트" 헤더 라벨 + 스코프 인디케이터 회귀 가드.
// JSX 렌더링은 별도 JSDOM harness 가 도입되기 전까지 커버 불가지만, 표기 카피 와
// 포맷 규칙은 순수 함수로 끄집어내 테스트 가능하게 만들었다. 여기서 고정하는 불변식:
//  - (H1) org/repo fullName 은 org 접두사 + repo 본문으로 쪼개져 헤더가 계층적으로 표현된다.
//  - (H2) fullName 에 '/' 가 없는 단일 이름도 안전하게 title 에만 실린다.
//  - (H3) null 입력은 placeholder 라벨로 폴백해 "선택 없음" 상태를 명시한다.
//  - (H4) prBaseBranch 가 defaultBranch 를 덮어쓰되, 둘 다 없으면 branch 는 undefined.
//  - (S1) PROJECT_SCOPE_LABEL/TOOLTIP 카피는 고정되어, 번역/워크플로 변경 시 회귀를 잡는다.
//  - (S2) describeProjectScope 는 선택된 프로젝트 이름을 스코프 문장에 편입한다.

function makeProject(partial: Partial<ManagedProject>): ManagedProject {
  return {
    id: partial.id ?? 'p1',
    projectId: partial.projectId ?? 'proj1',
    provider: partial.provider ?? 'github',
    integrationId: partial.integrationId ?? 'i1',
    remoteId: partial.remoteId ?? 'r1',
    name: partial.name ?? 'repo',
    fullName: partial.fullName ?? 'org/repo',
    description: partial.description,
    url: partial.url ?? 'https://example.com/org/repo',
    defaultBranch: partial.defaultBranch,
    prBaseBranch: partial.prBaseBranch,
    prTarget: partial.prTarget,
    private: partial.private ?? false,
    importedAt: partial.importedAt ?? '2026-01-01T00:00:00Z',
  };
}

test('TC-H1: org/repo fullName 은 subtitle(org/) 과 title(repo) 로 쪼개진다', () => {
  const label = formatEditingProjectLabel(makeProject({ fullName: 'acme/llm-tycoon' }));
  assert.equal(label.hasProject, true);
  assert.equal(label.title, 'llm-tycoon');
  assert.equal(label.subtitle, 'acme/');
  assert.equal(label.fullName, 'acme/llm-tycoon');
});

test('TC-H2: "/"가 없는 단일 이름은 title 에만 실리고 subtitle 은 undefined', () => {
  const label = formatEditingProjectLabel(makeProject({ fullName: 'solo', name: 'solo' }));
  assert.equal(label.hasProject, true);
  assert.equal(label.title, 'solo');
  assert.equal(label.subtitle, undefined);
});

test('TC-H3: null/undefined 입력은 placeholder 라벨로 폴백한다', () => {
  const a = formatEditingProjectLabel(null);
  const b = formatEditingProjectLabel(undefined);
  assert.equal(a.hasProject, false);
  assert.equal(a.title, '선택된 프로젝트 없음');
  assert.equal(a.subtitle, undefined);
  assert.equal(a.fullName, undefined);
  assert.deepEqual(a, b);
});

test('TC-H4: branch 는 prBaseBranch > defaultBranch 순으로 선택되고, 둘 다 없으면 undefined', () => {
  const both = formatEditingProjectLabel(makeProject({ prBaseBranch: 'release', defaultBranch: 'main' }));
  assert.equal(both.branch, 'release');
  const fallback = formatEditingProjectLabel(makeProject({ prBaseBranch: '', defaultBranch: 'main' }));
  assert.equal(fallback.branch, 'main');
  const none = formatEditingProjectLabel(makeProject({ prBaseBranch: undefined, defaultBranch: undefined }));
  assert.equal(none.branch, undefined);
});

// Joker(프런트): 프로젝트 선택 상태에서 헤더가 "선택된 repo 이름" 을 정확히 비추는지 검증.
// 회귀 시나리오: 스토어의 selectedProjectId 는 업데이트됐지만 Array.find 로 얻는
// editingProject 가 이전 프로젝트를 참조해 헤더에 옛 이름이 남는 버그. pure 레벨에서
// "선택된 ManagedProject 의 fullName/name 이 라벨 3필드(title/subtitle/fullName) 에
// 원형 그대로 흘러들어가는가" 를 고정해 둔다.
test('TC-H5: 선택된 프로젝트의 fullName=org/repo 가 헤더 라벨의 title/subtitle 로 정확히 분해된다', () => {
  const picked = makeProject({ id: 'mp-picked', fullName: 'anthropic/claude-code', name: 'claude-code' });
  const label = formatEditingProjectLabel(picked);
  assert.equal(label.hasProject, true, '선택 상태인데 hasProject 가 false 로 떨어졌다');
  assert.equal(label.title, 'claude-code', '헤더 title 이 선택 프로젝트의 repo 이름과 다르다');
  assert.equal(label.subtitle, 'anthropic/', '헤더 subtitle 이 org 접두사를 잃었다');
  assert.equal(label.fullName, 'anthropic/claude-code', '툴팁/접근성용 fullName 이 원형을 벗어났다');
});

test('TC-H6: 프로젝트 A→B 전환 후 라벨은 B 의 이름만 비춘다 (이전 선택의 흔적 없음)', () => {
  // App 에서 selectedProjectId 가 A→B 로 바뀌면 상위가 새 ManagedProject 를 찾아 내려준다.
  // 라벨 포맷터가 입력을 그대로 따라가는지 확인 — 포맷터 내부에 은닉 상태가 있어 A 의
  // 이름이 남아버리면 사용자가 "B 를 골랐는데 A 의 자동화 설정이 보인다" 고 오해한다.
  const a = makeProject({ id: 'mp-A', fullName: 'acme/frontend', name: 'frontend' });
  const b = makeProject({ id: 'mp-B', fullName: 'acme/backend', name: 'backend' });
  const labelA = formatEditingProjectLabel(a);
  const labelB = formatEditingProjectLabel(b);
  assert.equal(labelA.title, 'frontend');
  assert.equal(labelB.title, 'backend');
  assert.notEqual(labelA.title, labelB.title, '프로젝트를 바꿨는데 헤더 title 이 동일하다');
  assert.notEqual(labelA.fullName, labelB.fullName, '전환 후에도 fullName 이 이전 값으로 남았다');
  // 재호출에도 결과는 결정적이어야 한다 — 은닉 state 가 없다는 불변식.
  assert.deepEqual(formatEditingProjectLabel(a), labelA, '같은 입력이 다른 라벨을 돌려준다');
});

test('TC-H7: fullName 이 비면 name 이 title 로 폴백돼 "선택된 프로젝트 없음" 으로 떨어지지 않는다', () => {
  // 일부 provider(로컬 import) 는 fullName 을 비워둔다. 이 경우 라벨이 placeholder 로
  // 폴백하면 "선택했는데 선택 없음" 이라는 시각적 모순이 생긴다 — 무조건 name 으로 승격.
  const picked = makeProject({ fullName: '', name: 'solo-repo' });
  const label = formatEditingProjectLabel(picked);
  assert.equal(label.hasProject, true);
  assert.equal(label.title, 'solo-repo', 'fullName 이 비었을 때 name 폴백이 작동하지 않았다');
  assert.notEqual(label.title, '선택된 프로젝트 없음', '선택 상태인데 placeholder 로 떨어졌다');
});

test('TC-S1: 스코프 카피는 고정 문구를 유지한다 (번역/워크플로 회귀 가드)', () => {
  assert.equal(PROJECT_SCOPE_LABEL, '프로젝트 전용 설정');
  assert.match(PROJECT_SCOPE_TOOLTIP, /현재 편집 중인 프로젝트에만 적용/);
});

test('TC-S2: describeProjectScope 는 선택된 프로젝트 fullName 을 문장에 편입한다', () => {
  const label = formatEditingProjectLabel(makeProject({ fullName: 'acme/llm-tycoon' }));
  const sentence = describeProjectScope(label);
  assert.match(sentence, /acme\/llm-tycoon/);
  assert.match(sentence, /에만 적용됩니다/);
});

test('TC-S3: 선택이 없으면 describeProjectScope 는 기본 툴팁으로 폴백한다', () => {
  const sentence = describeProjectScope(formatEditingProjectLabel(null));
  assert.equal(sentence, PROJECT_SCOPE_TOOLTIP);
});

// 베타(개발): projectId 스코프 키 이관 계약 — 구현 대기 스펙.
// 감마의 TC-PROJ*/TC-ISO* 는 "단일 전역 슬롯" 모델의 불변식을 고정한다. 다음 단계는
// 단일 키(USER_PREFERENCES_KEY) 에서 프로젝트별 키("<prefix>:<projectId>") 로 이관하고
// 서버의 project_settings(projectId, settingKey, settingValue) 테이블과 동기화하는 것.
// 계약을 먼저 테스트로 고정해 두면, 구현 PR 이 올라올 때 { skip } 과
// (과거의) ts-expect-error 를 제거하는 것만으로 회귀 안전망이 즉시 켜진다.
//
// 불변식:
//  - (PS1) 프로젝트 A/B 저장본이 서로 다른 키 아래 독립 슬롯으로 격리된다.
//  - (PS2) A↔B 전환·재로드를 섞어도 각 프로젝트의 값이 원형 그대로 복원된다.
//  - (PS3) projectId 없이 호출된 load/save 는 기존 단일 키로 폴백한다 — 프로젝트 선택
//          전 랜딩 / SSR 렌더 / 마이그레이션 폴백 경로에서도 안전해야 하므로.
//  - (PS4) 레거시 단일 키 저장본은 최초 1회만 "현재 프로젝트"로 이관되고 그 즉시
//          원본이 제거된다 — 두 번 이관되어 다른 프로젝트로 값이 번지는 사고 방지.
const PROJECT_SETTINGS_KEY_PREFIX = 'llm-tycoon:project-settings';
const keyFor = (projectId: string) => `${PROJECT_SETTINGS_KEY_PREFIX}:${projectId}`;

const AUTOMATION_FOR_PROJ_B: GitAutomationPreference = {
  flowLevel: 'commitOnly',
  branchTemplate: 'hotfix/{slug}',
  commitConvention: 'plain',
  commitScope: '',
  prTitleTemplate: '{summary}',
  reviewers: [],
};

test('TC-PS1: projectId 스코프 키로 A/B 가 독립 슬롯에 저장된다', () => {
  const ctx = installFakeLocalStorage();
  try {
    saveUserPreferences({ gitAutomation: COMMIT_PUSH_PREFERENCE }, 'proj-A');
    saveUserPreferences({ gitAutomation: AUTOMATION_FOR_PROJ_B }, 'proj-B');

    assert.ok(ctx.store.get(keyFor('proj-A')), 'A 스코프 키 저장본이 있어야 한다');
    assert.ok(ctx.store.get(keyFor('proj-B')), 'B 스코프 키 저장본이 있어야 한다');

    assert.deepEqual(loadUserPreferences('proj-A').gitAutomation, COMMIT_PUSH_PREFERENCE);
    assert.deepEqual(loadUserPreferences('proj-B').gitAutomation, AUTOMATION_FOR_PROJ_B);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-PS2: A→B→A 전환·재로드 섞어도 각 프로젝트 원형이 복원된다', () => {
  installFakeLocalStorage();
  try {
    saveUserPreferences({ gitAutomation: COMMIT_PUSH_PREFERENCE }, 'proj-A');
    saveUserPreferences({ gitAutomation: AUTOMATION_FOR_PROJ_B }, 'proj-B');

    assert.deepEqual(loadUserPreferences('proj-A').gitAutomation, COMMIT_PUSH_PREFERENCE);
    assert.deepEqual(loadUserPreferences('proj-B').gitAutomation, AUTOMATION_FOR_PROJ_B);
    assert.deepEqual(loadUserPreferences('proj-A').gitAutomation, COMMIT_PUSH_PREFERENCE);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-PS3: projectId 없이 load/save 하면 단일 키(레거시) 경로로 동작한다', () => {
  // 프로젝트 선택 전 랜딩 / SSR 렌더 / 마이그레이션 폴백에서 USER_PREFERENCES_KEY 를
  // 그대로 써야 한다 — 새 시그니처가 들어와도 이 경로는 깨지면 안 된다.
  const ctx = installFakeLocalStorage();
  try {
    saveUserPreferences({ pinnedPrTargetProjectId: 'proj-A' });
    assert.ok(ctx.store.get(USER_PREFERENCES_KEY), '단일 키 저장본은 유지되어야 한다');
    assert.equal(loadUserPreferences().pinnedPrTargetProjectId, 'proj-A');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-PS4: 레거시 단일 키 저장본은 최초 1회만 현재 프로젝트로 이관된다', () => {
  // 구 빌드가 USER_PREFERENCES_KEY 에만 값을 남기고 종료한 상태를 재현한다.
  // 신규 클라이언트가 proj-A 를 활성으로 부팅하면:
  //  (1) proj-A 스코프 키로 값이 복제되고,
  //  (2) 단일 키는 제거되어 두 번 이관되는 사고를 막아야 한다.
  const ctx = installFakeLocalStorage(JSON.stringify({ gitAutomation: COMMIT_PUSH_PREFERENCE }));
  try {
    migrateUserPreferencesToProject('proj-A');
    assert.equal(ctx.store.get(USER_PREFERENCES_KEY), undefined, '레거시 키는 이관 후 제거되어야 한다');
    const scoped = ctx.store.get(keyFor('proj-A'));
    assert.ok(scoped, '프로젝트 스코프 키로 값이 복제되어야 한다');
    assert.deepEqual(JSON.parse(scoped!), { gitAutomation: COMMIT_PUSH_PREFERENCE });
  } finally { uninstallFakeLocalStorage(); }
});

// 감마(QA): 3-프로젝트(A/B/C) 격리 회귀 — 할당 업무 #PM-ABC.
// 사내 이슈 리포트 중 "프로젝트 하나 고치면 옆 프로젝트 설정이 날아간다"가 반복되는
// 구간을 잡는 가드. 현재 단일 키 모델이 아닌 projectId 스코프 모델의 계약을 먼저 고정해 둔다.
// 아래 네 개 케이스는 구현 후 { skip } 만 벗기면 즉시 발동한다.
//  - (ABC1) A/B/C 각각 서로 다른 중첩 설정 → A 만 수정 시 B,C 는 byte-identical 보존.
//  - (ABC2) 같은 fullName 을 가진 서로 다른 projectId 는 독립 슬롯을 가진다.
//  - (ABC3) 빈 설정({}) 을 저장한 프로젝트는 load 시 {} 를 그대로 돌려준다(undefined 폴백 금지).
//  - (ABC4) 깊게 중첩된 reviewers/templates 구조가 원형 그대로 round-trip 된다.
const AUTOMATION_FOR_PROJ_C: GitAutomationPreference = {
  flowLevel: 'commitPushPR',
  branchTemplate: 'release/{version}',
  commitConvention: 'conventional',
  commitScope: 'release',
  prTitleTemplate: 'release: cut {version}',
  reviewers: ['erin', 'frank', 'grace'],
};

function snapshotScope(ctx: FakeLocalCtx, projectId: string): string | undefined {
  return ctx.store.get(keyFor(projectId));
}

test('TC-PROJ-ABC1: 프로젝트 A 수정 시 B,C 저장본이 byte-identical 로 보존된다', () => {
  // 실제 사용자 시나리오: 3개 프로젝트를 순차 세팅한 뒤, 며칠 후 A 의 flowLevel 만 조정.
  // B,C 저장본의 "원문 JSON" 자체가 바뀌지 않는지까지 고정한다. 중간 merge 로직이
  // 다른 프로젝트 키를 건드리면 문자열 단위에서 잡힌다.
  const ctx = installFakeLocalStorage();
  try {
    saveUserPreferences({ gitAutomation: COMMIT_PUSH_PREFERENCE }, 'proj-A');
    saveUserPreferences({ gitAutomation: AUTOMATION_FOR_PROJ_B }, 'proj-B');
    saveUserPreferences({ gitAutomation: AUTOMATION_FOR_PROJ_C }, 'proj-C');

    const snapshotB = snapshotScope(ctx, 'proj-B');
    const snapshotC = snapshotScope(ctx, 'proj-C');
    assert.ok(snapshotB && snapshotC, 'B,C 저장본이 모두 존재해야 한다');

    // A 만 수정: flowLevel 을 commitPush → commitOnly 로 내린다.
    const modifiedA: GitAutomationPreference = { ...COMMIT_PUSH_PREFERENCE, flowLevel: 'commitOnly' };
    saveUserPreferences({ gitAutomation: modifiedA }, 'proj-A');

    // B,C 저장본의 원문이 단 한 바이트도 바뀌지 않아야 한다.
    assert.equal(snapshotScope(ctx, 'proj-B'), snapshotB, 'A 수정이 B 저장본 원문을 건드렸다');
    assert.equal(snapshotScope(ctx, 'proj-C'), snapshotC, 'A 수정이 C 저장본 원문을 건드렸다');

    // 로드 결과도 각자 원형 그대로여야 한다.
    assert.deepEqual(loadUserPreferences('proj-A').gitAutomation, modifiedA);
    assert.deepEqual(loadUserPreferences('proj-B').gitAutomation, AUTOMATION_FOR_PROJ_B);
    assert.deepEqual(loadUserPreferences('proj-C').gitAutomation, AUTOMATION_FOR_PROJ_C);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-PROJ-ABC2: 같은 이름 프로젝트(다른 id) 는 독립 슬롯을 가진다', () => {
  // Edge case: 사용자가 "llm-tycoon" fork 두 벌을 동시에 관리하는 상황. fullName 이
  // 동일해도 projectId 가 다르면 설정이 섞여서는 안 된다. 같은 문자열을 키로 쓰는
  // 해시 충돌 버그(실사례 있음) 를 1차 방어한다.
  const ctx = installFakeLocalStorage();
  try {
    saveUserPreferences({ gitAutomation: COMMIT_PUSH_PREFERENCE }, 'dup-id-1');
    saveUserPreferences({ gitAutomation: AUTOMATION_FOR_PROJ_B }, 'dup-id-2');

    // 두 저장본이 서로 다른 원문을 가져야 한다.
    const raw1 = snapshotScope(ctx, 'dup-id-1');
    const raw2 = snapshotScope(ctx, 'dup-id-2');
    assert.ok(raw1 && raw2);
    assert.notEqual(raw1, raw2, '같은 이름이라도 id 가 다르면 저장본이 달라야 한다');

    // dup-id-1 만 수정했을 때 dup-id-2 가 그대로여야 한다.
    saveUserPreferences({ gitAutomation: COMMIT_ONLY_PREFERENCE }, 'dup-id-1');
    assert.equal(snapshotScope(ctx, 'dup-id-2'), raw2, '같은 이름 프로젝트 설정이 전염됐다');
    assert.deepEqual(loadUserPreferences('dup-id-2').gitAutomation, AUTOMATION_FOR_PROJ_B);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-PROJ-ABC3: 빈 설정({}) 을 저장한 프로젝트는 load 시 {} 를 그대로 돌려준다', () => {
  // 프로젝트를 새로 추가했지만 아직 아무 설정도 안 잡은 상태. 이때 load 가 전역
  // 폴백(다른 프로젝트의 설정)을 돌려주면 "빈 프로젝트에 유령 설정이 보임" 사고.
  // 빈 객체를 저장한 사실 자체가 살아 있어야 한다.
  const ctx = installFakeLocalStorage();
  try {
    saveUserPreferences({ gitAutomation: COMMIT_PUSH_PREFERENCE }, 'proj-A');
    saveUserPreferences({}, 'proj-empty');
    saveUserPreferences({ gitAutomation: AUTOMATION_FOR_PROJ_C }, 'proj-C');

    assert.ok(snapshotScope(ctx, 'proj-empty'), '빈 설정도 스코프 키에 기록되어야 한다');
    assert.deepEqual(loadUserPreferences('proj-empty'), {});
    // 빈 프로젝트 저장이 A,C 를 훼손하지 않아야 한다.
    assert.deepEqual(loadUserPreferences('proj-A').gitAutomation, COMMIT_PUSH_PREFERENCE);
    assert.deepEqual(loadUserPreferences('proj-C').gitAutomation, AUTOMATION_FOR_PROJ_C);
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-PROJ-ABC4: 중첩 객체/배열 설정이 round-trip 후 원형 그대로 복원된다', () => {
  // reviewers 배열, 템플릿 문자열의 특수문자({type}, {slug}), 길이가 긴 scope 등
  // "비-프리미티브" 필드가 JSON round-trip 과 parser 검증을 넘어 원본 그대로 돌아오는지.
  // 중첩 객체 직렬화 버그 (키 정렬 / 공백 삽입 / 마지막 쉼표) 를 1건이라도 흘리면
  // A 저장본을 읽은 B 쓰기 경로가 깨져서 옆 프로젝트가 날아갈 수 있다.
  const nested: GitAutomationPreference = {
    flowLevel: 'commitPushPR',
    branchTemplate: 'feature/{type}/{ticket}/{slug}-auto',
    commitConvention: 'conventional',
    commitScope: 'ui-project-management',
    prTitleTemplate: '[{type}] {summary} — ticket:{ticket}',
    reviewers: ['alice', 'bob', 'carol', 'dave', 'erin'],
  };
  const ctx = installFakeLocalStorage();
  try {
    saveUserPreferences({ gitAutomation: nested, pinnedPrTargetProjectId: 'proj-nested' }, 'proj-nested');
    const restored = loadUserPreferences('proj-nested');
    assert.deepEqual(restored.gitAutomation, nested, 'reviewers 배열·템플릿이 원형 그대로 복원되어야 한다');
    assert.equal(restored.pinnedPrTargetProjectId, 'proj-nested');

    // 저장본 원문에 reviewers 5명이 모두 실렸는지 (배열 절단 버그 가드).
    const raw = snapshotScope(ctx, 'proj-nested') ?? '';
    for (const reviewer of nested.reviewers) {
      assert.ok(raw.includes(reviewer), `reviewers 배열에서 ${reviewer} 가 누락됐다`);
    }
    // 템플릿 특수문자 토큰이 escape 없이 그대로 살아 있어야 한다.
    assert.ok(raw.includes('{type}') && raw.includes('{ticket}'), '템플릿 플레이스홀더 토큰이 파손됐다');
  } finally { uninstallFakeLocalStorage(); }
});

// QA(감마): EmptyProjectPlaceholder 첫-렌더 플래시 회귀 가드 — 할당 업무 #EPP-FLASH.
// App.tsx 의 부모 가드(`{!selectedProjectId && <EmptyProjectPlaceholder />}`) 는 selectedProjectId
// state 가 localStorage 복원 / socket state:initial 수신(line 406-408) 을 통해 세팅되기 *이전* 한 프레임
// 이 비어 있을 수 있다. 이때 내부 가드(`if (currentProjectId) return null;`) 가 제거되면 "선택 복원
// 직후 첫 커밋 프레임" 에서 플레이스홀더가 깜빡 보이는 플래시 회귀가 재현된다. 실제 사용자가 보는
// 증상은 "새로고침 직후 0.x 초간 '프로젝트를 선택하세요' 화면이 번쩍 뜬 뒤 실제 프로젝트 화면으로 넘어감".
// 여기서는 컴포넌트 내부 가드를 순수 함수 레벨로 호출해 세 가지 불변식을 고정한다.
//   (EPP1) currentProjectId 가 truthy 이면 어떤 projectCount/busyAgentCount 조합에서도 null 반환.
//   (EPP2) localStorage 에서 복원된 pinnedPrTargetProjectId 를 그대로 넘겨도 null 반환 — "복원 지연"
//          시나리오에서 플래시 없음.
//   (EPP3) currentProjectId 가 null/undefined 이면 React element 를 실제로 반환 — 미선택 상태에서는
//          반드시 노출되어야 하므로 가드 반대편도 함께 고정한다.

const EPP_NOOP = () => {};

test('TC-EPP1a: currentProjectId 가 지정되면 플레이스홀더는 null 을 반환한다 (projectCount=0)', () => {
  const el = EmptyProjectPlaceholder({
    projectCount: 0,
    onOpenProjectList: EPP_NOOP,
    onCreateProject: EPP_NOOP,
    currentProjectId: 'proj-A',
  });
  assert.equal(el, null);
});

test('TC-EPP1b: busyAgentCount>0 이어도 프로젝트가 선택되어 있으면 null (이상 상태 배지 누수 방지)', () => {
  // busyAgentCount 는 프로젝트 미선택 상태에서만 노출되는 진단 배지. 선택 상태에서 배지 자체가
  // 보이면 "프로젝트 선택했는데 상태 이상 경고가 떠 있음" 사고로 이어진다.
  const el = EmptyProjectPlaceholder({
    projectCount: 3,
    onOpenProjectList: EPP_NOOP,
    onCreateProject: EPP_NOOP,
    currentProjectId: 'proj-A',
    busyAgentCount: 5,
  });
  assert.equal(el, null);
});

test('TC-EPP2: localStorage 에서 복원된 pinnedPrTargetProjectId 로 바로 렌더해도 null', () => {
  // 새로고침 / 느린 환경 재현: 저장본이 있는 상태에서 부팅 → load → setSelectedProjectId 반영.
  // 반영 직후 첫 커밋 프레임에서 부모 가드가 우회될 수 있으므로 내부 가드가 책임진다.
  installFakeLocalStorage(JSON.stringify({ pinnedPrTargetProjectId: 'proj-restore' }));
  try {
    const restored = loadUserPreferences();
    assert.equal(restored.pinnedPrTargetProjectId, 'proj-restore');
    const el = EmptyProjectPlaceholder({
      projectCount: 1,
      onOpenProjectList: EPP_NOOP,
      onCreateProject: EPP_NOOP,
      currentProjectId: restored.pinnedPrTargetProjectId,
    });
    assert.equal(el, null, '복원된 선택 ID 가 들어온 순간부터 플래시가 있으면 안 된다');
  } finally { uninstallFakeLocalStorage(); }
});

test('TC-EPP3: currentProjectId 가 null/undefined 이면 React element 를 반환 (가드 반대편)', () => {
  // 회귀 가드의 역-케이스: 미선택 상태에서는 반드시 실제 노드가 나와야 한다. 두 경우 모두 null
  // 반환으로 바뀌면 "프로젝트 없는 사용자가 빈 화면을 만나는" 반대 방향 사고.
  const elNull = EmptyProjectPlaceholder({
    projectCount: 0,
    onOpenProjectList: EPP_NOOP,
    onCreateProject: EPP_NOOP,
    currentProjectId: null,
  });
  const elUndef = EmptyProjectPlaceholder({
    projectCount: 0,
    onOpenProjectList: EPP_NOOP,
    onCreateProject: EPP_NOOP,
  });
  assert.notEqual(elNull, null);
  assert.notEqual(elUndef, null);
  assert.equal(typeof elNull, 'object');
  assert.equal(typeof elUndef, 'object');
});

// QA(감마): 에이전트 상태 전환 회귀 — 할당 업무 #AGT-STATUS.
// 배경: 에이전트가 장시간 태스크를 수행하는 동안 자신의 status 를 'idle' 로 조기 전환해
// 리더가 "완료 응답 전" 다음 업무를 분배하는 사고가 반복 보고됐다. 이 섹션은 update_status
// 이벤트 시퀀스를 순수 상태 전이로 모델링하고, 다음 네 가지 불변식을 회귀 가드로 고정한다.
//  - (AGT1) 작업 진행 중(working 하트비트 반복) 어떤 중간 스냅샷도 비활성이 되지 않는다.
//  - (AGT2) currentTask/workingOnFileId 가 살아있는데 status='idle' 인 조합은 회귀 시그널로 감지된다.
//  - (AGT3) 'idle' 이벤트가 명시적으로 수신되기 전까지는 비활성으로 전환되지 않는다 —
//          thinking 등 중간 전이가 섞여도 마찬가지.
//  - (AGT4) 동시 실행 중인 두 에이전트의 이벤트 타임라인이 교차해도 각자의 상태가 섞이지 않는다.

type StatusEvent = { status: Agent['status']; workingOnFileId?: string };

function makeAgentFixture(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: overrides.name ?? id,
    role: overrides.role ?? 'Developer',
    spriteTemplate: overrides.spriteTemplate ?? 'dev',
    persona: overrides.persona,
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    status: overrides.status ?? 'idle',
    currentTask: overrides.currentTask,
    lastMessage: overrides.lastMessage,
    lastMessageTo: overrides.lastMessageTo,
    workingOnFileId: overrides.workingOnFileId,
  };
}

// 이벤트 적용 직후의 스냅샷 배열을 돌려준다. 중간 상태 불변식 검증 용.
// workingOnFileId 가 빈 문자열이면 해제(undefined) 로 정규화 — MCP update_status 의 계약과 동일.
function applyStatusEvents(initial: Agent, events: StatusEvent[]): Agent[] {
  const snapshots: Agent[] = [];
  let current = initial;
  for (const ev of events) {
    const nextFile =
      ev.workingOnFileId === undefined
        ? current.workingOnFileId
        : ev.workingOnFileId === ''
        ? undefined
        : ev.workingOnFileId;
    current = { ...current, status: ev.status, workingOnFileId: nextFile };
    snapshots.push(current);
  }
  return snapshots;
}

test('TC-AGT1: 장시간 태스크의 working 하트비트 중 단 한 프레임도 비활성으로 떨어지지 않는다', () => {
  // 실사례: 리팩토링 같은 수 분~수십 분짜리 태스크. MCP update_status('working') 가 반복 호출되며
  // 중간에 어떤 이벤트도 status 를 idle 로 끌어내려선 안 된다. 한 번이라도 isActiveAgent=false
  // 스냅샷이 나오면 리더가 에이전트를 "가용"으로 오판해 다음 태스크를 얹는다.
  const initial = makeAgentFixture('dev-long', {
    status: 'working',
    workingOnFileId: 'f-long',
    currentTask: 'impl large refactor',
  });
  const heartbeats: StatusEvent[] = Array.from({ length: 25 }, () => ({
    status: 'working',
    workingOnFileId: 'f-long',
  }));
  const snapshots = applyStatusEvents(initial, heartbeats);
  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    assert.equal(isActiveAgent(s), true, `하트비트 ${i} 에서 조기 대기 전환 발생`);
    assert.equal(s.status, 'working');
    assert.equal(s.workingOnFileId, 'f-long', '진행 중 파일 포커스가 풀리면 안 된다');
  }
});

test('TC-AGT2: currentTask/workingOnFileId 가 살아있는데 status=idle 조합은 회귀로 감지된다', () => {
  // "완료 응답 전 '대기'로 바뀌는" 사고의 직접 시그널. 에이전트가 파일 포커스를 쥔 채
  // idle 로 보고하면 즉시 회귀 — 이 조합 자체가 테스트에서 빨간불이어야 한다.
  const premature = makeAgentFixture('dev-prem', {
    status: 'idle',
    currentTask: '아직 실행 중',
    workingOnFileId: 'f-prem',
  });
  assert.equal(isActiveAgent(premature), false, 'idle 은 그대로 비활성으로 집계');
  const hasLiveWork = !!premature.currentTask || !!premature.workingOnFileId;
  assert.ok(
    hasLiveWork,
    'currentTask/workingOnFileId 가 살아있는 채 idle 로 떨어진 조합은 회귀 시그널로 잡아야 한다',
  );
  // 대비: 정상 종료는 currentTask/workingOnFileId 가 모두 비워진 상태에서만 유효하다.
  const cleanDone = makeAgentFixture('dev-done', { status: 'idle' });
  assert.equal(isActiveAgent(cleanDone), false);
  assert.equal(cleanDone.currentTask, undefined);
  assert.equal(cleanDone.workingOnFileId, undefined);
});

test('TC-AGT3: thinking 이 끼어들어도 명시적 idle 이벤트 전까지는 절대 비활성으로 떨어지지 않는다', () => {
  // 중간 reasoning 전이(thinking) 가 섞인 태스크. thinking 은 활성 상태이므로 isActiveAgent=true
  // 를 유지해야 한다. 마지막 idle 이벤트에서만 비활성으로 전환된다.
  const initial = makeAgentFixture('dev-mix', {
    status: 'working',
    workingOnFileId: 'f-mix',
    currentTask: 'multi-step',
  });
  const events: StatusEvent[] = [
    { status: 'working', workingOnFileId: 'f-mix' },
    { status: 'thinking', workingOnFileId: 'f-mix' },
    { status: 'working', workingOnFileId: 'f-mix' },
    { status: 'thinking', workingOnFileId: 'f-mix' },
    { status: 'working', workingOnFileId: 'f-mix' },
    { status: 'idle', workingOnFileId: '' },
  ];
  const snapshots = applyStatusEvents(initial, events);
  for (let i = 0; i < snapshots.length - 1; i++) {
    assert.equal(
      isActiveAgent(snapshots[i]),
      true,
      `이벤트 ${i}(${snapshots[i].status}) 에서 조기 대기 전환`,
    );
  }
  const last = snapshots[snapshots.length - 1];
  assert.equal(last.status, 'idle');
  assert.equal(isActiveAgent(last), false);
  assert.equal(last.workingOnFileId, undefined, 'idle 시 파일 포커스가 해제되어야 한다');
});

test('TC-AGT4a: 동시 실행 — 한 에이전트의 완료가 다른 에이전트의 working 을 훼손하지 않는다', () => {
  // QA/Dev 가 병렬로 돌아가는 실사례. Dev 가 먼저 완료(idle)해도 QA 는 여전히 working.
  // 공유 가변 상태로 인한 교차 오염을 1차 방어.
  const qa = makeAgentFixture('qa-par', {
    status: 'working',
    workingOnFileId: 'fQA',
    currentTask: 'test-write',
  });
  const dev = makeAgentFixture('dev-par', {
    status: 'working',
    workingOnFileId: 'fDEV',
    currentTask: 'impl',
  });
  const [devDone] = applyStatusEvents(dev, [{ status: 'idle', workingOnFileId: '' }]);

  assert.equal(isActiveAgent(devDone), false, 'dev 는 완료 보고 후 비활성');
  assert.equal(isActiveAgent(qa), true, 'qa 는 여전히 working 이어야 한다');
  assert.equal(qa.status, 'working');
  assert.equal(qa.workingOnFileId, 'fQA', 'qa 의 파일 포커스가 풀리면 안 된다');
  assert.equal(qa.currentTask, 'test-write', 'qa 의 currentTask 도 유지되어야 한다');
});

test('TC-AGT4b: 동시 실행 — 인터리브된 하트비트 스트림에서 두 에이전트 타임라인이 섞이지 않는다', () => {
  // 이벤트 스트림이 교차해도 agentId 로 격리가 유지되는지. a1 이 먼저 완료 → a2 만 계속 working.
  // 원래 버그: 하나의 전역 currentStatus 슬롯을 두 에이전트가 공유해 최신 이벤트가 다른 에이전트를
  // 덮어쓰는 사고. 개별 상태 사본이 유지되면 이 테스트는 통과한다.
  const agents = new Map<string, Agent>([
    ['a1', makeAgentFixture('a1', { status: 'working', workingOnFileId: 'fA', currentTask: 'tA' })],
    ['a2', makeAgentFixture('a2', { status: 'working', workingOnFileId: 'fB', currentTask: 'tB' })],
  ]);
  const interleaved: Array<{ id: string; ev: StatusEvent }> = [
    { id: 'a1', ev: { status: 'working', workingOnFileId: 'fA' } },
    { id: 'a2', ev: { status: 'thinking', workingOnFileId: 'fB' } },
    { id: 'a1', ev: { status: 'thinking', workingOnFileId: 'fA' } },
    { id: 'a2', ev: { status: 'working', workingOnFileId: 'fB' } },
    { id: 'a1', ev: { status: 'working', workingOnFileId: 'fA' } },
    { id: 'a2', ev: { status: 'working', workingOnFileId: 'fB' } },
    { id: 'a1', ev: { status: 'idle', workingOnFileId: '' } }, // a1 완료
    { id: 'a2', ev: { status: 'working', workingOnFileId: 'fB' } },
    { id: 'a2', ev: { status: 'thinking', workingOnFileId: 'fB' } },
  ];
  for (const { id, ev } of interleaved) {
    const [next] = applyStatusEvents(agents.get(id)!, [ev]);
    agents.set(id, next);
    // 인터리브 타임라인 중 a2 는 어느 시점에도 idle 로 강등되면 안 된다 — a1 완료 이벤트가
    // 공용 버퍼를 덮어쓰는 공유 상태 버그가 있다면 이 어서션이 중간에 터진다.
    if (id === 'a1' && ev.status === 'idle') {
      assert.equal(agents.get('a2')!.status, 'working', 'a1 완료 순간 a2 가 조기 대기로 강등됐다');
    }
  }
  // 최종: a1 idle, a2 여전히 활성.
  const finalA1 = agents.get('a1')!;
  const finalA2 = agents.get('a2')!;
  assert.equal(finalA1.status, 'idle');
  assert.equal(finalA1.workingOnFileId, undefined, 'a1 완료 시 파일 포커스 해제');
  assert.equal(isActiveAgent(finalA2), true);
  assert.equal(finalA2.workingOnFileId, 'fB', 'a2 의 파일 포커스는 끝까지 fB');
  assert.equal(finalA2.currentTask, 'tB', 'a2 의 currentTask 도 교차 이벤트에 훼손되지 않는다');
});

// ─────────────────────────────────────────────────────────────────────────────
// QA(감마): 실제 작업 파일의 코드그래프 노출 회귀 — 할당 업무 #GRAPH-EXPOSURE.
// 에이전트가 Write/Edit 로 만든 실제 작업 파일이 server.ts /api/files 경로
// (line 446-498) 를 거쳐 캔버스의 노드로 노출되는지, 그리고 add/modify/delete
// 세 시나리오에서 노드 가시성이 흔들리지 않는지 클라이언트 모델로 고정한다.
// server.ts 의 계약:
//  (1) normalizeCodeGraphPath 로 경로 다듬기 (line 452)
//  (2) isExcludedFromCodeGraph 로 docs/ 류 배제 (line 457)
//  (3) (projectId, name) 기준으로 기존 노드 재사용 (line 464-471) — 중복 금지
//  (4) inferFileType 으로 시각 분류 기본값 (line 478)
// 이 네 가지가 클라이언트 어디에서 호출되든 동일하게 지켜지는지 검증한다.
// ─────────────────────────────────────────────────────────────────────────────

interface GraphNode { id: string; projectId: string; name: string; type: CodeFileType; }

// server.ts POST /api/files 의 단일-스레드 in-memory 등가물. DB 대신 Map 을
// 쓰지만 중복 해석·정규화·제외 필터 계약은 동일해야 한다.
function createInMemoryGraph() {
  const store = new Map<string, GraphNode>();
  const key = (projectId: string, name: string) => `${projectId}::${name}`;
  let seq = 0;
  return {
    add(projectId: string, rawName: string, type?: CodeFileType): GraphNode | null {
      const name = normalizeCodeGraphPath(rawName);
      if (!name) return null;
      if (isExcludedFromCodeGraph(name)) return null;
      const k = key(projectId, name);
      const existing = store.get(k);
      if (existing) return existing;
      const node: GraphNode = {
        id: `node-${++seq}`, projectId, name,
        type: type ?? inferFileType(name),
      };
      store.set(k, node);
      return node;
    },
    remove(projectId: string, rawName: string): boolean {
      return store.delete(key(projectId, normalizeCodeGraphPath(rawName)));
    },
    list(projectId: string): GraphNode[] {
      return Array.from(store.values()).filter((n) => n.projectId === projectId);
    },
    has(projectId: string, rawName: string): boolean {
      return store.has(key(projectId, normalizeCodeGraphPath(rawName)));
    },
  };
}

test('TC-GRAPH-ADD1: add_file 한 번으로 코드그래프 노드가 노출된다 (정상 경로)', () => {
  const graph = createInMemoryGraph();
  const added = graph.add('proj-A', 'src/components/EmptyProjectPlaceholder.tsx');
  assert.ok(added, '정상 경로는 노드가 생성되어야 한다');
  assert.equal(added!.name, 'src/components/EmptyProjectPlaceholder.tsx');
  assert.equal(added!.type, 'component', 'tsx 확장자는 component 로 분류되어야 한다');
  const nodes = graph.list('proj-A');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, added!.id);
});

test('TC-GRAPH-ADD2: 다른 프로젝트 간 동일 파일명은 각자 독립 노드로 노출된다', () => {
  // 프로젝트 간 노드 격리 불변식. 같은 src/App.tsx 라도 A/B 프로젝트에서는
  // 서로 다른 노드 id 를 가져야 canvas 가 혼선 없이 렌더된다.
  const graph = createInMemoryGraph();
  const a = graph.add('proj-A', 'src/App.tsx');
  const b = graph.add('proj-B', 'src/App.tsx');
  assert.ok(a && b);
  assert.notEqual(a!.id, b!.id, '프로젝트 간 동일 경로라도 서로 다른 노드여야 한다');
  assert.equal(graph.list('proj-A').length, 1);
  assert.equal(graph.list('proj-B').length, 1);
});

test('TC-GRAPH-DEDUPE: 같은 파일을 여러 번 add 해도 노드는 1개로 수렴한다', () => {
  // server.ts(line 464-471): 기존 노드가 있으면 새 id 를 만들지 않고 그대로 반환.
  // 경로 표기 차이(./, 역슬래시)도 정규화 후 동일 키에 모여야 한다.
  const graph = createInMemoryGraph();
  const first = graph.add('proj-A', 'src/App.tsx');
  const second = graph.add('proj-A', 'src/App.tsx');
  const third = graph.add('proj-A', './src/App.tsx');
  const fourth = graph.add('proj-A', 'src\\App.tsx');
  assert.ok(first && second && third && fourth);
  assert.equal(first!.id, second!.id, '두 번째 add 는 기존 노드를 돌려줘야 한다');
  assert.equal(first!.id, third!.id, './ 접두 차이가 유령 노드를 만들면 안 된다');
  assert.equal(first!.id, fourth!.id, '윈도우 구분자가 유령 노드를 만들면 안 된다');
  assert.equal(graph.list('proj-A').length, 1, '중복 add 는 노드 수를 늘리지 않는다');
});

test('TC-GRAPH-EXCLUDE: docs/ 경로는 add 호출해도 노드로 노출되지 않는다', () => {
  // server.ts line 457: isExcludedFromCodeGraph 가 docs/ 류를 즉시 거절.
  // 이 가드가 풀리면 핸드오프 노트가 캔버스에 노이즈로 쌓여 에이전트 HUD 를 가린다.
  const graph = createInMemoryGraph();
  assert.equal(graph.add('proj-A', 'docs/report.md'), null);
  assert.equal(graph.add('proj-A', './docs/handoffs/2026-04-18.md'), null);
  assert.equal(graph.add('proj-A', 'docs\\inbox\\x.md'), null);
  // 정상 파일은 그대로 노출되어야 한다 (가드의 반대 방향).
  assert.ok(graph.add('proj-A', 'src/App.tsx'));
  assert.deepEqual(graph.list('proj-A').map((n) => n.name), ['src/App.tsx']);
});

test('TC-GRAPH-MODIFY: 파일 편집 후 재-add 는 기존 노드를 유지하고 분열시키지 않는다', () => {
  // 에이전트가 Write 로 파일을 수정한 뒤 관행적으로 add_file 을 다시 호출해도
  // 새 노드가 생겨 캔버스에 중복 아이콘이 뜨면 안 된다 (멱등성 계약).
  const graph = createInMemoryGraph();
  const initial = graph.add('proj-A', 'src/components/EmptyProjectPlaceholder.tsx');
  const afterEdit = graph.add('proj-A', 'src/components/EmptyProjectPlaceholder.tsx');
  const afterConcurrent = graph.add('proj-A', './src/components/EmptyProjectPlaceholder.tsx');
  assert.equal(initial!.id, afterEdit!.id);
  assert.equal(initial!.id, afterConcurrent!.id);
  assert.equal(graph.list('proj-A').length, 1, '편집은 노드를 추가하지 않는다');
});

test('TC-GRAPH-DELETE: remove 호출 이후 list 에서 해당 노드가 사라진다', () => {
  const graph = createInMemoryGraph();
  graph.add('proj-A', 'src/App.tsx');
  graph.add('proj-A', 'src/components/EmptyProjectPlaceholder.tsx');
  assert.equal(graph.list('proj-A').length, 2);

  const removed = graph.remove('proj-A', 'src/components/EmptyProjectPlaceholder.tsx');
  assert.equal(removed, true, '존재하던 노드 삭제는 true 를 돌려줘야 한다');
  assert.equal(graph.has('proj-A', 'src/components/EmptyProjectPlaceholder.tsx'), false);
  const remaining = graph.list('proj-A');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].name, 'src/App.tsx', '남은 노드는 훼손되지 않아야 한다');
});

test('TC-GRAPH-DELETE-RE-ADD: 삭제된 파일을 재-add 하면 유령 없이 새 노드가 노출된다', () => {
  // 같은 이름 파일을 삭제 후 재-add 했을 때 이전 id 가 되살아나거나 소리 없이
  // 스킵되면 "유령 노드" 회귀. 새 id 가 발급되고 list 수는 1 이어야 한다.
  const graph = createInMemoryGraph();
  const first = graph.add('proj-A', 'src/App.tsx');
  graph.remove('proj-A', 'src/App.tsx');
  const second = graph.add('proj-A', 'src/App.tsx');
  assert.ok(first && second);
  assert.notEqual(first!.id, second!.id, '삭제 후 재-add 는 새 ID 를 발급해야 한다');
  assert.equal(graph.list('proj-A').length, 1);
});

test('TC-GRAPH-CROSS-PROJECT-DELETE: A 에서 삭제해도 B 의 동일 파일 노드는 살아남는다', () => {
  // 한 프로젝트의 remove 가 다른 프로젝트 같은 이름 노드까지 휩쓸면 cross-write
  // 버그. projectId 를 키에 포함하지 않은 index 가 들어오면 이 케이스가 터진다.
  const graph = createInMemoryGraph();
  graph.add('proj-A', 'src/App.tsx');
  graph.add('proj-B', 'src/App.tsx');
  graph.remove('proj-A', 'src/App.tsx');
  assert.equal(graph.has('proj-A', 'src/App.tsx'), false);
  assert.equal(graph.has('proj-B', 'src/App.tsx'), true, 'B 의 동일 파일은 훼손되면 안 된다');
  assert.equal(graph.list('proj-B').length, 1);
});

test('TC-GRAPH-CURRENT-BRANCH: 본 브랜치가 건드린 파일들이 모두 필터를 통과해 노드로 노출된다', () => {
  // git status 기준으로 이 브랜치가 수정/추가한 파일 집합. 필터 변경으로 이 중
  // 하나라도 docs/ 로 오분류되어 탈락하면 QA 가 바로 잡아야 한다.
  const touchedFiles = [
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
  const graph = createInMemoryGraph();
  for (const f of touchedFiles) {
    assert.ok(graph.add('proj-A', f), `${f} 가 그래프에서 탈락했다 — 필터 회귀 의심`);
  }
  assert.deepEqual(
    graph.list('proj-A').map((n) => n.name).sort(),
    [...touchedFiles].sort(),
    '본 브랜치 작업 파일 전체가 그래프에 노드로 노출되어야 한다',
  );
});

test('TC-GRAPH-EMPTY-NAME: 빈/공백 이름은 노드로 등록되지 않는다', () => {
  // server.ts line 453-455: 정규화 후 빈 문자열이면 400. 클라이언트도 같은
  // 계약을 지켜 유령 노드가 DB 에 박히는 사고를 막는다.
  const graph = createInMemoryGraph();
  assert.equal(graph.add('proj-A', ''), null);
  assert.equal(graph.add('proj-A', './'), null);
  assert.equal(graph.list('proj-A').length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// QA(감마): 실제 작업 파일 add/modify/delete 라이프사이클 회귀 — 할당 업무 #GRAPH-LIVE.
// TC-GRAPH-* 가 "필터/정규화/중복" 의 계약을 다뤘다면, 이 섹션은 에이전트가
// Write/Edit 로 실제 작업한 파일이 코드그래프에 끝까지 노출되는지를 세 시나리오
// (1) 동일 파일 N회 수정, (2) 신규 파일 추가, (3) 삭제 후 복구 를 체인으로 돌려
// 회귀 가드한다. EmptyProjectPlaceholder.tsx 는 이번 브랜치에서 AM 상태로 새로
// 추가된 파일이라 특히 "add 누락 시 캔버스에 영영 안 나오는" 사고 노출도가 크다.
// ─────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER_PATH = 'src/components/EmptyProjectPlaceholder.tsx';

test('TC-GRAPH-LIVE-MODIFY: 동일 파일을 N회 add(=수정 후 재신고) 해도 노드 id 와 타입이 흔들리지 않는다', () => {
  // 에이전트가 Edit/Write 반복 중 관행적으로 add_file 을 다시 호출해도 node id
  // 와 type 은 최초 등록값을 유지해야 한다. id 가 흔들리면 엣지(add_dependency)
  // 가 끊기고, type 이 흔들리면 캔버스 글리프 색이 깜빡인다.
  const graph = createInMemoryGraph();
  const initial = graph.add('proj-A', PLACEHOLDER_PATH);
  assert.ok(initial);
  for (let i = 0; i < 10; i++) {
    const again = graph.add('proj-A', PLACEHOLDER_PATH);
    assert.ok(again);
    assert.equal(again!.id, initial!.id, `${i}회차 재-add 에서 node id 가 변경됐다`);
    assert.equal(again!.type, initial!.type, `${i}회차 재-add 에서 node type 이 변경됐다`);
  }
  assert.equal(graph.list('proj-A').length, 1, '반복 재-add 가 노드 수를 증식시켰다');
});

test('TC-GRAPH-LIVE-ADD: 신규 추가된 EmptyProjectPlaceholder.tsx 는 add 호출 즉시 캔버스 노드로 노출된다', () => {
  // 브랜치에서 AM 상태로 막 만들어진 파일이 add_file 한 번으로 그래프에 실리는지.
  // 이 케이스가 깨지면 에이전트가 "파일을 만들었는데 캔버스에 안 보인다" 리포트를 받는다.
  const graph = createInMemoryGraph();
  assert.equal(graph.has('proj-A', PLACEHOLDER_PATH), false, '시작 시 노드가 있으면 안 된다');
  const added = graph.add('proj-A', PLACEHOLDER_PATH);
  assert.ok(added, '신규 파일 add 는 반드시 노드를 돌려줘야 한다');
  assert.equal(graph.has('proj-A', PLACEHOLDER_PATH), true);
  assert.equal(added!.type, 'component');
  // 다른 프로젝트에는 노출되지 않아야 한다.
  assert.equal(graph.list('proj-B').length, 0);
});

test('TC-GRAPH-LIVE-DELETE-RESTORE: 삭제 → 재-add 사이클을 3회 돌려도 마지막에 단일 노드가 노출된다', () => {
  // 실사례: 에이전트가 rename/rollback 을 반복하는 구간. 매 사이클마다 node id 는
  // 새로 발급되지만 프로젝트 별 노드 수는 "0 ↔ 1" 만 왕복해야 한다.
  const graph = createInMemoryGraph();
  let lastId: string | undefined;
  for (let cycle = 0; cycle < 3; cycle++) {
    const created = graph.add('proj-A', PLACEHOLDER_PATH);
    assert.ok(created, `cycle=${cycle} add 실패`);
    assert.notEqual(created!.id, lastId, `cycle=${cycle} 재-add 가 이전 id 를 되살렸다`);
    assert.equal(graph.list('proj-A').length, 1);
    lastId = created!.id;
    assert.equal(graph.remove('proj-A', PLACEHOLDER_PATH), true, `cycle=${cycle} 삭제 실패`);
    assert.equal(graph.list('proj-A').length, 0, `cycle=${cycle} 삭제 후 노드가 남았다`);
  }
  // 마지막 한 번만 add 해서 "최종적으로 캔버스에 살아 있는" 상태를 확정.
  const final = graph.add('proj-A', PLACEHOLDER_PATH);
  assert.ok(final);
  assert.equal(graph.list('proj-A').length, 1);
});

test('TC-GRAPH-LIVE-BRANCH-LIFECYCLE: 본 브랜치 작업 파일 전체의 add→modify→delete→re-add 가 격리된 채 수렴한다', () => {
  // 워킹 트리의 M/AM 파일 9종을 전수 돌리며 각 시나리오를 한 번에 검증.
  // 도중에 한 파일이라도 노드가 증식하거나 docs/ 필터에 걸리거나 type 이 바뀌면
  // 캔버스 회귀가 즉시 노출된다. 이 시나리오는 "에이전트 9명이 동시에 파일별
  // 라이프사이클을 돌리는 상황" 의 단일 스레드 근사.
  const touched = [
    ['server.ts', 'service'],
    ['src/App.tsx', 'component'],
    ['src/components/EmptyProjectPlaceholder.tsx', 'component'],
    ['src/components/ProjectManagement.tsx', 'component'],
    ['src/components/ProjectManagement.test.ts', 'util'],
    ['src/components/ProjectMenuScope.test.ts', 'util'],
    ['src/index.css', 'style'],
    ['src/types.ts', 'util'],
    ['src/utils/codeGraphFilter.ts', 'util'],
  ] as const;
  const graph = createInMemoryGraph();

  // (1) add: 모두 노출된다.
  const firstIds = new Map<string, string>();
  for (const [path, expectedType] of touched) {
    const node = graph.add('proj-A', path);
    assert.ok(node, `${path} 가 add 에서 탈락했다`);
    assert.equal(node!.type, expectedType, `${path} 의 최초 타입이 ${expectedType} 가 아니다`);
    firstIds.set(path, node!.id);
  }
  assert.equal(graph.list('proj-A').length, touched.length);

  // (2) modify: 동일 파일 재-add 는 기존 노드 id 를 돌려줘야 한다 (멱등).
  for (const [path] of touched) {
    const again = graph.add('proj-A', path);
    assert.equal(again!.id, firstIds.get(path), `${path} 수정 신고가 새 node id 를 발급했다`);
  }
  assert.equal(graph.list('proj-A').length, touched.length, '수정 사이클이 노드 수를 늘렸다');

  // (3) delete: 홀수 인덱스 파일만 삭제. 짝수 인덱스는 그대로 살아 있어야 한다.
  const deletedPaths: string[] = [];
  const survivorPaths: string[] = [];
  touched.forEach(([path], idx) => {
    if (idx % 2 === 1) {
      assert.equal(graph.remove('proj-A', path), true, `${path} 삭제 실패`);
      deletedPaths.push(path);
    } else {
      survivorPaths.push(path);
    }
  });
  const afterDelete = graph.list('proj-A').map((n) => n.name).sort();
  assert.deepEqual(afterDelete, [...survivorPaths].sort(), '삭제 후 생존 목록이 기대와 다르다');
  for (const gone of deletedPaths) {
    assert.equal(graph.has('proj-A', gone), false, `${gone} 가 삭제 후에도 캔버스에 남았다`);
  }

  // (4) re-add: 삭제했던 파일을 다시 add. 새 node id 가 발급되면서 캔버스 노출 복구.
  for (const path of deletedPaths) {
    const reborn = graph.add('proj-A', path);
    assert.ok(reborn, `${path} 재-add 실패`);
    assert.notEqual(reborn!.id, firstIds.get(path), `${path} 재-add 가 옛 id 를 되살렸다`);
  }
  // 최종: 모든 파일이 다시 노드로 살아 있고, 다른 프로젝트에는 전염되지 않았다.
  assert.deepEqual(
    graph.list('proj-A').map((n) => n.name).sort(),
    [...touched.map(([p]) => p)].sort(),
    '전체 라이프사이클 후 작업 파일이 모두 캔버스에 복원되어야 한다',
  );
  assert.equal(graph.list('proj-B').length, 0, '다른 프로젝트로 전염이 발생했다');
});

test('TC-GRAPH-LIVE-PEER-DELETE: EmptyProjectPlaceholder.tsx 삭제가 본 브랜치 peer 파일 노드를 훼손하지 않는다', () => {
  // 실사례: 에이전트가 rename 도중 플레이스홀더만 drop 하려다 index 계약이 깨지면 peer
  // 파일(App.tsx, types.ts 등) 노드가 동반 실종되는 사고. placeholder 한 개만 사라지고
  // 나머지는 byte-identical 로 살아 있어야 한다.
  const graph = createInMemoryGraph();
  const peers = [
    'server.ts', 'src/App.tsx', 'src/components/ProjectManagement.tsx',
    'src/index.css', 'src/types.ts', 'src/utils/codeGraphFilter.ts',
  ];
  const placeholderNode = graph.add('proj-A', PLACEHOLDER_PATH);
  const peerIds = new Map<string, string>();
  for (const p of peers) {
    const n = graph.add('proj-A', p);
    assert.ok(n, `${p} add 실패`);
    peerIds.set(p, n!.id);
  }
  assert.ok(placeholderNode);
  assert.equal(graph.list('proj-A').length, peers.length + 1);

  assert.equal(graph.remove('proj-A', PLACEHOLDER_PATH), true);
  assert.equal(graph.has('proj-A', PLACEHOLDER_PATH), false);
  // peer 파일 노드는 단 하나도 흔들리면 안 된다 (id 보존).
  for (const p of peers) {
    assert.equal(graph.has('proj-A', p), true, `${p} 가 peer 삭제 파장에 휩쓸렸다`);
    const stillThere = graph.list('proj-A').find((n) => n.name === p);
    assert.equal(stillThere!.id, peerIds.get(p), `${p} 의 node id 가 placeholder 삭제로 재발급됐다`);
  }
  assert.equal(graph.list('proj-A').length, peers.length, 'peer 노드 수가 placeholder 삭제 후 바뀌었다');
});

test('TC-GRAPH-LIVE-ORDER-COMMUTATIVE: add 순서에 상관없이 최종 노드 집합/타입은 동일하게 수렴한다', () => {
  // 에이전트가 병렬로 파일 작업을 하면 add_file 호출 순서가 비결정적이다. 순서가
  // 달라도 최종 캔버스 상태는 동일해야 한다 (가환성). 순서 의존 회귀가 숨으면
  // "같은 작업인데 캔버스가 다르게 보임" 사고로 이어진다.
  const files = [
    'src/components/EmptyProjectPlaceholder.tsx',
    'src/App.tsx',
    'src/types.ts',
    'src/index.css',
    'server.ts',
  ];
  const forward = createInMemoryGraph();
  for (const f of files) assert.ok(forward.add('proj-A', f));
  const reverse = createInMemoryGraph();
  for (const f of [...files].reverse()) assert.ok(reverse.add('proj-A', f));
  const shuffled = createInMemoryGraph();
  for (const f of [files[2], files[0], files[4], files[1], files[3]]) {
    assert.ok(shuffled.add('proj-A', f));
  }
  // 이름·타입 쌍 집합은 세 그래프에서 동일해야 한다 (id 는 seq 라서 다를 수 있음).
  const snapshot = (g: ReturnType<typeof createInMemoryGraph>) =>
    g.list('proj-A').map((n) => `${n.name}::${n.type}`).sort();
  assert.deepEqual(snapshot(forward), snapshot(reverse), '역순 add 가 다른 캔버스를 만들었다');
  assert.deepEqual(snapshot(forward), snapshot(shuffled), '셔플 순 add 가 다른 캔버스를 만들었다');
});

test('TC-GRAPH-LIVE-INTERLEAVE: add/remove 인터리브 스트림 끝에서도 placeholder 가시성이 정확히 결정된다', () => {
  // 멀티 에이전트가 같은 파일을 반복 add/remove 하는 스트림. 최종 연산이 add 면 1,
  // remove 면 0. 중간 상태에 상관없이 "마지막 호출" 이 승자여야 한다.
  const graph = createInMemoryGraph();
  const timeline: Array<['add' | 'remove', string]> = [
    ['add', PLACEHOLDER_PATH],
    ['remove', PLACEHOLDER_PATH],
    ['add', PLACEHOLDER_PATH],
    ['add', PLACEHOLDER_PATH], // 중복 add — 멱등
    ['remove', PLACEHOLDER_PATH],
    ['add', PLACEHOLDER_PATH],
  ];
  for (const [op, path] of timeline) {
    if (op === 'add') graph.add('proj-A', path);
    else graph.remove('proj-A', path);
  }
  // 마지막 연산이 add 이므로 노드는 살아 있어야 한다.
  assert.equal(graph.has('proj-A', PLACEHOLDER_PATH), true, '마지막 add 가 가시성을 회복시키지 못했다');
  assert.equal(graph.list('proj-A').length, 1, '인터리브 끝에서 노드 수가 1 이 아니다');

  // 반대 케이스: 같은 타임라인 끝에 remove 가 오면 0 이어야 한다.
  const tail = graph.remove('proj-A', PLACEHOLDER_PATH);
  assert.equal(tail, true);
  assert.equal(graph.has('proj-A', PLACEHOLDER_PATH), false);
  assert.equal(graph.list('proj-A').length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// QA(감마): "에이전트 편집 후 코드그래프 반영" 시나리오 — 할당 업무 #GRAPH-EDIT-SYNC.
// 에이전트가 Write/Edit 로 실제 디스크에 파일을 건드린 뒤 add_file 로 그래프에
// 올린 목록이 list_files 결과와 한 치도 어긋나면 안 된다. 편집 ≠ 그래프 노출
// 이 벌어지는 전형적 회귀 3종 — (a) 편집했는데 add_file 누락, (b) 삭제했는데
// remove 누락, (c) 경로 표기 차이로 이중 등록 — 을 list_files 관점에서 한 번에
// 잡는다. 이 테스트가 녹색이면 에이전트 HUD 가 "방금 편집한 파일이 캔버스에
// 없다"는 상태로 떨어지지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

// list_files 의 계약: (projectId 스코프, 편집 발생 시각 기준) 디스크에 남아 있는
// 파일만 노출. 이름·타입·프로젝트 격리가 맞아야 "일치" 로 본다.
function snapshotListFiles(
  graph: ReturnType<typeof createInMemoryGraph>,
  projectId: string,
) {
  return graph.list(projectId)
    .map((n) => ({ name: n.name, type: n.type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

test('TC-GRAPH-EDIT-SYNC-ADD: 에이전트가 신규 파일 3종을 편집→add_file 하면 list_files 결과가 동일 집합이다', () => {
  // 시나리오: 에이전트가 tsx/ts/css 3종을 새로 만들고 add_file 호출. list_files
  // 가 돌려주는 이름·타입 페어와 에이전트가 편집한 파일 목록이 정확히 겹쳐야 한다.
  const graph = createInMemoryGraph();
  const edited: Array<{ name: string; type: CodeFileType }> = [
    { name: 'src/components/EmptyProjectPlaceholder.tsx', type: 'component' },
    { name: 'src/utils/codeGraphFilter.ts', type: 'util' },
    { name: 'src/index.css', type: 'style' },
  ];
  for (const f of edited) graph.add('proj-A', f.name);
  assert.deepEqual(
    snapshotListFiles(graph, 'proj-A'),
    [...edited].sort((a, b) => a.name.localeCompare(b.name)),
    'list_files 결과가 에이전트가 편집한 파일 집합과 달라졌다',
  );
});

test('TC-GRAPH-EDIT-SYNC-MODIFY: 동일 파일 반복 편집→재-add 해도 list_files 스냅샷이 불변이다', () => {
  // Edit → add_file 사이클이 반복되는 실사례. node 가 증식하거나 타입이 흔들리면
  // HUD 는 "편집 내용이 방금 2번 들어왔다" 는 허위 신호를 낸다.
  const graph = createInMemoryGraph();
  const path = 'src/components/EmptyProjectPlaceholder.tsx';
  graph.add('proj-A', path);
  const baseline = snapshotListFiles(graph, 'proj-A');
  for (let i = 0; i < 5; i++) {
    graph.add('proj-A', path);
    assert.deepEqual(
      snapshotListFiles(graph, 'proj-A'),
      baseline,
      `재-add ${i + 1}회차에서 list_files 스냅샷이 변했다`,
    );
  }
});

test('TC-GRAPH-EDIT-SYNC-DELETE: 편집 파일을 디스크에서 지우고 remove 하면 list_files 에서 동시에 빠진다', () => {
  // 삭제 커밋 시나리오. 디스크 ↔ list_files 가 어긋나면 캔버스에 "이미 지운 파일" 이
  // 유령으로 남아 의존성 엣지가 끊어진 노드를 가리킨다.
  const graph = createInMemoryGraph();
  const touched = [
    'src/components/EmptyProjectPlaceholder.tsx',
    'src/components/ProjectManagement.tsx',
    'src/components/ProjectMenuScope.test.ts',
  ];
  for (const f of touched) graph.add('proj-A', f);
  graph.remove('proj-A', 'src/components/ProjectMenuScope.test.ts');
  const diskAfterDelete = touched.filter((f) => f !== 'src/components/ProjectMenuScope.test.ts').sort();
  assert.deepEqual(
    graph.list('proj-A').map((n) => n.name).sort(),
    diskAfterDelete,
    'remove 이후 list_files 가 디스크 상태를 따라오지 못했다',
  );
});

test('TC-GRAPH-EDIT-SYNC-PATH-VARIANT: 경로 표기 차이로 add 해도 list_files 는 정규화된 단일 이름만 노출한다', () => {
  // 에이전트마다 ./ 접두/역슬래시 표기가 다를 수 있다. 정규화가 한 곳에서
  // 일관되게 돌아야 list_files == 실제 편집 파일 집합 불변식이 유지된다.
  const graph = createInMemoryGraph();
  graph.add('proj-A', './src/App.tsx');
  graph.add('proj-A', 'src\\App.tsx');
  graph.add('proj-A', 'src/App.tsx');
  assert.deepEqual(
    graph.list('proj-A').map((n) => n.name),
    ['src/App.tsx'],
    '표기 차이로 중복 노드가 list_files 에 샜다',
  );
});

test('TC-GRAPH-EDIT-SYNC-FULL: 본 브랜치 편집 파일 전체의 list_files 집합이 디스크 목록과 정확히 일치한다', () => {
  // git status M/AM 목록과 list_files 결과 집합의 1:1 매핑. 이 불변식이 깨지면
  // 코드그래프 캔버스와 에이전트 HUD 가 서로 다른 현실을 그린다.
  const edited = [
    'server.ts',
    'src/App.tsx',
    'src/components/EmptyProjectPlaceholder.tsx',
    'src/components/GitAutomationPanel.test.ts',
    'src/components/ProjectManagement.tsx',
    'src/components/ProjectManagement.test.ts',
    'src/components/ProjectMenuScope.test.ts',
    'src/index.css',
    'src/types.ts',
    'src/utils/codeGraphFilter.ts',
  ];
  const graph = createInMemoryGraph();
  for (const f of edited) assert.ok(graph.add('proj-A', f), `${f} add 가 필터에 걸렸다`);
  assert.deepEqual(
    graph.list('proj-A').map((n) => n.name).sort(),
    [...edited].sort(),
    'list_files 집합이 디스크 편집 목록과 어긋났다',
  );
  // projectId 스코프 격리 — 다른 프로젝트로 전염되면 안 된다.
  assert.equal(graph.list('proj-B').length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// QA(감마): MCP list_files 응답 형태로 "실제 작업 파일이 코드그래프에 노출되는지"
// 검증 — 할당 업무 #GRAPH-MCP-EXPOSURE.
// createInMemoryGraph 는 server.ts POST /api/files 의 단일-스레드 근사치지만,
// 실제 MCP 클라이언트는 list_files payload 를 {id, name, type, projectId, x, y}
// 형태로 받는다. 이 섹션은 (1) 추가 후 payload 가 정확한 필드 집합을 돌려주는지,
// (2) 수정 사이클 중 list_files 스냅샷이 증식하지 않는지, (3) 삭제가 이웃 노드를
// 휩쓸지 않는지 — 3 시나리오를 MCP 응답 스키마 레이어에서 잠근다.
// AM 상태로 신규 편입된 EmptyProjectPlaceholder.tsx 를 주인공 삼아, "방금 만든
// 파일이 캔버스에 안 보인다" 류 회귀가 MCP 계약까지 침투하지 못하도록 한다.
// ─────────────────────────────────────────────────────────────────────────────

// server.ts list_files 가 돌려주는 필드 중 그래프 렌더/식별에 쓰이는 최소 집합.
// x/y 는 테스트 목적과 무관해 제외 — 대신 id/name/type/projectId 일치만 고정한다.
interface McpFileRow { id: string; name: string; type: CodeFileType; projectId: string; }

function snapshotMcpListFiles(
  graph: ReturnType<typeof createInMemoryGraph>,
  projectId: string,
): McpFileRow[] {
  return graph.list(projectId)
    .map((n) => ({ id: n.id, name: n.name, type: n.type, projectId: n.projectId }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

test('TC-GRAPH-MCP-LIST-ADD: AM 상태 신규 파일이 add 직후 list_files 스키마대로 정확히 노출된다', () => {
  // 실제 MCP whoami/list_files 계약: 이름·타입·프로젝트 격리가 맞고, id 가 안정적
  // 으로 발급되어야 클라이언트 HUD 가 노드를 정확히 짚어낼 수 있다.
  const graph = createInMemoryGraph();
  const placeholder = graph.add('proj-A', 'src/components/EmptyProjectPlaceholder.tsx');
  assert.ok(placeholder, 'AM 파일 add 가 null 을 돌려줬다');
  assert.equal(placeholder!.type, 'component', 'inferFileType 이 component 를 내지 못했다');

  const snapshot = snapshotMcpListFiles(graph, 'proj-A');
  assert.equal(snapshot.length, 1, 'list_files 응답에 노드가 정확히 1개 있어야 한다');
  assert.deepEqual(snapshot[0], {
    id: placeholder!.id,
    name: 'src/components/EmptyProjectPlaceholder.tsx',
    type: 'component',
    projectId: 'proj-A',
  }, 'list_files 응답 필드가 add 결과와 어긋났다');
  // 다른 프로젝트 스코프는 비어 있어야 한다 — 스코프 전염 금지.
  assert.deepEqual(snapshotMcpListFiles(graph, 'proj-B'), []);
});

test('TC-GRAPH-MCP-LIST-MODIFY: Edit 5회 + 경로 변형 add 에도 list_files 응답이 단일 엔트리로 유지된다', () => {
  // "수정" 시나리오 = Edit → add_file 재호출. MCP 응답이 node 를 증식시키면
  // 캔버스가 같은 파일을 여러 번 그려 사용자가 "내가 1번 수정했는데 HUD 에는
  // 3번 찍혀 있다" 는 혼란 신호를 받는다.
  const graph = createInMemoryGraph();
  const placeholder = graph.add('proj-A', 'src/components/EmptyProjectPlaceholder.tsx');
  assert.ok(placeholder);
  const baselineId = placeholder!.id;

  // Edit → add_file 재호출 5회. 경로 표기 변형(./·역슬래시) 섞어 넣어도 한 노드로 수렴.
  const variants = [
    'src/components/EmptyProjectPlaceholder.tsx',
    './src/components/EmptyProjectPlaceholder.tsx',
    'src\\components\\EmptyProjectPlaceholder.tsx',
    './src\\components/EmptyProjectPlaceholder.tsx',
    'src/components/EmptyProjectPlaceholder.tsx',
  ];
  for (const [i, v] of variants.entries()) {
    const again = graph.add('proj-A', v);
    assert.ok(again);
    assert.equal(again!.id, baselineId, `round=${i} 재-add 가 새 id 를 발급했다 — 캔버스 증식 회귀`);
    assert.equal(again!.type, 'component', `round=${i} 재-add 에서 type 이 흔들렸다`);
  }
  const snapshot = snapshotMcpListFiles(graph, 'proj-A');
  assert.equal(snapshot.length, 1, '수정 루프 후 list_files 엔트리 수가 1 이 아니다');
  assert.equal(snapshot[0].id, baselineId);
});

test('TC-GRAPH-MCP-LIST-DELETE: AM 파일 삭제 후 list_files 에서 제외되고 이웃 노드는 byte-identical 유지된다', () => {
  // "삭제" 시나리오 = remove 호출. MCP 응답에서 해당 노드만 빠지고, 같은
  // 프로젝트의 다른 파일은 id·type 모두 원형 보존돼야 한다. 회귀가 발생하면
  // "한 파일 지웠는데 캔버스가 통째로 재렌더" 되는 시각 충격.
  const graph = createInMemoryGraph();
  const peers = [
    'src/App.tsx',
    'src/types.ts',
    'src/utils/codeGraphFilter.ts',
  ];
  const peerSnapshotBefore = new Map<string, { id: string; type: CodeFileType }>();
  for (const p of peers) {
    const node = graph.add('proj-A', p);
    assert.ok(node);
    peerSnapshotBefore.set(p, { id: node!.id, type: node!.type });
  }
  const placeholder = graph.add('proj-A', 'src/components/EmptyProjectPlaceholder.tsx');
  assert.ok(placeholder);
  assert.equal(snapshotMcpListFiles(graph, 'proj-A').length, peers.length + 1);

  assert.equal(
    graph.remove('proj-A', 'src/components/EmptyProjectPlaceholder.tsx'),
    true,
    'AM 파일 remove 가 false 를 돌려줬다 — MCP delete 계약 파손',
  );
  const after = snapshotMcpListFiles(graph, 'proj-A');
  assert.equal(after.length, peers.length, 'remove 후 list_files 엔트리 수가 이웃만 남지 않는다');
  assert.equal(
    after.some((n) => n.name === 'src/components/EmptyProjectPlaceholder.tsx'),
    false,
    '삭제된 AM 파일이 list_files 응답에 유령으로 남았다',
  );
  // 이웃 노드는 id/type 모두 원형 유지.
  for (const p of peers) {
    const still = after.find((n) => n.name === p);
    assert.ok(still, `${p} 가 placeholder 삭제 파장에 휩쓸렸다`);
    const before = peerSnapshotBefore.get(p)!;
    assert.equal(still!.id, before.id, `${p} 의 id 가 재발급됐다 — 엣지 끊김 회귀`);
    assert.equal(still!.type, before.type, `${p} 의 type 이 바뀌었다`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// QA(감마): 새로고침/서버재시작/동시성/네트워크 지연 회귀 — 할당 업무 #REFRESH-WORKING.
// MongoDB 가 유일 진원(server.ts line 241-247, 408-452). 아래 네 테스트는
// "에이전트가 working 중에 페이지 새로고침/서버 재기동/동시 태스크/네트워크
// 지연이 겹쳐도 status 와 workingOnFileId 가 어느 프레임에서도 사라지지 않는다"
// 는 불변식을 클라이언트 모델로 고정한다. idle/빈 currentTask 플래시 한 번이면
// 리더 자동화가 가용으로 오판해 중복 태스크를 얹는다.
// ─────────────────────────────────────────────────────────────────────────────

// /api/agents 백엔드(server.ts line 245-248)의 단일-스레드 in-memory 등가물.
// 브라우저 세션과 서버 프로세스 바깥에 살아남는 지속 저장소(DB) 계약만 흉내낸다.
// upsert/snapshot 은 반드시 deep copy 를 주고받아 외부 변조가 저장소로 새지
// 않도록 한다 — Mongo 가 매 조회마다 fresh 문서를 돌려주는 것과 동치.
function createAgentStore() {
  const store = new Map<string, Agent>();
  const clone = (a: Agent): Agent => ({ ...a });
  return {
    upsert(agent: Agent) {
      store.set(agent.id, clone(agent));
    },
    snapshot(id: string): Agent | undefined {
      const a = store.get(id);
      return a ? clone(a) : undefined;
    },
    all(): Agent[] {
      return Array.from(store.values()).map(clone);
    },
  };
}

test('TC-REFRESH-1: working 중 새로고침(F5) 해도 status/workingOnFileId/currentTask 가 그대로 복원된다', () => {
  // 실사례: 장시간 태스크 중간에 사용자가 F5. 서버 재기동 없이 클라이언트만
  // 재접속하는 가장 흔한 경로. /api/agents (line 245-248) 가 DB 스냅샷을 즉시
  // 돌려줘야 소켓 연결 전에도 카드가 working 으로 그려진다 — idle 1프레임이라도
  // 샜다면 리더 자동화가 중복 태스크를 얹는다.
  const store = createAgentStore();
  const live = makeAgentFixture('dev-refresh', {
    status: 'working',
    workingOnFileId: 'f-refresh',
    currentTask: 'impl-refresh',
  });
  store.upsert(live);

  const restored = store.snapshot(live.id);
  assert.ok(restored, '새로고침 시 DB 스냅샷이 비어 있으면 안 된다');
  assert.equal(restored!.status, 'working', '새로고침이 status 를 idle 로 떨어뜨렸다');
  assert.equal(restored!.workingOnFileId, 'f-refresh', '파일 포커스가 풀렸다');
  assert.equal(restored!.currentTask, 'impl-refresh', 'currentTask 가 증발했다');
  assert.equal(isActiveAgent(restored!), true, '복원 직후 활성 판정이 깨졌다');
});

test('TC-REFRESH-2: 서버 재시작 후에도 multi-agent 의 status/workingOnFileId 가 1:1 로 복원된다', () => {
  // 실사례: pm2/docker 재기동. 프로세스 메모리는 날아가도 MongoDB 는 유일 진원.
  // 재접속한 클라이언트가 /api/agents 를 재호출하면 DB 값이 그대로 UI 로 흘러야 한다.
  // idle 로 폴백하거나 에이전트 간 상태가 섞이면 즉시 회귀.
  const store = createAgentStore();
  store.upsert(makeAgentFixture('qa-r', { status: 'working', workingOnFileId: 'fQA', currentTask: 'tQA' }));
  store.upsert(makeAgentFixture('dev-r', { status: 'thinking', workingOnFileId: 'fDEV', currentTask: 'tDEV' }));
  store.upsert(makeAgentFixture('des-r', { status: 'meeting', workingOnFileId: 'fDES', currentTask: 'tDES' }));
  store.upsert(makeAgentFixture('ldr-r', { status: 'idle' }));

  // 서버 재시작 — 프로세스 메모리만 날아가고 DB 는 그대로.
  const afterRestart = store.all();
  assert.equal(afterRestart.length, 4, '재시작 후 에이전트 수가 달라졌다');
  const byId = new Map(afterRestart.map((a) => [a.id, a]));

  assert.equal(byId.get('qa-r')!.status, 'working');
  assert.equal(byId.get('qa-r')!.workingOnFileId, 'fQA');
  assert.equal(byId.get('qa-r')!.currentTask, 'tQA');
  assert.equal(isActiveAgent(byId.get('qa-r')!), true);

  assert.equal(byId.get('dev-r')!.status, 'thinking');
  assert.equal(byId.get('dev-r')!.workingOnFileId, 'fDEV');
  assert.equal(isActiveAgent(byId.get('dev-r')!), true);

  assert.equal(byId.get('des-r')!.status, 'meeting');
  assert.equal(byId.get('des-r')!.workingOnFileId, 'fDES');
  assert.equal(isActiveAgent(byId.get('des-r')!), true);

  assert.equal(byId.get('ldr-r')!.status, 'idle');
  assert.equal(byId.get('ldr-r')!.workingOnFileId, undefined, 'idle 복원 시 파일 포커스는 비어야 한다');
  assert.equal(isActiveAgent(byId.get('ldr-r')!), false);
});

test('TC-REFRESH-3: 다중 에이전트가 동시 working 상태일 때 새로고침이 파일 포커스를 교차 오염시키지 않는다', () => {
  // 실사례: QA/Dev/Designer 가 서로 다른 파일을 잡고 병렬 작업. 전역 슬롯 공유
  // 버그(AGT4b 참고) 가 persistence 계층에도 있으면, 스냅샷 배열이 최신 에이전트의
  // 파일 id 로 전부 덮인다. id→file 매핑이 1:1 로 유지돼야 한다.
  const store = createAgentStore();
  const agents = [
    makeAgentFixture('a1', { status: 'working', workingOnFileId: 'f1', currentTask: 't1' }),
    makeAgentFixture('a2', { status: 'working', workingOnFileId: 'f2', currentTask: 't2' }),
    makeAgentFixture('a3', { status: 'working', workingOnFileId: 'f3', currentTask: 't3' }),
  ];
  for (const a of agents) store.upsert(a);

  const restored = store.all();
  assert.equal(restored.length, 3);
  const ids = restored.map((a) => a.id).sort();
  assert.deepEqual(ids, ['a1', 'a2', 'a3'], '에이전트 id 집합이 누락/중복됐다');

  for (const original of agents) {
    const r = restored.find((x) => x.id === original.id)!;
    assert.equal(r.status, 'working', `${original.id} 의 working 이 사라졌다`);
    assert.equal(r.workingOnFileId, original.workingOnFileId, `${original.id} 의 파일 포커스가 엉켰다`);
    assert.equal(r.currentTask, original.currentTask, `${original.id} 의 currentTask 가 섞였다`);
    assert.equal(isActiveAgent(r), true);
  }

  // 파일 포커스 집합 — 세 에이전트가 동일 파일로 엉켜 붙으면 즉시 실패.
  const files = restored.map((a) => a.workingOnFileId).sort();
  assert.deepEqual(files, ['f1', 'f2', 'f3'], '복원 후 파일 포커스가 교차 오염됐다');

  // 외부 변조가 저장소로 새면 다른 탭의 읽기가 오염된다 — deep-copy 불변식 가드.
  restored[0].status = 'idle';
  restored[0].workingOnFileId = undefined;
  const reread = store.snapshot(restored[0].id)!;
  const original0 = agents.find((a) => a.id === restored[0].id)!;
  assert.equal(reread.status, 'working', 'snapshot 이 저장소 참조를 노출하면 외부 변조가 전염된다');
  assert.equal(reread.workingOnFileId, original0.workingOnFileId);
});

test('TC-REFRESH-4: 네트워크 지연으로 stale idle PATCH 가 뒤늦게 도착해도 최신 working 을 덮지 않는다', () => {
  // 실사례: 클라이언트가 working→idle 을 낙관적으로 쏘는데 서버는 이미 다음 태스크로
  // working 을 재기록. PATCH /api/agents/:id/status (server.ts line 408-452) 가 단순
  // last-write-wins 라면 지연 도착한 stale idle 이 새 working 을 풀어버린다.
  // appliedAt 기반 LWW 불변식을 모델에 박아 회귀 가드로 삼는다.
  interface Versioned extends Agent { appliedAt: number; }
  type PatchEvent = { status: Agent['status']; workingOnFileId?: string; appliedAt: number };

  function applyIfFresher(current: Versioned, ev: PatchEvent): Versioned {
    if (ev.appliedAt <= current.appliedAt) return current; // stale — drop
    const nextFile =
      ev.workingOnFileId === undefined
        ? current.workingOnFileId
        : ev.workingOnFileId === ''
        ? undefined
        : ev.workingOnFileId;
    const nextTask = ev.status === 'idle' ? undefined : current.currentTask;
    return { ...current, status: ev.status, workingOnFileId: nextFile, currentTask: nextTask, appliedAt: ev.appliedAt };
  }

  const base: Versioned = {
    ...makeAgentFixture('agt-delay', { status: 'working', workingOnFileId: 'f-old', currentTask: 't-old' }),
    appliedAt: 100,
  };

  // t=200: 다음 태스크 착수로 서버가 새 working 을 먼저 커밋.
  const afterNewWorking = applyIfFresher(base, { status: 'working', workingOnFileId: 'f-new', appliedAt: 200 });
  assert.equal(afterNewWorking.status, 'working');
  assert.equal(afterNewWorking.workingOnFileId, 'f-new');
  assert.equal(afterNewWorking.appliedAt, 200);

  // t=150 에 큐잉됐던 idle PATCH 가 네트워크 지연으로 뒤늦게 도착 — 드랍돼야 한다.
  const afterStaleIdle = applyIfFresher(afterNewWorking, { status: 'idle', workingOnFileId: '', appliedAt: 150 });
  assert.equal(afterStaleIdle.status, 'working', 'stale idle 이 최신 working 을 덮었다');
  assert.equal(afterStaleIdle.workingOnFileId, 'f-new', 'stale idle 이 파일 포커스를 풀었다');
  assert.equal(afterStaleIdle.currentTask, base.currentTask, 'stale idle 이 currentTask 를 지웠다');
  assert.equal(afterStaleIdle.appliedAt, 200, 'stale 이벤트가 appliedAt 시계를 되돌렸다');

  // 동일 appliedAt 은 멱등 — 중복 배송되어도 상태 토글이 없어야 한다.
  const tieBreak = applyIfFresher(afterStaleIdle, { status: 'idle', workingOnFileId: '', appliedAt: 200 });
  assert.equal(tieBreak.status, 'working', '동일 appliedAt 재배송이 기존 상태를 덮었다');

  // t=300 의 진짜 최신 idle 은 반영돼야 한다 — LWW 가 얼어붙으면 그 자체가 회귀.
  const afterFreshIdle = applyIfFresher(tieBreak, { status: 'idle', workingOnFileId: '', appliedAt: 300 });
  assert.equal(afterFreshIdle.status, 'idle');
  assert.equal(afterFreshIdle.workingOnFileId, undefined);
  assert.equal(afterFreshIdle.currentTask, undefined, 'idle 전이 시 currentTask 는 함께 비워진다');
  assert.equal(isActiveAgent(afterFreshIdle), false);

  // 병렬 에이전트 간 격리 — 한 에이전트의 stale 이벤트가 다른 에이전트 시계에 개입 금지.
  const peer: Versioned = {
    ...makeAgentFixture('agt-peer', { status: 'working', workingOnFileId: 'f-peer', currentTask: 't-peer' }),
    appliedAt: 100,
  };
  const peerAfter = applyIfFresher(peer, { status: 'working', workingOnFileId: 'f-peer', appliedAt: 110 });
  assert.equal(peerAfter.status, 'working');
  assert.equal(peerAfter.workingOnFileId, 'f-peer', 'peer 파일 포커스가 다른 에이전트 이벤트에 끌려다녔다');
});
