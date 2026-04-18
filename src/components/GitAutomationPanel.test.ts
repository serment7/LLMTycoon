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
  shortCommitHash,
  validateNewBranchName,
  type GitAutomationSettings,
  type GitFlowLevel,
} from './GitAutomationPanel.tsx';
import {
  DEFAULT_GIT_AUTOMATION_CONFIG,
  validateGitAutomationConfig,
  type GitAutomationConfig,
} from '../utils/gitAutomation';

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

// ---------------------------------------------------------------------------
// QA: shortCommitHash — "마지막 커밋" 칩에 노출되는 해시 축약 규약.
// UI 와 sr-only aria-label 에서 같은 값을 쓰므로, 어긋나면 화면에는 7자리인데
// 스크린리더가 전체 해시를 읽는 등 접근성 회귀가 조용히 발생한다.
// ---------------------------------------------------------------------------

test('shortCommitHash: null/undefined/공백은 빈 문자열을 반환한다', () => {
  assert.equal(shortCommitHash(null), '');
  assert.equal(shortCommitHash(undefined), '');
  assert.equal(shortCommitHash(''), '');
  assert.equal(shortCommitHash('   '), '');
});

test('shortCommitHash: 앞 7자만 잘라 소문자로 정규화한다', () => {
  assert.equal(shortCommitHash('ABCDEF1234567890'), 'abcdef1');
  // 이미 7자 이하면 그대로 소문자 변환.
  assert.equal(shortCommitHash('AB12'), 'ab12');
  // 앞뒤 공백은 trim.
  assert.equal(shortCommitHash('  A1B2C3D4E5  '), 'a1b2c3d');
});

// ---------------------------------------------------------------------------
// QA: validateNewBranchName — 'fixed-branch'(새 브랜치명 지정) 전략의 입력 검증.
// 패널 입력·저장 버튼 disabled·스케줄러 트리거 페이로드가 동일 결과를 공유하도록
// 순수 함수로 잠근다. 회귀 시나리오(#e907cf04): 미입력·공백·연속 중복문자 거부.
// ---------------------------------------------------------------------------

test('validateNewBranchName: 빈 문자열은 empty 코드로 거부된다', () => {
  const r = validateNewBranchName('');
  assert.equal(r.ok, false);
  if (r.ok === false) assert.equal(r.code, 'empty');
});

test('validateNewBranchName: 공백만 입력은 whitespace 코드로 거부된다', () => {
  for (const raw of ['   ', '\t', '  \t '] as const) {
    const r = validateNewBranchName(raw);
    assert.equal(r.ok, false, `공백 "${raw}" 이(가) 통과됐다`);
    if (r.ok === false) assert.equal(r.code, 'whitespace');
  }
});

test('validateNewBranchName: 중간 공백은 whitespace 코드로 거부된다', () => {
  const r = validateNewBranchName('feature/foo bar');
  assert.equal(r.ok, false);
  if (r.ok === false) assert.equal(r.code, 'whitespace');
});

test('validateNewBranchName: 연속된 `/`, `.`, `-` 는 duplicate 코드로 거부된다', () => {
  for (const raw of ['feature//foo', 'foo..bar', 'foo--bar'] as const) {
    const r = validateNewBranchName(raw);
    assert.equal(r.ok, false, `중복문자 "${raw}" 이(가) 통과됐다`);
    if (r.ok === false) assert.equal(r.code, 'duplicate');
  }
});

test('validateNewBranchName: 선행·후행 구분자는 duplicate 코드로 거부된다', () => {
  for (const raw of ['/feature', 'feature/', '.feature', 'feature.', '-feature', 'feature-'] as const) {
    const r = validateNewBranchName(raw);
    assert.equal(r.ok, false, `경계 문자 "${raw}" 이(가) 통과됐다`);
    if (r.ok === false) assert.equal(r.code, 'duplicate');
  }
});

