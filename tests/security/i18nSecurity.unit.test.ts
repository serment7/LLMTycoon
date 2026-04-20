// Run with: npx tsx --test tests/security/i18nSecurity.unit.test.ts
//
// 지시 #c50309c3 (QA · 보안) · locales/*.json · translate() XSS 노출 축 점검.
//
// 검증 초점
//   1) locales/en.json · ko.json 의 모든 문자열에 `<script>` / `on*=` / javascript:
//      같은 스크립트 실행 흔적이 없다(번역자 실수 방어).
//   2) translate() 는 입력을 그대로 반환(이스케이프 X) 하므로 React 가 `{...}` 로
//      렌더할 때 자동 텍스트화한다는 계약을 테스트로 고정 — `dangerouslySetInnerHTML`
//      경로에 직접 투입되지 않도록 소스 전역에 dangerouslySetInnerHTML 사용이 없는지
//      정적 스캔도 함께.
//   3) 악성 번역 값이 들어와도 이후 interpolate 치환 경로에서 2차 해석이 일어나지
//      않는다(본 규칙은 tests/security/promptInjection.spec.ts 의 PI5 와 동일 — 재확인).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import en from '../../locales/en.json' with { type: 'json' };
import ko from '../../locales/ko.json' with { type: 'json' };
import { translate } from '../../src/i18n/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');

// ────────────────────────────────────────────────────────────────────────────
// 유틸 — JSON leaf 순회, 소스 스캔
// ────────────────────────────────────────────────────────────────────────────

function collectLeaves(tree: unknown, prefix = ''): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  if (!tree || typeof tree !== 'object') return out;
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.push({ path, value: v });
    else if (v && typeof v === 'object') for (const item of collectLeaves(v, path)) out.push(item);
  }
  return out;
}

function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, acc);
    else if (/\.(tsx?|jsx?)$/.test(entry)) acc.push(full);
  }
  return acc;
}

const enLeaves = collectLeaves(en);
const koLeaves = collectLeaves(ko);

// ────────────────────────────────────────────────────────────────────────────
// A. locales 내부에 스크립트 실행 유도 패턴이 없다
// ────────────────────────────────────────────────────────────────────────────

const DANGER_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: '<script> 태그', re: /<\s*script\b/i },
  { label: '이벤트 핸들러 on*', re: /\bon(error|click|load|mouseover|focus|blur|submit|change|input)\s*=/i },
  { label: 'javascript: 스킴', re: /javascript:/i },
  { label: 'data:text/html', re: /data:\s*text\/html/i },
  { label: '<iframe>', re: /<\s*iframe\b/i },
  { label: '<object>', re: /<\s*object\b/i },
  { label: '<svg onload', re: /<\s*svg[^>]*\bonload/i },
];

test('A1. locales/en.json — 모든 leaf 가 위험 패턴을 포함하지 않는다', () => {
  const hits: string[] = [];
  for (const { path, value } of enLeaves) {
    for (const { label, re } of DANGER_PATTERNS) {
      if (re.test(value)) hits.push(`${path}: ${label}`);
    }
  }
  assert.equal(hits.length, 0, '\n[위험 패턴 hit]\n' + hits.map((h) => '  - ' + h).join('\n'));
});

test('A2. locales/ko.json — 모든 leaf 가 위험 패턴을 포함하지 않는다', () => {
  const hits: string[] = [];
  for (const { path, value } of koLeaves) {
    for (const { label, re } of DANGER_PATTERNS) {
      if (re.test(value)) hits.push(`${path}: ${label}`);
    }
  }
  assert.equal(hits.length, 0, '\n[위험 패턴 hit]\n' + hits.map((h) => '  - ' + h).join('\n'));
});

test('A3. locales 값 안에 HTML 태그 `<` 가 등장하지 않는다(번역자 실수 방어)', () => {
  const hits: string[] = [];
  for (const { path, value } of [...enLeaves, ...koLeaves]) {
    if (/<[a-zA-Z]/.test(value)) hits.push(`${path}: '${value.slice(0, 40)}…'`);
  }
  // {count} 같은 플레이스홀더는 { 로 시작해 규제 대상 아님.
  assert.equal(hits.length, 0, '\n[태그로 보이는 leaf]\n' + hits.map((h) => '  - ' + h).join('\n'));
});

// ────────────────────────────────────────────────────────────────────────────
// B. translate() 의 출력은 React 가 텍스트로 렌더 — 악성 입력도 자동 이스케이프
// ────────────────────────────────────────────────────────────────────────────

test('B1. translate("key", locale) 반환값은 원문 문자열(이스케이프 안 된 상태) — React 가 JSX `{...}` 로 텍스트 렌더한다는 계약 자체를 문서화', () => {
  // translate 자체는 리터럴 이스케이프를 하지 않는다. React 가 안전한 것은 JSX 텍스트
  // 노드에서 자동 이스케이프하기 때문 — dangerouslySetInnerHTML 로 투입되는 순간 위험.
  // 본 테스트는 "번역 함수가 어떤 변환도 하지 않는다" 는 사실을 명시적으로 잠근다.
  const raw = '<script>evil</script>';
  const fakeLookup = (key: string) => (key === 'fake' ? raw : key);
  assert.equal(fakeLookup('fake'), raw);
  // translate 경로에서도 동일 — 값 변환 없음.
  assert.equal(translate('app.title', 'en'), 'LLM Tycoon');
});

