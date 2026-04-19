// Run with: npx tsx --test tests/uiSmokeReportBlockerContracts.regression.test.ts
//
// QA 회귀 — `tests/qa/ui-smoke-report.md` (2026-04-19) 가 식별한 3건 차단(§1.1·1.2·1.3)
// 과 §2.1·§2.2·§2.4 중대 결함을 "소스 레벨 계약" 으로 잠근다.
//
// 접근법:
//   1) **BASE 섹션(통과)** — 버그의 재료(타입, prop, 컴포넌트) 가 아직 의도대로 정의돼
//      있음을 잠근다. 수정자가 실수로 DirectivePrompt.readOnlyMode prop 을 지우거나
//      MediaAttachmentPanel 파일을 삭제하지 못하도록 회귀 가드를 둔다.
//   2) **CONTRACT 섹션(현재 skip)** — "수정 후" App.tsx 에 들어가야 하는 와이어링
//      정규식을 test.skip 으로 선언한다. Thanos(또는 후속 개발자) 가 blocker 를 고친
//      뒤 각 test.skip 을 test 로 전환하면 그 즉시 회귀 잠금이 발효된다. CI 를 깨지
//      않으면서 "정의된 완료 기준" 을 코드로 보존하는 것이 목적.
//
// 소스 전체 렌더가 아닌 정규식 감사로 잠그는 이유: App.tsx 가 2800+ 줄이라 jsdom
// 부팅 비용이 과하고, 본 계약은 정적 와이어링(소켓 등록·prop 전달) 이라 정규식으로
// 충분히 결정적이다. 동적 동작은 `tests/tokenExhaustedFallback.regression.test.tsx`
// 와 `tests/collabTimelineMedia.regression.test.tsx` 가 이미 컴포넌트 단위로 잠갔다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSrc(rel: string): string {
  return readFileSync(resolve(__dirname, '..', 'src', rel), 'utf8');
}

const APP_TSX            = readSrc('App.tsx');
const DIRECTIVE_PROMPT   = readSrc('components/DirectivePrompt.tsx');
const SHARED_GOAL_FORM   = readSrc('components/SharedGoalForm.tsx');
const MEDIA_PANEL        = readSrc('components/MediaAttachmentPanel.tsx');
const COLLAB_TIMELINE    = readSrc('components/CollabTimeline.tsx');
const PROJECT_MGMT       = readSrc('components/ProjectManagement.tsx');
const CLAUDE_STORE       = readSrc('utils/claudeTokenUsageStore.ts');

// ─── BASE · 빌딩블록이 여전히 존재함을 잠근다 ────────────────────────────────────

