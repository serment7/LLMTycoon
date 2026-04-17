// Run with: tsx --test src/utils/codeGraphFilter.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  EXCLUDED_PATHS,
  GIT_STAGE_EXCLUDED_PATHS,
  inferFileType,
  isExcludedFromCodeGraph,
  isExcludedFromGitStaging,
} from './codeGraphFilter.ts';

test('docs/ prefix is excluded by default', () => {
  assert.ok(EXCLUDED_PATHS.includes('docs/'));
});

test('docs subpaths are filtered out', () => {
  assert.equal(isExcludedFromCodeGraph('docs/team-charter.md'), true);
  assert.equal(isExcludedFromCodeGraph('docs/handoffs/a.md'), true);
  assert.equal(isExcludedFromCodeGraph('./docs/x.md'), true);
  assert.equal(isExcludedFromCodeGraph('docs\\nested\\y.md'), true);
  assert.equal(isExcludedFromCodeGraph('docs'), true);
});

test('non-docs paths pass through', () => {
  assert.equal(isExcludedFromCodeGraph('src/App.tsx'), false);
  assert.equal(isExcludedFromCodeGraph('documentation/readme.md'), false);
  assert.equal(isExcludedFromCodeGraph('LoginForm.tsx'), false);
});

test('docs/test.md fixture is rejected by the filter', () => {
  assert.equal(isExcludedFromCodeGraph('docs/test.md'), true);
  assert.equal(isExcludedFromCodeGraph('./docs/test.md'), true);
  assert.equal(isExcludedFromCodeGraph('docs\\test.md'), true);
});

test('docs/ nested directories (handoffs, reports, inbox, design) are all excluded', () => {
  assert.equal(isExcludedFromCodeGraph('docs/handoffs/2026-04-17-foo.md'), true);
  assert.equal(isExcludedFromCodeGraph('docs/reports/nested/deeper/bar.md'), true);
  assert.equal(isExcludedFromCodeGraph('docs/inbox/2026-04-17-user-directives.md'), true);
  assert.equal(isExcludedFromCodeGraph('docs/design/spec.md'), true);
});

test('substring-not-prefix: DocsPanel / docsite / document must NOT be filtered', () => {
  // Regression guard: the filter anchors on "docs/" as a path segment, not
  // a bare substring. If this ever flips, every component whose name starts
  // with "docs" gets silently dropped from the graph.
  assert.equal(isExcludedFromCodeGraph('DocsPanel.tsx'), false);
  assert.equal(isExcludedFromCodeGraph('docsite/index.ts'), false);
  assert.equal(isExcludedFromCodeGraph('document.ts'), false);
});

test('regression: src/ files are included in the code graph', () => {
  assert.equal(isExcludedFromCodeGraph('src/App.tsx'), false);
  assert.equal(isExcludedFromCodeGraph('src/utils/codeGraphFilter.ts'), false);
  assert.equal(isExcludedFromCodeGraph('src/components/LoginForm.tsx'), false);
  assert.equal(isExcludedFromCodeGraph('App.tsx'), false);
  assert.equal(isExcludedFromCodeGraph('milestone-watcher.ts'), false);
});

test('regression: scripts/ and top-level source files are included', () => {
  assert.equal(isExcludedFromCodeGraph('scripts/milestone-watcher.ts'), false);
  assert.equal(isExcludedFromCodeGraph('scripts/milestone-automation.ts'), false);
  assert.equal(isExcludedFromCodeGraph('server.ts'), false);
  assert.equal(isExcludedFromCodeGraph('mcp-agent-server.ts'), false);
});

test('EXCLUDED_PATHS stays in the documented .gitignore-style shape', () => {
  // Contract: every entry ends with "/" so directory semantics are
  // unambiguous. The filter tolerates a bare entry, but the constant is
  // the human-facing spec.
  for (const prefix of EXCLUDED_PATHS) {
    assert.ok(
      prefix.endsWith('/'),
      `EXCLUDED_PATHS entry "${prefix}" must end with "/"`,
    );
  }
});

test('end-to-end: docs/test.md fixture exists on disk and is filtered', () => {
  // Confirms the filter agrees with reality — the fixture is on disk, and
  // the filter rejects the POSIX-style relative path a client would send.
  const fixture = path.resolve(process.cwd(), 'docs', 'test.md');
  const body = readFileSync(fixture, 'utf8');
  assert.ok(body.length > 0, 'docs/test.md fixture must be non-empty');
  assert.equal(isExcludedFromCodeGraph('docs/test.md'), true);
});

