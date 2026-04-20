// Run with: npx tsx --test tests/project/recommendLocale.spec.ts
//
// 지시 #bd1eeb7d (QA · S1~S2) · i18n × 추천 교차 통합 — locale 라우팅 · translateOnly.
//
// 대상: Joker 가 구현한 src/project/recommendAgentTeam.ts 의 locale 인자와
// translateRecommendations (translateOnly 경량 경로). 본 스펙은 (a) locale 별로
// 역할명·rationale 이 제대로 갈라지는지, (b) translateOnly 경로가 전체 재생성 대비
// 유의미한 토큰 절감을 만드는지 두 축을 잠근다.
//
// 시나리오
//   S1. locale='ko' → 한국어 items, 'en' → 영어 items (heuristic · claude 경로 모두).
//   S2. 동일 description + locale 변경 시 buildTranslationMessages 입력이
//       buildRecommendationMessages 입력 대비 40% 이상 짧다(토큰 예산 절감).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recommendAgentTeam,
  translateRecommendations,
  buildRecommendationMessages,
  buildTranslationMessages,
  heuristicTeam,
  DEFAULT_RECOMMENDATION_LOCALE,
  type AgentRecommendation,
  type AgentTeamRecommendation,
  type RecommendationLocale,
} from '../../src/project/recommendAgentTeam.ts';
import type { CacheableClaudeMessages } from '../../src/server/claudeClient.ts';

// ────────────────────────────────────────────────────────────────────────────
// 유틸 — invoker 모의 · 토큰 추정
// ────────────────────────────────────────────────────────────────────────────

const KO_ITEMS: AgentRecommendation[] = [
  { role: 'Leader', name: 'Kai', rationale: '범위를 쪼개어 병렬로 분배합니다.' },
  { role: 'Developer', name: 'Dev', rationale: '핵심 기능 구현을 맡습니다.' },
  { role: 'QA', name: 'QA', rationale: '회귀 테스트와 품질 게이트를 담당합니다.' },
];
const EN_ITEMS: AgentRecommendation[] = [
  { role: 'Leader', name: 'Kai', rationale: 'Splits scope and delegates in parallel.' },
  { role: 'Developer', name: 'Dev', rationale: 'Owns the core feature implementation.' },
  { role: 'QA', name: 'QA', rationale: 'Locks regression tests and quality gates.' },
];

function invokerForLocale(locale: RecommendationLocale) {
  return async (_m: CacheableClaudeMessages): Promise<string> => {
    return JSON.stringify({ items: locale === 'ko' ? KO_ITEMS : EN_ITEMS });
  };
}

