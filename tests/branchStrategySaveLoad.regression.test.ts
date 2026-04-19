// Run with: npx tsx --test tests/branchStrategySaveLoad.regression.test.ts
//
// QA 회귀 — 브랜치 전략(branchStrategy) "저장 → 새로고침 → 로드" 왕복 계약.
//
// 배경
// ────────────────────────────────────────────────────────────────────────────
// GitAutomationPanel 은 4 전략(per-commit / per-task / per-session / fixed-branch)
// 라디오를 노출하고, 사용자가 선택한 값은 `PATCH /api/projects/:id/options`
// 경로로 MongoDB `projects.branchStrategy` 필드에 저장된다. 재로드는
// `GET /api/projects/:id/options` → `projectOptionsView(project)` 로 수행한다.
// 본 파일은 그 **저장 페이로드(updateProjectOptionsSchema) ↔ 로드 뷰
// (projectOptionsView)** 의 왕복 계약을 네 가지 축으로 잠근다.
//
// 관련 선행 테스트
// ────────────────────────────────────────────────────────────────────────────
// · tests/gitAutomationPanelBranchStrategy.regression.test.ts   — 패널 ↔ 래퍼
//   하이드레이션 레이스(선택값이 로딩 구간 DEFAULT 로 덮이지 않는지).
// · tests/branchStrategy.regression.test.ts                     — 전략별 실제
//   git 저장소에서 브랜치 생성·재사용 계약.
// · src/utils/projectOptions.test.ts                            — 단건 필드
//   검증기 단위 테스트.
//
// 본 파일이 잠그는 "빈 틈"
// ────────────────────────────────────────────────────────────────────────────
//   ① 4 전략 모두 저장·로드 왕복이 무손실인지(표본 한두 개가 아니라 **전체
//      열거값**)
//   ② 전략을 B → A, 단일모드(fixed-branch) → A 로 바꾸는 환승 흐름에서,
//      이전 전략의 잔존 필드(fixedBranchName / branchNamePattern) 가 새 저장
//      페이로드를 오염시키지 않는지
//   ③ 레거시 프로젝트 문서(branchStrategy 필드 자체가 없는 경우) 로드 시
//      PROJECT_OPTION_DEFAULTS 로 매끈하게 폴백하는지
//   ④ DB 덤프·수동 편집·스키마 마이그레이션 누수로 유효하지 않은 문자열
//      ('legacy-v0', 42, null) 이 들어와 있을 때, 로드 계층이 조용히 기본값으로
//      폴백해 UI 라디오가 "선택 없음" 으로 깨지지 않는지
//
// ┌─ 시나리오 지도 ────────────────────────────────────────────────────────────┐
// │ S1  A안(per-task) 선택·저장 → 새로고침 → A안 복원                           │
// │ S2  B안(per-commit)/단일모드(fixed-branch) 에서 A안(per-task) 으로 환승      │
// │ S3  설정 파일에 branchStrategy 값이 없음 → 기본값(per-session)              │
// │ S4  잘못된 값(타입 오류·열거 외 문자열) → 로드 폴백 + 저장 시 400           │
// └─────────────────────────────────────────────────────────────────────────────┘

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProjectOptionsValidationError,
  hasAnyUpdate,
  projectOptionsView,
  updateProjectOptionsSchema,
} from '../src/utils/projectOptions.ts';
import {
  BRANCH_STRATEGY_VALUES,
  PROJECT_OPTION_DEFAULTS,
  type BranchStrategy,
} from '../src/types.ts';

// ---------------------------------------------------------------------------
// 인메모리 저장소 시뮬레이터.
//
// server.ts `/api/projects/:id/options` 의 분기(validate → $set/$unset →
// updateOne → findOne → projectOptionsView) 를 압축해 동일 순서로 재현한다.
// 실 서버/Mongo 를 띄우지 않으므로 테스트는 환경 독립이며, `ProjectRow` 는
// 실제 Mongo 문서와 달리 _id 만 제거한 평면 레코드.
// ---------------------------------------------------------------------------

