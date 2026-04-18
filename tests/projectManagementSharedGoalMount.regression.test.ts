// Run with: npx tsx --test tests/projectManagementSharedGoalMount.regression.test.ts
//
// 회귀 테스트: 프로젝트 관리 메뉴(ProjectManagement) 화면에 공동 목표(SharedGoal)
// 입력 폼이 **항상** 렌더되어야 한다. 자동 개발 ON 의 전제조건이 "활성 공동 목표
// 1건" 이기 때문에(tests/autoDevToggleSharedGoalModal.regression.test.ts 계약 참조),
// 폼이 숨겨져 있으면 사용자는 App 루트의 "공동 목표를 먼저 입력해주세요" 가드
// 모달에서 빠져나올 방법이 없어 자동 개발을 시작할 수 없다.
//
// 본 파일은 소스 문자열 수준에서 두 가지를 잠근다:
//  1. SharedGoalForm 컴포넌트 파일이 존재하고 기본 export 가 SharedGoalForm 이다.
//  2. ProjectManagement.tsx 가 SharedGoalForm 을 import 하고, prTargetManaged 의
//     길이 조건 "바깥" 에서 마운트한다(즉 PR 대상 프로젝트가 없어도 폼은 보여야 함).
//
// 컴포넌트 렌더링 통합 테스트는 JSDOM harness 가 아직 없어 별도로 도입된다.
// 지금은 GitAutomationPanel 하이드레이션 레이스 회귀(1587ea9) 와 같은 스타일로
// 정적 검증만 수행한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHARED_GOAL_FORM_PATH = resolve(__dirname, '..', 'src', 'components', 'SharedGoalForm.tsx');
const PROJECT_MGMT_PATH = resolve(__dirname, '..', 'src', 'components', 'ProjectManagement.tsx');

test('SharedGoalForm.tsx 파일이 존재하고 SharedGoalForm 을 export 한다', () => {
  assert.ok(existsSync(SHARED_GOAL_FORM_PATH), 'src/components/SharedGoalForm.tsx 가 존재해야 한다');
  const src = readFileSync(SHARED_GOAL_FORM_PATH, 'utf8');
  assert.match(src, /export\s+function\s+SharedGoalForm\b/,
    'named export `SharedGoalForm` 가 선언되어야 한다');
  assert.match(src, /\/api\/projects\/\$\{projectId\}\/shared-goal/,
    '서버 계약대로 /api/projects/:id/shared-goal 엔드포인트를 사용해야 한다');
  assert.match(src, /method:\s*'POST'/,
    '저장 경로는 POST 이어야 한다 (server.ts 985~1018 계약)');
});

test('ProjectManagement.tsx 는 SharedGoalForm 을 import 하고 마운트한다', () => {
  const src = readFileSync(PROJECT_MGMT_PATH, 'utf8');
  assert.match(src, /import\s*\{\s*SharedGoalForm\s*\}\s*from\s*['"]\.\/SharedGoalForm['"]/,
    '`SharedGoalForm` 을 같은 components 디렉터리에서 import 해야 한다');
  assert.match(src, /<SharedGoalForm\b[^>]*\bprojectId=/,
    '`<SharedGoalForm projectId={...} />` 형태로 마운트되어야 한다');
});

test('SharedGoalForm 마운트는 prTargetManaged.length 조건 바깥에 있어야 한다', () => {
  // 회귀 방지: prTargetManaged 블록 내부에 넣으면 PR 대상 프로젝트가 없을 때
  // 폼이 숨겨진다. ResearchInsights/GitCredentialsSection 위쪽(= prTargetManaged
  // 분기 바깥) 에 위치해야 "항상 표시" 계약이 성립한다.
  const src = readFileSync(PROJECT_MGMT_PATH, 'utf8');
  const mountIdx = src.indexOf('<SharedGoalForm');
  assert.ok(mountIdx > 0, '`<SharedGoalForm` 마운트 위치를 찾을 수 없다');
  // 같은 <SharedGoalForm ... /> 요소가 감싸진 가장 가까운 `prTargetManaged.length > 0 && (`
  // 분기를 찾기 위해 단순 역추적 — 분기 시작점 이후 `)` 닫힘 위치가 마운트 앞에 있어야 한다.
  const branchPattern = /prTargetManaged\.length\s*>\s*0\s*&&\s*\(/g;
  let lastOpenBeforeMount = -1;
  let match: RegExpExecArray | null;
  while ((match = branchPattern.exec(src)) !== null) {
    if (match.index >= mountIdx) break;
    lastOpenBeforeMount = match.index;
  }
  if (lastOpenBeforeMount === -1) return; // 분기 자체가 없으면 마운트는 당연히 바깥.
  // 해당 분기의 대응 `)` 를 대강 추적: 다음 `)}` 출현을 취한다. JSX 중첩이 있으므로
  // 정확한 AST 는 아니지만, 본 테스트 목적은 "마운트가 해당 분기 '밖' 인지" 를
  // 잠그는 데 있으며, 분기 내부에 들어가면 close 위치가 mountIdx 뒤로 밀려난다.
  const closeIdx = src.indexOf(')}', lastOpenBeforeMount);
  assert.ok(
    closeIdx > -1 && closeIdx < mountIdx,
    'SharedGoalForm 이 `prTargetManaged.length > 0` 분기 내부에 들어가 있다. PR 대상이 없을 때 폼이 숨겨지는 회귀를 유발한다.',
  );
});
