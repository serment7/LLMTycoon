// Run with: npx tsx --test tests/mediaGenerationCardAndDraftBadge.regression.test.ts
//
// 지시 #97bdee2b · multimedia-ui-spec.md §5 + §8.1 회귀 가드.
//
// 본 파일은 Designer 시안이 요구하는 2개 신규 컴포넌트의 **정적 계약** 만 잠근다.
// (실제 인터랙션·타이머 모션은 디자이너/QA 의 수동 체크리스트 §10 가 다룬다.)
//
// MediaGenerationCard (§5)
//   1. 3종 kind 프리셋(video/pdf/pptx) 의 제목·부제·아이콘이 프리셋 테이블에 묶여 있다.
//   2. status 3상태(ready/generating/failed) 의 CTA 라벨이 스펙대로 매핑돼 있다.
//   3. aria-labelledby/aria-describedby + aria-busy 가 generating 시에만 붙는다.
//   4. failed 시 에러 카피가 role="alert" 로 분리 노출된다.
//
// MediaDraftRestoreBadge (§8.1)
//   1. 루트가 role="status" · aria-live="polite" 로 한 번만 발화한다(M-07).
//   2. 3초 페이드 기본값(3000ms) 이 유지되고, prefers-reduced-motion 이면 전이 없이 즉시 소거.
//   3. "전송" 버튼은 별개 CTA 로 분리돼 자동 전송 금지(M-07) 가 구조적으로 보장된다.
//   4. 호버/포커스 시 타이머 일시정지 핸들러가 선언돼 있다.
//
// 추가로 index.css 토큰 묶음(§9) 도 본 파일이 함께 잠근다. 디자이너가 값을 조정하는
// 것은 자유지만 "선언 자체가 없어지는 것" 은 회귀로 간주한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readRepo(rel: string): string {
  return readFileSync(resolve(__dirname, '..', rel), 'utf8');
}

const CARD_SRC = readRepo('src/components/MediaGenerationCard.tsx');
const BADGE_SRC = readRepo('src/components/MediaDraftRestoreBadge.tsx');
const CSS_SRC = readRepo('src/index.css');

test('MediaGenerationCard — 3종 kind 프리셋이 PRESETS 테이블에 묶여 있다', () => {
  assert.match(CARD_SRC, /const PRESETS: Record<MediaGenerationKind, KindPreset>/);
  for (const kind of ['video', 'pdf', 'pptx'] as const) {
    assert.match(CARD_SRC, new RegExp(`${kind}:\\s*{[\\s\\S]*?title:`),
      `PRESETS.${kind} 에 title 항목이 없다`);
  }
  // 아이콘 매핑은 lucide-react import 로 확정.
  assert.match(CARD_SRC, /from 'lucide-react'/);
  assert.match(CARD_SRC, /Film,\s*FileText,\s*Presentation/);
});

test('MediaGenerationCard — status 3상태 CTA 라벨 매핑이 스펙 그대로 존재한다', () => {
  assert.match(CARD_SRC, /STATUS_CTA_LABEL: Record<MediaGenerationCardStatus, string>/);
  assert.match(CARD_SRC, /ready:\s*'생성 시작 →'/);
  assert.match(CARD_SRC, /generating:\s*'생성 중…'/);
  assert.match(CARD_SRC, /failed:\s*'재생성'/);
});

test('MediaGenerationCard — aria-labelledby/describedby 가 카드 루트에 붙어 있고 aria-busy 는 generating 시에만 true', () => {
  assert.match(CARD_SRC, /aria-labelledby=\{titleId\}/);
  assert.match(CARD_SRC, /aria-describedby=\{descId\}/);
  assert.match(CARD_SRC, /aria-busy=\{isGenerating \|\| undefined\}/);
});