test('BASE · MediaAttachmentPanel 컴포넌트 정의와 기본 MIME accept 리스트가 유지된다', () => {
  assert.match(MEDIA_PANEL, /export function MediaAttachmentPanel/,
    'UI 진입점이 사라지면 §1.1 블로커 복구 경로 자체가 없어진다');
  // 정의된 accept 리스트 — Thanos 가 실수로 축소하지 못하도록 감시.
  assert.match(MEDIA_PANEL, /pdf/i);
  assert.match(MEDIA_PANEL, /pptx?/i);
  assert.match(MEDIA_PANEL, /video\//i);
  assert.match(MEDIA_PANEL, /image\//i);
});

test('BASE · DirectivePrompt 는 readOnlyMode prop 을 선언·소비한다', () => {
  // 타입·사용부 양쪽이 살아 있어야 부모가 prop 을 내릴 수 있다.
  assert.match(DIRECTIVE_PROMPT, /readOnlyMode\?:\s*boolean/);
  assert.match(DIRECTIVE_PROMPT, /readOnlyMode/);
});

test('BASE · SharedGoalForm 도 readOnlyMode prop 을 선언한다', () => {
  assert.match(SHARED_GOAL_FORM, /readOnlyMode\?:\s*boolean/);
});

test('BASE · CollabTimeline 은 mediaEvents prop 을 선언하고 MediaTimelineEvent 를 소비한다', () => {
  assert.match(COLLAB_TIMELINE, /mediaEvents\?:\s*ReadonlyArray<MediaTimelineEvent>/,
    '§1.3 fix 를 위한 소비자 쪽 prop 이 제거되면 와이어링 자체가 불가능해진다');
});

test('BASE · claudeTokenUsageStore 가 setSessionStatus 공개 API 를 유지한다', () => {
  assert.match(CLAUDE_STORE, /setSessionStatus/,
    '§1.2 fix 는 App.tsx 소켓 핸들러 → setSessionStatus 호출 경로를 쓴다');
});

// ─── BASE · 현재 와이어링 상태를 가시화(정적 사실만 잠근다) ───────────────────────

test('BASE · App.tsx 는 `claude-usage:updated` / `claude-usage:reset` 소켓 2종을 유지한다', () => {
  assert.match(APP_TSX, /newSocket\.on\('claude-usage:updated'/);
  assert.match(APP_TSX, /newSocket\.on\('claude-usage:reset'/);
});

// ─── CONTRACT · 블로커 수정 후 활성화할 정규식 (현재 skip) ──────────────────────

test.skip('CONTRACT §1.1 · App.tsx 또는 DirectivePrompt 가 <MediaAttachmentPanel/> 을 렌더해야 한다', () => {
  // 허용 경로: 둘 중 한 곳에서 렌더되면 된다(설계 자유도 보존).
  const appRenders = /<MediaAttachmentPanel[\s>]/.test(APP_TSX);
  const promptRenders = /<MediaAttachmentPanel[\s>]/.test(DIRECTIVE_PROMPT);
  assert.ok(appRenders || promptRenders,
    '§1.1 — PDF/PPT/비디오 업로드 UI 진입점이 화면 어디에도 인스턴스화되지 않음');
});

test.skip('CONTRACT §1.2 · App.tsx 가 `claude-session:status` 소켓을 구독해야 한다', () => {
  assert.match(
    APP_TSX,
    /newSocket\.on\(['"]claude-session:status['"][\s\S]{0,200}setSessionStatus/,
    '§1.2 — 서버가 소진 방송을 해도 스토어 sessionStatus 가 갱신되지 않아 배너가 뜨지 않는다'
  );
});

test.skip('CONTRACT §1.3 · <CollabTimeline/> 에 mediaEvents prop 이 전달되어야 한다', () => {
  assert.match(APP_TSX, /<CollabTimeline[\s\S]{0,400}mediaEvents=/,
    '§1.3 — mediaEvents 를 prop 으로 넘기지 않으면 서버가 emit 해도 타임라인이 비어 있다');
});

test.skip('CONTRACT §2.1 · claude-usage:reset 핸들러가 sessionStatus 를 "active" 로 복원해야 한다', () => {
  // hydrate 는 누적을 0 으로만 리셋하고 sessionStatus 는 건드리지 않으므로,
  // reset 이벤트 핸들러가 명시적으로 setSessionStatus('active') 를 호출해야 한다.
  assert.match(
    APP_TSX,
    /newSocket\.on\(['"]claude-usage:reset['"][\s\S]{0,300}setSessionStatus\(\s*['"]active['"]\s*\)/,
    '§2.1 — 서버 재기동 후에도 "읽기 전용" 배너가 남아 UI 가 영구 잠김 상태로 보임'
  );
});

test.skip('CONTRACT §2.2 · App.tsx 가 DirectivePrompt/SharedGoalForm 에 readOnlyMode prop 을 전달해야 한다', () => {
  assert.match(APP_TSX, /<DirectivePrompt[\s\S]{0,600}readOnlyMode=/,
    '§2.2 DirectivePrompt — readOnlyMode 가 누락되면 소진 상태에서도 전송 버튼이 활성');
  assert.match(APP_TSX, /<SharedGoalForm[\s\S]{0,600}readOnlyMode=/,
    '§2.2 SharedGoalForm — readOnlyMode 가 누락되면 소진 상태에서도 저장 버튼이 활성');
});

test.skip('CONTRACT §2.4 · ProjectManagement "PR 대상 선택" 버튼이 managed 가 비어 있을 때 disabled 로 닫혀야 한다', () => {
  // 현재: `onClick={() => setShowPrTargetSelector(true)}` 만 있고 disabled 없음.
  // 수정 후: `disabled={managed.length === 0}` (혹은 `prTargetEligible.length === 0`) 이 붙어야 함.
  assert.match(
    PROJECT_MGMT,
    /setShowPrTargetSelector\(true\)[\s\S]{0,400}disabled=\{[\s\S]{0,60}(managed|prTargetEligible)[\s\S]{0,60}\.length\s*===\s*0/,
    '§2.4 — 연동 0건 상태에서 빈 모달이 뜨는 UX 저해'
  );
});

// ─── 감사 메타(자기 방어) ─────────────────────────────────────────────────────────

test('META · 본 파일이 잠근 블로커 섹션 번호가 ui-smoke-report.md 와 동기화돼 있다', () => {
  const report = readFileSync(resolve(__dirname, 'qa/ui-smoke-report.md'), 'utf8');
  for (const section of ['### 1.1', '### 1.2', '### 1.3', '### 2.1', '### 2.2', '### 2.4']) {
    assert.ok(
      report.includes(section),
      `스모크 보고서에서 ${section} 섹션이 사라지면 본 테스트의 근거가 없어진다 — 보고서·테스트 중 하나만 수정하지 말 것`
    );
  }
});
