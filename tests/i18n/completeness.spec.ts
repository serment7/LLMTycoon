// Run with: npx tsx --test tests/i18n/completeness.spec.ts
//
// 지시 #3d188ad0 (QA) · i18n 완전성 회귀.
//
// 본 스펙은 locales/{en,ko}.json 과 src 에서 실제로 호출되는 t()/translate() 키를
// 대조해 "컴파일은 통과하지만 런타임에서 key 원문이 그대로 노출되는" i18n 회귀를
// 즉시 드러낸다. 실패 메시지는 Joker·Thanos 가 보강할 키 목록을 한 줄 단위로
// 명확히 출력하도록 포맷을 고정한다.
//
// 시나리오
//   S1. src 전체의 정적 t()·translate() 키가 en·ko 양쪽에서 문자열로 해석된다.
//   S2. en·ko 의 leaf 경로 집합이 완전히 동일하다(한쪽에만 존재하는 키 없음).
//   S3. 네 네임스페이스(onboarding, tokenUsage, mcp.transport, recommend) 의
//        키 집합 스냅샷 — 기대 키가 누락되면 실패, 미등록 네임스페이스는 "미도입"
//        으로 명시 리포트.
//   S4. ko 값이 빈 문자열이면 실패, en 과 완전히 동일한 ko 는 경고(console).
//   S5. 포맷 매개변수({name}) 집합이 en·ko 양쪽에서 동일.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import en from '../../locales/en.json' with { type: 'json' };
import ko from '../../locales/ko.json' with { type: 'json' };
import { translate } from '../../src/i18n/index.ts';

// ────────────────────────────────────────────────────────────────────────────
// 유틸 — leaf 경로 수집, 소스 스캔, 포맷 파라미터 추출
// ────────────────────────────────────────────────────────────────────────────

type LocaleTree = { [k: string]: string | LocaleTree };

function collectLeafPaths(tree: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (!tree || typeof tree !== 'object') return out;
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      out.set(path, v);
    } else if (v && typeof v === 'object') {
      for (const [p, val] of collectLeafPaths(v, path)) out.set(p, val);
    }
  }
  return out;
}

function extractParams(value: string): Set<string> {
  const re = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) out.add(m[1]);
  return out;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');

function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // __tests__ 는 회귀 테스트가 t() 를 쓰지 않는 한 스킵해도 안전.
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walkFiles(full, acc);
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * 정적 t('...') / translate('...') / translate('...', locale) 호출에서 key 를 추출.
 * 따옴표 안에 영숫자/마침표/언더스코어·하이픈만 허용(동적 문자열 배제).
 */
