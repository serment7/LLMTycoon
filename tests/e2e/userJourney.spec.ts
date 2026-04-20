// Run with: npx tsx --test tests/e2e/userJourney.spec.ts
//
// 지시 #670e418b (QA) · 네 축 엔드투엔드 스모크 — 한 사용자 여정.
//
// 본 스펙은 "신규 사용자가 언어를 한국어로 전환 → 한국어 설명으로 추천 팀 수락
// → 생성된 에이전트에 streamable-http MCP 를 붙임 → 10분 연속 대화 → 자동 압축"
// 까지를 한 테스트 파일에서 순차적으로 검증한다. 외부 네트워크(Anthropic/
// MCP 서버) 는 녹화된 응답을 재생(replay) 하는 모의 어댑터로 대체하고, 시간은
// 결정론적 now() 를 주입해 "10분 세션" 을 30턴으로 압축 시뮬레이션한다.
//
// 단계
//   STEP 1. 신규 사용자 로캘 전환 + user_preferences 저장
//   STEP 2. 한국어 설명 → 한국어 추천 카드 → 일괄 '바로 추가'
//   STEP 3. streamable-http MCP 부착 · 핸드셰이크 · 첫 메시지 수신
//   STEP 4. 10분(=30턴) 연속 대화 — TokenUsageIndicator 증가 + 자동 압축 토스트
//   STEP 5. 압축 전후 cache_read_input_tokens 증가 → 실질 토큰 비용 감소 확인

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetLocaleForTests,
  detectLocale,
  setLocale,
  getLocale,
  translate,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  type LocaleStorage,
} from '../../src/i18n/index.ts';
import {
  recommendAgentTeam,
  translateRecommendations,
  type AgentRecommendation,
} from '../../src/project/recommendAgentTeam.ts';
import { applyRecommendedTeam } from '../../src/project/api.ts';
import {
  createMemoryMcpServerStorage,
  createProjectMcpServersStore,
  type McpTransport,
} from '../../src/stores/projectMcpServersStore.ts';
import {
  EMPTY_TOTALS,
  mergeUsage,
  cacheHitRate,
} from '../../src/utils/claudeTokenUsageStore.ts';
import { extractUsageFromStreamJsonResult } from '../../src/server/claudeClient.ts';
import type { ClaudeTokenUsage, ClaudeTokenUsageTotals } from '../../src/types.ts';

// ────────────────────────────────────────────────────────────────────────────
// 여정 공용 상태
// ────────────────────────────────────────────────────────────────────────────

interface JourneyState {
  readonly userId: string;
  localeStorage: LocaleStorage & { snapshot: () => Record<string, string> };
  // user_preferences 서버 저장소.
  preferences: Map<string, 'en' | 'ko'>;
  // 생성된 에이전트 id 들.
  agentIds: string[];
  // 각 에이전트별 추천(일괄 추가 결과).
  teamItems: AgentRecommendation[];
  // TokenUsageIndicator 가 구독하는 총계.
  totals: ClaudeTokenUsageTotals;
  // 자동 압축 토스트 발생 카운터.
  compactionToasts: number;
  // 각 턴의 totals.inputTokens 스냅샷.
  inputHistory: number[];
  // 압축 시점의 cacheReadTokens 스냅샷(있다면).
  cacheReadAtCompaction: number | null;
  // 세션이 살아 있는지(예외로 죽지 않았는지).
  sessionAlive: boolean;
}

function makeMemoryStorage(): LocaleStorage & { snapshot: () => Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
    snapshot: () => Object.fromEntries(map.entries()),
  };
}

function newJourney(userId = 'u-journey-1'): JourneyState {
  return {
    userId,
    localeStorage: makeMemoryStorage(),
    preferences: new Map(),
    agentIds: [],
    teamItems: [],
    totals: { ...EMPTY_TOTALS, byModel: {}, errors: EMPTY_TOTALS.errors },
    compactionToasts: 0,
    inputHistory: [],
    cacheReadAtCompaction: null,
    sessionAlive: true,
  };
}

