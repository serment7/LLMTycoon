// Run with: npx tsx --test tests/projects/recommendationAccuracy.spec.ts
//
// 지시 #a01fb9b7 — "추천 정확도 개선" 회귀 잠금.
//
// 본 spec 은 다섯 갈래 회귀를 한 파일에 묶는다.
//   D. 도메인 5종(커머스·게임·데이터 분석·교육·B2B SaaS) 별 추천 역할 셋이 사전
//      정의된 기대 역할 셋과 매칭(자카드 점수 ≥ 0.8)되는지 검증.
//   C. 동일 설명·동일 인원수 재요청 시 캐시 적중·LLM 호출 0회.
//   L. '역할 고정' 토글 후 새로고침(스토어 재초기화) 시 고정 역할이 유지되는지
//      `projectCreateStore` 의 실제 영속 경로(localStorage stub) 로 검증.
//   M. 설명 20자 미만(`MIN_DESCRIPTION_LENGTH`)이면 추천이 호출되지 않는 가드
//      `isDescriptionLongEnough` 가 UI 가 의지하는 정확한 임계를 강제하는지.
//   S. 한국어/영어 동의어(디자인↔design, 보안↔security, 연구↔research, 분석↔analysis,
//      화면↔screen, 테스트↔test) 가 동일 역할 셋으로 수렴.
//
// 추가 산출
//   - SNAP. 5 도메인 입력 → 추천 역할 셋·이유 한 줄·매칭 점수 를 직렬화한 스냅샷
//     문자열을 형성·검증해, 휴리스틱이나 시스템 프롬프트가 흔들릴 때 한 줄 diff 로
//     회귀를 식별할 수 있도록 한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  heuristicTeam,
  recommendAgentTeam,
  DEFAULT_RECOMMENDATION_COUNT,
  type AgentRecommendation,
  type AgentTeamRecommendation,
} from '../../src/project/recommendAgentTeam.ts';
import {
  createDebouncedRecommender,
  createRecommendationCache,
  normalizeDescription,
  type RecommenderFetcher,
} from '../../src/project/recommendationClient.ts';
import { createRecommendationCacheStore } from '../../src/llm/recommendationCacheStore.ts';
import {
  createRecommendAgentsHandler,
  type HandlerRequest,
  type HandlerResponse,
} from '../../src/server/api/recommendAgents.ts';
import {
  MIN_DESCRIPTION_LENGTH,
  isDescriptionLongEnough,
  readLockedRoles,
  persistLockedRoles,
  LOCKED_ROLES_STORAGE_KEY,
  mergeLockedRoles,
  type ProjectCreateStorage,
} from '../../src/stores/projectCreateStore.ts';
import type { AgentRole } from '../../src/types.ts';

// ─── 공용 유틸 ──────────────────────────────────────────────────────────────

interface Recorded {
  res: HandlerResponse;
  status: number;
  body: unknown;
}
function recordingResponse(): Recorded {
  const out: Recorded = {
    res: null as unknown as HandlerResponse,
    status: 0,
    body: undefined,
  };
  const res: HandlerResponse = {
    status(code) { out.status = code; return res; },
    json(body) { out.body = body; },
  };
  out.res = res;
  return out;
}

/** 자카드 유사도. */
function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : inter / union;
}

function rolesOf(team: { items: readonly AgentRecommendation[] }): Set<AgentRole> {
  return new Set(team.items.map((it) => it.role));
}

/** 메모리 storage stub — projectCreateStore / recommendCountStore 모두에 주입 가능. */
function memoryStorage(seed: Record<string, string> = {}): ProjectCreateStorage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem(key) { return map.has(key) ? map.get(key)! : null; },
    setItem(key, value) { map.set(key, value); },
    removeItem(key) { map.delete(key); },
  };
}

// ─── D. 도메인별 샘플 설명 셋 ────────────────────────────────────────────────

interface DomainSample {
  readonly key: string;
  readonly description: string;
  /** 휴리스틱이 정확히 매칭해야 하는 역할 셋. count = expected.size 로 호출해 자카드 1.0 잠금. */
  readonly expected: ReadonlySet<AgentRole>;
}

