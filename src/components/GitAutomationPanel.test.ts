// Run with: npx tsx --test src/components/GitAutomationPanel.test.ts
//
// 감마(QA): GitAutomationPanel 의 퓨어 헬퍼(renderTemplate / hasTemplateVariable /
// formatRelativeTime) 회귀 테스트. 이 패널은 JSDOM harness 가 붙기 전이므로
// 컴포넌트 렌더는 커버하지 않고, 미리보기·경고·상대 시각 뱃지의 계산 계층만 고정한다.
// 이 세 함수는 GitAutomationPanel.tsx 에서 export 되어 입력 필드 경고/미리보기/
// "마지막 실행 X분 전" 뱃지를 모두 같은 결과로 유도하므로, 하나만 어긋나도 UI
// 여러 곳이 동시에 어긋나는 회귀가 일어난다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveAutomationOptions,
  formatRelativeTime,
  hasTemplateVariable,
  renderTemplate,
  type GitAutomationSettings,
} from './GitAutomationPanel.tsx';

// ---------------------------------------------------------------------------
// renderTemplate: 미리보기·저장·단위 테스트가 공유하는 토큰 치환기.
// 모르는 변수는 원문 유지라는 계약이 깨지면 사용자가 오타({brach})를 발견할
// 수단이 사라진다.
// ---------------------------------------------------------------------------

test('renderTemplate: 알려진 토큰은 치환, 모르는 토큰은 원문 유지', () => {
  const out = renderTemplate('{type}/{ticket}-{branch}', {
    type: 'feat', ticket: 'LLM-1', branch: 'panel',
  });
  assert.equal(out, 'feat/LLM-1-panel');

  // 오타 토큰은 그대로 남아야 사용자가 즉시 눈치챈다.
  const typo = renderTemplate('{type}/{brach}', { type: 'fix', branch: 'x' });
  assert.equal(typo, 'fix/{brach}');
});

test('renderTemplate: 빈 문자열 변수는 치환하지 않고 원문을 남긴다', () => {
  // "{ticket} 값이 없는데 괄호만 사라져서 `feat/ -panel` 이 되는" 실수를 방지.
  const out = renderTemplate('{type}/{ticket}-{branch}', {
    type: 'feat', ticket: '', branch: 'panel',
  });
  assert.equal(out, 'feat/{ticket}-panel');
});

test('renderTemplate: 빈 템플릿은 빈 문자열을 반환한다', () => {
  assert.equal(renderTemplate('', { type: 'feat' }), '');
});

// ---------------------------------------------------------------------------
// hasTemplateVariable: "정적 문자열로 박힌" 템플릿을 경고하는 근거.
// 저장은 막지 않지만 노란 힌트를 띄우는 단일 조건이므로 계약을 고정한다.
// ---------------------------------------------------------------------------

test('hasTemplateVariable: 중괄호 토큰 존재 여부를 정확히 판단한다', () => {
  assert.equal(hasTemplateVariable('{type}: {branch}'), true);
  assert.equal(hasTemplateVariable('no variable here'), false);
  assert.equal(hasTemplateVariable(''), false);
  // 한 글자짜리 그룹도 허용(레거시 템플릿 호환).
  assert.equal(hasTemplateVariable('{a}'), true);
  // 빈 중괄호는 변수로 치지 않는다 — `\w+` 는 한 글자 이상.
  assert.equal(hasTemplateVariable('prefix-{} end'), false);
});

// ---------------------------------------------------------------------------
// formatRelativeTime: "마지막 자동 커밋+푸시" 뱃지의 상대 시각 라벨.
// 60초/60분/24시간 경계를 여기서 고정한다. now 인자를 주입 가능하게 둔 덕분에
// Date 모킹 없이 결정론적 테스트가 가능하다.
// ---------------------------------------------------------------------------

const BASE_NOW = Date.parse('2026-04-17T12:00:00Z');

test('formatRelativeTime: null/undefined/빈 문자열은 "아직 실행되지 않음"', () => {
  assert.equal(formatRelativeTime(null, BASE_NOW), '아직 실행되지 않음');
  assert.equal(formatRelativeTime(undefined, BASE_NOW), '아직 실행되지 않음');
  assert.equal(formatRelativeTime('', BASE_NOW), '아직 실행되지 않음');
});

test('formatRelativeTime: 파싱 불가한 문자열은 "아직 실행되지 않음"', () => {
  assert.equal(formatRelativeTime('not-a-date', BASE_NOW), '아직 실행되지 않음');
});

test('formatRelativeTime: 60초 미만은 "방금 전"', () => {
  const iso = new Date(BASE_NOW - 30 * 1000).toISOString();
  assert.equal(formatRelativeTime(iso, BASE_NOW), '방금 전');
});

