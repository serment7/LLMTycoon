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
