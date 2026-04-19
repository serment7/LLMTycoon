import { performance } from 'node:perf_hooks';
import {
  EMPTY_TOTALS,
  mergeUsage,
  serializePersistedTotals,
  deserializePersistedTotals,
  applyDeltaToState,
} from '../../src/utils/claudeTokenUsageStore.ts';

function empty() {
  return { all: { ...EMPTY_TOTALS, byModel: {} }, today: { ...EMPTY_TOTALS, byModel: {} }, todayDate: '2026-04-19', history: [], loadError: null };
}
function timed(label, fn) {
  const t0 = performance.now();
  const r = fn();
  const ms = performance.now() - t0;
  console.log(`  ${label}: ${ms.toFixed(3)} ms`);
  return ms;
}
function mkUsage(i) {
  return {
    input_tokens: 100 + (i % 500),
    output_tokens: 40 + (i % 200),
    cache_read_input_tokens: i % 7 === 0 ? 800 : 0,
    cache_creation_input_tokens: 0,
    model: ['claude-opus-4-7','claude-sonnet-4-6','claude-haiku-4-5'][i % 3],
    at: new Date(2026,3,19,10,0,i%60).toISOString(),
  };
}

console.log('=== mergeUsage 반복 (배지 실시간 증가 시뮬레이션) ===');
for (const N of [100, 1000, 10000, 50000]) {
  timed(`mergeUsage x${N.toString().padStart(5)}`, () => {
    let t = { ...EMPTY_TOTALS, byModel: {} };
    for (let i = 0; i < N; i++) t = mergeUsage(t, mkUsage(i));
  });
}

console.log('\n=== applyDeltaToState 반복 (스토어 경로 전체) ===');
for (const N of [100, 1000, 10000, 50000]) {
  timed(`applyDeltaToState x${N.toString().padStart(5)}`, () => {
    let s = empty();
    const now = new Date(2026, 3, 19, 10, 0, 0);
    for (let i = 0; i < N; i++) s = applyDeltaToState(s, mkUsage(i), now);
  });
}

console.log('\n=== localStorage 직렬화/파싱 (대용량 스토어 상태) ===');
for (const N of [1000, 10000, 50000]) {
  let s = empty();
  const now = new Date(2026, 3, 19, 10, 0, 0);
  for (let i = 0; i < N; i++) s = applyDeltaToState(s, mkUsage(i), now);
  const nowIso = '2026-04-19T10:00:00.000Z';
  const tSer = [], tStr = [], tPar = [], tDe = [];
  for (let k = 0; k < 3; k++) {
    const t1 = performance.now();
    const payload = serializePersistedTotals(s, nowIso);
    const t2 = performance.now(); tSer.push(t2 - t1);
    const str = JSON.stringify(payload);
    const t3 = performance.now(); tStr.push(t3 - t2);
    const obj = JSON.parse(str); void obj;
    const t4 = performance.now(); tPar.push(t4 - t3);
    const restored = deserializePersistedTotals(str, now); void restored;
    const t5 = performance.now(); tDe.push(t5 - t4);
  }
  const avg = arr => (arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(3);
  const size = JSON.stringify(serializePersistedTotals(s, nowIso)).length;
  console.log(`  N=${N.toString().padStart(5)} · payload=${(size/1024).toFixed(1).padStart(5)}KB | serialize ${avg(tSer).padStart(6)}ms · JSON.stringify ${avg(tStr).padStart(6)}ms · JSON.parse ${avg(tPar).padStart(6)}ms · deserialize ${avg(tDe).padStart(6)}ms`);
}

console.log('\n=== byModel 키 폭발 (모델 이름이 다양할 때) ===');
for (const M of [3, 30, 300]) {
  let t = { ...EMPTY_TOTALS, byModel: {} };
  const N = 10000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    t = mergeUsage(t, { ...mkUsage(i), model: `claude-model-${i % M}` });
  }
  const ms = (performance.now() - t0).toFixed(3);
  const keys = Object.keys(t.byModel).length;
  console.log(`  N=${N} · M=${M.toString().padStart(3)} 고유 모델 | ${ms}ms · byModel keys=${keys}`);
}