test('pruning a mixed listing removes docs entries and keeps src/scripts entries', () => {
  // Simulates "기존 코드그래프에 docs 파일이 있었다면 제거되는지": feed a
  // mixed list through the filter and assert the survivors/prune set.
  const existing = [
    { id: '1', name: 'App.tsx' },
    { id: '2', name: 'docs/team-charter.md' },
    { id: '3', name: 'src/utils/codeGraphFilter.ts' },
    { id: '4', name: 'docs/handoffs/2026-04-17-foo.md' },
    { id: '5', name: 'scripts/milestone-watcher.ts' },
    { id: '6', name: 'docs/test.md' },
  ];
  const survivors = existing.filter((f) => !isExcludedFromCodeGraph(f.name));
  assert.deepEqual(
    survivors.map((f) => f.id),
    ['1', '3', '5'],
  );
  const pruned = existing.filter((f) => isExcludedFromCodeGraph(f.name));
  assert.equal(pruned.length, 3);
  assert.ok(pruned.every((f) => f.name.startsWith('docs/')));
});

// ─── 에이전트 HUD 가시성 · 고밀도 그래프 회귀 ─────────────────────────────
//
// 배경: 캔버스에 코드 파일 노드가 빽빽해지면, 에이전트 스프라이트 위에 상시
// 떠 있는 AgentContextBubble과 말풍선이 가려질 위험이 커진다. 이 회귀는
// AgentStatusPanel.test.ts가 z-index · DOM 순서 축에서 막고 있고, 여기서는
// "그래프에 어떤 파일이 나타나는가"를 결정하는 필터 쪽에서 상보적으로 막는다.
// 즉, HUD 렌더를 구성하는 소스 파일 자체가 필터에 잘못 걸려 노드에서 사라져
// 결과적으로 HUD가 "보이지 않는" 이슈가 재발하지 않도록 고정한다.

// AgentContextBubble/AgentStatusPanel/App(스프라이트 렌더러)는 에이전트 노드
// 가시성의 단일 근원. 이 목록은 AgentStatusPanel.test.ts의 z-index 앵커가
// 가리키는 소스와 정확히 일치해야 한다.
const AGENT_HUD_FILES: readonly string[] = [
  'src/components/AgentContextBubble.tsx',
  'src/components/AgentStatusPanel.tsx',
  'src/App.tsx',
];