const DOMAIN_SAMPLES: readonly DomainSample[] = [
  {
    key: 'commerce',
    // 커머스 — 결제·보안·디자인·QA. PM 은 휴리스틱 카탈로그에 없으므로 Leader 로 흡수.
    description: '이커머스 결제 보안 화면 디자인 테스트 검증 플랫폼 구축',
    expected: new Set<AgentRole>(['Leader', 'Developer', 'Designer', 'QA']),
  },
  {
    key: 'game',
    description: '모바일 게임 UI 디자인 화면 보안 테스트 회귀',
    expected: new Set<AgentRole>(['Leader', 'Developer', 'Designer', 'QA']),
  },
  {
    key: 'data-analytics',
    description: '사용자 데이터 분석 시장 조사 연구 대시보드 화면 디자인',
    expected: new Set<AgentRole>(['Leader', 'Developer', 'Researcher', 'Designer']),
  },
  {
    key: 'education',
    description: '온라인 교육 플랫폼 화면 디자인 회귀 테스트 보안',
    expected: new Set<AgentRole>(['Leader', 'Developer', 'Designer', 'QA']),
  },
  {
    key: 'b2b-saas',
    // B2B SaaS — 보안 감사·시장 분석·UX 가 동시에 필요한 풀스택 케이스(5명 균형).
    description: 'B2B SaaS 보안 감사 시장 분석 대시보드 화면 설계',
    expected: new Set<AgentRole>(['Leader', 'Developer', 'Designer', 'QA', 'Researcher']),
  },
];

test('D1. 5 도메인 모두 — heuristic 추천이 기대 역할 셋과 자카드 = 1.0', () => {
  for (const sample of DOMAIN_SAMPLES) {
    const team = heuristicTeam(sample.description, 'ko', sample.expected.size);
    const actual = new Set(team.map((it) => it.role));
    const score = jaccard(actual, sample.expected);
    assert.equal(
      score,
      1,
      `[${sample.key}] 기대 ${[...sample.expected].sort().join(',')} ↔ 실제 ${[...actual].sort().join(',')}`,
    );
    assert.ok(actual.has('Leader'));
    assert.ok(actual.has('Developer'));
  }
});

test('D2. 5 도메인 모두 — recommendAgentTeam 폴백 경로에서도 동일 매칭', async () => {
  for (const sample of DOMAIN_SAMPLES) {
    const team = await recommendAgentTeam(sample.description, {
      locale: 'ko',
      count: sample.expected.size,
    });
    assert.equal(team.source, 'heuristic');
    assert.equal(team.locale, 'ko');
    const score = jaccard(rolesOf(team), sample.expected);
    assert.equal(score, 1, `[${sample.key}] 폴백 경로에서 자카드 ${score}`);
  }
});

test('D3. 5 도메인 모두 — 모든 추천 카드의 rationale 이 비어 있지 않다', () => {
  for (const sample of DOMAIN_SAMPLES) {
    const team = heuristicTeam(sample.description, 'ko', sample.expected.size);
    for (const it of team) {
      assert.ok(
        typeof it.rationale === 'string' && it.rationale.trim().length > 0,
        `[${sample.key}] ${it.role} rationale 누락`,
      );
    }
  }
});

// ─── C. 동일 설명·동일 인원수 재요청 → 캐시 적중·LLM 0 호출 ─────────────────

test('C1. handler + recommendationCacheStore — 동일 설명 두 번째는 invoker 미호출', async () => {
  const cacheStore = createRecommendationCacheStore();
  let invokerCalls = 0;
  const handler = createRecommendAgentsHandler({
    cacheStore,
    invoker: async () => {
      invokerCalls += 1;
      return JSON.stringify({
        items: [
          { role: 'Leader', name: 'Kai', rationale: 'lead' },
          { role: 'Developer', name: 'Dev', rationale: 'impl' },
        ],
      });
    },
  });
  for (const sample of DOMAIN_SAMPLES) {
    await handler(
      { body: { description: sample.description, locale: 'ko' } } as HandlerRequest,
      recordingResponse().res,
    );
  }
  assert.equal(invokerCalls, DOMAIN_SAMPLES.length, '첫 사이클은 도메인 수만큼 호출');
  for (const sample of DOMAIN_SAMPLES) {
    const second = recordingResponse();
    await handler(
      { body: { description: sample.description, locale: 'ko' } } as HandlerRequest,
      second.res,
    );
    assert.equal(
      (second.body as { source: string }).source,
      'cache',
      `[${sample.key}] 두 번째 호출이 cache 가 아니다`,
    );
  }
  assert.equal(
    invokerCalls,
    DOMAIN_SAMPLES.length,
    '재요청 사이클에서는 invoker 호출 추가 0 — LLM 토큰 0',
  );
});