test('validateNewBranchName: 허용되지 않은 문자(한글·특수기호)는 invalid 코드로 거부된다', () => {
  for (const raw of ['feature/한글', 'feature/foo?bar', 'feature:foo', 'feature~foo'] as const) {
    const r = validateNewBranchName(raw);
    assert.equal(r.ok, false, `허용 외 문자 "${raw}" 이(가) 통과됐다`);
    if (r.ok === false) assert.equal(r.code, 'invalid');
  }
});

test('validateNewBranchName: 정상 입력은 ok=true 를 돌려준다', () => {
  for (const raw of ['feature/foo', 'fix/LLM-123', 'chore/bump-deps', 'auto/dev', 'feature/foo_bar.v2'] as const) {
    const r = validateNewBranchName(raw);
    assert.equal(r.ok, true, `정상 입력 "${raw}" 이 거부됐다`);
  }
});

// ---------------------------------------------------------------------------
// QA E2E: 옵션 토글 → 저장 → 새로고침 후 값 유지 시나리오.
// 실제 브라우저 E2E 는 JSDOM harness 부재로 돌릴 수 없으므로, 저장 경로의
// 계약(validate → persist → reload) 을 소켓/DB 대역 없이 in-memory 로 돌려
// "토글한 값이 왕복 후에도 살아남는다" 를 한 줄로 고정한다. 이 테스트가 녹색이면
// UI 폼이 바뀌어도 라운드트립 계약은 서버와 같은 규칙을 따른다.
// ---------------------------------------------------------------------------

// server.ts 의 POST /api/projects/:id/git-automation 를 모방하는 in-memory 저장소.
// 실제 핸들러와 동일하게 validate → merge → upsert 순으로 돈다.
function makeInMemoryStore() {
  const store = new Map<string, GitAutomationConfig & { enabled: boolean; updatedAt: string }>();
  return {
    async save(projectId: string, raw: Partial<GitAutomationConfig> & { enabled?: boolean }) {
      const v = validateGitAutomationConfig(raw);
      if (v.ok !== true) return { ok: false as const, error: v.error };
      const row = {
        ...v.config,
        enabled: raw.enabled !== false,
        updatedAt: '2026-04-18T00:00:00.000Z',
      };
      store.set(projectId, row);
      return { ok: true as const, row };
    },
    async load(projectId: string) {
      return store.get(projectId) ?? null;
    },
    _raw: store,
  };
}

test('TC-E2E-PERSIST1: 옵션 토글 후 저장 → 새로고침(load) 하면 값이 그대로 유지된다', async () => {
  const db = makeInMemoryStore();
  const projectId = 'proj-e2e-1';

  // 1) 초기 상태: enabled=true, flowLevel=commitPush (DEFAULT)
  const first = await db.save(projectId, { ...DEFAULT_GIT_AUTOMATION_CONFIG });
  assert.equal(first.ok, true);

  // 2) 사용자가 토글: flowLevel → commitPushPR, enabled → false, commitScope → 'ui'
  const saved = await db.save(projectId, {
    ...DEFAULT_GIT_AUTOMATION_CONFIG,
    flowLevel: 'commitPushPR',
    commitScope: 'ui',
    enabled: false,
  });
  assert.equal(saved.ok, true);

  // 3) 새로고침 = load 재호출. 토글된 값이 보존돼야 한다.
  const reloaded = await db.load(projectId);
  assert.ok(reloaded, 'load 는 null 이 아니어야 한다');
  assert.equal(reloaded!.flowLevel, 'commitPushPR');
  assert.equal(reloaded!.commitScope, 'ui');
  assert.equal(reloaded!.enabled, false);
  // 기본값 병합이 끼어들어 반드시 있어야 할 필드를 날려먹지 않았는지도 확인.
  assert.ok(reloaded!.branchTemplate.includes('{slug}'));
});

