// Run with: npx tsx --test tests/appHeaderMetricsA11y.regression.test.ts
//
// QA 회귀 · 상단 헤더 메트릭 칩 접근성(지시 #ccb2d506).
//
// 정적 계약 4가지를 잠근다:
//   1. 메트릭 묶음에 role="group" + aria-label 이 붙어 스크린리더가 독립 섹션으로 인식한다.
//   2. 6개 칩(zoom/agents/projects 수/coverage/activity/collaboration) 이 각기 role="status"
//      + 의미 있는 aria-label 을 가진다.
//   3. "프로젝트: N" (count) 칩은 CurrentProjectBadge 의 "현재 프로젝트: 이름" 과
//      시각적으로도 구분되도록 "전체 프로젝트:" 접두어를 쓴다. 라벨 충돌 회귀 차단.
//   4. 각 칩에 data-testid 가 부여돼 있어 후속 E2E/접근성 스캐너가 대상을 안정적으로 식별한다.
//
// 본 테스트는 파일 내용을 문자열로 읽어 정규식으로 확인한다. 전체 App 렌더까지 올리지
// 않는 이유는 App.tsx 가 2800+줄이라 jsdom 부팅 비용이 커지기 때문이며, 본 계약은
// "정적 마크업" 이라 소스 정규식으로 충분히 잠글 수 있다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  resolve(__dirname, '..', 'src', 'App.tsx'),
  'utf8',
);

test('상단 메트릭 묶음에 role="group" + aria-label="상단 요약 지표" 가 선언돼 있다', () => {
  assert.match(SRC, /role="group"[\s\S]{0,160}aria-label="상단 요약 지표"/,
    'header 메트릭 묶음 <div> 에 role="group" 과 aria-label 이 모두 필요하다');
  assert.match(SRC, /data-testid="app-header-metrics"/);
});

test('확대 칩 — role="status" + aria-label + data-testid 가 모두 붙어 있다', () => {
  assert.match(SRC, /aria-label=\{`확대 \$\{Math\.round\(zoom \* 100\)\} 퍼센트`\}/);
  assert.match(SRC, /data-testid="header-metric-zoom"/);
});

test('전체 에이전트 칩 — aria-label 에 인원 수가 그대로 반영된다', () => {
  assert.match(SRC, /aria-label=\{`전체 에이전트 \$\{gameState\.agents\.length\} 명`\}/);
  assert.match(SRC, /data-testid="header-metric-agents"/);
});

test('전체 프로젝트 개수 칩 — 시각 라벨과 aria-label 이 CurrentProjectBadge 와 구분된다', () => {
  // 시각 라벨은 "전체 프로젝트:" 로 "현재 프로젝트:" (CurrentProjectBadge) 와 분리된다.
  assert.match(SRC, />\s*전체 프로젝트: \{gameState\.projects\.length\}\s*</,
    '시각 라벨이 "전체 프로젝트:" 접두어로 갱신되어야 한다');
  assert.match(SRC, /aria-label=\{`관리 중인 전체 프로젝트 \$\{gameState\.projects\.length\} 개`\}/);
  assert.match(SRC, /data-testid="header-metric-projects"/);
  // 이전 라벨(접두어 없이 "프로젝트: N")로 회귀하지 않도록 잠근다.
  assert.doesNotMatch(SRC, />\s*프로젝트: \{gameState\.projects\.length\}\s*</,
    '구 라벨 "프로젝트: {count}" 로 회귀 금지 — "현재 프로젝트:" 배지와 충돌한다');
});

test('커버리지 칩 — aria-label 이 고립 파일 건수를 함께 전달한다', () => {
  assert.match(SRC, /aria-label=\{`의존성 커버리지 \$\{workspaceInsights\.coveragePercent\} 퍼센트/);
  assert.match(SRC, /고립 파일 \$\{workspaceInsights\.isolatedFiles\.length\} 건/);
  assert.match(SRC, /data-testid="header-metric-coverage"/);
});

test('활성률 칩 — role="status" + aria-label + data-testid', () => {
  assert.match(SRC, /aria-label=\{`에이전트 활성률 \$\{agentActivity\.ratio\} 퍼센트`\}/);
  assert.match(SRC, /data-testid="header-metric-activity"/);
});

test('협업 칩 — role="status" + aria-label + data-testid', () => {
  assert.match(SRC, /aria-label=\{`협업 지표 \$\{collaborationBadge\}`\}/);
  assert.match(SRC, /data-testid="header-metric-collaboration"/);
});

test('6개 메트릭 칩 모두 role="status" 를 쓴다(zoom~collaboration)', () => {
  // 헤더 블록 안의 role="status" 개수를 세서 정확히 6개인지 확인한다.
  // `<header>` ~ `</header>` 사이만 잘라 카운트해야 다른 토큰 배지와 혼동하지 않는다.
  const headerMatch = SRC.match(/<header[\s\S]*?<\/header>/);
  assert.ok(headerMatch, 'header 블록을 찾지 못했다');
  const statusRoles = headerMatch![0].match(/role="status"/g) ?? [];
  assert.equal(statusRoles.length, 6, `헤더 role="status" 수는 6 이어야 한다(실제 ${statusRoles.length})`);
});
