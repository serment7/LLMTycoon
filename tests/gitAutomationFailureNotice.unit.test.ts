// Run with: npx tsx --test tests/gitAutomationFailureNotice.unit.test.ts
//
// 지시 #55bb8822 — Git 자동화 실패 알림(GitAutomationFailureNotice) 의 메시지
// 빌더 검증. 검증 포인트
//   1. failure 와 message 가 모두 비면 라인이 없다(컴포넌트는 null 반환).
//   2. failure 없이 message 만 있으면 stderrLabel 라인 한 줄로 폴백한다.
//   3. failure 가 있으면 step/exitCode/branch/stderr/stdout 순서로 라인이 쌓인다.
//   4. stderr 가 비면 emptyStderrFallback 라인이 inferred=true 로 추가된다.
//   5. spawn 실패(code === null) 면 spawnFailure 라인까지 함께 끼어든다.
//   6. ko 로케일에서는 한국어 라벨/문구가 그대로 노출된다(영어 디폴트 + 한국어 토글).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFailureLines,
  buildFailureLinesForLocale,
} from '../src/components/GitAutomationFailureNotice.tsx';
import { translate } from '../src/i18n';
import type { GitAutomationStepResult } from '../src/utils/gitAutomation';

const enT = (key: string) => translate(key, 'en');

test('failure 와 message 가 모두 없으면 폴백 메시지 단일 라인', () => {
  const lines = buildFailureLines({}, enT);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].inferred, true);
  // 영어 폴백 본문이 그대로 박혀야 한다.
  assert.equal(lines[0].value, translate('gitAutomation.failure.fallbackMessage', 'en'));
});

test('message 만 있으면 stderrLabel 라인 1개로 그대로 노출', () => {
  const lines = buildFailureLines({ message: '  remote rejected  ' }, enT);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].label, translate('gitAutomation.failure.stderrLabel', 'en'));
  assert.equal(lines[0].value, 'remote rejected');
  // inferred 가 아니어야 한다(원본 메시지이므로).
  assert.notEqual(lines[0].inferred, true);
});

test('failure 가 가득 차 있으면 step/exit/branch/stderr/stdout 순서 라인', () => {
  const failure: GitAutomationStepResult = {
    label: 'commit',
    ok: false,
    code: 128,
    stderr: 'fatal: not a git repository',
    stdout: '',
  };
  const lines = buildFailureLines({ failure, branch: 'feature/x' }, enT);
  // step / exit / branch / stderr 4줄 (stdout 비어 있음)
  assert.equal(lines.length, 4);
  assert.equal(lines[0].label, translate('gitAutomation.failure.step', 'en'));
  assert.equal(lines[0].value, 'commit');
  assert.equal(lines[1].label, translate('gitAutomation.failure.exitCode', 'en'));
  assert.equal(lines[1].value, '128');
  assert.equal(lines[2].label, translate('gitAutomation.failure.branch', 'en'));
  assert.equal(lines[2].value, 'feature/x');
  assert.equal(lines[3].label, translate('gitAutomation.failure.stderrLabel', 'en'));
  assert.equal(lines[3].value, 'fatal: not a git repository');
  assert.equal(lines[3].monospace, true);
});

test('빈 stderr → emptyStderrFallback 추정 라인이 inferred=true 로 끼어든다', () => {
  const failure: GitAutomationStepResult = {
    label: 'commit',
    ok: false,
    code: 1,
    stderr: '   ',
  };
  const lines = buildFailureLines({ failure }, enT);
  // step, exitCode, stderr(빈), fallback 라인
  assert.equal(lines.length, 4);
  const fallback = lines.find(
    l => l.value === translate('gitAutomation.failure.emptyStderrFallback', 'en'),
  );
  assert.ok(fallback, 'emptyStderrFallback 라인이 있어야 한다');
  assert.equal(fallback?.inferred, true);
});

test('spawn 실패(code===null) 는 spawnFailure 라인까지 추가', () => {
  const failure: GitAutomationStepResult = {
    label: 'push',
    ok: false,
    code: null,
    stderr: '',
  };
  const lines = buildFailureLines({ failure }, enT);
  // step, exitCode(null), stderr(빈), emptyStderrFallback, spawnFailure
  assert.equal(lines.length, 5);
  // exit code 라인은 'null' 텍스트로 노출돼 사용자가 spawn 단계 실패임을 알아본다.
  const exitLine = lines[1];
  assert.equal(exitLine.value, 'null');
  // spawnFailure 와 emptyStderrFallback 가 모두 inferred 로 들어가야 한다.
  const inferredValues = lines.filter(l => l.inferred).map(l => l.value);
  assert.ok(
    inferredValues.includes(translate('gitAutomation.failure.emptyStderrFallback', 'en')),
  );
  assert.ok(
    inferredValues.includes(translate('gitAutomation.failure.spawnFailure', 'en')),
  );
});

test('stdout 이 있으면 마지막 라인으로 모노스페이스 표기', () => {
  const failure: GitAutomationStepResult = {
    label: 'pr',
    ok: false,
    code: 1,
    stderr: 'gh: rate limited',
    stdout: '  https://github.com/foo/bar/pull/1  ',
  };
  const lines = buildFailureLines({ failure }, enT);
  const last = lines[lines.length - 1];
  assert.equal(last.label, translate('gitAutomation.failure.stdoutLabel', 'en'));
  assert.equal(last.value, 'https://github.com/foo/bar/pull/1');
  assert.equal(last.monospace, true);
});

test('ko 로케일에서는 한국어 라벨/추정 문구가 그대로 노출', () => {
  const failure: GitAutomationStepResult = {
    label: 'commit',
    ok: false,
    code: 1,
    stderr: '',
  };
  const lines = buildFailureLinesForLocale({ failure }, 'ko');
  const labels = lines.map(l => l.label);
  // 한국어 라벨이 적어도 한 번씩 나타나야 한다.
  assert.ok(labels.includes('단계'));
  assert.ok(labels.includes('종료 코드'));
  assert.ok(labels.includes('오류 출력'));
  // emptyStderrFallback 한국어 본문이 들어 있어야 한다.
  const fallbackKo = 'stderr 가 비어 있습니다 — 변경 사항이 없을 가능성이 높습니다.';
  assert.ok(lines.some(l => l.value === fallbackKo));
});