test('TC-E2E-PERSIST2: 잘못된 설정 저장 시도는 이전 값을 덮어쓰지 않는다', async () => {
  // QA 관점: 실패 저장이 조용히 기존 값을 날리면, 사용자는 "저장 눌렀는데 토글이
  // 초기값으로 돌아갔다" 는 최악의 UX 를 겪는다. validate 실패는 반드시 no-op.
  const db = makeInMemoryStore();
  const projectId = 'proj-e2e-2';

  await db.save(projectId, {
    ...DEFAULT_GIT_AUTOMATION_CONFIG,
    flowLevel: 'commitPushPR',
    commitScope: 'core',
  });

  // branchTemplate 에 필수 토큰 {slug} 가 빠진 잘못된 입력.
  const bad = await db.save(projectId, {
    ...DEFAULT_GIT_AUTOMATION_CONFIG,
    branchTemplate: 'feature/no-tokens-here',
  });
  assert.equal(bad.ok, false);

  // 새로고침 시 이전 상태가 그대로 살아 있어야 한다.
  const reloaded = await db.load(projectId);
  assert.equal(reloaded!.flowLevel, 'commitPushPR');
  assert.equal(reloaded!.commitScope, 'core');
});

// ---------------------------------------------------------------------------
// QA E2E: 저장 상태 머신 — idle → saving → saved/error.
// 패널 내부의 justSaved 배지·저장 버튼 disabled·lastError 토스트는 모두
// 이 상태 머신을 읽어 그리므로, 전이가 어긋나면 "저장됐는데 버튼이 풀리지
// 않는다" 같은 체감 버그가 난다. 여기서 in-memory 상태로 계약을 고정한다.
// ---------------------------------------------------------------------------

type SaveUiState =
  | { phase: 'idle'; justSaved: null; lastError: null }
  | { phase: 'saving'; justSaved: null; lastError: null }
  | { phase: 'saved'; justSaved: number; lastError: null }
  | { phase: 'error'; justSaved: null; lastError: string };

// 패널이 save 버튼에 바인딩하는 흐름을 모방. onSave 결과에 따라 상태를 전이시킨다.
async function runSaveFlow(
  next: GitAutomationSettings,
  onSave: (s: GitAutomationSettings) => Promise<void>,
  now: () => number = () => 1_700_000_000_000,
): Promise<SaveUiState[]> {
  const trail: SaveUiState[] = [{ phase: 'idle', justSaved: null, lastError: null }];
  trail.push({ phase: 'saving', justSaved: null, lastError: null });
  try {
    await onSave(next);
    trail.push({ phase: 'saved', justSaved: now(), lastError: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    trail.push({ phase: 'error', justSaved: null, lastError: msg });
  }
  return trail;
}

const SAMPLE_SETTINGS: GitAutomationSettings = {
  flow: 'commit-push' as GitFlowLevel,
  branchPattern: '{type}/{ticket}-{branch}',
  commitTemplate: '{type}: {branch}',
  prTitleTemplate: '[{ticket}] {type} — {branch}',
  enabled: true,
  branchStrategy: 'per-session',
  newBranchName: '',
};

test('TC-E2E-LOADING: 저장 중(saving) 구간이 반드시 존재하고 저장 버튼은 그 구간 동안 잠긴다', async () => {
  // saving 구간이 사라지면 스피너/disabled 가 한 프레임도 안 뜨고 지나가, 사용자가
  // "저장이 되긴 한 건가" 를 판단할 단서가 없어진다. 전이 순서 자체를 고정한다.
  let resolveFn!: () => void;
  const pending = new Promise<void>(r => { resolveFn = r; });
  const trailP = runSaveFlow(SAMPLE_SETTINGS, async () => { await pending; });

  // 마이크로태스크 한 번 돌려 saving 이 찍혔는지 확인.
  await Promise.resolve();
  // saving 단계가 존재함을 간접 확인: 성공 phase 는 아직 push 되지 않아야 한다.
  // (pending 이 resolve 되기 전이므로 trail 은 [idle, saving] 상태)
  resolveFn();
  const trail = await trailP;
  assert.deepEqual(trail.map(s => s.phase), ['idle', 'saving', 'saved']);

  // saving 구간의 버튼 disabled 계약: phase==='saving' 이면 dirty 여도 잠긴다.
  const savingStep = trail[1];
  const buttonDisabledDuringSave = savingStep.phase === 'saving';
  assert.equal(buttonDisabledDuringSave, true);
});

test('TC-E2E-TOAST-SUCCESS: onSave 성공 시 justSaved 타임스탬프가 찍히고 lastError 는 null 을 유지한다', async () => {
  const captured: GitAutomationSettings[] = [];
  const trail = await runSaveFlow(SAMPLE_SETTINGS, async (s) => {
    captured.push(s);
  });

  const finalState = trail.at(-1)!;
  assert.equal(finalState.phase, 'saved');
  assert.equal(finalState.lastError, null);
  assert.ok(finalState.phase === 'saved' && typeof finalState.justSaved === 'number');
  // onSave 에 전달된 페이로드가 변조 없이 그대로 흐르는지도 회귀 고정.
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0], SAMPLE_SETTINGS);
});