test('C2. createDebouncedRecommender — 동일 description 재요청 시 fetcher 1회', async () => {
  const fetched: string[] = [];
  const fetcher: RecommenderFetcher = async ({ description }) => {
    fetched.push(description);
    return {
      items: heuristicTeam(description, 'ko', DEFAULT_RECOMMENDATION_COUNT),
      source: 'heuristic',
      locale: 'ko',
    };
  };
  const cache = createRecommendationCache(8);
  const recommender = createDebouncedRecommender({ fetcher, cache, debounceMs: 0 });
  const desc = DOMAIN_SAMPLES[0].description;
  const first = await recommender.request(desc);
  const second = await recommender.request(desc);
  assert.ok(first && second);
  assert.equal(second!.source, 'cache');
  assert.equal(fetched.length, 1);
});

// ─── L. '역할 고정' 토글 → 새로고침 후 유지 (storage 레이어 직접) ───────────

test('L1. 빈 storage — readLockedRoles 는 빈 배열', () => {
  const storage = memoryStorage();
  assert.deepEqual([...readLockedRoles(storage)], []);
});

test('L2. persistLockedRoles 후 storage 키에 JSON 으로 영속된다', () => {
  const storage = memoryStorage();
  persistLockedRoles(['Designer', 'QA'], storage);
  const raw = storage.getItem(LOCKED_ROLES_STORAGE_KEY);
  assert.ok(raw);
  const parsed = JSON.parse(raw!);
  assert.deepEqual([...parsed].sort(), ['Designer', 'QA']);
});

test('L3. 새로고침(=새 readLockedRoles 호출) 시 동일 storage 로부터 동일 값 복원', () => {
  const storage = memoryStorage();
  persistLockedRoles(['Designer', 'Researcher'], storage);
  // "새로고침" — 새로운 reader 가 동일 storage 로부터 다시 읽는다(모듈 상태 의존 없음).
  const restored = readLockedRoles(storage);
  assert.deepEqual([...restored].sort(), ['Designer', 'Researcher']);
});

test('L4. 깨진 JSON 이 storage 에 들어 있어도 readLockedRoles 는 빈 배열로 안전 폴백', () => {
  const storage = memoryStorage({ [LOCKED_ROLES_STORAGE_KEY]: 'not-json{' });
  assert.deepEqual([...readLockedRoles(storage)], []);
});

test('L5. mergeLockedRoles — 잠긴 역할은 fresh 응답에 없을 때 previous 에서 보존', () => {
  const previous: readonly AgentRecommendation[] = [
    { role: 'Designer', name: 'Dex', rationale: '직전 시안' },
    { role: 'QA', name: 'QA', rationale: '회귀 잠금' },
  ];
  const fresh: readonly AgentRecommendation[] = [
    { role: 'Leader', name: 'Kai', rationale: '분배' },
    { role: 'Developer', name: 'Dev', rationale: '구현' },
    { role: 'Researcher', name: 'Riz', rationale: '연구' },
  ];
  const merged = mergeLockedRoles(fresh, {
    lockedRoles: ['Designer', 'QA'],
    previous,
    count: 5,
  });
  const roles = merged.map((it) => it.role);
  assert.ok(roles.includes('Designer'), 'Designer 가 fresh 에 없어도 previous 에서 복원');
  assert.ok(roles.includes('QA'));
  assert.ok(roles.includes('Leader'));
});

// ─── M. 설명 20자 미만 → 추천 미호출 가드 ────────────────────────────────────

test('M1. MIN_DESCRIPTION_LENGTH 상수 = 20', () => {
  assert.equal(MIN_DESCRIPTION_LENGTH, 20);
});

test('M2. isDescriptionLongEnough — 19자 이하 false, 20자 이상 true', () => {
  assert.equal(isDescriptionLongEnough(''), false);
  assert.equal(isDescriptionLongEnough('짧은 설명'), false);
  assert.equal(isDescriptionLongEnough('a'.repeat(19)), false);
  assert.equal(isDescriptionLongEnough('a'.repeat(20)), true);
  for (const sample of DOMAIN_SAMPLES) {
    assert.ok(
      isDescriptionLongEnough(sample.description),
      `[${sample.key}] 도메인 샘플은 20자 이상이어야 한다`,
    );
  }
});

