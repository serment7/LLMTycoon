// Run with: npx tsx --test tests/gitAutomationCommitStrategy.unit.test.ts
//
// 단위 테스트(#f1d5ce51) — 태스크 경계 커밋 필드 두 개가 `validateGitAutomationConfig`
// 를 무사 통과하고, 불변 계약을 그대로 유지하는지 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateGitAutomationConfig,
  DEFAULT_GIT_AUTOMATION_CONFIG,
  type GitAutomationConfig,
} from '../src/utils/gitAutomation.ts';
import { COMMIT_STRATEGY_VALUES, COMMIT_STRATEGY_LABEL } from '../src/types.ts';

function base(): Partial<GitAutomationConfig> {
  return { ...DEFAULT_GIT_AUTOMATION_CONFIG };
}

test('validateGitAutomationConfig — commitStrategy / commitMessagePrefix 가 생략되면 통과 + 기본 머지', () => {
  const r = validateGitAutomationConfig(base());
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.config.commitStrategy, undefined);
    assert.equal(r.config.commitMessagePrefix, undefined);
  }
});

test('validateGitAutomationConfig — 세 가지 commitStrategy 모두 수용', () => {
  for (const s of COMMIT_STRATEGY_VALUES) {
    const r = validateGitAutomationConfig({ ...base(), commitStrategy: s });
    assert.equal(r.ok, true, `${s} 는 유효해야 한다`);
    if (r.ok) assert.equal(r.config.commitStrategy, s);
  }
});

test('validateGitAutomationConfig — 알 수 없는 commitStrategy 는 400', () => {
  const r = validateGitAutomationConfig({ ...base(), commitStrategy: 'bogus' as never });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /invalid commitStrategy/);
});

test('validateGitAutomationConfig — commitMessagePrefix 는 string 이면 모두 허용', () => {
  for (const prefix of ['', 'auto: ', 'chore(pay): ', '한글 접두어 ']) {
    const r = validateGitAutomationConfig({ ...base(), commitMessagePrefix: prefix });
    assert.equal(r.ok, true, `"${prefix}" 는 유효해야 한다`);
    if (r.ok) assert.equal(r.config.commitMessagePrefix, prefix);
  }
});

test('validateGitAutomationConfig — commitMessagePrefix 가 string 이 아니면 400', () => {
  const r = validateGitAutomationConfig({ ...base(), commitMessagePrefix: 42 as unknown as string });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /invalid commitMessagePrefix/);
});

test('COMMIT_STRATEGY_LABEL — 세 키 모두 한국어 요약 문자열을 갖는다', () => {
  for (const s of COMMIT_STRATEGY_VALUES) {
    const label = COMMIT_STRATEGY_LABEL[s];
    assert.equal(typeof label, 'string');
    assert.ok(label.length > 0, `${s} 라벨이 비어 있지 않아야 한다`);
  }
});