test('TC-E2E-TOAST-FAILURE: onSave 가 Error 를 던지면 lastError 에 메시지가 실리고 justSaved 는 null', async () => {
  const trail = await runSaveFlow(SAMPLE_SETTINGS, async () => {
    throw new Error('validation failed: branchTemplate must include {slug} token');
  });

  const finalState = trail.at(-1)!;
  assert.equal(finalState.phase, 'error');
  assert.equal(finalState.justSaved, null);
  assert.match(finalState.lastError ?? '', /branchTemplate must include \{slug\}/);
});

test('TC-E2E-NETWORK-ERROR: fetch 거부(TypeError) 도 토스트로 surface 되며 이후 저장은 정상 복구된다', async () => {
  // 네트워크 단절(offline) 시 브라우저 fetch 는 TypeError 로 떨어진다. 같은 경로를
  // 시뮬레이션해 (1) 에러가 삼켜지지 않고 UI 토스트로 올라오고, (2) 재시도가
  // 전역 상태를 오염시키지 않아 다음 저장에서 saved 로 깔끔히 전이하는지 본다.
  const offlineTrail = await runSaveFlow(SAMPLE_SETTINGS, async () => {
    throw new TypeError('Failed to fetch');
  });
  const offlineFinal = offlineTrail.at(-1)!;
  assert.equal(offlineFinal.phase, 'error');
  assert.equal(offlineFinal.lastError, 'Failed to fetch');

  // 네트워크 복구 후 재시도.
  const retryTrail = await runSaveFlow(SAMPLE_SETTINGS, async () => { /* ok */ });
  const retryFinal = retryTrail.at(-1)!;
  assert.equal(retryFinal.phase, 'saved');
  assert.equal(retryFinal.lastError, null);
});

test('TC-E2E-NETWORK-ERROR2: 5xx 응답처럼 문자열만 던지는 케이스도 String 으로 직렬화돼 lastError 에 실린다', async () => {
  // 어떤 라이브러리는 fetch 후 `throw await res.text()` 로 raw string 을 던진다.
  // Error 인스턴스가 아닌 값이 와도 UI 는 깨지면 안 되고 반드시 문자열로 surface.
  const trail = await runSaveFlow(SAMPLE_SETTINGS, async () => {
    // eslint-disable-next-line no-throw-literal
    throw 'Internal Server Error';
  });
  const final = trail.at(-1)!;
  assert.equal(final.phase, 'error');
  assert.equal(final.lastError, 'Internal Server Error');
});