type ProjectRow = Record<string, unknown>;

interface FakeDb {
  projects: Map<string, ProjectRow>;
}

function createDb(seed: ProjectRow = {}): FakeDb {
  const db: FakeDb = { projects: new Map() };
  db.projects.set('P', { id: 'P', ...seed });
  return db;
}

type PatchResponse =
  | { status: 200; body: ReturnType<typeof projectOptionsView> }
  | { status: 400; body: { error: string; field?: string } };

// PATCH 시뮬레이터. server.ts:793-831 을 그대로 따른다 —
//   1) updateProjectOptionsSchema 로 입력 검증
//   2) $set / $unset 을 기존 row 에 병합(서버 updateOne 과 동등)
//   3) 저장 직후 projectOptionsView 로 변환해 응답
// sharedGoalId 교차 검증은 본 파일의 시나리오와 무관해 생략한다.
function simulatePatch(db: FakeDb, body: unknown): PatchResponse {
  try {
    const validated = updateProjectOptionsSchema(body);
    if (!hasAnyUpdate(validated)) {
      return { status: 400, body: { error: '갱신할 필드가 없습니다' } };
    }
    const row = db.projects.get('P') ?? { id: 'P' };
    const next: ProjectRow = { ...row };
    for (const [k, v] of Object.entries(validated.$set)) next[k] = v;
    for (const k of Object.keys(validated.$unset)) delete next[k];
    db.projects.set('P', next);
    return { status: 200, body: projectOptionsView(next as Parameters<typeof projectOptionsView>[0]) };
  } catch (e) {
    if (e instanceof ProjectOptionsValidationError) {
      return { status: 400, body: { error: e.message, field: e.field } };
    }
    throw e;
  }
}

// GET 시뮬레이터 — 새로고침/다른 탭 복원을 모사.
function simulateGet(db: FakeDb): ReturnType<typeof projectOptionsView> {
  const row = db.projects.get('P') ?? { id: 'P' };
  return projectOptionsView(row as Parameters<typeof projectOptionsView>[0]);
}

// BranchStrategy 가 BRANCH_STRATEGY_VALUES 에 포함되는지 런타임 검사.
// 로드 경로가 "잘못된 문자열을 그대로 통과시키면 UI 라디오가 미선택 상태로 깨진다"
// 는 S4 계약을 말로가 아닌 함수로 잠그기 위해 export.
function isKnownBranchStrategy(x: unknown): x is BranchStrategy {
  return typeof x === 'string' && (BRANCH_STRATEGY_VALUES as readonly string[]).includes(x);
}

// ---------------------------------------------------------------------------
// 공용 픽스처. "A안" 은 per-task, "B안" 은 per-commit, "단일모드" 는 fixed-branch
// 로 고정. 시나리오 지도 주석과 1:1.
// ---------------------------------------------------------------------------

const PLAN_A: BranchStrategy = 'per-task';
const PLAN_B: BranchStrategy = 'per-commit';
const SINGLE_MODE: BranchStrategy = 'fixed-branch';

// ---------------------------------------------------------------------------
// S1 — A안(per-task) 선택·저장 → 새로고침 → A안 복원
// ---------------------------------------------------------------------------

test('S1 — Given 빈 프로젝트 When A안(per-task) 저장 → GET(새로고침) Then 패널 로드값이 per-task', () => {
  const db = createDb();

  // When: 사용자가 A안 라디오를 선택·저장.
  const saved = simulatePatch(db, { branchStrategy: PLAN_A });
  assert.equal(saved.status, 200);
  if (saved.status !== 200) throw new Error('unreachable');

  // Then 1: 저장 응답이 A안.
  assert.equal(saved.body.branchStrategy, PLAN_A);

  // When 2: 새로고침.
  const reloaded = simulateGet(db);

  // Then 2: 로드값도 A안.
  assert.equal(reloaded.branchStrategy, PLAN_A, '새로고침 후 A안이 복원되지 않으면 저장/로드 왕복 회귀');
  assert.notEqual(reloaded.branchStrategy, PROJECT_OPTION_DEFAULTS.branchStrategy,
    '기본값(per-session) 으로 되돌아오면 S1 회귀 재발');
});