test('formatRelativeTime: 60초~60분은 분 단위로 축약', () => {
  const iso = new Date(BASE_NOW - 5 * 60 * 1000).toISOString();
  assert.equal(formatRelativeTime(iso, BASE_NOW), '5분 전');
  // 경계: 정확히 60초 = 1분.
  const iso60 = new Date(BASE_NOW - 60 * 1000).toISOString();
  assert.equal(formatRelativeTime(iso60, BASE_NOW), '1분 전');
});

test('formatRelativeTime: 60분~24시간은 시간 단위로 축약', () => {
  const iso = new Date(BASE_NOW - 3 * 3600 * 1000).toISOString();
  assert.equal(formatRelativeTime(iso, BASE_NOW), '3시간 전');
});

test('formatRelativeTime: 24시간 이상은 일 단위로 축약', () => {
  const iso = new Date(BASE_NOW - 2 * 24 * 3600 * 1000).toISOString();
  assert.equal(formatRelativeTime(iso, BASE_NOW), '2일 전');
});

test('formatRelativeTime: 미래 타임스탬프는 음수가 되지 않도록 "방금 전"으로 클램프', () => {
  // 클럭 스큐로 서버 시각이 살짝 앞선 경우에도 "-3분 전" 같은 음수 라벨은 나오면 안 된다.
  const iso = new Date(BASE_NOW + 10 * 1000).toISOString();
  assert.equal(formatRelativeTime(iso, BASE_NOW), '방금 전');
});

// ---------------------------------------------------------------------------
// deriveAutomationOptions: 상단 요약 바의 체크박스 상태 산출.
// flow 레벨이 단조증가(commit ⊂ commit+push ⊂ full-pr)한다는 계약과
// enabled=false 일 때 모든 옵션이 꺼진 상태로 표시돼야 한다는 불변을 고정한다.
// ---------------------------------------------------------------------------

test('deriveAutomationOptions: commit 흐름은 커밋만 활성, 푸시/PR은 비활성', () => {
  const opts = deriveAutomationOptions({ flow: 'commit', enabled: true });
  assert.deepEqual(opts.map(o => [o.key, o.active]), [
    ['commit', true], ['push', false], ['pr', false],
  ]);
});

test('deriveAutomationOptions: commit-push 흐름은 커밋+푸시까지 활성', () => {
  const opts = deriveAutomationOptions({ flow: 'commit-push', enabled: true });
  assert.deepEqual(opts.map(o => [o.key, o.active]), [
    ['commit', true], ['push', true], ['pr', false],
  ]);
});

test('deriveAutomationOptions: full-pr 흐름은 세 단계 모두 활성', () => {
  const opts = deriveAutomationOptions({ flow: 'full-pr', enabled: true });
  assert.deepEqual(opts.map(o => [o.key, o.active]), [
    ['commit', true], ['push', true], ['pr', true],
  ]);
});

test('deriveAutomationOptions: enabled=false 는 flow 와 무관하게 모든 옵션을 끈다', () => {
  const opts = deriveAutomationOptions({ flow: 'full-pr', enabled: false });
  assert.deepEqual(opts.map(o => o.active), [false, false, false]);
});

// ---------------------------------------------------------------------------
// 상단바 체크 옵션(autoCommit / autoPush / autoPR) 표시 계약.
// 상단 요약 바는 deriveAutomationOptions 결과를 commit→autoCommit, push→autoPush,
// pr→autoPR 로 투영해 체크 표시를 그린다. 라벨·순서·각 flow×enabled 조합의 on/off
// 를 한 표로 고정해, 렌더 계층이 바뀌어도 사용자가 보는 체크 상태는 어긋나지 않게 한다.
// ---------------------------------------------------------------------------

// 세 체크 옵션을 autoCommit/autoPush/autoPR 네이밍으로 풀어서 비교하기 위한 헬퍼.
function flagsFor(flow: 'commit' | 'commit-push' | 'full-pr', enabled: boolean) {
  const opts = deriveAutomationOptions({ flow, enabled });
  const byKey: Record<string, boolean> = {};
  for (const o of opts) byKey[o.key] = o.active;
  return { autoCommit: byKey.commit, autoPush: byKey.push, autoPR: byKey.pr };
}

test('상단바 체크 옵션: 순서(commit → push → pr)와 한국어 라벨이 고정된다', () => {
  // 상단바는 "자동 커밋 / 자동 푸시 / 자동 PR" 순으로 좌→우 배치. 순서나 라벨이
  // 바뀌면 사용자가 습관적으로 클릭하던 위치가 다른 의미가 된다.
  const opts = deriveAutomationOptions({ flow: 'commit', enabled: true });
  assert.equal(opts.length, 3);
  assert.deepEqual(opts.map(o => o.key), ['commit', 'push', 'pr']);
  assert.deepEqual(opts.map(o => o.label), ['자동 커밋', '자동 푸시', '자동 PR']);
});