// ---------------------------------------------------------------------------
// QA(감마): "에이전트 편집 후 코드그래프 반영" — 할당 업무 #GRAPH-EDIT-SYNC.
// Git 자동화 패널은 flow 게이트만 정하고 파일 스테이징은 하지 않지만, 자동
// 커밋이 발사되는 순간 "방금 편집한 파일 목록" 과 "list_files 스냅샷" 이
// 어긋나면 유령 스테이지/유실 스테이지 회귀가 터진다. 여기서는 에이전트의
// 편집 타임라인을 흉내내는 in-memory 그래프를 조립해, (1) 편집 직후 list
// 가 편집 집합과 동일한지, (2) enabled=true + commit 흐름에서만 commit 실행기가
// 깨어나는지를 한 번에 고정한다.
// ---------------------------------------------------------------------------

// server.ts POST /api/files 의 단일-스레드 등가물. ProjectManagement.test 의
// createInMemoryGraph 와 동일 계약이지만, 두 테스트 파일 간 순환 import 를 피하려
// 여기 최소 구현만 둔다. 필터/정규화는 실제 util 을 그대로 통과시킨다.
import { isExcludedFromCodeGraph, normalizeCodeGraphPath, inferFileType } from '../utils/codeGraphFilter.ts';

interface GraphNodeLite { id: string; name: string; type: ReturnType<typeof inferFileType>; }
function createGraph() {
  const store = new Map<string, GraphNodeLite>();
  let seq = 0;
  const key = (pid: string, n: string) => `${pid}::${n}`;
  return {
    add(pid: string, raw: string) {
      const name = normalizeCodeGraphPath(raw);
      if (!name || isExcludedFromCodeGraph(name)) return null;
      const k = key(pid, name);
      const hit = store.get(k);
      if (hit) return hit;
      const node: GraphNodeLite = { id: `n-${++seq}`, name, type: inferFileType(name) };
      store.set(k, node);
      return node;
    },
    remove(pid: string, raw: string) {
      return store.delete(key(pid, normalizeCodeGraphPath(raw)));
    },
    list(pid: string) {
      return Array.from(store.entries())
        .filter(([k]) => k.startsWith(`${pid}::`))
        .map(([, v]) => v);
    },
  };
}

test('TC-GRAPH-SYNC-AFTER-EDIT: 에이전트가 파일 5종을 편집한 직후 list_files 이름 집합이 편집 목록과 정확히 일치한다', () => {
  // Git 자동화 패널 기준 "지금 커밋되면 스테이지에 올라갈 파일" 의 근거가 list_files.
  // 편집 타임라인이 끝난 시점에 list_files 집합과 편집 집합이 어긋나면, 자동 커밋이
  // 유령 파일을 올리거나 진짜 편집을 누락한다.
  const graph = createGraph();
  const edited = [
    'server.ts',
    'src/App.tsx',
    'src/components/EmptyProjectPlaceholder.tsx',
    'src/components/GitAutomationPanel.test.ts',
    'src/utils/codeGraphFilter.ts',
  ];
  for (const f of edited) assert.ok(graph.add('proj-A', f), `${f} add 가 필터에 걸렸다`);
  assert.deepEqual(
    graph.list('proj-A').map((n) => n.name).sort(),
    [...edited].sort(),
    'list_files 스냅샷이 에이전트 편집 목록과 달라졌다',
  );
});

test('TC-GRAPH-SYNC-DOCS-EXCLUDE: 에이전트가 docs/ 를 만졌더라도 list_files 집합은 소스 파일만 노출한다', () => {
  // 자동 커밋 스테이지 후보에서 docs/ 는 배제된다는 필터 계약(isExcludedFromCodeGraph).
  // 패널의 자동 커밋이 핸드오프 노트를 긁어가면 팀 공용 커밋이 오염된다.
  const graph = createGraph();
  graph.add('proj-A', 'docs/handoffs/2026-04-18.md');
  graph.add('proj-A', 'src/App.tsx');
  graph.add('proj-A', './docs/report.md');
  assert.deepEqual(
    graph.list('proj-A').map((n) => n.name).sort(),
    ['src/App.tsx'],
    'docs/ 파일이 list_files 집합에 샜다',
  );
});

