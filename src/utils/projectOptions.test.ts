// updateProjectOptionsSchema 검증기의 단위 테스트. node --test 러너에서 실행되며,
// server.ts / useProjectOptions 훅이 의존하는 계약(입력 형 강제, $set/$unset 빌드,
// null == 해제) 을 고정한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProjectOptionsValidationError,
  hasAnyUpdate,
  projectOptionsView,
  updateProjectOptionsSchema,
} from './projectOptions';

test('빈 객체는 업데이트 없음으로 통과', () => {
  const result = updateProjectOptionsSchema({});
  assert.equal(hasAnyUpdate(result), false);
  assert.deepEqual(result.$set, {});
  assert.deepEqual(result.$unset, {});
});

test('autoDevEnabled 는 boolean 이어야 한다', () => {
  assert.throws(() => updateProjectOptionsSchema({ autoDevEnabled: 'true' }), ProjectOptionsValidationError);
  const ok = updateProjectOptionsSchema({ autoDevEnabled: true });
  assert.equal(ok.$set.autoDevEnabled, true);
});

test('defaultBranch 공백/타입 오류를 거부하고 trim 한다', () => {
  assert.throws(() => updateProjectOptionsSchema({ defaultBranch: '' }), ProjectOptionsValidationError);
  assert.throws(() => updateProjectOptionsSchema({ defaultBranch: 42 }), ProjectOptionsValidationError);
  const ok = updateProjectOptionsSchema({ defaultBranch: '  develop  ' });
  assert.equal(ok.$set.defaultBranch, 'develop');
});

test('gitRemoteUrl: null 은 $unset, 문자열은 $set', () => {
  const clear = updateProjectOptionsSchema({ gitRemoteUrl: null });
  assert.equal(clear.$unset.gitRemoteUrl, '');
  const set = updateProjectOptionsSchema({ gitRemoteUrl: 'https://example.com/repo.git' });
  assert.equal(set.$set.gitRemoteUrl, 'https://example.com/repo.git');
  assert.throws(() => updateProjectOptionsSchema({ gitRemoteUrl: 5 }), ProjectOptionsValidationError);
});

test('sharedGoalId: null → $unset, 빈 문자열은 거부', () => {
  assert.equal(updateProjectOptionsSchema({ sharedGoalId: null }).$unset.sharedGoalId, '');
  assert.equal(updateProjectOptionsSchema({ sharedGoalId: 'goal-1' }).$set.sharedGoalId, 'goal-1');
  assert.throws(() => updateProjectOptionsSchema({ sharedGoalId: '' }), ProjectOptionsValidationError);
});

test('settingsJson 은 배열·원시형을 거부하고 객체만 통과', () => {
  assert.throws(() => updateProjectOptionsSchema({ settingsJson: [] }), ProjectOptionsValidationError);
  assert.throws(() => updateProjectOptionsSchema({ settingsJson: 'x' }), ProjectOptionsValidationError);
  const ok = updateProjectOptionsSchema({ settingsJson: { flowLevel: 'commitPush' } });
  assert.deepEqual(ok.$set.settingsJson, { flowLevel: 'commitPush' });
});

test('projectOptionsView 는 누락 필드에 기본값을 채운다', () => {
  const view = projectOptionsView({});
  assert.equal(view.autoDevEnabled, false);
  assert.equal(view.autoCommitEnabled, false);
  assert.equal(view.autoPushEnabled, false);
  assert.equal(view.defaultBranch, 'main');
  assert.deepEqual(view.settingsJson, {});
});

test('projectOptionsView 는 저장된 값을 우선한다', () => {
  const view = projectOptionsView({
    autoDevEnabled: true,
    autoCommitEnabled: true,
    autoPushEnabled: false,
    defaultBranch: 'develop',
    gitRemoteUrl: 'https://example/repo.git',
    settingsJson: { flowLevel: 'commitPushPR' },
  });
  assert.equal(view.autoDevEnabled, true);
  assert.equal(view.autoCommitEnabled, true);
  assert.equal(view.autoPushEnabled, false);
  assert.equal(view.defaultBranch, 'develop');
  assert.equal(view.gitRemoteUrl, 'https://example/repo.git');
  assert.deepEqual(view.settingsJson, { flowLevel: 'commitPushPR' });
});

test('branchStrategy 는 per-session|per-task|per-commit|fixed-branch 만 허용', () => {
  assert.throws(() => updateProjectOptionsSchema({ branchStrategy: 'invalid' }), ProjectOptionsValidationError);
  assert.throws(() => updateProjectOptionsSchema({ branchStrategy: 42 }), ProjectOptionsValidationError);
  const ok = updateProjectOptionsSchema({ branchStrategy: 'fixed-branch' });
  assert.equal(ok.$set.branchStrategy, 'fixed-branch');
});

test('fixedBranchName 은 비어있지 않은 문자열 강제, trim 적용', () => {
  assert.throws(() => updateProjectOptionsSchema({ fixedBranchName: '' }), ProjectOptionsValidationError);
  assert.throws(() => updateProjectOptionsSchema({ fixedBranchName: 123 }), ProjectOptionsValidationError);
  const ok = updateProjectOptionsSchema({ fixedBranchName: '  auto/main  ' });
  assert.equal(ok.$set.fixedBranchName, 'auto/main');
});

test('branchNamePattern 은 비어있지 않은 문자열 강제, trim 적용', () => {
  assert.throws(() => updateProjectOptionsSchema({ branchNamePattern: '   ' }), ProjectOptionsValidationError);
  const ok = updateProjectOptionsSchema({ branchNamePattern: 'auto/{slug}' });
  assert.equal(ok.$set.branchNamePattern, 'auto/{slug}');
});