// ---------------------------------------------------------------------------
// 감마(QA): "UI 게이트 → git 실행기" 연결 계약.
// 패널은 직접 git 을 쏘지 않지만, 상단바 체크 옵션이 active=false 인 단계는
// orchestrator 가 절대 발사하지 않아야 한다는 불변이 있다. 여기서는 상단바 결과를
// 소비하는 얇은 가짜 실행기를 조립해, "enabled=false 면 git 호출 0건" 을 한 번 더
// UI 계층에서 고정한다. 이 테스트가 녹색이면 "체크를 내렸는데도 커밋이 나갔다" 는
// 회귀는 UI 단일 출처(deriveAutomationOptions)에서 먼저 잡힌다.
// ---------------------------------------------------------------------------

type GitStep = 'commit' | 'push' | 'pr';

function makeSpyExecutor() {
  const calls: GitStep[] = [];
  return {
    commit: () => { calls.push('commit'); },
    push:   () => { calls.push('push'); },
    pr:     () => { calls.push('pr'); },
    calls,
  };
}

// orchestrator 모방: 패널 summary(=deriveAutomationOptions) 를 읽어 active 단계만 실행.
function dispatchFromPanel(
  settings: Pick<GitAutomationSettings, 'flow' | 'enabled'>,
  exec: ReturnType<typeof makeSpyExecutor>,
) {
  for (const opt of deriveAutomationOptions(settings)) {
    if (!opt.active) continue;
    if (opt.key === 'commit') exec.commit();
    else if (opt.key === 'push') exec.push();
    else if (opt.key === 'pr') exec.pr();
  }
}

test('TC-GATE1: enabled=false 는 flow 가 무엇이든 git 실행기를 한 번도 호출하지 않는다', () => {
  for (const flow of ['commit', 'commit-push', 'full-pr'] as const) {
    const exec = makeSpyExecutor();
    dispatchFromPanel({ flow, enabled: false }, exec);
    assert.deepEqual(exec.calls, [], `flow=${flow} 에서 호출이 발생했다`);
  }
});

test('TC-GATE2: enabled=true + full-pr 은 commit→push→pr 세 단계를 정확히 1회씩 호출한다', () => {
  const exec = makeSpyExecutor();
  dispatchFromPanel({ flow: 'full-pr', enabled: true }, exec);
  assert.deepEqual(exec.calls, ['commit', 'push', 'pr']);
});

test('TC-GATE3: enabled=true + commit-push 는 PR 실행기를 절대 깨우지 않는다', () => {
  const exec = makeSpyExecutor();
  dispatchFromPanel({ flow: 'commit-push', enabled: true }, exec);
  assert.deepEqual(exec.calls, ['commit', 'push']);
});

test('TC-GATE4: enabled=true + commit 은 push/pr 을 발사하지 않고 커밋만 트리거한다', () => {
  const exec = makeSpyExecutor();
  dispatchFromPanel({ flow: 'commit', enabled: true }, exec);
  assert.deepEqual(exec.calls, ['commit']);
});

test('상단바 체크 옵션: flow×enabled 6조합 각 옵션의 on/off 가 정확히 렌더된다', () => {
  // 6개 조합을 한 표로 고정한다. enabled=false 행은 어떤 flow 든 모두 off 여야 한다.
  // flow 상승은 하위 단계를 포함한다(commit ⊂ commit-push ⊂ full-pr).
  const cases: Array<{
    flow: 'commit' | 'commit-push' | 'full-pr';
    enabled: boolean;
    expected: { autoCommit: boolean; autoPush: boolean; autoPR: boolean };
  }> = [
    { flow: 'commit',      enabled: true,  expected: { autoCommit: true,  autoPush: false, autoPR: false } },
    { flow: 'commit-push', enabled: true,  expected: { autoCommit: true,  autoPush: true,  autoPR: false } },
    { flow: 'full-pr',     enabled: true,  expected: { autoCommit: true,  autoPush: true,  autoPR: true  } },
    { flow: 'commit',      enabled: false, expected: { autoCommit: false, autoPush: false, autoPR: false } },
    { flow: 'commit-push', enabled: false, expected: { autoCommit: false, autoPush: false, autoPR: false } },
    { flow: 'full-pr',     enabled: false, expected: { autoCommit: false, autoPush: false, autoPR: false } },
  ];
  for (const c of cases) {
    assert.deepEqual(
      flagsFor(c.flow, c.enabled),
      c.expected,
      `flow=${c.flow} enabled=${c.enabled}`,
    );
  }
});
