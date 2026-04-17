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
import { USER_PREFERENCES_KEY } from '../types.ts';
import type { GitAutomationPreference, ManagedProject } from '../types.ts';
import { shouldAutoCommit, shouldAutoPush } from '../utils/gitAutomation.ts';

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
