// Run with: npx tsx --test tests/releaseReadinessScorecard.regression.test.ts
//
// QA 회귀(지시 #ce5d9402) · 출시 준비 스코어카드 동기화 가드.
//
// 본 파일은 "새 기능 동작" 을 검증하지 않는다. 대신 8회차 스코어카드 문서와
// 1~7회차 회귀 스위트 사이의 **일관성** 을 잠근다:
//   · 스코어카드에 기록된 7개 선행 보고서 파일이 저장소에 실제 존재한다.
//   · 스코어카드에 명시된 9개 회귀 스위트 파일이 저장소에 실제 존재한다.
//   · 스코어카드에 명시된 17건 결함 ID(§2.1·§2.2·§2.3) 가 전부 선행 보고서
//     또는 회귀 스위트 한 곳 이상에 언급되어 있다(근거 드리프트 방지).
//   · go/no-go 판정이 "NO-GO" 인 동안 §1.1·§1.3·§2.2 블로커 3건은 여전히
//     `test.skip` 으로 대기 중이다.
//
// 이 가드가 깨지면 스코어카드와 실제 코드·테스트가 어긋났다는 신호 — 출시
// 판단의 근거가 흔들리므로 즉시 수정이 필요하다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function docs(rel: string): string {
  return resolve(__dirname, '..', 'docs', rel);
}
function tests(rel: string): string {
  return resolve(__dirname, rel);
}
function read(p: string): string { return readFileSync(p, 'utf8'); }

const SCORECARD = docs('qa-release-readiness-scorecard-2026-04-19.md');

// ─── SC-1 · 선행 보고서 7건 존재 ─────────────────────────────────────────────

test('SC-1 · 스코어카드가 참조하는 7 선행 보고서 파일이 실제로 존재한다', () => {
  const expected = [
    tests('qa/ui-smoke-report.md'),
    docs('qa-ui-smoke-regression-2026-04-19-followup.md'),
    docs('qa-session-sync-multitab-smoke-2026-04-19.md'),
    docs('qa-accessibility-crossbrowser-2026-04-19.md'),
    docs('qa-performance-stress-2026-04-19.md'),
    docs('qa-uat-final-acceptance-2026-04-19.md'),
    docs('qa-security-defensive-audit-2026-04-19.md'),
  ];
  for (const p of expected) {
    assert.ok(existsSync(p), `선행 보고서 누락: ${p} — 스코어카드 근거가 끊긴다`);
  }
});

// ─── SC-2 · 9 QA 회귀 스위트 존재 ────────────────────────────────────────────

test('SC-2 · 스코어카드가 참조하는 9 회귀 스위트 파일이 실제로 존재한다', () => {
  const expected = [
    'uiSmokeReportBlockerContracts.regression.test.ts',
    'sessionSyncMultiTabRefresh.regression.test.ts',
    'accessibilityGlobalAudit.regression.test.ts',
    'performanceTokenIndicatorTimer.regression.test.tsx',
    'performanceMediaLoadersStress.regression.test.ts',
    'performanceSessionSyncStress.regression.test.ts',
    'uatFinalAcceptance.regression.test.ts',
    'securityDefensiveAudit.regression.test.ts',
    'claudeSubscriptionSession.regression.test.ts',
  ];
  for (const name of expected) {
    assert.ok(existsSync(tests(name)), `회귀 스위트 누락: tests/${name}`);
  }
});

// ─── SC-3 · 17 결함 ID 가 보고서에 흩어져 있음을 확인 ─────────────────────────

test('SC-3 · 스코어카드의 17 결함 ID 가 각자 최소 1개 선행 보고서·회귀 스위트에 근거를 남기고 있다', () => {
  const allSources = [
    read(SCORECARD),
    read(tests('qa/ui-smoke-report.md')),
    read(docs('qa-ui-smoke-regression-2026-04-19-followup.md')),
    read(docs('qa-session-sync-multitab-smoke-2026-04-19.md')),
    read(docs('qa-accessibility-crossbrowser-2026-04-19.md')),
    read(docs('qa-performance-stress-2026-04-19.md')),
    read(docs('qa-uat-final-acceptance-2026-04-19.md')),
    read(docs('qa-security-defensive-audit-2026-04-19.md')),
  ].join('\n');

  const ids = [
    '§1.1', '§1.3', '§2.2',
    'A11Y-DEF-1', 'PERF-DEF-1', 'SEC-DEF-1', 'SEC-DEF-2',
    '§2.3', 'UAT-DEF-1', 'A11Y-DEF-2', 'A11Y-DEF-3', 'A11Y-DEF-4', 'A11Y-DEF-5',
    'SEC-DEF-3', 'SEC-DEF-4', 'SEC-DEF-5', 'SEC-DEF-6',
  ];
  for (const id of ids) {
    assert.ok(
      allSources.includes(id),
      `결함 ID ${id} 의 근거가 7 보고서 · 스코어카드 어디에도 없다 — 수정 추적이 끊긴다`,
    );
  }
});

// ─── SC-4 · NO-GO 상태에서 블로커 3건이 여전히 skip 으로 대기 중 ──────────────

test('SC-4 · §1.1·§1.3 블로커는 uiSmokeReportBlockerContracts 에서 여전히 test.skip 으로 남아 있다', () => {
  const src = read(tests('uiSmokeReportBlockerContracts.regression.test.ts'));
  // 문서가 "NO-GO" 인 동안 CONTRACT §1.1·§1.3·§2.2 는 skip 상태여야 한다.
  assert.match(src, /test\.skip\(['"]CONTRACT §1\.1/,
    '스코어카드가 NO-GO 인데 §1.1 잠금이 해제돼 있으면 보고서와 테스트 상태가 모순');
  assert.match(src, /test\.skip\(['"]CONTRACT §1\.3/);
  assert.match(src, /test\.skip\(['"]CONTRACT §2\.2/);
});

// ─── SC-5 · 스코어카드 판정이 NO-GO 임을 명시한다 ─────────────────────────────

test('SC-5 · 스코어카드가 최종 권고를 🔴 NO-GO 로 명시한다', () => {
  const doc = read(SCORECARD);
  assert.match(doc, /🔴 NO-GO/,
    '출시 판정이 사라지거나 GO 로 바뀌면 본 테스트가 깨진다 — 수정 시 블로커 3건 확인 필수');
});

// ─── SC-6 · 담당자 3명(Joker·Thanos·디자이너) 액션 블록이 모두 존재 ──────────

test('SC-6 · 마지막 보정 스프린트 §6 에 Joker · Thanos · 디자이너 블록이 모두 존재한다', () => {
  const doc = read(SCORECARD);
  assert.match(doc, /### 6\.1 Joker/);
  assert.match(doc, /### 6\.2 Thanos/);
  assert.match(doc, /### 6\.3 디자이너/);
});