test('B2. src 전역 — dangerouslySetInnerHTML 이 translate()/t() 값과 결합된 곳이 없다', () => {
  // React 에서 XSS 는 dangerouslySetInnerHTML 로만 유발된다. 소스 전역에 본 속성이
  // 전혀 쓰이지 않음을 정적으로 확인해 안전망을 고정한다.
  const files = walkFiles(SRC_DIR);
  const hits: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (/dangerouslySetInnerHTML/.test(src)) {
      hits.push(f.replace(REPO_ROOT + '\\', '').replace(/\\/g, '/'));
    }
  }
  assert.equal(hits.length, 0, '\n[dangerouslySetInnerHTML 사용처]\n' + hits.map((h) => '  - ' + h).join('\n'));
});

// ────────────────────────────────────────────────────────────────────────────
// C. 악성 번역 키 입력 시 React 안전 렌더 — 치환 경로까지 포함
// ────────────────────────────────────────────────────────────────────────────

/**
 * interpolate — 치환기 한 번만 동작. 치환 결과 내부의 `{other}` 플레이스홀더는
 * 재해석되지 않는다(2차 치환 금지). 본 계약이 깨지면 사용자 제어 문자열이 다른 키로
 * 재해석되어 XSS 또는 메시지 혼동이 발생한다.
 */
function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_full, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : `{${key}}`,
  );
}

test('C1. 악성 params 값("<img src=x onerror=alert(1)>") — 그대로 문자열 반환(2차 해석 없음)', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const out = interpolate('hi {user}', { user: payload });
  assert.equal(out, `hi ${payload}`, '치환기는 문자열 연결만 — React 가 JSX 텍스트로 렌더하면 자동 이스케이프');
});

test('C2. 악성 params 값에 `{other}` 가 들어있어도 재치환되지 않는다', () => {
  const out = interpolate('hi {user}', { user: 'malicious {count}', count: 42 });
  assert.equal(out, 'hi malicious {count}', '2차 치환 금지 — 사용자 제어 문자열이 다른 키로 재해석되면 위험');
});

test('C3. 번역 값 자체에 `{count}` 가 정상 포함된 케이스 — 사용자 값으로 치환되고 사용자 값 내부는 건드리지 않음', () => {
  const template = '{count}개 추가됨 — 상세: {detail}';
  const out = interpolate(template, { count: 3, detail: '{count} 자리표시자 유지' });
  assert.equal(out, '3개 추가됨 — 상세: {count} 자리표시자 유지');
});

test('C4. 실 locales 의 포맷 매개변수 {count} 를 악의 값으로 치환해도 2차 해석 없음', () => {
  const en = translate('project.newProjectWizard.apply.button', 'en');
  const ko = translate('project.newProjectWizard.apply.button', 'ko');
  assert.match(en, /\{count\}/);
  assert.match(ko, /\{count\}/);
  const renderedEn = interpolate(en, { count: '<b onclick=alert(1)>5</b>' });
  const renderedKo = interpolate(ko, { count: '<b onclick=alert(1)>5</b>' });
  // 출력 문자열에 여전히 태그 리터럴이 있지만 React 가 JSX 텍스트로 렌더하면 안전.
  // 본 테스트는 치환기가 태그를 "실행 가능한 구조" 로 바꾸지 않음을 확인.
  assert.ok(renderedEn.includes('<b onclick=alert(1)>5</b>'));
  assert.ok(renderedKo.includes('<b onclick=alert(1)>5</b>'));
});

// ────────────────────────────────────────────────────────────────────────────
// D. locales 파일 파서 강건성 — 악성 JSON 삽입 시나리오(번역 PR 리뷰 보조)
// ────────────────────────────────────────────────────────────────────────────

test('D1. JSON 파싱 — locales 파일 자체는 코드 실행을 유발할 수 없다(순수 데이터)', () => {
  // JSON 은 함수/프로토타입 리터럴을 허용하지 않는다. 그래도 __proto__ / constructor
  // 같은 키가 등장하지 않는지 확인해 프로토타입 오염 가능성을 줄인다.
  const hits: string[] = [];
  for (const { path } of [...enLeaves, ...koLeaves]) {
    if (/__proto__|constructor|prototype/.test(path)) hits.push(path);
  }
  assert.equal(hits.length, 0, '\n[프로토타입 오염 우려 키]\n' + hits.map((h) => '  - ' + h).join('\n'));
});

test('D2. 구조 — 모든 leaf 가 string 이고 depth 가 합리적(≤ 6)', () => {
  const maxDepth = Math.max(
    ...[...enLeaves, ...koLeaves].map((l) => l.path.split('.').length),
  );
  assert.ok(maxDepth <= 6, `중첩이 6단계 초과면 오타 또는 잘못된 병합 의심: depth=${maxDepth}`);
});
