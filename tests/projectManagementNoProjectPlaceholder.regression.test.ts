// Run with: npx tsx --test tests/projectManagementNoProjectPlaceholder.regression.test.ts
//
// 회귀 테스트: 프로젝트 관리 탭(ProjectManagement) 에 진입했을 때 현재 프로젝트가
// 없으면 `null` 로 빈 화면을 만들지 말고, "프로젝트를 먼저 선택하세요" 안내 박스를
// 반드시 렌더해야 한다. docs/ui-audit-2026-04-19.md §4-Ⅱ 에서 도출된 요구.
//
// 잠그는 계약 3가지:
//   1. src/components/ProjectManagement.tsx 에서 `if (!currentProjectId) return null;`
//      표현식(예전 회귀 근원)이 더 이상 존재하지 않는다.
//   2. 같은 분기가 `data-testid="project-management-no-project"` 컨테이너를 반환한다.
//   3. 안내 문구에 "프로젝트를 먼저 선택" 혹은 "선택된 프로젝트가 없습니다" 류
//      한국어 문자열이 포함되어 사용자가 원인을 즉시 읽을 수 있다.
//
// 컴포넌트 렌더링 통합 테스트는 JSDOM harness 도입 전이라 정적 검증만으로
// 표면을 최대한 넓힌다(본 파일과 동일 패턴: projectManagementSharedGoalMount.
// regression.test.ts).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_MGMT_PATH = resolve(__dirname, '..', 'src', 'components', 'ProjectManagement.tsx');

test('ProjectManagement 는 currentProjectId 가 비어 있을 때 null 을 돌려주지 않는다', () => {
  const src = readFileSync(PROJECT_MGMT_PATH, 'utf8');
  assert.doesNotMatch(
    src,
    /if\s*\(\s*!currentProjectId\s*\)\s*return\s+null\s*;/,
    '`if (!currentProjectId) return null;` 표현식이 남아 있다. 빈 상태 안내 박스로 교체해야 한다.',
  );
});

test('ProjectManagement 는 `project-management-no-project` 컨테이너를 렌더한다', () => {
  const src = readFileSync(PROJECT_MGMT_PATH, 'utf8');
  assert.match(
    src,
    /data-testid="project-management-no-project"/,
    '빈 상태 식별용 `data-testid="project-management-no-project"` 컨테이너가 필요하다.',
  );
});

test('빈 상태 안내 문구에 한국어 원인 설명이 포함된다', () => {
  const src = readFileSync(PROJECT_MGMT_PATH, 'utf8');
  assert.match(
    src,
    /선택된 프로젝트가 없습니다/,
    '사용자가 즉시 읽을 수 있는 한국어 원인 문구(예: "현재 선택된 프로젝트가 없습니다.") 가 필요하다.',
  );
  assert.match(
    src,
    /프로젝트를 먼저 선택|먼저 선택하면/,
    '어떤 행동을 해야 하는지 안내하는 한국어 문구(예: "먼저 선택하면 ...") 가 필요하다.',
  );
});

test('접근성: role="status" + aria-live 로 스크린리더에 빈 상태 전이를 낭독한다', () => {
  const src = readFileSync(PROJECT_MGMT_PATH, 'utf8');
  // 빈 상태 박스 주변에 role="status" 와 aria-live 가 함께 선언되어 있어야 한다.
  // 단순히 두 속성이 파일 어딘가에 있으면 안 되고, "project-management-no-project"
  // 컨테이너 근처 창 안에 같이 있어야 계약이 성립한다. 160자 폭 창이면 충분.
  const idx = src.indexOf('data-testid="project-management-no-project"');
  assert.ok(idx > -1, '빈 상태 컨테이너가 선행되어야 한다');
  const windowStart = Math.max(0, idx - 160);
  const windowEnd = Math.min(src.length, idx + 160);
  const snippet = src.slice(windowStart, windowEnd);
  assert.match(snippet, /role="status"/, '빈 상태 컨테이너에 role="status" 가 필요하다');
  assert.match(snippet, /aria-live=/, '빈 상태 컨테이너에 aria-live 가 필요하다');
});