test('M3. 가드 위반 시 fetcher·cache 모두 미접근 (호출자 패턴)', async () => {
  const fetched: string[] = [];
  const fetcher: RecommenderFetcher = async ({ description }) => {
    fetched.push(description);
    return { items: [], source: 'heuristic', locale: 'ko' };
  };
  const cache = createRecommendationCache(4);
  const recommender = createDebouncedRecommender({ fetcher, cache, debounceMs: 0 });
  const tooShort = '결제 보안';
  if (isDescriptionLongEnough(tooShort)) {
    await recommender.request(tooShort);
  }
  assert.equal(fetched.length, 0);
  assert.equal(cache.size(), 0);
});

test('M4. 정규화된 길이 기준 — 앞뒤 공백·중복 공백은 trim 후 셈', () => {
  const padded = '  ' + 'a'.repeat(20) + '  ';
  assert.ok(isDescriptionLongEnough(padded));
  assert.equal(normalizeDescription(padded).length, 20);
});

// ─── S. 한국어/영어 동의어 매칭 ──────────────────────────────────────────────

interface SynonymPair {
  readonly ko: string;
  readonly en: string;
  readonly expected: AgentRole;
}
const SYNONYM_PAIRS: readonly SynonymPair[] = [
  { ko: '결제 디자인 화면 작업과 사용자 인터뷰', en: 'payment design screen work and user interviews', expected: 'Designer' },
  { ko: '결제 보안 강화와 회귀 테스트 자동화', en: 'payment security hardening and regression tests', expected: 'QA' },
  { ko: '경쟁사 연구와 트래픽 분석 데이터 정리', en: 'competitor research and traffic analysis cleanup', expected: 'Researcher' },
];

test('S1. ko/en 동의어 — 핵심 역할 키워드만 추출하면 동일 역할 셋', () => {
  for (const pair of SYNONYM_PAIRS) {
    // count=3 으로 Leader+Developer+키워드 1 역할만 잠근다(부족분 보조 채움 방지).
    const ko = heuristicTeam(pair.ko, 'ko', 3);
    const en = heuristicTeam(pair.en, 'en', 3);
    const koRoles = new Set(ko.map((it) => it.role));
    const enRoles = new Set(en.map((it) => it.role));
    assert.ok(koRoles.has(pair.expected), `[${pair.expected}] 한국어 누락 — ${[...koRoles].join(',')}`);
    assert.ok(enRoles.has(pair.expected), `[${pair.expected}] 영어 누락 — ${[...enRoles].join(',')}`);
    assert.equal(jaccard(koRoles, enRoles), 1, '한·영 추천 역할 셋이 동일해야 한다');
  }
});

test('S2. 한·영 locale 별 rationale 카피가 다른 언어로 분리되어 있다', async () => {
  const ko = await recommendAgentTeam(SYNONYM_PAIRS[0].ko, { locale: 'ko', count: 3 });
  const en = await recommendAgentTeam(SYNONYM_PAIRS[0].en, { locale: 'en', count: 3 });
  assert.ok(/[가-힣]/.test(ko.items[0].rationale), '한국어 폴백 rationale 에 한글이 있어야 한다');
  assert.ok(!/[가-힣]/.test(en.items[0].rationale), '영어 폴백 rationale 에 한글이 없어야 한다');
});

// ─── SNAP. 도메인 5종 추천 결과 스냅샷 ───────────────────────────────────────

/**
 * 휴리스틱 결과를 안정적인 한 줄 문자열로 직렬화. 점수 기반 selectTopRoles 가
 * 도입된 뒤 push 순서가 변동될 수 있으므로, 본 직렬화는 역할 셋을 정렬해
 * 추천 회귀가 발생하면 한 줄 diff 로 식별 가능하게 한다.
 */
function serializeTeam(
  domain: string,
  description: string,
  team: readonly AgentRecommendation[],
  expected: ReadonlySet<AgentRole>,
): string {
  const score = jaccard(new Set(team.map((it) => it.role)), expected);
  const sorted = [...team].sort((a, b) => a.role.localeCompare(b.role));
  const roleStr = sorted.map((it) => `${it.role}=${it.name}|${it.rationale}`).join('; ');
  return `${domain}\tscore=${score.toFixed(2)}\tdesc="${description}"\troles=[${roleStr}]`;
}

