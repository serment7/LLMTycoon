// Run with: npx tsx --test tests/accessibilityGlobalAudit.regression.test.ts
//
// QA 회귀(지시 #60cb075a) — 전역 접근성·크로스브라우저 감사 라운드.
//
// 본 저장소는 Chrome/Edge/Firefox 를 직접 기동하는 환경이 없고 axe-core·Lighthouse
// 가 devDependencies 에 포함돼 있지 않다. 실제 브라우저 스캔은 수동 체크리스트
// (`docs/qa-accessibility-crossbrowser-2026-04-19.md`) 로 이관하고, 본 파일은
// **정적 소스 감사로 잠글 수 있는 계약** 만 고정한다. 범위:
//   1) TokenUsageIndicator 의 스크린리더 라벨/키보드 포커스/역할 유지
//   2) MediaPipelinePanel 의 에러 alert · 섹션 라벨 · 헤딩 존재
//   3) MediaAttachmentPanel 의 파일 선택 버튼 → 숨은 input 접근 경로
//   4) ProjectEditingHeader 의 상태 분기 aria(미선택 시 aria-live=polite)
//   5) App.tsx 상단바 TokenUsageIndicator 배선(추가 회귀 가드)
//
// 이미 `tests/appHeaderMetricsA11y.regression.test.ts` 가 상단바 메트릭 6칩을
// 잠갔으므로 본 파일은 메트릭은 손대지 않는다.
//
// 잔존 결함(현재 미수정) 은 test.skip 으로 "정의된 완료 기준" 을 보존한다.
// 수정 PR 이 들어오면 skip → test 로 전환한 뒤 같은 PR 에 포함시키면 회귀 방지.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSrc(rel: string): string {
  return readFileSync(resolve(__dirname, '..', 'src', rel), 'utf8');
}

const TOKEN_INDICATOR    = readSrc('components/TokenUsageIndicator.tsx');
const MEDIA_PIPELINE     = readSrc('components/MediaPipelinePanel.tsx');
const MEDIA_ATTACH       = readSrc('components/MediaAttachmentPanel.tsx');
const EMPTY_PLACEHOLDER  = readSrc('components/EmptyProjectPlaceholder.tsx');
const APP_TSX            = readSrc('App.tsx');
const INDEX_CSS          = readSrc('index.css');

// ─── TokenUsageIndicator ───────────────────────────────────────────────────────

test('TI · 기본 배지에 role="status" + aria-live="polite" + aria-label + tabIndex=0 을 모두 유지한다', () => {
  // 4축 중 하나라도 빠지면 스크린리더 알림·키보드 포커스 어느 한 쪽이 죽는다.
  assert.match(TOKEN_INDICATOR, /role="status"/);
  assert.match(TOKEN_INDICATOR, /aria-live="polite"/);
  assert.match(TOKEN_INDICATOR, /aria-label=\{ariaLabel\}/,
    'aria-label 이 정적 문자열로 바뀌면 잔량·리셋 시각이 보조기술에 전달되지 않는다');
  assert.match(TOKEN_INDICATOR, /tabIndex=\{0\}/,
    'tabIndex=0 이 빠지면 키보드 사용자가 툴팁 정보에 도달할 수 없다');
});

test('TI · 폴백 배지(loadError) 도 role="status" + aria-label 를 유지한다', () => {
  // 속성 순서는 자유지만 "폴백 분기 내부에 aria-label 이 함께 존재" 가 보장되어야 한다.
  // data-fallback 와 aria-label 이 같은 JSX 요소(같은 여는 태그) 안에 함께 선언되어 있는지만 감사.
  assert.match(
    TOKEN_INDICATOR,
    /aria-label="토큰 정보 없음[^"]+"[\s\S]{0,400}data-fallback="true"/,
    '폴백 경로에서 aria-label 이 사라지면 "에러 배지" 가 무언의 실선으로만 남는다',
  );
});

test('TI · 장식용 아이콘·프로그레스 바는 aria-hidden 으로 이중 낭독을 막는다', () => {
  // 같은 정보(심각도) 를 아이콘이 한 번, 텍스트가 한 번 각각 읽히면 스크린리더 사용자가 중복 청취한다.
  assert.match(TOKEN_INDICATOR, /aria-hidden="true"/,
    '배지 내 장식 아이콘/막대가 aria-hidden 을 잃으면 청취 중복이 발생한다');
  assert.match(TOKEN_INDICATOR, /role="presentation"/,
    '40x3 얇은 바의 role="presentation" 이 사라지면 보조기술이 별도 요소로 오해한다');
});

// ─── MediaPipelinePanel ──────────────────────────────────────────────────────

test('MP · 에러 영역은 role="alert" 로 실시간 알림되어야 한다', () => {
  assert.match(MEDIA_PIPELINE, /role="alert"/,
    '에러 영역이 role="alert" 가 아니면 업로드 실패를 시각 외 사용자가 인지 불가');
});

test('MP · 미리보기 섹션 aria-label 과 리스트 시맨틱이 유지된다', () => {
  assert.match(MEDIA_PIPELINE, /aria-label="미디어 처리 결과 미리보기"/);
  assert.match(MEDIA_PIPELINE, /<ul\b/);
  assert.match(MEDIA_PIPELINE, /<li\b/);
});

// ─── MediaAttachmentPanel ────────────────────────────────────────────────────

test('MA · 파일 선택 버튼이 aria-describedby 로 섹션 제목과 묶여 있다', () => {
  assert.match(MEDIA_ATTACH, /aria-describedby="media-attachment-title"/,
    '버튼 단독 "파일 선택" 라벨은 맥락이 없어 aria-describedby 로 섹션 제목과 묶어야 한다');
  assert.match(MEDIA_ATTACH, /id="media-attachment-title"/);
});