test('autoMergeToMain 은 boolean 만 허용', () => {
  assert.throws(() => updateProjectOptionsSchema({ autoMergeToMain: 1 }), ProjectOptionsValidationError);
  const ok = updateProjectOptionsSchema({ autoMergeToMain: true });
  assert.equal(ok.$set.autoMergeToMain, true);
});

test('projectOptionsView 는 브랜치 관련 필드 기본값을 채운다', () => {
  const view = projectOptionsView({});
  assert.equal(view.branchStrategy, 'per-session');
  assert.equal(view.fixedBranchName, 'auto/dev');
  assert.equal(view.branchNamePattern, 'auto/{date}-{shortId}');
  assert.equal(view.autoMergeToMain, false);
  assert.equal(view.currentAutoBranch, undefined);
});

test('projectOptionsView 는 저장된 브랜치 값을 우선한다', () => {
  const view = projectOptionsView({
    branchStrategy: 'fixed-branch',
    fixedBranchName: 'release/stable',
    branchNamePattern: 'ft/{slug}',
    autoMergeToMain: true,
    currentAutoBranch: 'auto/2026-04-18-deadbee',
  });
  assert.equal(view.branchStrategy, 'fixed-branch');
  assert.equal(view.fixedBranchName, 'release/stable');
  assert.equal(view.branchNamePattern, 'ft/{slug}');
  assert.equal(view.autoMergeToMain, true);
  assert.equal(view.currentAutoBranch, 'auto/2026-04-18-deadbee');
});

test('body 가 객체가 아니면 즉시 거부', () => {
  assert.throws(() => updateProjectOptionsSchema(null), ProjectOptionsValidationError);
  assert.throws(() => updateProjectOptionsSchema([]), ProjectOptionsValidationError);
  assert.throws(() => updateProjectOptionsSchema('x'), ProjectOptionsValidationError);
});

// 로드 경로 방어(#설계 #b8defbe0) — DB 직접 편집·구 스키마 잔존·다른 서비스 이식
// 등으로 잘못된 타입/공백 문자열이 저장돼 있을 때, projectOptionsView 가
// PROJECT_OPTION_DEFAULTS 로 폴백해 UI 패널이 "값은 있는데 비어 보이는" 상태에
// 빠지지 않도록 잠근다. 쓰기 경로(updateProjectOptionsSchema) 가 이미 강제하지만
// 과거 데이터에 대한 안전망이다.
test('projectOptionsView 는 비-boolean 토글값을 기본값으로 폴백한다', () => {
  const view = projectOptionsView({
    autoDevEnabled: 1 as unknown as boolean,
    autoCommitEnabled: 'true' as unknown as boolean,
    autoPushEnabled: null as unknown as boolean,
    autoMergeToMain: 0 as unknown as boolean,
  });
  assert.equal(view.autoDevEnabled, false);
  assert.equal(view.autoCommitEnabled, false);
  assert.equal(view.autoPushEnabled, false);
  assert.equal(view.autoMergeToMain, false);
});

test('projectOptionsView 는 공백 문자열·비문자 defaultBranch 를 기본값으로 폴백한다', () => {
  const view = projectOptionsView({
    defaultBranch: '   ' as unknown as string,
  });
  assert.equal(view.defaultBranch, 'main');
  const view2 = projectOptionsView({
    defaultBranch: 42 as unknown as string,
  });
  assert.equal(view2.defaultBranch, 'main');
});

test('projectOptionsView 는 공백 fixedBranchName/branchNamePattern 을 기본값으로 폴백한다', () => {
  const view = projectOptionsView({
    fixedBranchName: '' as unknown as string,
    branchNamePattern: '   ' as unknown as string,
  });
  assert.equal(view.fixedBranchName, 'auto/dev');
  assert.equal(view.branchNamePattern, 'auto/{date}-{shortId}');
});

test('projectOptionsView 는 비-객체 settingsJson 을 빈 객체로 폴백한다', () => {
  const view = projectOptionsView({
    settingsJson: 'corrupt' as unknown as Record<string, unknown>,
  });
  assert.deepEqual(view.settingsJson, {});
  const view2 = projectOptionsView({
    settingsJson: [1, 2, 3] as unknown as Record<string, unknown>,
  });
  assert.deepEqual(view2.settingsJson, {});
});

test('projectOptionsView 는 공백/비문자 gitRemoteUrl/sharedGoalId/currentAutoBranch 를 undefined 로 만든다', () => {
  const view = projectOptionsView({
    gitRemoteUrl: '   ' as unknown as string,
    sharedGoalId: 7 as unknown as string,
    currentAutoBranch: '' as unknown as string,
  });
  assert.equal(view.gitRemoteUrl, undefined);
  assert.equal(view.sharedGoalId, undefined);
  assert.equal(view.currentAutoBranch, undefined);
});

test('projectOptionsView 는 합법적 문자열 필드를 trim 한 결과로 노출한다', () => {
  const view = projectOptionsView({
    defaultBranch: '  release  ' as unknown as string,
    fixedBranchName: '  auto/main  ' as unknown as string,
    branchNamePattern: '  auto/{slug}  ' as unknown as string,
    gitRemoteUrl: '  https://example/repo.git  ' as unknown as string,
    sharedGoalId: '  goal-1  ' as unknown as string,
    currentAutoBranch: '  auto/2026-04-19-deadbee  ' as unknown as string,
  });
  assert.equal(view.defaultBranch, 'release');
  assert.equal(view.fixedBranchName, 'auto/main');
  assert.equal(view.branchNamePattern, 'auto/{slug}');
  assert.equal(view.gitRemoteUrl, 'https://example/repo.git');
  assert.equal(view.sharedGoalId, 'goal-1');
  assert.equal(view.currentAutoBranch, 'auto/2026-04-19-deadbee');
});