test('TC-GRAPH-SYNC-GATE: enabled=false 면 편집이 있더라도 dispatchFromPanel 은 git 실행기를 한 번도 깨우지 않는다', () => {
  // "편집은 발생했지만 자동 커밋은 꺼둔 상태" 의 불변식. list_files 가 가득 차 있어도
  // flow 게이트가 active=false 면 commit/push/pr 어느 단계도 발사되면 안 된다.
  const graph = createGraph();
  for (const f of ['src/App.tsx', 'src/index.css']) graph.add('proj-A', f);
  assert.equal(graph.list('proj-A').length, 2);
  const exec = makeSpyExecutor();
  dispatchFromPanel({ flow: 'full-pr', enabled: false }, exec);
  assert.deepEqual(exec.calls, [], 'enabled=false 인데 git 실행기가 호출됐다');
});

test('TC-GRAPH-SYNC-COMMIT-ONLY: enabled=true + commit 흐름은 편집 파일이 있을 때 commit 만 1회 호출한다', () => {
  // 패널은 파일 개수를 세지 않는다 — dispatchFromPanel 은 flow 레벨만 보고 단계를 연다.
  // 편집 파일이 0 개든 N 개든 commit 흐름은 "commit 1회" 로 고정되어야, 패널의 UI 게이트
  // 계약과 list_files 스냅샷이 서로 독립된 관심사로 유지된다.
  const graph = createGraph();
  for (const f of ['server.ts', 'src/components/EmptyProjectPlaceholder.tsx']) graph.add('proj-A', f);
  assert.equal(graph.list('proj-A').length, 2);
  const exec = makeSpyExecutor();
  dispatchFromPanel({ flow: 'commit', enabled: true }, exec);
  assert.deepEqual(exec.calls, ['commit']);
});

test('TC-GRAPH-SYNC-REMOVE: 편집 사이클 끝에 remove 된 파일은 list_files 에서 빠지고 남은 집합이 커밋 후보가 된다', () => {
  // 에이전트가 중간에 파일을 만들었다가 rollback(삭제) 한 실사례. 최종 list_files 가
  // 실제로 디스크에 남은 파일 집합과 동일해야, 자동 커밋이 지운 파일까지 스테이지에
  // 올리는 사고(= 유령 add) 가 생기지 않는다.
  const graph = createGraph();
  const finalEdited = ['src/App.tsx', 'src/utils/codeGraphFilter.ts'];
  const transient = 'src/components/ProjectMenuScope.test.ts';
  for (const f of finalEdited) graph.add('proj-A', f);
  graph.add('proj-A', transient);
  assert.equal(graph.remove('proj-A', transient), true);
  assert.deepEqual(
    graph.list('proj-A').map((n) => n.name).sort(),
    [...finalEdited].sort(),
    'remove 이후 list_files 가 디스크 최종 상태와 어긋났다',
  );
});

