// Run with: npx tsx --test tests/uatFinalAcceptance.regression.test.ts
//
// QA 회귀(지시 #80be5853) · 최종 수락 시나리오(UAT) — 공동 목표 체크리스트 기반.
//
// 본 파일은 UAT 5대 시나리오(§1~§5 in docs/qa-uat-final-acceptance-2026-04-19.md)
// 의 **결정적 합격 기준** 을 소스 레벨 계약으로 잠근다. 실제 "사용자가 눌렀을 때"
// 체험은 수동 브라우저 세션이 필요하므로 docs 의 Given/When/Then 표로 이관하고,
// 여기서는 "부품이 계약을 지키고 있는가" 만 자동 검증한다.
//
// 시나리오 지도
//   UAT-1  TokenUsageIndicator 배지·경고·리셋 타이머 (이미 별도 스위트로 잠금 → 교차 참조)
//   UAT-2  첨부 → Claude 콘텐츠 블록 변환 (Thanos 진행 중 · mock 계약 선 설계)
//   UAT-3  PDF/PPT/영상 출력 다운로드·미리보기 (MediaPipelinePanel + mediaExporters 경로)
//   UAT-4  토큰 만료·네트워크·레이트리밋 시 ErrorBoundary·Toast 조치 버튼
//   UAT-5  전체 UI 재스윕 — 잔존 블로커와 계약 레지스트리 동기화

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
const TOKEN_INDICATOR    = readSrc('components/TokenUsageIndicator.tsx');
const MEDIA_PIPELINE     = readSrc('components/MediaPipelinePanel.tsx');
const MEDIA_EXPORTERS    = readSrc('utils/mediaExporters.ts');
const MEDIA_LOADERS      = readSrc('utils/mediaLoaders.ts');
const ERROR_BOUNDARY     = readSrc('components/ErrorBoundary.tsx');
const ERROR_MESSAGES     = readSrc('utils/errorMessages.ts');

// ─── UAT-1 · TokenUsageIndicator ────────────────────────────────────────────
// (순수·E2E 잠금은 tests/tokenUsageIndicator.e2e.test.tsx · tests/performanceTokenIndicatorTimer.regression.test.tsx
//  · tests/accessibilityGlobalAudit.regression.test.ts 가 이미 담당. 여기서는 UAT 관점의
//  "상단바 배선" 만 교차 확인해 레지스트리 드리프트를 잠근다.)

test('UAT-1 · 상단바 메트릭 그룹 안에 TokenUsageIndicator 가 여전히 배치된다', () => {
  assert.match(APP_TSX, /<TokenUsageIndicator\s*\/>/);
  // 3단계 severity 구현이 유지된다(ok/caution/critical). 색·경계값은 별도 스위트에서 잠금.
  assert.match(TOKEN_INDICATOR, /data-severity=\{snapshot\.severity\}/);
  // 리셋 타이머 펄스 데이터 속성이 배지에 붙어 있어야 한다(§UAT-1 합격 기준).
  assert.match(TOKEN_INDICATOR, /data-just-reset/);
});

// ─── UAT-2 · 첨부 → Claude 콘텐츠 블록 변환 (진행 중, mock 계약) ───────────────

test('UAT-2 · MediaChatAttachment 타입이 summary·textExcerpt·page/slideIndices 축을 보존한다', () => {
  // Thanos 후속 PR 에서 `attachments` → Claude 콘텐츠 블록 변환이 붙을 때, 여기 네
  // 필드가 사라지면 리더가 "PDF 의 몇 페이지" 근거를 잃는다. 본 계약을 잠근다.
  assert.match(MEDIA_LOADERS, /export interface MediaChatAttachment/);
  assert.match(MEDIA_LOADERS, /summary:\s*string/);
  assert.match(MEDIA_LOADERS, /textExcerpt\?:\s*string/);
  assert.match(MEDIA_LOADERS, /pageIndices\?:\s*number\[\]/);
  assert.match(MEDIA_LOADERS, /slideIndices\?:\s*number\[\]/);
});

test('UAT-2 · toChatAttachment 변환 함수가 공개 API 로 유지된다', () => {
  assert.match(MEDIA_LOADERS, /export function toChatAttachment/);
  // App.tsx 가 동일 경로로 소비하는지 교차 확인.
  assert.match(APP_TSX, /MediaChatAttachment/);
  assert.match(APP_TSX, /mediaChatAttachments/);
});

test.skip('UAT-2 · (진행 중) attachments → Claude content blocks 변환 함수가 서버 요청 경로에 연결됨', () => {
  // Thanos 가 `buildClaudeContentBlocks(attachments)` 같은 공개 헬퍼를 만들면 여기
  // skip → test 로 전환. 현재는 App.tsx 가 `attachments` 를 서버 `directive.attachments`
  // 로만 보내고, Claude 메시지 content blocks 로 변환하는 명시적 헬퍼는 미구현.
  assert.match(APP_TSX, /buildClaudeContentBlocks|attachmentsToClaudeBlocks/);
});

// ─── UAT-3 · 출력 다운로드·미리보기 ────────────────────────────────────────

test('UAT-3 · MediaPipelinePanel 이 exportPdfReport·exportPptxDeck·exportVideo 3 경로를 모두 import 한다', () => {
  assert.match(MEDIA_PIPELINE, /exportPdfReport/);
  assert.match(MEDIA_PIPELINE, /exportPptxDeck/);
  assert.match(MEDIA_PIPELINE, /exportVideo/);
});