test('S1 — GET 을 두 번 연속 호출해도 동일 응답(순수 읽기 불변)', () => {
  const db = createDb();
  simulatePatch(db, { branchStrategy: PLAN_A });
  const r1 = simulateGet(db);
  const r2 = simulateGet(db);
  assert.deepEqual(r1, r2, '로드 경로에 부작용이 있으면 새로고침 간 값이 흔들린다');
});

test('S1 — 4 전략 전수(per-commit|per-task|per-session|fixed-branch) 저장·로드 왕복 무손실', () => {
  // 표본 한 두 전략만 테스트하면 유효값 중 하나가 조용히 손실되는 회귀를 놓친다.
  // 전체 열거값을 훑어, 어떤 전략도 왕복에서 누락/변조되지 않음을 잠근다.
  for (const strategy of BRANCH_STRATEGY_VALUES) {
    const db = createDb();
    // fixed-branch 는 fixedBranchName 을 함께 저장해 "전략+보조 필드" 짝도 잠금.
    const patch: Record<string, unknown> = { branchStrategy: strategy };
    if (strategy === 'fixed-branch') patch.fixedBranchName = 'release/stable';
    const saved = simulatePatch(db, patch);
    assert.equal(saved.status, 200, `${strategy} 저장이 실패했다`);
    if (saved.status !== 200) continue;

    const got = simulateGet(db);
    assert.equal(got.branchStrategy, strategy, `${strategy} 가 왕복에서 변조됐다`);
    if (strategy === 'fixed-branch') {
      assert.equal(got.fixedBranchName, 'release/stable', 'fixedBranchName 이 왕복에서 유실됐다');
    }
  }
});

// ---------------------------------------------------------------------------
// S2 — B안/단일모드에서 A안으로 환승. 저장 페이로드가 깔끔하게 A안만 포함해야
// 이전 전략의 보조 필드(fixedBranchName 등)가 자동화 파이프라인을 흐리지 않는다.
// ---------------------------------------------------------------------------

test('S2 — Given B안(per-commit) 저장 상태 When A안(per-task) 으로 변경 → GET Then 로드값이 per-task', () => {
  const db = createDb();
  simulatePatch(db, { branchStrategy: PLAN_B });
  assert.equal(simulateGet(db).branchStrategy, PLAN_B, '사전 조건: B안이 저장되어야 한다');

  const saved = simulatePatch(db, { branchStrategy: PLAN_A });
  assert.equal(saved.status, 200);
  assert.equal(simulateGet(db).branchStrategy, PLAN_A, 'B → A 환승이 로드에 반영되지 않음');
});

test('S2 — Given 단일모드(fixed-branch) + fixedBranchName When A안으로 변경 Then 로드는 per-task, fixedBranchName 은 이전 값 보존', () => {
  // projectOptions 의 $set 은 "보낸 필드만 교체" 계약이다. 전략을 A안으로 바꾸는
  // PATCH 가 fixedBranchName 을 같이 보내지 않으면, 서버는 그 값을 건드리지 않고
  // 다음 번 다시 단일모드로 돌아올 때를 대비해 남겨 둔다. 이 "남겨 둠" 계약을
  // 깨면, 단일모드 → A안 → 단일모드 로 순환할 때 fixedBranchName 이 매번 기본값
  // 으로 초기화되는 사용성 회귀가 발생한다.
  const db = createDb();
  simulatePatch(db, { branchStrategy: SINGLE_MODE, fixedBranchName: 'release/alpha' });
  assert.equal(simulateGet(db).branchStrategy, SINGLE_MODE);
  assert.equal(simulateGet(db).fixedBranchName, 'release/alpha');

  // When: 전략만 A안으로 환승 (fixedBranchName 은 페이로드에 포함하지 않음).
  const saved = simulatePatch(db, { branchStrategy: PLAN_A });
  assert.equal(saved.status, 200);

  const got = simulateGet(db);
  assert.equal(got.branchStrategy, PLAN_A, 'A안으로의 환승 결과가 로드에 반영되어야 한다');
  assert.equal(got.fixedBranchName, 'release/alpha',
    'A안 환승 시 fixedBranchName 이 사라지면 사용자가 다시 단일모드로 돌아올 때 값을 복구할 수 없다');
});