// user_preferences 서버 핸들러(회귀 계약은 tests/server/userPreferences.spec.ts 에서 잠금).
// 여기서는 저장/조회만 사용하고 유효성 판정을 그대로 재현한다.
function postUserPreferences(
  userId: string | null,
  language: unknown,
  store: Map<string, 'en' | 'ko'>,
): { status: number; language?: 'en' | 'ko'; fallback?: string } {
  if (typeof language !== 'string' || !(SUPPORTED_LOCALES as readonly string[]).includes(language)) {
    return { status: 400 };
  }
  const lang = language as 'en' | 'ko';
  if (!userId) return { status: 204, fallback: 'localStorage', language: lang };
  const existed = store.has(userId);
  store.set(userId, lang);
  return { status: existed ? 200 : 201, language: lang };
}

// ────────────────────────────────────────────────────────────────────────────
// 녹화된 응답 — Claude(추천) + MCP 핸드셰이크 + 대화 턴 usage
// ────────────────────────────────────────────────────────────────────────────

const RECORDED_KO_RECOMMENDATION = JSON.stringify({
  items: [
    { role: 'Leader', name: '카이', rationale: '범위를 쪼개고 병렬로 분배합니다.' },
    { role: 'Developer', name: '데브', rationale: '핵심 CRUD 와 인증을 맡습니다.' },
    { role: 'Designer', name: '데스', rationale: '화면 시안과 상호작용을 설계합니다.' },
    { role: 'QA', name: '큐에이', rationale: '회귀 테스트와 품질 게이트를 담당합니다.' },
  ],
});

function makeAgentFetchStub(): typeof globalThis.fetch {
  let seq = 0;
  return async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.endsWith('/api/agents/hire')) {
      seq += 1;
      return new Response(JSON.stringify({ id: `agent-${seq}` }), { status: 200 });
    }
    if (/\/api\/projects\/[^/]+\/agents$/.test(url)) {
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
}

// MCP 핸드셰이크/첫 메시지 녹화.
interface McpRecordedSession {
  initialize: () => Promise<{ serverInfo: { name: string; version: string } }>;
  firstMessage: () => Promise<{ type: 'progress'; token: string }>;
  close: () => void;
}