function extractUsedKeys(source: string): Set<string> {
  const re = /(?:\bt|\btranslate)\(\s*['"]([a-zA-Z][\w.\-]+)['"]\s*[,)]/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.add(m[1]);
  return out;
}

const enLeaves = collectLeafPaths(en as LocaleTree);
const koLeaves = collectLeafPaths(ko as LocaleTree);

// ────────────────────────────────────────────────────────────────────────────
// S1. src 의 t()·translate() 키 vs locales 해석
// ────────────────────────────────────────────────────────────────────────────

test('S1-1. src 전체의 정적 t()/translate() 키가 en·ko 양쪽에서 문자열로 해석된다', () => {
  const files = walkFiles(SRC_DIR);
  const missingEn: Array<{ key: string; file: string }> = [];
  const missingKo: Array<{ key: string; file: string }> = [];

  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const keys = extractUsedKeys(src);
    if (keys.size === 0) continue;
    const rel = relative(REPO_ROOT, f).replace(/\\/g, '/');
    for (const k of keys) {
      if (translate(k, 'en') === k) missingEn.push({ key: k, file: rel });
      if (translate(k, 'ko') === k) missingKo.push({ key: k, file: rel });
    }
  }

  const report: string[] = [];
  if (missingEn.length > 0) {
    report.push('[누락된 en 키]');
    for (const { key, file } of missingEn) report.push(`  - ${key}  (사용처: ${file})`);
  }
  if (missingKo.length > 0) {
    report.push('[누락된 ko 키]');
    for (const { key, file } of missingKo) report.push(`  - ${key}  (사용처: ${file})`);
  }
  assert.equal(missingEn.length + missingKo.length, 0, '\n' + report.join('\n'));
});

test('S1-2. src 키 스캐너 자체 검증 — t("known.key") 가 정규식에 걸린다', () => {
  const sample = `const x = t('tokenUsage.indicator.label'); const y = translate('project.newProjectWizard.loading', 'ko');`;
  const keys = extractUsedKeys(sample);
  assert.ok(keys.has('tokenUsage.indicator.label'));
  assert.ok(keys.has('project.newProjectWizard.loading'));
});

// ────────────────────────────────────────────────────────────────────────────
// S2. 구조 패리티 — 한쪽에만 존재하는 leaf 금지
// ────────────────────────────────────────────────────────────────────────────

test('S2-1. en 에 있지만 ko 에 없는 leaf 0개', () => {
  const onlyInEn: string[] = [];
  for (const p of enLeaves.keys()) if (!koLeaves.has(p)) onlyInEn.push(p);
  assert.equal(
    onlyInEn.length,
    0,
    '\n[ko 누락 leaf]\n' + onlyInEn.map((p) => `  - ${p}`).join('\n'),
  );
});

test('S2-2. ko 에 있지만 en 에 없는 leaf 0개', () => {
  const onlyInKo: string[] = [];
  for (const p of koLeaves.keys()) if (!enLeaves.has(p)) onlyInKo.push(p);
  assert.equal(
    onlyInKo.length,
    0,
    '\n[en 누락 leaf]\n' + onlyInKo.map((p) => `  - ${p}`).join('\n'),
  );
});

test('S2-3. 동일한 leaf 수 — 구조 패리티 숫자 검증', () => {
  assert.equal(enLeaves.size, koLeaves.size, `en=${enLeaves.size} · ko=${koLeaves.size}`);
});

// ────────────────────────────────────────────────────────────────────────────
// S3. 네 네임스페이스 스냅샷 — onboarding · tokenUsage · mcp.transport · recommend
// ────────────────────────────────────────────────────────────────────────────

/**
 * 2026-04-21 기준 스냅샷. 신규 키 추가/제거 시 본 배열을 업데이트해야 테스트가
 * 통과한다. 반대로 런타임 누락이 생기면 본 스냅샷이 즉시 실패 원인을 특정한다.
 */
const NAMESPACE_SNAPSHOTS = {
  onboarding: [
    'onboarding.title',
    'onboarding.skip',
    'onboarding.next',
    'onboarding.prev',
    'onboarding.finish',
    'onboarding.restart',
    'onboarding.stepIndicator',
    'onboarding.steps.locale.title',
    'onboarding.steps.locale.body',
    'onboarding.steps.mcp.title',
    'onboarding.steps.mcp.body',
    'onboarding.steps.recommend.title',
    'onboarding.steps.recommend.body',
    'onboarding.steps.recommend.demoDescription',
    'onboarding.steps.tokens.title',
    'onboarding.steps.tokens.body',
  ] as readonly string[],
  tokenUsage: [
    'tokenUsage.indicator.label',
    'tokenUsage.indicator.input',
    'tokenUsage.indicator.output',
    'tokenUsage.indicator.cacheHit',
    'tokenUsage.indicator.remaining',
    'tokenUsage.indicator.noLimit',
    'tokenUsage.panel.title',
    'tokenUsage.panel.trend',
    'tokenUsage.panel.topAgents',
    'tokenUsage.panel.compactions',
    'tokenUsage.panel.empty',
    'tokenUsage.panel.savedTokens',
    'tokenUsage.toast.compacted',
  ] as readonly string[],
  'mcp.transport': [
    // 현재 미도입 — mcp.transport.stdio / http / streamable-http 같은 라벨 예약.
  ] as readonly string[],
  recommend: [
    // 현재 미도입 — newProjectWizard 내부 키는 project.newProjectWizard.* 에 있으며
    // 루트 recommend.* 네임스페이스는 추후 도입(추천 카드 상단 배지 등) 을 위해 예약.
  ] as readonly string[],
} as const;

test('S3-1. tokenUsage 네임스페이스 — 스냅샷 키가 전부 존재하고 추가 키 없음', () => {
  const expected = new Set<string>(NAMESPACE_SNAPSHOTS.tokenUsage);
  const actual = new Set<string>(
    [...enLeaves.keys()].filter((p) => p.startsWith('tokenUsage.')),
  );
  const missing: string[] = [];
  const extra: string[] = [];
  for (const k of expected) if (!actual.has(k)) missing.push(k);
  for (const k of actual) if (!expected.has(k)) extra.push(k);
  assert.equal(
    missing.length + extra.length,
    0,
    '\n[tokenUsage 스냅샷 드리프트]\n' +
      (missing.length > 0 ? '  누락: ' + missing.join(', ') + '\n' : '') +
      (extra.length > 0 ? '  추가(스냅샷 업데이트 필요): ' + extra.join(', ') : ''),
  );
});

test('S3-2. 미도입 네임스페이스 리포트 — onboarding · mcp.transport · recommend', () => {
  const reservedNamespaces: Array<keyof typeof NAMESPACE_SNAPSHOTS> = [
    'onboarding',
    'mcp.transport',
    'recommend',
  ];
  const lines: string[] = [];
  for (const ns of reservedNamespaces) {
    const expected = NAMESPACE_SNAPSHOTS[ns];
    const prefix = `${ns}.`;
    const actual = [...enLeaves.keys()].filter((p) => p === ns || p.startsWith(prefix));
    // 예약 네임스페이스는 현재 expected 와 actual 둘 다 "비어있음" 이 정상.
    // 한쪽에만 값이 생기면 스냅샷 업데이트를 강제.
    if (expected.length === 0 && actual.length === 0) {
      lines.push(`  · ${ns}: 미도입(예약)`);
    } else {
      const missing = expected.filter((k) => !actual.includes(k));
      const extra = actual.filter((k) => !(expected as readonly string[]).includes(k));
      if (missing.length === 0 && extra.length === 0) {
        lines.push(`  · ${ns}: ${actual.length}개 키 — OK`);
      } else {
        lines.push(
          `  · ${ns}: 드리프트 — 누락 [${missing.join(', ')}] / 추가 [${extra.join(', ')}]`,
        );
      }
    }
  }
  // 리포트 내용이 항상 출력되어야 Joker/Thanos 가 다음 단계에서 보강 계획을 세울 수 있다.
  const report = lines.join('\n');
  assert.ok(report.length > 0);
  // 스냅샷 드리프트가 하나라도 있으면 즉시 실패.
  assert.equal(
    report.includes('드리프트'),
    false,
    '\n[예약 네임스페이스 상태]\n' + report,
  );
});

// ────────────────────────────────────────────────────────────────────────────
// S4. 빈 값 금지 · ko==en 경고
// ────────────────────────────────────────────────────────────────────────────

test('S4-1. 모든 ko 값이 비어 있지 않다', () => {
  const empties: string[] = [];
  for (const [p, v] of koLeaves) {
    if (v.trim().length === 0) empties.push(p);
  }
  assert.equal(
    empties.length,
    0,
    '\n[ko 빈 문자열]\n' + empties.map((p) => `  - ${p}`).join('\n'),
  );
});

test('S4-2. 모든 en 값이 비어 있지 않다', () => {
  const empties: string[] = [];
  for (const [p, v] of enLeaves) {
    if (v.trim().length === 0) empties.push(p);
  }
  assert.equal(empties.length, 0, '\n[en 빈 문자열]\n' + empties.map((p) => `  - ${p}`).join('\n'));
});

test('S4-3. ko == en 인 항목은 번역 필요 여부를 리포트(경고)', () => {
  // 고유명사(예: "LLM Tycoon" 은 영문 유지 가능) 허용. 상수 자릿수 템플릿 등도 자연스러울 수 있어
  // 현재는 하드 실패 대신 diagnostic 으로 남긴다.
  const unchanged: string[] = [];
  for (const [p, enVal] of enLeaves) {
    const koVal = koLeaves.get(p);
    if (koVal !== undefined && koVal === enVal) unchanged.push(`${p} = "${enVal}"`);
  }
  // locale.en / locale.ko 같은 "언어명" 은 의도적으로 로캘별 다른 표기이므로 여기 걸리지 않는다.
  if (unchanged.length > 0) {
    // diagnostic 로그 — 실패는 아님. ko 와 en 이 같으면 번역 확인 필요.
    // eslint-disable-next-line no-console
    console.warn('\n[ko==en 동일 항목 — 번역 확인 권장]\n' + unchanged.map((l) => '  · ' + l).join('\n'));
  }
  // 5개 이상 동일하면 대량 미번역 가능성 → 실패.
  assert.ok(
    unchanged.length < 5,
    `ko==en 항목이 ${unchanged.length}개 — 대량 미번역 의심, 확인 필요`,
  );
});

// ────────────────────────────────────────────────────────────────────────────
// S5. 포맷 매개변수 패리티
// ────────────────────────────────────────────────────────────────────────────

test('S5-1. 모든 leaf 에서 en/ko 포맷 매개변수 집합이 동일', () => {
  const mismatches: string[] = [];
  for (const [p, enVal] of enLeaves) {
    const koVal = koLeaves.get(p);
    if (typeof koVal !== 'string') continue;
    const enParams = extractParams(enVal);
    const koParams = extractParams(koVal);
    const missingInKo = [...enParams].filter((x) => !koParams.has(x));
    const missingInEn = [...koParams].filter((x) => !enParams.has(x));
    if (missingInKo.length > 0 || missingInEn.length > 0) {
      mismatches.push(
        `  - ${p}: en={${[...enParams].join(',')}} ko={${[...koParams].join(',')}}`,
      );
    }
  }
  assert.equal(
    mismatches.length,
    0,
    '\n[포맷 매개변수 불일치]\n' + mismatches.join('\n'),
  );
});

test('S5-2. extractParams 자체 검증 — 단일/중복/공백 처리', () => {
  assert.deepEqual([...extractParams('Hello {name}, you have {count} msgs')].sort(), ['count', 'name']);
  assert.deepEqual([...extractParams('{count}개 중 {count}번째')], ['count'], '중복은 1회만');
  assert.deepEqual([...extractParams('no params here')], []);
});