test('MA · 숨은 file input 은 aria-hidden 이지만 visible 트리거 버튼이 키보드 접근 경로를 제공한다', () => {
  assert.match(MEDIA_ATTACH, /type="file"[\s\S]{0,200}aria-hidden="true"/,
    '디자이너가 input 을 커스텀 버튼으로 가릴 때 input 은 aria-hidden 이어야 중복 포커스가 안 생긴다');
  assert.match(MEDIA_ATTACH, /data-testid="media-attachment-choose"/,
    '트리거 버튼 testid 가 사라지면 "키보드 접근 경로 존재" 가 회귀 감사 불가');
});

test('MA · 빈 상태 안내가 role="status" 로 고지된다', () => {
  assert.match(MEDIA_ATTACH, /data-testid="media-attachment-empty"[\s\S]{0,120}role="status"/,
    '빈 상태 안내가 role="status" 가 아니면 보조기술이 "첨부 0건" 을 전달하지 못한다');
});

// ─── ProjectEditingHeader ────────────────────────────────────────────────────

test('PE · 선택/미선택 공통으로 aria-label="현재 편집 중인 프로젝트" 를 유지한다', () => {
  assert.match(EMPTY_PLACEHOLDER, /aria-label="현재 편집 중인 프로젝트"/);
});

test('PE · 미선택일 때만 role="status" + aria-live="polite" 로 상태 고지된다', () => {
  // 선택됐을 때 role="status" 를 계속 붙이면 프로젝트 이름이 바뀔 때마다 낭독이 반복된다.
  assert.match(EMPTY_PLACEHOLDER, /role=\{selected \? undefined : 'status'\}/);
  assert.match(EMPTY_PLACEHOLDER, /aria-live=\{selected \? undefined : 'polite'\}/);
});

test('PE · 미선택 CTA 버튼은 서술형 aria-label 을 가진다', () => {
  assert.match(EMPTY_PLACEHOLDER, /aria-label="프로젝트를 선택해 스코프를 고정합니다"/,
    '버튼 아이콘이 FolderOpen 뿐이라 aria-label 이 없으면 "프로젝트 선택" 만으로 맥락 부족');
});

// ─── App.tsx 상단바 TokenUsageIndicator 배선 ──────────────────────────────────

test('AP · App.tsx 상단바 메트릭 그룹에 <TokenUsageIndicator/> 가 그대로 배치된다', () => {
  assert.match(APP_TSX, /<TokenUsageIndicator\s*\/>/,
    '상단바에서 인스턴스화가 빠지면 잔량 배지 자체가 사라져 2회차 감사 결과가 역행한다');
});

// ─── 색상 대비 — CSS 토큰 값 하드 락 ──────────────────────────────────────────

test('CX · 배지 전경색 토큰이 밝은 대비 값을 유지한다(AA 4.5:1 관찰치 근거)', () => {
  // 어두운 배경(0x0b0b10 계열) 위 전경 밝기를 밝음 쪽으로 고정.
  // 토큰 값이 낮은 명도로 바뀌면 수동 대비 측정을 거치지 않고는 AA 가 보장되지 않는다.
  assert.match(INDEX_CSS, /--token-usage-caution-fg:\s*#fde68a/);
  assert.match(INDEX_CSS, /--token-usage-warning-fg:\s*#fecaca/);
  assert.match(INDEX_CSS, /--error-state-title-fg:\s*#fecaca/);
});

// ─── 잔존 결함(현재 미수정) — skip 으로 "정의된 완료 기준" 보존 ────────────────

test.skip('A11Y-DEF-1 · MediaPipelinePanel · busy 상태에 aria-busy 가 필요(업로드 중 보조기술 고지)', () => {
  // 수정 기준: 루트 div 또는 MediaAttachmentPanel 에 aria-busy={busy} 주입.
  assert.match(MEDIA_PIPELINE, /aria-busy=\{busy\}/,
    '업로드·생성이 수초+ 걸릴 때 보조기술이 "대기 중" 을 알리지 못한다');
});

test.skip('A11Y-DEF-2 · MediaPipelinePanel · 미리보기 헤딩이 h3 로 승격되어야 한다(문서 outline 건너뜀 금지)', () => {
  // 현재 <h4> 단독. 부모 패널에 h3 가 없어 outline 이 skip 된다.
  assert.doesNotMatch(MEDIA_PIPELINE, /<h4\b/);
  assert.match(MEDIA_PIPELINE, /<h3\b/);
});

test.skip('A11Y-DEF-3 · TokenUsageIndicator · 툴팁이 aria-describedby 로 배지와 연결되어야 한다', () => {
  // 수정 기준: 배지 wrapper 에 aria-describedby={tooltipId}, 툴팁 div 에 id={tooltipId}.
  assert.match(TOKEN_INDICATOR, /aria-describedby=\{tooltipId\}/);
  assert.match(TOKEN_INDICATOR, /id=\{tooltipId\}/);
});

// ─── 감사 메타 ──────────────────────────────────────────────────────────────

test('META · 본 스위트가 참조하는 보고서·선행 회귀가 함께 존재한다(싱크 가드)', () => {
  // 보고서 파일 자체가 사라지면 정적 감사의 근거가 끊기므로 동기화 가드.
  const report = readFileSync(
    resolve(__dirname, '..', 'docs', 'qa-accessibility-crossbrowser-2026-04-19.md'),
    'utf8',
  );
  assert.ok(report.length > 0);
  assert.match(report, /A11Y-DEF-1/);
  assert.match(report, /A11Y-DEF-2/);
  assert.match(report, /A11Y-DEF-3/);
});
