// Run with: npx tsx --test tests/accessibilityKeyboardOnboarding.unit.test.ts
//
// 접근성·키보드·온보딩 단위 테스트(#4c9bc4a6).
//   1) 키보드 네비게이션 — AttachmentPreviewPanel 의 pickFocusIndexOnKey 계약.
//   2) 내보내기 단축키 — ExportButtons 의 resolveExportShortcut + 라벨 매핑.
//   3) 온보딩 저장/재개 — OnboardingTour 의 isOnboardingCompleted + nextOnboardingStep.
//
// 본 파일은 React DOM 없이 순수 파생 함수만 검증한다. 상위 컴포넌트는 이 함수들을
// 그대로 재사용하므로 실제 UI 동작 계약이 동일하게 잠긴다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { pickFocusIndexOnKey } from '../src/components/AttachmentPreviewPanel.tsx';
import {
  EXPORT_BUTTONS,
  exportShortcutLabel,
  resolveExportShortcut,
  type ExportKind,
} from '../src/components/ExportButtons.tsx';
import {
  DEFAULT_ONBOARDING_STEPS,
  ONBOARDING_STORAGE_KEY,
  isOnboardingCompleted,
  markOnboardingCompletedValue,
  nextOnboardingStep,
  onboardingResetKey,
} from '../src/components/OnboardingTour.tsx';

// ---------------------------------------------------------------------------
// 1) 키보드 네비게이션 — 방향키/Home/End/경계 고정
// ---------------------------------------------------------------------------

test('pickFocusIndexOnKey — 방향키/Home/End 동작과 경계 고정', () => {
  // 빈 리스트는 -1.
  assert.equal(pickFocusIndexOnKey({ current: 0, total: 0, key: 'ArrowDown' }), -1);

  // ArrowDown/Right 는 +1, 끝에서는 고정(래핑 없음).
  assert.equal(pickFocusIndexOnKey({ current: 0, total: 3, key: 'ArrowDown' }), 1);
  assert.equal(pickFocusIndexOnKey({ current: 2, total: 3, key: 'ArrowDown' }),
    2, '끝에서 아래로 가면 동일 인덱스에 고정 — listbox 권장 동작');
  assert.equal(pickFocusIndexOnKey({ current: 0, total: 3, key: 'ArrowRight' }), 1);

  // ArrowUp/Left 는 -1, 처음에서 고정.
  assert.equal(pickFocusIndexOnKey({ current: 0, total: 3, key: 'ArrowUp' }), 0);
  assert.equal(pickFocusIndexOnKey({ current: 2, total: 3, key: 'ArrowLeft' }), 1);

  // Home/End 는 즉시 처음/끝.
  assert.equal(pickFocusIndexOnKey({ current: 2, total: 3, key: 'Home' }), 0);
  assert.equal(pickFocusIndexOnKey({ current: 0, total: 3, key: 'End' }), 2);

  // 비정상 current(음수/NaN) 는 0 으로 안전화 후 처리.
  assert.equal(pickFocusIndexOnKey({ current: -5, total: 3, key: 'ArrowDown' }), 1);
  assert.equal(pickFocusIndexOnKey({ current: Number.NaN, total: 3, key: 'ArrowDown' }), 1);

  // 알 수 없는 키는 현재 인덱스 유지 — 무의미한 리렌더 회피.
  assert.equal(pickFocusIndexOnKey({ current: 1, total: 3, key: 'a' }), 1);
});

// ---------------------------------------------------------------------------
// 2) 내보내기 단축키 — Alt+P/S/V 매핑 + 비Alt/조합키 거부
// ---------------------------------------------------------------------------

