// Run with: npx tsx --test tests/i18n/sourceParity.spec.ts
//
// 지시 #5141b375 (Developer/베타) · i18n 정본 동기화 가드.
//
// 배경
//   `src/i18n/index.ts:14-16` 주석에 "locales/{en,ko}.json 과 src/i18n/{en,ko}.json
//   은 동일 내용을 유지해야 한다" 고 명시되어 있으나, 이를 강제하는 테스트가 없었다.
//   `tests/i18n/completeness.spec.ts` 는 `locales/*` 만 import 해 패리티를 검증하고,
//   런타임 `translate()` 는 `src/i18n/*` 를 본다. 한쪽만 갱신되면 빌드와 leaf 패리티
//   테스트는 통과하지만 런타임은 옛 키 원문이 노출되는 회귀가 발생한다.
//
// 본 spec 은 두 정본 사이의 드리프트를 즉시 잡는 가드 4종이다.
//   P1. locales/en.json ≡ src/i18n/en.json (byte-equal)
//   P2. locales/ko.json ≡ src/i18n/ko.json (byte-equal)
//   P3. src/i18n/{en,ko}.json 의 leaf 경로 집합이 동일(런타임 정본 자체 패리티)
//   P4. translate() 가 두 정본 어느 쪽으로 평가해도 동일 결과(샘플 키 4종)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { translate } from '../../src/i18n/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');

function readJsonText(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

function parseJson(rel: string): unknown {
  return JSON.parse(readJsonText(rel));
}

type LocaleTree = { [k: string]: string | LocaleTree };

function collectLeafPaths(tree: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  if (!tree || typeof tree !== 'object') return out;
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.add(path);
    else if (v && typeof v === 'object') {
      for (const p of collectLeafPaths(v, path)) out.add(p);
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// P1·P2. byte-equal — 두 정본 파일 텍스트가 완전히 동일해야 한다
// ────────────────────────────────────────────────────────────────────────────

test('P1. locales/en.json 과 src/i18n/en.json 은 바이트 단위로 동일하다', () => {
  const a = readJsonText('locales/en.json');
  const b = readJsonText('src/i18n/en.json');
  assert.equal(
    a,
    b,
    '두 en 정본이 드리프트했습니다. 한쪽만 갱신된 경우 런타임이 옛 키를 노출합니다. ' +
      '`src/i18n/index.ts:14-16` 의 동기화 약속에 따라 두 파일을 즉시 일치시키세요.',
  );
});

test('P2. locales/ko.json 과 src/i18n/ko.json 은 바이트 단위로 동일하다', () => {
  const a = readJsonText('locales/ko.json');
  const b = readJsonText('src/i18n/ko.json');
  assert.equal(
    a,
    b,
    '두 ko 정본이 드리프트했습니다. 한쪽만 갱신된 경우 런타임이 옛 키를 노출합니다. ' +
      '`src/i18n/index.ts:14-16` 의 동기화 약속에 따라 두 파일을 즉시 일치시키세요.',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// P3. src/i18n/{en,ko}.json 자체의 leaf 패리티 — 런타임 정본 단독 검증.
//      completeness.spec.ts 는 locales/* 만 검증하므로, src/i18n/* 만 패리티가
//      깨진 경우(예: ko 만 새 키 추가)를 본 가드가 잡는다.
// ────────────────────────────────────────────────────────────────────────────

test('P3-1. src/i18n/en.json 과 src/i18n/ko.json 의 leaf 경로 집합이 완전히 동일', () => {
  const en = collectLeafPaths(parseJson('src/i18n/en.json') as LocaleTree);
  const ko = collectLeafPaths(parseJson('src/i18n/ko.json') as LocaleTree);
  const onlyInEn: string[] = [];
  const onlyInKo: string[] = [];
  for (const p of en) if (!ko.has(p)) onlyInEn.push(p);
  for (const p of ko) if (!en.has(p)) onlyInKo.push(p);
  const lines: string[] = [];
  if (onlyInEn.length > 0) lines.push('[ko 누락 leaf]\n' + onlyInEn.map((p) => '  - ' + p).join('\n'));
  if (onlyInKo.length > 0) lines.push('[en 누락 leaf]\n' + onlyInKo.map((p) => '  - ' + p).join('\n'));
  assert.equal(onlyInEn.length + onlyInKo.length, 0, '\n' + lines.join('\n'));
});

// ────────────────────────────────────────────────────────────────────────────
// P4. translate() 결과가 정본 양쪽에서 동일 — 샘플 키 4종.
//      P1/P2 가 byte-equal 을 보장해도, 만약 translate() 의 import 경로가
//      바뀌어 다른 파일을 참조하게 되는 회귀를 빠르게 드러내기 위함.
// ────────────────────────────────────────────────────────────────────────────

const SAMPLE_KEYS = [
  'tokenUsage.indicator.label',
  'tokenUsage.settings.title',
  'project.newProjectWizard.loading',
  'login.title',
] as const;

test('P4. translate() 결과가 정본 JSON(직접 lookup) 결과와 일치 — 샘플 4종', () => {
  const enTree = parseJson('src/i18n/en.json') as LocaleTree;
  const koTree = parseJson('src/i18n/ko.json') as LocaleTree;

  function directLookup(tree: LocaleTree, key: string): string | undefined {
    let cursor: unknown = tree;
    for (const seg of key.split('.')) {
      if (cursor === null || typeof cursor !== 'object') return undefined;
      cursor = (cursor as Record<string, unknown>)[seg];
    }
    return typeof cursor === 'string' ? cursor : undefined;
  }

  for (const k of SAMPLE_KEYS) {
    const enDirect = directLookup(enTree, k);
    const koDirect = directLookup(koTree, k);
    if (enDirect !== undefined) {
      assert.equal(translate(k, 'en'), enDirect, `en 정본 lookup 과 translate() 결과 불일치: ${k}`);
    }
    if (koDirect !== undefined) {
      assert.equal(translate(k, 'ko'), koDirect, `ko 정본 lookup 과 translate() 결과 불일치: ${k}`);
    }
  }
});