test('S2 — A안 → 단일모드 → A안 왕복에서 전략값이 유실되지 않는다', () => {
  // 반대 방향 환승도 동일하게 동작해야 한다. 두 번 환승이 "기본값으로 되돌아가는"
  // 회귀를 만들면 B3(탭 전환 보존) 와 중첩돼 사용자가 "내 선택이 사라졌다"고 느낀다.
  const db = createDb();
  simulatePatch(db, { branchStrategy: PLAN_A });
  assert.equal(simulateGet(db).branchStrategy, PLAN_A);

  simulatePatch(db, { branchStrategy: SINGLE_MODE, fixedBranchName: 'auto/work' });
  assert.equal(simulateGet(db).branchStrategy, SINGLE_MODE);

  simulatePatch(db, { branchStrategy: PLAN_A });
  assert.equal(simulateGet(db).branchStrategy, PLAN_A, '두 번 환승 후에도 A안이 유지되어야 한다');
});

test('S2 — 전략 변경과 함께 branchNamePattern 도 갱신되면, 두 필드가 한 번에 원자적으로 보존된다', () => {
  // 패널의 save() 가 branchStrategy 와 branchNamePattern 을 동시에 $set 으로 보낼 때,
  // 둘 중 하나만 적용되는 부분 저장이 일어나지 않아야 한다.
  const db = createDb();
  const saved = simulatePatch(db, {
    branchStrategy: PLAN_A,
    branchNamePattern: 'auto/{ticket}-{shortId}',
  });
  assert.equal(saved.status, 200);

  const got = simulateGet(db);
  assert.equal(got.branchStrategy, PLAN_A);
  assert.equal(got.branchNamePattern, 'auto/{ticket}-{shortId}',
    '두 필드를 함께 저장했는데 한쪽만 반영되면 원자성 계약 위반');
});

// ---------------------------------------------------------------------------
// S3 — 기존 설정 파일에 branchStrategy 값이 없는 경우 기본값 처리.
// ---------------------------------------------------------------------------

test('S3 — Given branchStrategy 필드가 없는 레거시 프로젝트 When GET Then 기본값(per-session) 이 채워진다', () => {
  // 한 번도 저장한 적 없는 프로젝트 — projects 컬렉션에 옵션 필드가 전혀 없는 row.
  const db = createDb(); // seed 는 id 만.
  const got = simulateGet(db);
  assert.equal(got.branchStrategy, PROJECT_OPTION_DEFAULTS.branchStrategy);
  assert.equal(got.branchStrategy, 'per-session', '기본값이 per-session 에서 벗어나면 리더 단일 브랜치 정책 회귀');
});

test('S3 — branchStrategy 누락 + 보조 필드도 누락 Then 보조 기본값(fixedBranchName, branchNamePattern, autoMergeToMain)도 함께 채워진다', () => {
  // 로드 뷰 한 곳에서 모든 기본값이 한꺼번에 채워져야, 패널이 "일부만 누락된 설정"
  // 에 대한 가지 수 분기를 가지지 않아도 된다.
  const db = createDb();
  const got = simulateGet(db);
  assert.equal(got.fixedBranchName, PROJECT_OPTION_DEFAULTS.fixedBranchName);
  assert.equal(got.branchNamePattern, PROJECT_OPTION_DEFAULTS.branchNamePattern);
  assert.equal(got.autoMergeToMain, PROJECT_OPTION_DEFAULTS.autoMergeToMain);
});