test('에이전트 HUD 소스 파일은 어떤 경로 변형으로도 그래프에서 제외되지 않는다', () => {
  // 필터가 잘못 진화해 이 파일들이 사라지면, 캔버스에서 에이전트/컨텍스트 버블
  // 노드 자체가 그래프에 등록되지 않아 z-index 불변식이 무의미해진다.
  for (const path of AGENT_HUD_FILES) {
    assert.equal(
      isExcludedFromCodeGraph(path),
      false,
      `HUD 소스 ${path}는 그래프에 포함되어야 한다`,
    );
    assert.equal(
      isExcludedFromCodeGraph(`./${path}`),
      false,
      `상대경로 prefix에도 흔들리면 안 된다: ${path}`,
    );
    assert.equal(
      isExcludedFromCodeGraph(path.replace(/\//g, '\\')),
      false,
      `윈도우 경로 구분자에도 흔들리면 안 된다: ${path}`,
    );
  }
});

test('회귀: 300개짜리 밀집 리스팅에서도 HUD 파일 3종은 모두 생존', () => {
  // 운영 중 워크스페이스가 수백 파일로 커져도 HUD 소스가 묻혀 사라지지
  // 않는지 검증. docs/ 계열 노이즈를 대거 섞어 필터 압력을 최대로 높인다.
  const docsNoise = Array.from({ length: 250 }, (_, i) => ({
    id: `doc-${i}`,
    name: `docs/nested/deep/path-${i}.md`,
  }));
  const srcNoise = Array.from({ length: 47 }, (_, i) => ({
    id: `src-${i}`,
    // 의도적으로 "docs"로 시작하는 컴포넌트명을 섞어, prefix가 아닌 segment
    // 매칭이 유지되는지도 동시에 회귀 방어한다.
    name: i % 5 === 0 ? `DocsPanel${i}.tsx` : `src/components/Noise${i}.tsx`,
  }));
  const hudFiles = AGENT_HUD_FILES.map((name, i) => ({
    id: `hud-${i}`,
    name,
  }));

  const listing = [...docsNoise, ...hudFiles, ...srcNoise];
  const survivors = listing.filter((f) => !isExcludedFromCodeGraph(f.name));
  const survivorNames = new Set(survivors.map((f) => f.name));

  // HUD 파일 3종은 밀도와 무관하게 100% 생존해야 한다.
  for (const path of AGENT_HUD_FILES) {
    assert.ok(
      survivorNames.has(path),
      `${path}가 밀집 그래프에서도 그래프에 남아야 한다`,
    );
  }
  // docs 노이즈는 전부 제거. HUD·src 노이즈는 그대로.
  assert.equal(survivors.length, hudFiles.length + srcNoise.length);
  assert.ok(
    survivors.every((f) => !f.name.startsWith('docs/')),
    'docs/ 접두 파일은 모두 제거되어야 한다',
  );
});

test('회귀: HUD 파일명을 닮은 "docs" 변종이 필터를 우회해 HUD를 가리지 않는다', () => {
  // 과거 사고 시나리오 재현: 누군가 "docs-AgentContextBubble.tsx" 같은 이름의
  // 노이즈 파일을 만든 상황. 이게 필터에서 실수로 "docs/"로 해석되면 HUD 파일이
  // 같이 탈락하거나, 반대로 변종이 생존해 HUD 위에 겹쳐 가리게 된다.
  // 필터는 segment 경계 기반이므로 변종은 살아남아야 하고(= 거짓 삭제 없음),
  // HUD 진짜 파일도 함께 살아남아야 한다.
  assert.equal(isExcludedFromCodeGraph('docs-AgentContextBubble.tsx'), false);
  assert.equal(isExcludedFromCodeGraph('docsAgentStatusPanel.tsx'), false);
  for (const hud of AGENT_HUD_FILES) {
    assert.equal(isExcludedFromCodeGraph(hud), false);
  }
});

// ─── 프로젝트 설정 HUD 가시성 (디자이너 보호선) ─────────────────────────────
//
// ProjectManagement.tsx는 "현재 선택된 프로젝트명"을 설정 패널 상단 배지로
// 표시하고, 전역 설정과 프로젝트별 설정을 시각적으로 구분하는 단일 근원이다.
// 이 컴포넌트가 코드그래프 필터에 잘못 걸려 사라지면 설정 패널의 컨텍스트
// 라벨이 통째로 유실되어, 사용자는 자신이 어느 프로젝트의 설정을 편집 중인지
// 분간할 수 없다 — 전역/프로젝트별 설정이 서로 덮어써지는 은밀한 회귀를 낳는다.
const PROJECT_CONFIG_HUD_FILES: readonly string[] = [
  'src/components/ProjectManagement.tsx',
];

test('프로젝트 설정 HUD(ProjectManagement.tsx)는 어떤 경로 변형으로도 그래프에서 탈락하지 않는다', () => {
  for (const path of PROJECT_CONFIG_HUD_FILES) {
    assert.equal(isExcludedFromCodeGraph(path), false, `${path}는 그래프에 포함되어야 한다`);
    assert.equal(isExcludedFromCodeGraph(`./${path}`), false, `상대경로에도 흔들리면 안 된다: ${path}`);
    assert.equal(
      isExcludedFromCodeGraph(path.replace(/\//g, '\\')),
      false,
      `윈도우 구분자에도 흔들리면 안 된다: ${path}`,
    );
  }
});

test('회귀: 프로젝트 설정 배지를 흉내 낸 "docs" 변종 파일은 HUD를 잠식하지 못한다', () => {
  // "docs-ProjectManagement.tsx" 같은 변종이 생겨도 진짜 HUD가 함께 탈락하거나
  // 필터가 변종을 잘못 먹어버려 설정 패널 상단 프로젝트 배지가 사라지는 일이
  // 없어야 한다. segment 경계 기반 필터의 계약을 프로젝트 설정 축에서도 고정.
  assert.equal(isExcludedFromCodeGraph('docs-ProjectManagement.tsx'), false);
  assert.equal(isExcludedFromCodeGraph('docsProjectManagement.tsx'), false);
  for (const hud of PROJECT_CONFIG_HUD_FILES) {
    assert.equal(isExcludedFromCodeGraph(hud), false);
  }
});

// ─── 첫-1초 스냅샷 · 파일 호버 오버레이 가시성 (디자이너 보호선) ──────────────
//
// AgentStatusSnapshot.tsx 는 사용자가 돌아왔을 때 "지금 팀 상태"를 1초 내에
// 읽게 해주는 상단 고정 스냅샷 패널이고, FileTooltip.tsx 는 파일 노드 hover
// 시 뜨는 오버레이다. 둘 다 렌더되려면 코드그래프에 해당 소스 노드가 살아
// 있어야 하고, 필터에서 잘못 탈락하면 디자인 계약(at-a-glance readability,
// hover affordance)이 통째로 깨진다. AGENT_HUD_FILES 와 동일한 3축 (정규,
// ./ prefix, 윈도우 구분자) 변형으로 고정한다.
const VISUAL_OVERLAY_HUD_FILES: readonly string[] = [
  'src/components/AgentStatusSnapshot.tsx',
  'src/components/FileTooltip.tsx',
];

test('스냅샷·툴팁 오버레이 소스는 어떤 경로 변형으로도 그래프에서 탈락하지 않는다', () => {
  for (const path of VISUAL_OVERLAY_HUD_FILES) {
    assert.equal(isExcludedFromCodeGraph(path), false, `${path}는 그래프에 포함되어야 한다`);
    assert.equal(
      isExcludedFromCodeGraph(`./${path}`),
      false,
      `상대경로에도 흔들리면 안 된다: ${path}`,
    );
    assert.equal(
      isExcludedFromCodeGraph(path.replace(/\//g, '\\')),
      false,
      `윈도우 구분자에도 흔들리면 안 된다: ${path}`,
    );
  }
});

// ─── 타입 추론: 신규 파일의 시각 분류 일관성 ────────────────────────────────
//
// 배경: add_file 경로는 type 이 비면 일괄적으로 'util' 로 저장해왔다. 그러면
// 캔버스의 색·글리프·말풍선이 전부 '유틸' 룩으로 고정되어, 실제로는 컴포넌트나
// 스타일 파일인데도 시각적으로 구분되지 않는 회귀가 생긴다. 아래는 디자이너가
// 기대하는 분류 규칙을 테스트로 고정해, 향후 이름 규약이 바뀌어도 시각 계약이
// 깨지지 않도록 방어한다.

test('inferFileType: 스타일 확장자는 style 로 분류된다', () => {
  assert.equal(inferFileType('src/index.css'), 'style');
  assert.equal(inferFileType('theme.scss'), 'style');
  assert.equal(inferFileType('src/components/Button.module.css'), 'style');
});

test('inferFileType: 서비스성 이름/경로는 service 로 분류된다', () => {
  assert.equal(inferFileType('server.ts'), 'service');
  assert.equal(inferFileType('src/api/users.ts'), 'service');
  assert.equal(inferFileType('src/auth/authService.ts'), 'service');
  assert.equal(inferFileType('src/auth/providers/mongoProvider.ts'), 'service');
  assert.equal(inferFileType('mcp-agent-server.ts'), 'service');
});

test('inferFileType: 리액트 컴포넌트 확장자는 component 로 분류된다', () => {
  assert.equal(inferFileType('src/App.tsx'), 'component');
  assert.equal(inferFileType('src/components/LoginForm.tsx'), 'component');
  assert.equal(inferFileType('Widget.jsx'), 'component');
});

test('inferFileType: 애매하면 util 로 폴백한다', () => {
  assert.equal(inferFileType('src/utils/codeGraphFilter.ts'), 'util');
  assert.equal(inferFileType('src/types.ts'), 'util');
  assert.equal(inferFileType('scripts/milestone-watcher.ts'), 'util');
  assert.equal(inferFileType('README.md'), 'util');
});

// ─── Git 스테이징 제외 계약 ─────────────────────────────────────────────────
//
// GIT_STAGE_EXCLUDED_PATHS 는 .gitignore 의 빌드/샌드박스 산출물과 1:1 로
// 맞춰둔 2차 방어선이다. 누군가 .gitignore 에 항목을 추가하면서 이 목록을
// 깜빡하면, 외부에서 주입된 스테이징 입력(예: simple-git 배열 인자)으로
// 산출물이 그대로 커밋에 섞여 들어갈 수 있다. 아래 테스트는 목록의 현재
// 모양을 고정하고, 새로 들어온 build/·coverage/ 이 실제로 걸러지는지를
// 명시적으로 확인한다.

test('GIT_STAGE_EXCLUDED_PATHS: 빌드 산출물/샌드박스 접두사가 모두 포함된다', () => {
  // .gitignore 의 산출물 항목과 이 목록이 어긋나지 않는지 스냅샷으로 고정.
  for (const prefix of ['.git/', 'node_modules/', 'dist/', 'build/', 'coverage/', 'workspaces/']) {
    assert.ok(
      GIT_STAGE_EXCLUDED_PATHS.includes(prefix),
      `${prefix} 가 GIT_STAGE_EXCLUDED_PATHS 에 없으면 산출물이 커밋에 샐 수 있다`,
    );
  }
  for (const prefix of GIT_STAGE_EXCLUDED_PATHS) {
    assert.ok(prefix.endsWith('/'), `${prefix} 는 디렉터리 의미가 명확하도록 "/" 로 끝나야 한다`);
  }
});

test('isExcludedFromGitStaging: build/ · coverage/ 산출물은 스테이징에서 제외된다', () => {
  // 회귀 방어: .gitignore 에 있지만 필터에는 없던 두 디렉터리가 실제로 걸러지는지.
  assert.equal(isExcludedFromGitStaging('build/index.html'), true);
  assert.equal(isExcludedFromGitStaging('build'), true);
  assert.equal(isExcludedFromGitStaging('coverage/lcov.info'), true);
  assert.equal(isExcludedFromGitStaging('coverage/tmp/report.json'), true);
  // 경로 구분자·상대 prefix 변형에도 동일 계약이 유지되어야 한다.
  assert.equal(isExcludedFromGitStaging('./build/bundle.js'), true);
  assert.equal(isExcludedFromGitStaging('coverage\\summary.txt'), true);
});

test('isExcludedFromGitStaging: 이름만 닮은 "build"/"coverage" 파일은 통과시킨다', () => {
  // segment 경계 기반 필터가 substring 매칭으로 잘못 진화하면, 합법 소스가 조용히
  // 커밋에서 사라지는 정반대 사고가 난다. 여기서는 그 방향의 회귀도 함께 막는다.
  assert.equal(isExcludedFromGitStaging('src/utils/buildHelpers.ts'), false);
  assert.equal(isExcludedFromGitStaging('coverageReport.tsx'), false);
  assert.equal(isExcludedFromGitStaging('src/App.tsx'), false);
});

test('inferFileType: 윈도우 구분자와 앞선 ./ 에도 흔들리지 않는다', () => {
  assert.equal(inferFileType('./src/App.tsx'), 'component');
  assert.equal(inferFileType('src\\index.css'), 'style');
  assert.equal(inferFileType('.\\src\\api\\users.ts'), 'service');
});

test('inferFileType: service 규칙이 component 보다 우선한다 (AuthProvider.tsx 등)', () => {
  // React 컴포넌트 확장자(.tsx)지만 Provider/Service/Client 로 끝나는 파일은
  // 시각적으로 "서비스 노드"로 보여야 한다. 디자이너가 기대하는 우선순위를 고정.
  assert.equal(inferFileType('src/auth/AuthProvider.tsx'), 'service');
  assert.equal(inferFileType('src/data/UserRepository.ts'), 'service');
  assert.equal(inferFileType('src/api/HttpClient.ts'), 'service');
});

test('회귀: 필터는 입력 리스팅의 순서를 보존해 DOM 렌더 순서 불변식을 깨지 않는다', () => {
  // App.tsx의 "파일 노드 → 에이전트 스프라이트" 렌더 순서는
  // AgentStatusPanel.test.ts의 동률-z 회귀에서 핵심 방어선이다.
  // 필터가 리스팅을 재정렬하면 같은 z에서 파일이 스프라이트를 덮을 수 있다.
  const input = [
    { id: 'file-a', name: 'src/components/Alpha.tsx' },
    { id: 'doc-1', name: 'docs/noise.md' },
    { id: 'file-b', name: 'src/components/AgentContextBubble.tsx' },
    { id: 'doc-2', name: 'docs/inbox/x.md' },
    { id: 'file-c', name: 'src/components/AgentStatusPanel.tsx' },
    { id: 'file-d', name: 'src/App.tsx' },
  ];
  const survivors = input.filter((f) => !isExcludedFromCodeGraph(f.name));
  // 입력 배열에서 docs 항목만 빠지고 나머지 상대 순서는 그대로여야 한다.
  assert.deepEqual(
    survivors.map((f) => f.id),
    ['file-a', 'file-b', 'file-c', 'file-d'],
  );
});
