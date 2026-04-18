// resolveBranch() 계약 테스트. executeGitAutomation 이 태스크마다 새 브랜치를
// 만들던 회귀(#91aeaf7a) 를 막기 위해 전략별 동작을 고정한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ActiveBranchCache, resolveBranch } from './branchResolver';

const BASE_CTX = { type: 'chore', summary: 'first commit' };

test("fixed-branch 전략은 fixedBranchName 을 그대로 반환하고 persist=false", () => {
  const r = resolveBranch({
    strategy: 'fixed-branch',
    fixedBranchName: 'release/production',
    templateContext: BASE_CTX,
  });
  assert.equal(r.branch, 'release/production');
  assert.equal(r.source, 'fixed');
  assert.equal(r.persist, false);
  assert.equal(r.reused, true);
});

test("fixed-branch 의 fixedBranchName 이 비면 기본 'auto/dev' 로 폴백", () => {
  const r = resolveBranch({ strategy: 'fixed-branch', templateContext: BASE_CTX });
  assert.equal(r.branch, 'auto/dev');
});

test('per-session: 캐시가 있으면 재사용(persist=false, reused=true, source=cache)', () => {
  const r = resolveBranch({
    strategy: 'per-session',
    cachedActiveBranch: 'auto/2026-04-18-abc',
    templateContext: BASE_CTX,
  });
  assert.equal(r.branch, 'auto/2026-04-18-abc');
  assert.equal(r.source, 'cache');
  assert.equal(r.reused, true);
  assert.equal(r.persist, false);
});

test('per-session: 캐시는 없지만 DB 값이 있으면 재사용 + persist=true 로 캐시 채움 요청', () => {
  const r = resolveBranch({
    strategy: 'per-session',
    persistedActiveBranch: 'auto/saved-earlier',
    templateContext: BASE_CTX,
  });
  assert.equal(r.branch, 'auto/saved-earlier');
  assert.equal(r.source, 'persisted');
  assert.equal(r.reused, true);
  assert.equal(r.persist, true);
});

test('per-session: 캐시/영속값 모두 없으면 템플릿으로 새 브랜치 + persist=true', () => {
  const r = resolveBranch({
    strategy: 'per-session',
    branchNamePattern: 'auto/{type}-{slug}',
    templateContext: BASE_CTX,
  });
  assert.equal(r.source, 'fresh');
  assert.equal(r.reused, false);
  assert.equal(r.persist, true);
  assert.match(r.branch, /^auto\/chore-first-commit/);
});

test('per-task 전략은 매 호출마다 fresh 브랜치를 만들고 persist=false', () => {
  const r = resolveBranch({
    strategy: 'per-task',
    branchNamePattern: 'feature/{slug}',
    templateContext: BASE_CTX,
  });
  assert.equal(r.source, 'fresh');
  assert.equal(r.reused, false);
  assert.equal(r.persist, false);
  assert.match(r.branch, /^feature\/first-commit/);
});

test('전략 미지정 기본값은 per-session 으로 취급된다', () => {
  const r = resolveBranch({
    branchNamePattern: 'auto/{slug}',
    templateContext: BASE_CTX,
  });
  assert.equal(r.strategy, 'per-session');
});

test('ActiveBranchCache: set/get/clear 동작', () => {
  const cache = new ActiveBranchCache();
  cache.set('p1', 'auto/x');
  assert.equal(cache.get('p1'), 'auto/x');
  cache.clear('p1');
  assert.equal(cache.get('p1'), undefined);
  cache.set('p1', 'auto/y');
  cache.set('p2', 'auto/z');
  cache.clear();
  assert.equal(cache.get('p1'), undefined);
  assert.equal(cache.get('p2'), undefined);
});