test('resolveExportShortcut — Alt+P/S/V 는 각각 pdf/pptx/video, Alt 없으면 null', () => {
  const cases: Array<[{ key: string; altKey: boolean; ctrlKey?: boolean; metaKey?: boolean }, ExportKind | null]> = [
    [{ key: 'p', altKey: true }, 'pdf'],
    [{ key: 'P', altKey: true }, 'pdf'],
    [{ key: 's', altKey: true }, 'pptx'],
    [{ key: 'v', altKey: true }, 'video'],
    // Alt 없이 같은 글자는 무시 — 본문 입력과의 충돌 회피.
    [{ key: 'p', altKey: false }, null],
    // Alt + Ctrl/Meta 조합은 시스템 예약일 수 있어 무시.
    [{ key: 'p', altKey: true, ctrlKey: true }, null],
    [{ key: 'p', altKey: true, metaKey: true }, null],
    // 지정되지 않은 글자는 null.
    [{ key: 'x', altKey: true }, null],
    // 비문자 키.
    [{ key: 'Enter', altKey: true }, null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(
      resolveExportShortcut(input),
      expected,
      `${JSON.stringify(input)} → ${String(expected)}`,
    );
  }

  // 단축키 라벨이 UI·테스트 양쪽에서 일관되게 노출되는지.
  assert.equal(exportShortcutLabel('pdf'), 'Alt+P');
  assert.equal(exportShortcutLabel('pptx'), 'Alt+S');
  assert.equal(exportShortcutLabel('video'), 'Alt+V');

  // EXPORT_BUTTONS description 에 단축키 라벨이 모두 포함되는지 — 툴팁 회귀 잠금.
  for (const btn of EXPORT_BUTTONS) {
    const expected = exportShortcutLabel(btn.kind);
    assert.ok(btn.description.includes(expected),
      `${btn.kind} 버튼의 description 에 ${expected} 가 포함되어야 한다 (툴팁 안내 누락 방지)`);
  }
});

// ---------------------------------------------------------------------------
// 3) 온보딩 저장/재개 — localStorage 계약 + 스텝 전환
// ---------------------------------------------------------------------------

test('OnboardingTour · 저장·재개·스텝 전환 순수 함수 계약', () => {
  // localStorage 키 노출.
  assert.equal(ONBOARDING_STORAGE_KEY, 'llmtycoon.onboarding.completed');
  assert.equal(onboardingResetKey(), ONBOARDING_STORAGE_KEY,
    '다시 보기 리셋 키는 ONBOARDING_STORAGE_KEY 와 동일해야 한다 — 저장·삭제 경로 단일 출처');

  // 저장값은 'true' — truthy 문자열 대소문자 허용.
  assert.equal(markOnboardingCompletedValue(), 'true');
  assert.equal(isOnboardingCompleted('true'), true);
  assert.equal(isOnboardingCompleted('TRUE'), true);
  assert.equal(isOnboardingCompleted('  true  '), true, '공백은 trim 되어야 한다');
  assert.equal(isOnboardingCompleted('false'), false);
  assert.equal(isOnboardingCompleted(''), false);
  assert.equal(isOnboardingCompleted(null), false);
  assert.equal(isOnboardingCompleted(undefined), false);
  assert.equal(isOnboardingCompleted('yes'), false, '명시 true 문자열만 완료로 인정');

  // 스텝 전환: 마지막에서 next 는 'done', 처음에서 prev 는 0.
  const total = DEFAULT_ONBOARDING_STEPS.length;
  assert.ok(total >= 3, '기본 3스텝 이상 유지');
  assert.equal(nextOnboardingStep({ current: 0, total, action: 'next' }), 1);
  assert.equal(nextOnboardingStep({ current: total - 1, total, action: 'next' }), 'done',
    '마지막 스텝의 next 는 done — localStorage 에 완료 기록');
  assert.equal(nextOnboardingStep({ current: 0, total, action: 'prev' }), 0);
  assert.equal(nextOnboardingStep({ current: 1, total, action: 'prev' }), 0);
  assert.equal(nextOnboardingStep({ current: 1, total, action: 'skip' }), 'done',
    '건너뛰기도 done 으로 수렴해 다음 방문에 다시 뜨지 않아야 한다');
  assert.equal(nextOnboardingStep({ current: 0, total, action: 'finish' }), 'done');

  // 범위 밖 current 는 안전화 — 투어가 비정상 상태에서도 버튼 클릭이 행동을 남긴다.
  assert.equal(nextOnboardingStep({ current: -1, total, action: 'next' }), 1);
  assert.equal(nextOnboardingStep({ current: 99, total, action: 'prev' }), total - 2);

  // 기본 스텝 anchor 는 TokenUsageIndicator/UploadDropzone/ExportButtons 순서.
  assert.deepEqual(
    DEFAULT_ONBOARDING_STEPS.map(s => s.anchor),
    ['token-usage-indicator', 'upload-dropzone', 'export-buttons'],
    '투어 순서가 바뀌면 data-tour-anchor 부착 컴포넌트도 함께 점검해야 한다',
  );
});