const EXPECTED_SNAPSHOT = [
  'commerce\tscore=1.00\tdesc="이커머스 결제 보안 화면 디자인 테스트 검증 플랫폼 구축"\troles=[Designer=Dex|화면 시안과 상호작용을 설계합니다.; Developer=Dev|핵심 기능 구현을 맡습니다.; Leader=Kai|범위를 쪼개고 분배합니다.; QA=QA|회귀 테스트와 품질 게이트를 담당합니다.]',
  'game\tscore=1.00\tdesc="모바일 게임 UI 디자인 화면 보안 테스트 회귀"\troles=[Designer=Dex|화면 시안과 상호작용을 설계합니다.; Developer=Dev|핵심 기능 구현을 맡습니다.; Leader=Kai|범위를 쪼개고 분배합니다.; QA=QA|회귀 테스트와 품질 게이트를 담당합니다.]',
  'data-analytics\tscore=1.00\tdesc="사용자 데이터 분석 시장 조사 연구 대시보드 화면 디자인"\troles=[Designer=Dex|화면 시안과 상호작용을 설계합니다.; Developer=Dev|핵심 기능 구현을 맡습니다.; Leader=Kai|범위를 쪼개고 분배합니다.; Researcher=Riz|레퍼런스·사례 조사를 맡습니다.]',
  'education\tscore=1.00\tdesc="온라인 교육 플랫폼 화면 디자인 회귀 테스트 보안"\troles=[Designer=Dex|화면 시안과 상호작용을 설계합니다.; Developer=Dev|핵심 기능 구현을 맡습니다.; Leader=Kai|범위를 쪼개고 분배합니다.; QA=QA|회귀 테스트와 품질 게이트를 담당합니다.]',
  'b2b-saas\tscore=1.00\tdesc="B2B SaaS 보안 감사 시장 분석 대시보드 화면 설계"\troles=[Designer=Dex|화면 시안과 상호작용을 설계합니다.; Developer=Dev|핵심 기능 구현을 맡습니다.; Leader=Kai|범위를 쪼개고 분배합니다.; QA=QA|회귀 테스트와 품질 게이트를 담당합니다.; Researcher=Riz|레퍼런스·사례 조사를 맡습니다.]',
];

test('SNAP. 5 도메인 추천 결과 스냅샷 — 휴리스틱 회귀 시 한 줄 diff', () => {
  const actual = DOMAIN_SAMPLES.map((sample) => {
    const team = heuristicTeam(sample.description, 'ko', sample.expected.size);
    return serializeTeam(sample.key, sample.description, team, sample.expected);
  });
  for (let i = 0; i < EXPECTED_SNAPSHOT.length; i += 1) {
    assert.equal(
      actual[i],
      EXPECTED_SNAPSHOT[i],
      `도메인 ${DOMAIN_SAMPLES[i].key} 스냅샷이 변경됐다 — 휴리스틱 카피·키워드·이름 표를 함께 점검`,
    );
  }
});

// ─── Integ. 5 시나리오 통합 가드 ─────────────────────────────────────────────

test('Integ. 5 시나리오 통합', async (t) => {
  await t.test('D — 도메인 매칭 자카드 = 1', () => {
    for (const sample of DOMAIN_SAMPLES) {
      const score = jaccard(
        new Set(heuristicTeam(sample.description, 'ko', sample.expected.size).map((it) => it.role)),
        sample.expected,
      );
      assert.equal(score, 1);
    }
  });
  await t.test('C — 캐시 히트 시 invoker 0 회', async () => {
    const store = createRecommendationCacheStore();
    let invokerCalls = 0;
    const handler = createRecommendAgentsHandler({
      cacheStore: store,
      invoker: async () => {
        invokerCalls += 1;
        return JSON.stringify({ items: [{ role: 'Leader', name: 'Kai', rationale: 'r' }] });
      },
    });
    await handler({ body: { description: '동일 설명 통합 가드용' } } as HandlerRequest, recordingResponse().res);
    await handler({ body: { description: '동일 설명 통합 가드용' } } as HandlerRequest, recordingResponse().res);
    assert.equal(invokerCalls, 1);
  });
  await t.test('L — 토글 후 새로고침 시 유지', () => {
    const storage = memoryStorage();
    persistLockedRoles(['QA'], storage);
    assert.ok(readLockedRoles(storage).includes('QA'));
  });
  await t.test('M — 20자 미만 가드', () => {
    assert.equal(isDescriptionLongEnough('짧음'), false);
    assert.equal(isDescriptionLongEnough(DOMAIN_SAMPLES[0].description), true);
  });
  await t.test('S — 한·영 동의어 동일 역할', () => {
    for (const pair of SYNONYM_PAIRS) {
      const ko = new Set(heuristicTeam(pair.ko, 'ko', 3).map((it) => it.role));
      const en = new Set(heuristicTeam(pair.en, 'en', 3).map((it) => it.role));
      assert.equal(jaccard(ko, en), 1);
    }
  });
});