test('S3 — branchStrategy 누락 상태에서도 사용자 저장 없이 GET 이 400/throw 를 내지 않는다', () => {
  // 방어 계약: 한 번도 저장하지 않은 프로젝트 열기 시 로드 예외가 나면, 프로젝트
  // 관리 탭이 아예 렌더되지 않는다. 항상 200-shaped 응답이 나와야 한다.
  const db = createDb();
  assert.doesNotThrow(() => simulateGet(db));
});

test('S3 — 일부 필드(branchStrategy 는 있으나 fixedBranchName 이 없음) 도 누락분만 기본값으로 채워진다', () => {
  // 한 쪽 필드만 저장된 중간 상태 — 마이그레이션 중/일부 필드만 PATCH 된 경우.
  const db = createDb({ branchStrategy: PLAN_A });
  const got = simulateGet(db);
  assert.equal(got.branchStrategy, PLAN_A, '있는 값은 유지');
  assert.equal(got.fixedBranchName, PROJECT_OPTION_DEFAULTS.fixedBranchName, '없는 값만 기본값');
});

// ---------------------------------------------------------------------------
// S4 — 잘못된 값이 들어있을 때의 폴백 + 저장 시 400.
// ---------------------------------------------------------------------------

test('S4-a — 저장 경로: 열거 외 문자열(branchStrategy="legacy-v0") 은 PATCH 400 으로 차단', () => {
  const db = createDb();
  const res = simulatePatch(db, { branchStrategy: 'legacy-v0' });
  assert.equal(res.status, 400);
  if (res.status !== 400) throw new Error('unreachable');
  assert.match(res.body.error, /branchStrategy/);
  // DB 에 아무 값도 들어가지 않아야 한다.
  const row = db.projects.get('P');
  assert.ok(row && !('branchStrategy' in row), '400 인 저장 요청이 DB 를 오염시키면 안 된다');
});

test('S4-a — 저장 경로: 비문자형(숫자/boolean/배열/객체/null) 은 모두 400', () => {
  // 한 케이스만 검사하면 타입 가드가 조용히 한 쪽으로 새는 회귀를 놓친다.
  for (const bad of [42, true, false, [], {}, null]) {
    const res = simulatePatch(createDb(), { branchStrategy: bad });
    assert.equal(res.status, 400, `${typeof bad}(${String(bad)}) 가 400 으로 차단되지 않았다`);
  }
});

test('S4-b — 로드 경로: DB 에 이미 들어있는 잘못된 값은 조용히 기본값으로 폴백된다', () => {
  // 서버 외 경로(DB 수동 편집 · 예전 스키마 · 다른 서비스 이식) 로 유효하지 않은
  // 문자열이 DB 에 존재하는 상황. projectOptionsView 가 이 값을 그대로 내려 주면
  // UI 라디오가 "알 수 없는 값" 으로 선택되지 않는 상태가 되어 저장조차 할 수 없다.
  // 계약: 로드 계층이 열거값이 아닌 branchStrategy 를 PROJECT_OPTION_DEFAULTS 로 폴백.
  const db = createDb({ branchStrategy: 'legacy-v0' });
  const got = simulateGet(db);
  assert.ok(
    isKnownBranchStrategy(got.branchStrategy),
    `로드된 branchStrategy='${String(got.branchStrategy)}' 가 열거값이 아니다 — UI 라디오가 깨진다`,
  );
  assert.equal(got.branchStrategy, PROJECT_OPTION_DEFAULTS.branchStrategy);
});