test('MediaGenerationCard — failed 상태에서 role="alert" 카피가 별도 노출된다', () => {
  assert.match(CARD_SRC, /isFailed && errorMessage/);
  assert.match(CARD_SRC, /role="alert"/);
  assert.match(CARD_SRC, /data-testid=\{`media-generation-card-\$\{kind\}-error`\}/);
});

test('MediaGenerationCard — CTA 버튼은 실제 <button type="button"> 요소 + data-testid 를 가진다', () => {
  assert.match(CARD_SRC, /<button[\s\S]{0,80}type="button"[\s\S]{0,200}data-testid=\{`media-generation-card-\$\{kind\}-cta`\}/);
});

test('MediaDraftRestoreBadge — 루트에 role="status" + aria-live="polite" 가 선언돼 있다(M-07)', () => {
  assert.match(BADGE_SRC, /role="status"/);
  assert.match(BADGE_SRC, /aria-live="polite"/);
  // 한 번만 노출되어야 하므로 내부에 `assertive` 는 금지.
  assert.doesNotMatch(BADGE_SRC, /aria-live="assertive"/);
});

test('MediaDraftRestoreBadge — 기본 페이드 지연이 3000ms 이고 fade duration 이 상수로 분리돼 있다', () => {
  assert.match(BADGE_SRC, /const DEFAULT_FADE_DELAY_MS = 3000;/);
  assert.match(BADGE_SRC, /const FADE_DURATION_MS = \d+;/);
});

test('MediaDraftRestoreBadge — prefers-reduced-motion 감지 + transition:none 분기가 있다', () => {
  assert.match(BADGE_SRC, /prefers-reduced-motion: reduce/);
  assert.match(BADGE_SRC, /transition:\s*reduce \? 'none' :/);
});

test('MediaDraftRestoreBadge — 전송/지우기는 각각 별도 <button> 이고 자동 전송 경로가 없다(M-07)', () => {
  assert.match(BADGE_SRC, /data-testid="media-draft-restore-badge-send"/);
  assert.match(BADGE_SRC, /data-testid="media-draft-restore-badge-dismiss"/);
  // "전송" 은 사용자 onClick 경로로만 호출되어야 한다. useEffect 안에서 onSend 를 호출하지 않는다.
  assert.doesNotMatch(BADGE_SRC, /useEffect\([^)]*onSend\s*\(/);
});

test('MediaDraftRestoreBadge — mouseEnter/mouseLeave/focus/blur 에 타이머 일시정지 핸들러가 연결돼 있다', () => {
  for (const prop of ['onMouseEnter', 'onMouseLeave', 'onFocus', 'onBlur']) {
    assert.match(BADGE_SRC, new RegExp(`${prop}=\\{handle`),
      `${prop} 핸들러가 배지 루트에 연결되지 않았다`);
  }
});

test('index.css — §9 미디어 허브 토큰 묶음이 모두 선언돼 있다', () => {
  const required = [
    '--media-hub-section-gap',
    '--media-hub-queue-bar-h',
    '--media-hub-queue-bar-track',
    '--media-hub-phase-fg-precheck',
    '--media-hub-phase-fg-upload',
    '--media-hub-phase-fg-finalize',
    '--media-hub-phase-fg-error',
    '--media-hub-phase-fg-canceled',
    '--media-hub-generation-card-hover-border',
    '--shared-goal-modal-confirm-bg-soft',
    '--media-draft-badge-bg',
    '--media-draft-badge-fg',
  ];
  for (const token of required) {
    assert.match(CSS_SRC, new RegExp(`${token}\\s*:`),
      `${token} 토큰 선언이 index.css 에서 누락되었다`);
  }
});

test('index.css — 초안 배지 배경이 confirm-bg-soft 를 거쳐 emerald 계열을 유지한다', () => {
  assert.match(CSS_SRC, /--media-draft-badge-bg:\s*var\(--shared-goal-modal-confirm-bg-soft\)/);
  assert.match(CSS_SRC, /--media-draft-badge-fg:\s*var\(--shared-goal-modal-confirm-bg\)/);
});