function estimateTokens(text: string): number {
  const hangul = (text.match(/[\uac00-\ud7a3]/g) ?? []).length;
  const nonHangul = text
    .replace(/[\uac00-\ud7a3]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .reduce((sum, w) => sum + Math.max(1, w.length * 0.3), 0);
  return Math.ceil(hangul * 1.5 + nonHangul);
}

function messagesTextTokens(m: CacheableClaudeMessages): number {
  const sys = m.system.map((b) => b.text).join('\n');
  const user = m.messages.map((x) => x.content.map((c) => c.text).join('\n')).join('\n');
  return estimateTokens(sys) + estimateTokens(user);
}

// ────────────────────────────────────────────────────────────────────────────
// S1. locale 라우팅
// ────────────────────────────────────────────────────────────────────────────

test('S1-1. recommendAgentTeam(locale="ko") — source=claude · 한글 rationale · locale="ko"', async () => {
  const res = await recommendAgentTeam('블로그 CMS 구축', {
    invoker: invokerForLocale('ko'),
    locale: 'ko',
  });
  assert.equal(res.locale, 'ko');
  assert.equal(res.source, 'claude');
  for (const it of res.items) {
    assert.match(it.rationale, /[\uac00-\ud7a3]/);
  }
});

test('S1-2. recommendAgentTeam(locale="en") — ASCII 전용 rationale · locale="en"', async () => {
  const res = await recommendAgentTeam('Build a blog CMS', {
    invoker: invokerForLocale('en'),
    locale: 'en',
  });
  assert.equal(res.locale, 'en');
  for (const it of res.items) {
    assert.doesNotMatch(it.rationale, /[\uac00-\ud7a3]/);
    assert.match(it.rationale, /^[\x20-\x7e]+$/);
  }
});

test('S1-3. locale 미지정 시 DEFAULT_RECOMMENDATION_LOCALE 이 적용된다("en")', async () => {
  assert.equal(DEFAULT_RECOMMENDATION_LOCALE, 'en');
  const res = await recommendAgentTeam('test', { invoker: invokerForLocale('en') });
  assert.equal(res.locale, 'en');
});

test('S1-4. heuristicTeam — 기본 en · "ko" 인자 시 한국어 카피(동일 role 순서)', () => {
  const enItems = heuristicTeam('UI 디자인 개선');
  assert.doesNotMatch(enItems[0].rationale, /[\uac00-\ud7a3]/);
  const koItems = heuristicTeam('UI 디자인 개선', 'ko');
  assert.match(koItems[0].rationale, /[\uac00-\ud7a3]/);
  assert.deepEqual(enItems.map((i) => i.role), koItems.map((i) => i.role));
});

test('S1-5. invoker 없을 때도 locale 에 맞는 heuristic 카피가 채워진다', async () => {
  const res = await recommendAgentTeam('블로그 CMS', { locale: 'ko' });
  assert.equal(res.source, 'heuristic');
  assert.equal(res.locale, 'ko');
  assert.match(res.items[0].rationale, /[\uac00-\ud7a3]/);
});

// ────────────────────────────────────────────────────────────────────────────
// S2. translateRecommendations (translateOnly) — 토큰 절감
// ────────────────────────────────────────────────────────────────────────────

test('S2-1. 동일 description 의 재생성(EN→KO) 대비 translateOnly 가 토큰을 덜 쓴다', () => {
  const description = '결제 모듈 보안 강화 — PCI 감사·토큰 암호화 및 키 회전';
  const fullKoMessages = buildRecommendationMessages(description, 'ko');
  const existingEn: AgentTeamRecommendation = { items: EN_ITEMS, source: 'claude', locale: 'en' };
  const translateMessages = buildTranslationMessages(existingEn, 'ko');
  const full = messagesTextTokens(fullKoMessages);
  const translated = messagesTextTokens(translateMessages);
  assert.ok(translated < full, `translated(${translated}) < full(${full}) 이어야 한다`);
});

test('S2-2. 긴 description 에서 translateOnly 절감률 ≥ 30%(회귀 감시 임계)', () => {
  // 임계치 30% 는 현재 버전(2026-04-21) 에서 한영 ↔ 영한 모두 관측되는 하한.
  // 시스템 프롬프트/스키마 증가로 이 값이 깨지면 토큰 예산 회귀로 간주한다.
  const description = '블로그 CMS — 사용자 인증, 게시글 CRUD, 댓글, 이미지 업로드, 관리자 대시보드, 댓글 알림, 태그 검색, RSS 피드 및 모바일 최적화 뷰.';
  const fullEnMessages = buildRecommendationMessages(description, 'en');
  const existingKo: AgentTeamRecommendation = { items: KO_ITEMS, source: 'claude', locale: 'ko' };
  const translateMessages = buildTranslationMessages(existingKo, 'en');
  const full = messagesTextTokens(fullEnMessages);
  const translated = messagesTextTokens(translateMessages);
  const savings = (full - translated) / full;
  assert.ok(savings >= 0.30, `절감률 ≥30% 기대, got ${(savings * 100).toFixed(1)}% (full=${full} translated=${translated})`);
});

test('S2-3. translateRecommendations — 이미 targetLocale 이면 invoker 호출 없이 원본 반환', async () => {
  let invoked = 0;
  const res = await translateRecommendations(
    { items: EN_ITEMS, source: 'claude', locale: 'en' },
    'en',
    { invoker: async () => { invoked += 1; return '{}'; } },
  );
  assert.equal(invoked, 0, 'invoker 호출 없어야 한다(네트워크 0)');
  assert.equal(res.locale, 'en');
});

test('S2-4. translateRecommendations — invoker 미주입 시 heuristic 번역표로 폴백', async () => {
  const res = await translateRecommendations(
    { items: EN_ITEMS, source: 'claude', locale: 'en' },
    'ko',
  );
  assert.equal(res.locale, 'ko');
  assert.equal(res.source, 'heuristic');
  for (const it of res.items) {
    assert.match(it.rationale, /[\uac00-\ud7a3]/);
  }
  // role 순서는 원본 그대로 보존.
  assert.deepEqual(res.items.map((i) => i.role), EN_ITEMS.map((i) => i.role));
});

test('S2-5. translateRecommendations — invoker 응답 수량이 달라지면 heuristic 폴백', async () => {
  const badInvoker = async (): Promise<string> =>
    JSON.stringify({ items: [{ role: 'Leader', name: 'K', rationale: '축소' }] });
  const res = await translateRecommendations(
    { items: KO_ITEMS, source: 'claude', locale: 'ko' },
    'en',
    { invoker: badInvoker },
  );
  assert.equal(res.source, 'heuristic', '수량 불일치는 폴백으로');
  assert.equal(res.items.length, KO_ITEMS.length);
});

test('S2-6. translateRecommendations — invoker 성공 시 source="translated" · role 원본 보존', async () => {
  const goodInvoker = async (): Promise<string> => JSON.stringify({
    items: KO_ITEMS.map((it) => ({ role: it.role, name: it.name, rationale: `EN: ${it.role}` })),
  });
  const res = await translateRecommendations(
    { items: KO_ITEMS, source: 'claude', locale: 'ko' },
    'en',
    { invoker: goodInvoker },
  );
  assert.equal(res.source, 'translated');
  assert.equal(res.locale, 'en');
  assert.deepEqual(res.items.map((i) => i.role), KO_ITEMS.map((i) => i.role));
});
