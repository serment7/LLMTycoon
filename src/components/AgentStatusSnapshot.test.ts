// Run with: tsx --test src/components/AgentStatusSnapshot.test.ts
//
// assessRisk 의 workloadConcentration 신호 승격 회귀 방지 테스트.
// 디자이너 합의 2026-04-18 §"업무 쏠림 alert 티어":
//   - concentration < 0.75  → 신호 없음 (ok 유지)
//   - 0.75 ≤ concentration < 0.95 → warn (기존 동작 보존)
//   - concentration ≥ 0.95 → alert (신규 티어: 사실상 모든 활성 인력이
//     한 파일에 붙은 상태. 충돌 파일 경보와 동급 긴급도로 취급.)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessRisk,
  computeStaleSec,
  RISK_CONCENTRATION_ALERT_THRESHOLD,
  RISK_CONCENTRATION_WARN_THRESHOLD,
  RISK_STALE_ALERT_SEC,
} from './AgentStatusSnapshot.tsx';

const BASE = {
  contentionFiles: 0,
  isolated: 0,
  total: 4,
  staleSec: 0,
};

test('워크로드 쏠림이 경보 임계치 미만이면 경보 없음', () => {
  const risk = assessRisk({ ...BASE, workloadConcentration: 0.7 });
  assert.equal(risk.level, 'ok');
  assert.equal(risk.label, '정상');
});

test('워크로드 쏠림이 warn 임계치~alert 임계치 사이면 warn', () => {
  const risk = assessRisk({ ...BASE, workloadConcentration: RISK_CONCENTRATION_WARN_THRESHOLD });
  assert.equal(risk.level, 'warn');
  assert.match(risk.reason, /쏠림 75%/);
});

test('워크로드 쏠림이 alert 임계치 이상이면 alert 로 승격', () => {
  const risk = assessRisk({ ...BASE, workloadConcentration: RISK_CONCENTRATION_ALERT_THRESHOLD });
  assert.equal(risk.level, 'alert');
  assert.equal(risk.tone, 'alert');
  assert.match(risk.reason, /쏠림 95%/);
});

test('전원 한 파일 집중(1.0) 은 alert 로 승격되며 Pill 톤도 alert', () => {
  const risk = assessRisk({ ...BASE, workloadConcentration: 1.0 });
  assert.equal(risk.level, 'alert');
  assert.equal(risk.tone, 'alert');
  assert.match(risk.reason, /쏠림 100%/);
});

// computeStaleSec 는 Pill·FreshnessDot·buildSnapshotDigest 세 곳에서 경쟁적으로
// 재구현되던 staleSec 계산을 통일한 단일 출처다. 세 경로 사이의 처리 차이가
// "정상 Pill + 빨간 도트" 같은 표시 드리프트를 만들었던 이력이 있어,
// 미래·NaN·undefined 입력에 대한 수렴 규칙을 고정 테스트로 잠근다.
test('computeStaleSec: 정상 입력은 초 단위 floor 로 반환', () => {
  assert.equal(computeStaleSec(1_000_000, 1_000_000 + 7_499), 7);
});

test('computeStaleSec: undefined / NaN / Infinity lastSyncedAt 는 Infinity', () => {
  assert.equal(computeStaleSec(undefined, 1_000_000), Infinity);
  assert.equal(computeStaleSec(Number.NaN, 1_000_000), Infinity);
  assert.equal(computeStaleSec(Number.POSITIVE_INFINITY, 1_000_000), Infinity);
});

test('computeStaleSec: 미래 타임스탬프(now < lastSyncedAt) 는 Infinity 로 수렴', () => {
  // 과거에는 본문 컴포넌트가 Math.max(0, …) 로 "0초" 를 돌려 "정상 Pill" 이 떴지만
  // FreshnessDot 은 Infinity 로 취급해 빨간 도트를 그렸다 — 이 드리프트 회귀 방지.
  assert.equal(computeStaleSec(2_000_000, 1_000_000), Infinity);
});

test('computeStaleSec 결과가 assessRisk 의 alert 임계치와 호환된다', () => {
  const now = 1_000_000;
  const lastSyncedAt = now - RISK_STALE_ALERT_SEC * 1000;
  const staleSec = computeStaleSec(lastSyncedAt, now);
  const risk = assessRisk({
    contentionFiles: 0,
    isolated: 0,
    total: 4,
    staleSec,
  });
  assert.equal(risk.level, 'alert');
  assert.match(risk.reason, /동기화 끊김/);
});

test('alert 쏠림은 다른 warn 신호보다 앞에 정렬된다', () => {
  // 쏠림이 alert, 고립이 warn 인 상황을 만든다. 고립 warn 비율은 isolated/total ≥ 0.5.
  const risk = assessRisk({
    contentionFiles: 0,
    isolated: 2,
    total: 4,
    staleSec: 0,
    workloadConcentration: 1.0,
  });
  assert.equal(risk.level, 'alert');
  // alert 사유가 warn 보다 앞에 있어야 한다(심각도 내림차순 정렬 규칙).
  const alertIdx = risk.reason.indexOf('쏠림');
  const warnIdx = risk.reason.indexOf('고립');
  assert.ok(alertIdx >= 0 && warnIdx >= 0, `두 사유 모두 포함돼야 함: ${risk.reason}`);
  assert.ok(alertIdx < warnIdx, `alert(쏠림) 이 warn(고립) 보다 앞이어야 함: ${risk.reason}`);
});