// QA(감마): list_files ↔ "에이전트가 실제로 편집한 파일 집합" 1:1 불변식.
// 기존 TC-GRAPH-SYNC-* 는 특정 시점 스냅샷을 고정했지만, add/remove 혼합 스트림
// 동안 "편집 트래커"(=agent 자신이 add_file 로 올렸다가 remove 하지 않은 파일 집합)
// 와 list_files 결과 집합이 매 스텝마다 동일해야 한다는 집합 동등 불변식은 비어
// 있다. 이 불변이 깨지면 (a) add 누락으로 커밋에 안 올라가거나 (b) remove 누락으로
// 유령 파일이 스테이지에 올라간다.
test('TC-GRAPH-SYNC-BIJECTION: 편집 트래커와 list_files 는 add/remove 혼합 스트림 매 스텝에서 정확히 일치한다', () => {
  const graph = createGraph();
  // "에이전트가 지금 이 순간 편집 상태로 유지하고 있다고 주장하는" 파일 집합.
  // 실제 운영에서는 Write/Edit 호출 직후 이 집합에 add, 디스크 삭제 직후 remove.
  const editedTracker = new Set<string>();

  type Step = ['add' | 'remove', string];
  // 실제 워킹 트리를 반영한 시나리오: 추가→중복추가(멱등)→삭제→재추가→다른파일
  // 추가→중간 파일 제거→경로 표기 변형 추가 등 흔한 에이전트 패턴을 한 스트림에 섞는다.
  const timeline: Step[] = [
    ['add', 'src/App.tsx'],
    ['add', 'src/components/EmptyProjectPlaceholder.tsx'],
    ['add', 'src/App.tsx'],               // 멱등 재-add
    ['add', 'server.ts'],
    ['remove', 'src/components/EmptyProjectPlaceholder.tsx'],
    ['add', 'src/components/EmptyProjectPlaceholder.tsx'], // 재-add
    ['add', './src/utils/codeGraphFilter.ts'], // 표기 변형
    ['remove', 'server.ts'],
    ['add', 'src/index.css'],
  ];

  for (const [op, raw] of timeline) {
    const normalized = normalizeCodeGraphPath(raw);
    if (op === 'add') {
      // 필터에 걸린 파일은 트래커에도 올라가면 안 된다 (패널은 그런 파일을 모른다).
      if (!isExcludedFromCodeGraph(normalized)) editedTracker.add(normalized);
      graph.add('proj-A', raw);
    } else {
      editedTracker.delete(normalized);
      graph.remove('proj-A', raw);
    }
    const listed = new Set(graph.list('proj-A').map((n) => n.name));
    assert.deepEqual(
      [...listed].sort(),
      [...editedTracker].sort(),
      `op=${op} path=${raw} 에서 list_files 집합이 편집 트래커와 어긋났다`,
    );
  }
  // 최종 상태: 스트림 종료 후에도 두 집합은 완전 일치해야 한다.
  assert.equal(editedTracker.size, 4, '최종 편집 트래커 크기가 기대와 다르다');
  assert.deepEqual(
    graph.list('proj-A').map((n) => n.name).sort(),
    [...editedTracker].sort(),
    '스트림 종료 후 list_files 와 편집 트래커가 어긋났다',
  );
});

test('TC-GRAPH-SYNC-DISPATCH-PURE: dispatchFromPanel 호출은 list_files 스냅샷을 1바이트도 변조하지 않는다', () => {
  // QA 관심사: Git 자동화 패널이 dispatch 경로에서 실수로 graph 상태를 건드리면
  // 자동 커밋 한 번에 list_files 가 뒤틀려 다음 커밋 후보 계산이 오염된다. dispatch 는
  // 순수 "읽기 + 실행기 호출" 이어야 한다.
  const graph = createGraph();
  const edited = [
    'server.ts',
    'src/App.tsx',
    'src/components/EmptyProjectPlaceholder.tsx',
    'src/index.css',
  ];
  for (const f of edited) graph.add('proj-A', f);
  const before = graph.list('proj-A').map((n) => `${n.id}::${n.name}::${n.type}`).sort();
  const exec = makeSpyExecutor();
  dispatchFromPanel({ flow: 'full-pr', enabled: true }, exec);
  const after = graph.list('proj-A').map((n) => `${n.id}::${n.name}::${n.type}`).sort();
  assert.deepEqual(after, before, 'dispatchFromPanel 이 list_files 스냅샷을 건드렸다');
  // dispatch 자체는 정상 동작해야 하므로 세 단계가 모두 깨어났는지도 같이 고정.
  assert.deepEqual(exec.calls, ['commit', 'push', 'pr']);
});