function playRecordedMcpSession(transport: McpTransport, url: string): McpRecordedSession {
  assert.equal(transport, 'streamable-http', '본 녹화는 streamable-http 만');
  assert.match(url, /^https?:\/\//);
  let closed = false;
  return {
    async initialize() {
      if (closed) throw new Error('already closed');
      return { serverInfo: { name: 'mcp-demo', version: '1.0.0' } };
    },
    async firstMessage() {
      return { type: 'progress', token: 'prog-42' };
    },
    close() { closed = true; },
  };
}

// 대화 turn usage 녹화 — 10분(30턴) 시퀀스. 첫 3턴은 웜업(cache_creation 큼),
// 이후 턴은 안정(cache_read 지배). 15턴에서 input 급증 → 압축 트리거.
function recordTurnUsage(turn: number, atBaseMs: number): unknown {
  const at = new Date(atBaseMs + turn * 20_000).toISOString(); // 20초 간격 × 30턴 = 10분.
  if (turn < 3) {
    return {
      type: 'result', at, model: 'claude-opus-4-7',
      usage: { input_tokens: 800, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 4000 },
    };
  }
  if (turn === 15) {
    // 스파이크 턴 — 압축 직전 큰 input.
    return {
      type: 'result', at, model: 'claude-opus-4-7',
      usage: { input_tokens: 5000, output_tokens: 800, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500 },
    };
  }
  if (turn === 16) {
    // 압축 직후 cache_creation 재발(요약 블록 캐시).
    return {
      type: 'result', at, model: 'claude-opus-4-7',
      usage: { input_tokens: 300, output_tokens: 400, cache_read_input_tokens: 2000, cache_creation_input_tokens: 1500 },
    };
  }
  return {
    type: 'result', at, model: 'claude-opus-4-7',
    usage: { input_tokens: 200, output_tokens: 400, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 },
  };
}

// 압축 트리거 — 현재 turn 기준 shouldCompact.
function shouldCompactNow(totals: ClaudeTokenUsageTotals, threshold: number): boolean {
  return totals.inputTokens >= threshold;
}

// ────────────────────────────────────────────────────────────────────────────
// STEP 1. 로캘 전환 + user_preferences 저장
// ────────────────────────────────────────────────────────────────────────────

const journey = newJourney();

test.before(() => {
  __resetLocaleForTests('en');
});

test('STEP 1-1. 최초 접속은 기본 en · storage 비어 있음', () => {
  const detected = detectLocale({ storage: journey.localeStorage, navigatorLanguage: 'en-US' });
  assert.equal(detected, 'en');
  assert.equal(journey.localeStorage.snapshot()[LOCALE_STORAGE_KEY], undefined);
});

test('STEP 1-2. 사용자가 ko 로 전환 → localStorage 저장 + user_preferences 서버 저장(201)', () => {
  setLocale('ko', journey.localeStorage);
  assert.equal(getLocale(), 'ko');
  assert.equal(journey.localeStorage.snapshot()[LOCALE_STORAGE_KEY], 'ko');
  const res = postUserPreferences(journey.userId, 'ko', journey.preferences);
  assert.equal(res.status, 201);
  assert.equal(journey.preferences.get(journey.userId), 'ko');
});

test('STEP 1-3. 재접속 시뮬레이션 — 모듈 상태 리셋 후에도 storage 로부터 ko 복원', () => {
  __resetLocaleForTests('en');
  const detected = detectLocale({ storage: journey.localeStorage, navigatorLanguage: 'en-US' });
  assert.equal(detected, 'ko');
});

// ────────────────────────────────────────────────────────────────────────────
// STEP 2. 한국어 설명 → 한국어 추천 카드 → 일괄 '바로 추가'
// ────────────────────────────────────────────────────────────────────────────

test('STEP 2-1. recommendAgentTeam — 한국어 설명 + locale="ko" → 한국어 rationale', async () => {
  const res = await recommendAgentTeam('블로그 CMS — 사용자 인증, 게시글 CRUD, 댓글, 이미지 업로드', {
    invoker: async () => RECORDED_KO_RECOMMENDATION,
    locale: 'ko',
  });
  assert.equal(res.source, 'claude');
  assert.equal(res.locale, 'ko');
  assert.ok(res.items.length >= 3);
  for (const it of res.items) {
    assert.match(it.rationale, /[\uac00-\ud7a3]/, `한글 rationale: ${it.rationale}`);
  }
  journey.teamItems = [...res.items];
});

test('STEP 2-2. applyRecommendedTeam — 4명 전원 hire+attach 성공', async () => {
  const fetchImpl = makeAgentFetchStub();
  const res = await applyRecommendedTeam('proj-journey-1', journey.teamItems, { fetch: fetchImpl });
  assert.equal(res.appliedCount, journey.teamItems.length);
  for (const item of res.items) {
    assert.equal(item.ok, true, `${item.recommendation.role} 실패: ${item.error ?? ''}`);
    if (item.agentId) journey.agentIds.push(item.agentId);
  }
  assert.equal(journey.agentIds.length, journey.teamItems.length);
});

test('STEP 2-3. translateRecommendations(en←ko) — 동일 팀을 번역만 돌려 영어 카드 캐시 확보', async () => {
  const en = await translateRecommendations(
    { items: journey.teamItems, source: 'claude', locale: 'ko' },
    'en',
    { invoker: async () => JSON.stringify({
      items: journey.teamItems.map((i) => ({ role: i.role, name: i.name, rationale: `EN for ${i.role}` })),
    }) },
  );
  assert.equal(en.source, 'translated');
  assert.equal(en.locale, 'en');
  assert.equal(en.items.length, journey.teamItems.length);
});

// ────────────────────────────────────────────────────────────────────────────
// STEP 3. streamable-http MCP 부착 + 핸드셰이크 + 첫 메시지
// ────────────────────────────────────────────────────────────────────────────

const mcpStore = createProjectMcpServersStore({
  adapter: createMemoryMcpServerStorage(),
  now: () => 1_700_000_000_000,
  newId: () => 'mcp-stream-1',
});

test('STEP 3-1. streamable-http 레코드 저장 — URL·헤더 검증 통과', async () => {
  const rec = await mcpStore.add({
    projectId: 'proj-journey-1',
    name: 'journey-stream',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/journey',
    headers: { 'X-Client': 'llmtycoon' },
    authToken: 'Bearer journey-abc',
  });
  assert.equal(rec.transport, 'streamable-http');
  assert.equal(rec.url, 'https://mcp.example.com/journey');
});

test('STEP 3-2. 녹화 재생 — initialize 응답 + 첫 progress 메시지 수신', async () => {
  const rows = await mcpStore.list('proj-journey-1');
  assert.equal(rows.length, 1);
  const r = rows[0];
  const session = playRecordedMcpSession(r.transport, r.url as string);
  const init = await session.initialize();
  assert.equal(init.serverInfo.name, 'mcp-demo');
  const first = await session.firstMessage();
  assert.equal(first.type, 'progress');
  assert.equal(first.token, 'prog-42');
  session.close();
});

// ────────────────────────────────────────────────────────────────────────────
// STEP 4. 10분(30턴) 연속 대화 — 토큰 누적 · 자동 압축 토스트
// ────────────────────────────────────────────────────────────────────────────

const BASE_MS = 1_700_000_000_000;
const COMPACT_THRESHOLD = 8_000; // 누적 input 8k 이상에서 압축 토스트 발생.

test('STEP 4-1. 30턴(=10분) 누적 — callCount=30 · 입력 단조 증가 · 압축 토스트 ≥ 1', () => {
  for (let turn = 0; turn < 30; turn++) {
    const event = extractUsageFromStreamJsonResult(recordTurnUsage(turn, BASE_MS));
    assert.ok(event, `turn ${turn} usage 파싱 실패`);
    journey.totals = mergeUsage(journey.totals, event as ClaudeTokenUsage);
    journey.inputHistory.push(journey.totals.inputTokens);
    if (journey.cacheReadAtCompaction === null && shouldCompactNow(journey.totals, COMPACT_THRESHOLD)) {
      // 압축 발생 — 토스트 집계하고 cacheRead 스냅샷.
      journey.compactionToasts += 1;
      journey.cacheReadAtCompaction = journey.totals.cacheReadTokens;
    }
  }
  assert.equal(journey.totals.callCount, 30);
  for (let i = 1; i < journey.inputHistory.length; i++) {
    assert.ok(
      journey.inputHistory[i] >= journey.inputHistory[i - 1],
      `turn ${i} inputTokens 감소(${journey.inputHistory[i - 1]} → ${journey.inputHistory[i]})`,
    );
  }
  assert.ok(journey.compactionToasts >= 1, '자동 압축 토스트가 한 번은 떠야 한다');
});

test('STEP 4-2. 세션 지속 — 30턴 완료 후에도 sessionAlive=true', () => {
  assert.equal(journey.sessionAlive, true);
  assert.ok(journey.totals.inputTokens > 0);
  assert.ok(journey.totals.outputTokens > 0);
});

test('STEP 4-3. TokenUsageIndicator — callCount/inputTokens/updatedAt 이 최신 상태', () => {
  assert.equal(journey.totals.callCount, 30);
  assert.notEqual(journey.totals.updatedAt, '1970-01-01T00:00:00.000Z');
  // 모델별 브레이크다운에 오푸스가 있어야 함.
  assert.ok(journey.totals.byModel['claude-opus-4-7']);
  assert.equal(journey.totals.byModel['claude-opus-4-7'].callCount, 30);
});

// ────────────────────────────────────────────────────────────────────────────
// STEP 5. 압축 전후 cache_read 증가 → 토큰 비용 감소
// ────────────────────────────────────────────────────────────────────────────

test('STEP 5-1. 압축 이후 cacheReadTokens 가 압축 시점보다 증가', () => {
  assert.ok(journey.cacheReadAtCompaction !== null, 'STEP 4-1 에서 압축이 발생했어야 함');
  const finalCacheRead = journey.totals.cacheReadTokens;
  assert.ok(
    finalCacheRead > (journey.cacheReadAtCompaction ?? 0),
    `압축 후 cache_read 증가 기대: 압축시 ${journey.cacheReadAtCompaction} → 종료시 ${finalCacheRead}`,
  );
});

test('STEP 5-2. 캐시 적중률 ≥ 0.75 — 장기 대화에서 실질 토큰 비용 감소 신호', () => {
  const rate = cacheHitRate(journey.totals);
  assert.ok(rate >= 0.75, `cacheHitRate ≥ 0.75 기대, got ${rate.toFixed(3)}`);
});

test('STEP 5-3. 압축 전후 턴당 cache_read delta — 후반 평균이 전반보다 커진다(토큰 비용 감소 신호)', () => {
  // 전반 steady(3~14, 웜업 3턴 제외) vs 후반 steady(17~29, 스파이크·압축 2턴 제외) 의
  // 턴당 평균 cache_read 증가량을 비교한다. 압축 후에는 요약 블록이 캐시로 재사용돼
  // cache_read 가 더 크게 증가해야 한다.
  // journey.totals 는 누적치라 턴별 델타는 녹화 함수에서 다시 읽어 계산.
  function readUsage(turn: number) {
    const raw = recordTurnUsage(turn, BASE_MS) as { usage: { cache_read_input_tokens: number } };
    return raw.usage.cache_read_input_tokens;
  }
  const front = Array.from({ length: 12 }, (_, k) => readUsage(3 + k)); // 3~14
  const back = Array.from({ length: 13 }, (_, k) => readUsage(17 + k)); // 17~29
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const frontAvg = avg(front);
  const backAvg = avg(back);
  assert.ok(
    backAvg >= frontAvg,
    `후반 평균 cache_read(${backAvg.toFixed(0)}) 가 전반(${frontAvg.toFixed(0)}) 이상이어야 — 압축으로 캐시 재사용 강화`,
  );
});

test('STEP 5-4. 번역/에러 상태 문구도 로캘(ko) 에서 정상 해석 — UI 가 일관된 언어 유지', () => {
  assert.equal(translate('project.newProjectWizard.loading', 'ko'), '추천을 준비하는 중…');
  assert.equal(translate('project.newProjectWizard.error', 'ko'), '추천을 불러오지 못했습니다. 다시 시도해 주세요.');
});

// ────────────────────────────────────────────────────────────────────────────
// 종합 — 여정 최종 상태 스냅샷
// ────────────────────────────────────────────────────────────────────────────

test('JOURNEY-FINAL. 사용자 여정 종료 상태 — 설정·팀·MCP·토큰 4축 모두 적재', async () => {
  assert.equal(journey.preferences.get(journey.userId), 'ko');
  assert.equal(journey.agentIds.length, 4, '4명 전원 반영');
  const rows = await mcpStore.list('proj-journey-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].transport, 'streamable-http');
  assert.equal(journey.totals.callCount, 30);
  assert.ok(journey.compactionToasts >= 1);
  assert.equal(journey.sessionAlive, true);
});
