// Run with: npx tsx --test tests/sharedGoalModalAtomic.regression.test.ts
//
// 회귀 테스트: SharedGoalModal 의 "저장→ON 원자성" 계약을 소스 수준에서 잠근다.
// 시안: tests/shared-goal-modal-mockup.md §1 — 목표 저장 200 이 도착한 **뒤에만**
// PATCH /api/auto-dev { enabled: true } 를 호출해야 한다.
//
// JSDOM harness 도입 전까지는 정적 검증만으로 회귀 표면을 최대한 넓혀 둔다.
// 본 파일이 잠그는 3가지:
//   1. src/components/SharedGoalModal.tsx 파일 존재 + named export.
//   2. 저장 엔드포인트(POST /api/projects/:id/shared-goal) 와 자동 개발 토글
//      엔드포인트(PATCH /api/auto-dev) 둘 다 같은 파일에서 호출된다.
//   3. src/App.tsx 가 SharedGoalModal 을 import 하고 `<SharedGoalModal` 로 마운트.
//      기존 "안내" Modal 문구("프로젝트 관리 탭의 공동 목표 입력 폼에서") 는 제거.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODAL_PATH = resolve(__dirname, '..', 'src', 'components', 'SharedGoalModal.tsx');
const APP_PATH = resolve(__dirname, '..', 'src', 'App.tsx');

test('SharedGoalModal.tsx 파일이 존재하고 named export 한다', () => {
  assert.ok(existsSync(MODAL_PATH), 'src/components/SharedGoalModal.tsx 가 존재해야 한다');
  const src = readFileSync(MODAL_PATH, 'utf8');
  assert.match(src, /export\s+function\s+SharedGoalModal\b/,
    'named export `SharedGoalModal` 가 선언되어야 한다');
});

test('SharedGoalModal 은 목표 저장과 자동 개발 ON 두 엔드포인트를 모두 호출한다', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  assert.match(src, /\/api\/projects\/\$\{projectId\}\/shared-goal/,
    'POST /api/projects/:id/shared-goal 를 호출해야 한다 (server.ts 985~1018 계약)');
  assert.match(src, /method:\s*'POST'/,
    '목표 저장은 POST 이어야 한다');
  assert.match(src, /\/api\/auto-dev/,
    'PATCH /api/auto-dev 를 호출해야 한다 (server.ts 714~731 계약)');
  assert.match(src, /method:\s*'PATCH'/,
    '자동 개발 토글은 PATCH 이어야 한다');
});

test('원자 순서: 저장 호출이 PATCH 호출보다 먼저 나타난다', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  const saveIdx = src.indexOf('/shared-goal');
  const patchIdx = src.indexOf('/auto-dev');
  assert.ok(saveIdx > 0 && patchIdx > 0,
    '두 엔드포인트 호출 문자열이 모두 존재해야 한다');
  assert.ok(saveIdx < patchIdx,
    '시안 §1 원자성: 저장(POST shared-goal) 이 ON(PATCH auto-dev) 보다 먼저 호출되어야 한다');
});

test('App.tsx 는 SharedGoalModal 을 import 하고 마운트한다', () => {
  const src = readFileSync(APP_PATH, 'utf8');
  assert.match(src, /import\s*\{\s*SharedGoalModal\s*\}\s*from\s*['"]\.\/components\/SharedGoalModal['"]/,
    '`SharedGoalModal` 을 components 디렉터리에서 import 해야 한다');
  assert.match(src, /<SharedGoalModal\b/,
    '`<SharedGoalModal ...>` 로 마운트되어야 한다');
});

test('App.tsx 의 기존 "프로젝트 관리 탭의 공동 목표 입력 폼에서" 안내 문구는 제거됐다', () => {
  // 교체 회귀 방지: 예전 안내 Modal(탭 이동만 안내) 이 살아있으면 사용자는 두
  // 경로 중 어느 것이 권장인지 혼란을 겪는다. 모달 내에서 저장 완결이 가능한
  // 새 SharedGoalModal 로 완전 교체되었는지 확인한다.
  const src = readFileSync(APP_PATH, 'utf8');
  assert.doesNotMatch(src, /프로젝트 관리" 탭의 공동 목표 입력 폼에서/,
    '기존 안내 모달 문구가 App.tsx 에 남아 있다. SharedGoalModal 로 교체되어야 한다.');
});