test('UAT-3 · prepareDownload 는 storageUrl 없어도 data: URL 폴백으로 anchor[download] 를 채운다', () => {
  // storageUrl 이 비어 있는 1차 스켈레톤에서도 사용자가 "다운로드" 버튼을 누르면
  // 무언가 내려가야 한다. 현재는 data:text/plain 폴백(§UAT-3 합격 기준 PASS).
  assert.match(MEDIA_EXPORTERS, /data:text\/plain;charset=utf-8/);
  assert.match(MEDIA_EXPORTERS, /anchor\[download\]/);
});

test('UAT-3 · safeDownloadName 이 kind 별 기본 확장자를 붙여 파일명이 잘리지 않는다', () => {
  assert.match(MEDIA_EXPORTERS, /pdf:\s*'pdf'/);
  assert.match(MEDIA_EXPORTERS, /pptx:\s*'pptx'/);
  assert.match(MEDIA_EXPORTERS, /video:\s*'mp4'/);
  assert.match(MEDIA_EXPORTERS, /image:\s*'png'/);
});

// ─── UAT-4 · ErrorBoundary·Toast 조치 버튼 ────────────────────────────────

test('UAT-4 · App.tsx 최상단이 <ErrorBoundary><ToastProvider> 순서로 감싸진다', () => {
  // 이 순서가 바뀌면 Toast 가 ErrorBoundary 복구 UI 에 도달하지 못한다.
  assert.match(APP_TSX, /<ErrorBoundary>[\s\S]{0,200}<ToastProvider>/);
});

test('UAT-4 · ErrorBoundary 는 복구 UI 에 "다시 시도" · "새로고침" 두 조치 버튼을 렌더한다', () => {
  assert.match(ERROR_BOUNDARY, /다시 시도/);
  assert.match(ERROR_BOUNDARY, /새로고침/);
  assert.match(ERROR_BOUNDARY, /role="alert"/);
  assert.match(ERROR_BOUNDARY, /aria-live="assertive"/);
});

test('UAT-4 · 에러 메시지 테이블에 세션 만료·업로드 실패·생성 실패 한국어 문구가 모두 정의되어 있다', () => {
  // 사용자가 가장 자주 마주치는 4가지 실패 경로의 문구 존재를 잠근다.
  assert.match(ERROR_MESSAGES, /세션 한도를 초과했습니다/);
  assert.match(ERROR_MESSAGES, /업로드에 실패했어요/);
  assert.match(ERROR_MESSAGES, /생성 요청을 처리하지 못했습니다/);
  assert.match(ERROR_MESSAGES, /변환 엔진이 준비되지 않았어요/);
  // 조치 버튼 action 필드가 retry-now / open-settings 두 종을 제공하는지.
  assert.match(ERROR_MESSAGES, /retry-now/);
  assert.match(ERROR_MESSAGES, /open-settings/);
});

// ─── UAT-5 · 전체 UI 재스윕 — 잔존 블로커 현황 ─────────────────────────────

test('UAT-5 · 1·2회차 잔존 블로커 3건(§1.1·§1.3·§2.2) 은 여전히 미수정(현 시점 스냅)', () => {
  // 본 레지스트리가 흔들리면 Kai 에게 "출시 차단이 갑자기 해제됐다" 같은 잘못된 신호가 간다.
  // 각 블로커 증상의 존재 여부로 현재 상태를 잠근다.
  assert.doesNotMatch(APP_TSX, /<MediaAttachmentPanel[\s>]/,
    '§1.1 이 고쳐지면 본 테스트를 업데이트해 "MediaAttachmentPanel 렌더됨" 으로 전환');
  assert.doesNotMatch(APP_TSX, /<CollabTimeline[\s\S]{0,400}mediaEvents=/,
    '§1.3 이 고쳐지면 본 테스트를 업데이트');
  assert.doesNotMatch(APP_TSX, /<DirectivePrompt[\s\S]{0,600}readOnlyMode=/,
    '§2.2 이 고쳐지면 본 테스트를 업데이트');
});

test('UAT-5 · pptLoader 는 어댑터 미등록 상태에서 MEDIA_UNSUPPORTED_FORMAT 로 수렴한다', () => {
  // 어댑터가 붙기 전까지 "PPTX 업로드가 조용히 실패" 하면 안 된다 — 명시적 에러 코드로
  // 토스트가 뜨도록 한 현재 계약을 잠근다.
  const pptLoader = readSrc('services/media/pptLoader.ts');
  assert.match(pptLoader, /MEDIA_UNSUPPORTED_FORMAT/);
  assert.match(pptLoader, /어댑터.*등록되지 않았습니다/);
});

// ─── META · UAT 문서 섹션 동기화 가드 ───────────────────────────────────────

test('META · UAT 문서 §1~§5 섹션 번호가 본 테스트와 동기화돼 있다', () => {
  const doc = readFileSync(
    resolve(__dirname, '..', 'docs', 'qa-uat-final-acceptance-2026-04-19.md'),
    'utf8',
  );
  for (const section of ['UAT-1', 'UAT-2', 'UAT-3', 'UAT-4', 'UAT-5']) {
    assert.ok(doc.includes(section), `문서에서 ${section} 섹션이 사라지면 본 테스트의 근거가 없어진다`);
  }
});