test('S4-b — 로드 경로: branchStrategy 가 null 이면 기본값으로 폴백', () => {
  // nullish coalescing(??) 은 null 을 기본값으로 치환하지만, DB 가 `null` 이 아니라
  // 빈 문자열 '' 을 담고 있는 경우도 있어 두 케이스를 함께 잠근다.
  const got = simulateGet(createDb({ branchStrategy: null }));
  assert.equal(got.branchStrategy, PROJECT_OPTION_DEFAULTS.branchStrategy);
});

test('S4-b — 로드 경로: branchStrategy 가 빈 문자열/공백만 있으면 기본값으로 폴백', () => {
  // 빈 문자열은 `??` 로 기본값 폴백되지 않는다(?? 은 null/undefined 만 감지). 별도
  // 방어가 필요하다. 공백만 있는 경우도 같은 축으로 막는다.
  for (const empty of ['', '   ', '\t\n']) {
    const got = simulateGet(createDb({ branchStrategy: empty }));
    assert.equal(
      got.branchStrategy,
      PROJECT_OPTION_DEFAULTS.branchStrategy,
      `branchStrategy='${empty.replace(/\s/g, '·')}' 가 기본값으로 폴백되지 않았다`,
    );
  }
});

test('S4-b — 로드 경로: branchStrategy 가 숫자/객체/배열 등 비문자형이면 기본값으로 폴백', () => {
  // 마이그레이션 중 `1` 로 저장돼 있거나, JS→Mongo 경계에서 unknown 이 주입된
  // 경우도 동일 폴백. 타입이 완전히 어긋난 값이 UI 까지 흘러가면 anti-XSS 경로도 깨진다.
  for (const bad of [42, true, false, { kind: 'per-task' }, ['per-task']]) {
    const got = simulateGet(createDb({ branchStrategy: bad }));
    assert.ok(
      isKnownBranchStrategy(got.branchStrategy),
      `branchStrategy=${JSON.stringify(bad)} 로드 결과가 열거값이 아니다`,
    );
    assert.equal(got.branchStrategy, PROJECT_OPTION_DEFAULTS.branchStrategy);
  }
});

test('S4 — 로드 폴백 후 다시 PATCH 를 보내 값을 바로잡으면 이후 로드가 올바른 값으로 고정된다', () => {
  // "잘못된 값 → 로드 폴백 → 사용자가 다시 저장 → 정상화" 사이클을 잠금.
  // 이 계약이 깨지면 한 번 오염된 프로젝트가 영구적으로 기본값에 고정된다.
  const db = createDb({ branchStrategy: 'legacy-v0' });
  assert.equal(simulateGet(db).branchStrategy, PROJECT_OPTION_DEFAULTS.branchStrategy);

  const saved = simulatePatch(db, { branchStrategy: PLAN_A });
  assert.equal(saved.status, 200);
  assert.equal(simulateGet(db).branchStrategy, PLAN_A, '폴백 상태에서의 재저장이 로드에 반영되지 않으면 회귀');
});

// ---------------------------------------------------------------------------
// 왕복 라운드트립 — PATCH 응답 본문과 직후 GET 본문이 완전히 일치하는가.
// 두 경로를 따로 바라보는 두 UI 소비자(save() 콜백 캐시 vs 새로고침 로드)가
// 조용히 갈라지는 회귀를 여기서 한 줄로 차단한다.
// ---------------------------------------------------------------------------

test('라운드트립 — PATCH 응답과 동일 시점 GET 응답이 완전히 같다', () => {
  const db = createDb();
  const patched = simulatePatch(db, {
    branchStrategy: PLAN_A,
    branchNamePattern: 'auto/{ticket}-{shortId}',
    autoMergeToMain: true,
  });
  assert.equal(patched.status, 200);
  if (patched.status !== 200) throw new Error('unreachable');
  const got = simulateGet(db);
  assert.deepEqual(patched.body, got, 'PATCH 응답과 GET 응답이 어긋나면 UI 가 두 값 사이에서 깜빡인다');
});
