// 지시 #2dc45b6c · POST /api/recommendAgents — 프로젝트 설명을 받아 팀 추천 JSON 을 반환.
//
// 책임
//   1) zod 로 요청 본문 검증. 허용 필드: `{description: string, locale?: 'en'|'ko'}`.
//   2) description 이 길면 `tokenBudget` 의 `shouldCompact`·`compactHistory` 를 재사용해
//      요약 프롬프트로 축약 → LLM 입력 토큰 절약. 짧은 description 은 원문 그대로.
//   3) `recommendAgentTeam` 을 위임 호출. 실제 LLM 호출자(invoker) 는 주입 가능.
//   4) 응답은 `role/name/rationale/skills` 4 필드로 3~5명. skills 미지정 항목은
//      `DEFAULT_ROLE_SKILLS` 로 서버가 보강해 UI 가 항상 칩을 그릴 수 있게 한다.
//
// 스타일은 `userPreferences.ts`·`mcpConnections.ts` 와 정렬 — 얇은 HandlerRequest/
// Response 계약 + 팩토리. 실제 express 라우트 등록(`app.post(...)`) 은 server.ts 담당.

import { z } from 'zod';

import {
  DEFAULT_RECOMMENDATION_COUNT,
  DEFAULT_ROLE_SKILLS,
  MAX_RECOMMENDATION_COUNT,
  MIN_RECOMMENDATION_COUNT,
  clampRecommendationCount,
  recommendAgentTeam,
  type AgentRecommendation,
  type AgentTeamRecommendation,
  type RecommendAgentTeamOptions,
  type RecommendationLocale,
} from '../../project/recommendAgentTeam';
import {
  compactHistory,
  shouldCompact,
  type ConversationTurn,
} from '../../llm/tokenBudget';
import type { RecommendationCacheStore } from '../../llm/recommendationCacheStore';
import {
  USAGE_CATEGORY_RECOMMEND_AGENTS,
  type UsageLogSink,
} from '../../llm/usageLog';

// ────────────────────────────────────────────────────────────────────────────
// 요청 스키마
// ────────────────────────────────────────────────────────────────────────────

export const RecommendAgentsRequestSchema = z.object({
  description: z.string().min(1).max(4000),
  locale: z.enum(['en', 'ko']).optional(),
  // 지시 #797538d6 — 사용자가 선택한 추천 인원수. 누락 시 서버 기본 5 로 처리.
  count: z
    .number()
    .int()
    .min(MIN_RECOMMENDATION_COUNT)
    .max(MAX_RECOMMENDATION_COUNT)
    .optional(),
});

export type RecommendAgentsRequest = z.infer<typeof RecommendAgentsRequestSchema>;

/** LLM 입력 토큰 예산의 상한. 이 값 이상이 되면 description 을 요약한다. */
export const DESCRIPTION_COMPACT_THRESHOLD = 1500;

/**
 * description 을 ConversationTurn 한 건으로 포장한 뒤 shouldCompact 판정으로 걸러,
 * 초과 시 `compactHistory` 포맷을 재사용한 앞뒤 요약으로 치환한다. 요약 포맷은 한 줄
 * 이라 LLM 이 "컨텍스트로 읽기" 어렵지 않게, 원문 앞 160자와 뒤 160자 사이에 한
 * 줄 요약 메타만 끼운다.
 */
export function maybeShrinkDescription(description: string): string {
  const trimmed = description.trim();
  const approxTokens = Math.ceil(trimmed.length / 4);
  const turn: ConversationTurn = { role: 'user', content: trimmed, tokens: approxTokens };
  if (!shouldCompact([turn], DESCRIPTION_COMPACT_THRESHOLD)) return trimmed;
  // compactHistory 는 다중 턴 전용이라 단일 턴에는 효과가 없다. 정책 정신을 빌려
  // "head + 요약 메타 + tail" 패턴으로 단일 턴 축약을 구현한다.
  const head = trimmed.slice(0, 160);
  const tail = trimmed.slice(-160);
  return `${head}\n… [요약: 원본 ${trimmed.length}자, 추정 ${approxTokens}토큰 중 320자 발췌] …\n${tail}`;
}

/** 응답 항목에 기본 skills 를 보강 — 이미 있으면 그대로 둔다. */
export function ensureSkills(items: readonly AgentRecommendation[]): AgentRecommendation[] {
  return items.map((item) => {
    if (item.skills && item.skills.length > 0) return item;
    return { ...item, skills: DEFAULT_ROLE_SKILLS[item.role] };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 핸들러 계약 — 다른 API 와 정렬된 얇은 표면.
// ────────────────────────────────────────────────────────────────────────────

export interface HandlerRequest {
  readonly body?: unknown;
  readonly headers?: Record<string, string | string[] | undefined>;
}

export interface HandlerResponse {
  status(code: number): HandlerResponse;
  json(body: unknown): void;
}

export type Handler = (req: HandlerRequest, res: HandlerResponse) => Promise<void>;

export interface RecommendAgentsDeps {
  /**
   * 실제 LLM 호출자. 미주입 시 `recommendAgentTeam` 이 휴리스틱 폴백으로 수렴하므로
   * 서비스가 중단되지는 않는다. 운영에서는 Thanos 의 `client.ts` 어댑터를 주입.
   */
  readonly invoker?: RecommendAgentTeamOptions['invoker'];
  /** 익명 요청도 허용할지. 기본 true — 프로젝트 생성 모달은 로그인 전에도 쓰일 수 있다. */
  readonly allowAnonymous?: boolean;
  /** 인증 필수일 때 user 를 해석. allowAnonymous=false 인 경우에만 호출된다. */
  readonly resolveUser?: (req: HandlerRequest) => string | null;
  /** 24h TTL 응답 캐시. 주입되면 동일 설명 해시 재요청은 LLM 왕복을 생략한다. */
  readonly cacheStore?: RecommendationCacheStore;
  /** 사용량 로그. 캐시 히트/미스 카테고리 라인을 기록. 미주입 시 로깅 생략. */
  readonly usageLog?: UsageLogSink;
}

// ────────────────────────────────────────────────────────────────────────────
// 핸들러
// ────────────────────────────────────────────────────────────────────────────

export function createRecommendAgentsHandler(deps: RecommendAgentsDeps = {}): Handler {
  const allowAnonymous = deps.allowAnonymous ?? true;

  return async (req, res) => {
    if (!allowAnonymous) {
      const userId = deps.resolveUser?.(req) ?? null;
      if (!userId) {
        res.status(401).json({ ok: false, error: 'unauthenticated' });
        return;
      }
    }

    const parsed = RecommendAgentsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid-body', details: parsed.error.issues });
      return;
    }

    const originalDescription = parsed.data.description;
    const description = maybeShrinkDescription(originalDescription);
    const resolvedLocale: RecommendationLocale = parsed.data.locale ?? 'en';
    const resolvedCount = clampRecommendationCount(
      parsed.data.count ?? DEFAULT_RECOMMENDATION_COUNT,
    );

    // 1) 캐시 히트 — LLM 왕복 생략. usageLog 에 category=recommend_agents/zero-tokens 라인 기록.
    //    캐시 키는 (description, locale, count) 3 축이라 동일 설명도 인원수가 다르면 별도 슬롯.
    if (deps.cacheStore) {
      const hit = deps.cacheStore.get(originalDescription, resolvedLocale, resolvedCount);
      if (hit) {
        await deps.usageLog
          ?.appendLine(
            JSON.stringify({
              ts: new Date().toISOString(),
              model: 'cache',
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheCreation: 0,
              category: USAGE_CATEGORY_RECOMMEND_AGENTS,
              callId: 'hit',
            }),
          )
          .catch(() => undefined);
        res.status(200).json({
          ok: true,
          source: 'cache',
          locale: hit.locale,
          count: resolvedCount,
          items: ensureSkills(hit.items).slice(0, resolvedCount),
        });
        return;
      }
    }

    let outcome: AgentTeamRecommendation;
    try {
      outcome = await recommendAgentTeam(description, {
        invoker: deps.invoker,
        locale: parsed.data.locale,
        count: resolvedCount,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'recommend-failed',
        message: err instanceof Error ? err.message : 'unknown',
      });
      return;
    }

    // 2) 미스 — 성공한 경우에 한해 (description, locale, count) 키로 캐시 저장.
    if (deps.cacheStore && outcome.items.length > 0) {
      deps.cacheStore.set(originalDescription, resolvedLocale, outcome, resolvedCount);
      await deps.usageLog
        ?.appendLine(
          JSON.stringify({
            ts: new Date().toISOString(),
            model: outcome.source === 'heuristic' ? 'heuristic' : 'claude',
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheCreation: 0,
            category: USAGE_CATEGORY_RECOMMEND_AGENTS,
            callId: 'miss',
          }),
        )
        .catch(() => undefined);
    }

    const items = ensureSkills(outcome.items).slice(0, resolvedCount);
    res.status(200).json({
      ok: true,
      source: outcome.source,
      locale: outcome.locale,
      count: resolvedCount,
      items,
    });
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 클라이언트 래퍼 — UI 에서 fetch 로 호출. 실패 시 상위가 휴리스틱으로 폴백 가능.
// ────────────────────────────────────────────────────────────────────────────

export interface RecommendAgentsClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
}

export interface RecommendAgentsClient {
  readonly fetch: (input: RecommendAgentsRequest) => Promise<{
    readonly items: readonly AgentRecommendation[];
    readonly source: AgentTeamRecommendation['source'];
    readonly locale: RecommendationLocale;
    readonly count?: number;
  }>;
}

export function createRecommendAgentsClient(
  options: RecommendAgentsClientOptions = {},
): RecommendAgentsClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('fetch is missing');
  const url = `${options.baseUrl ?? ''}/api/recommendAgents`;
  return {
    async fetch(input) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`http-${res.status}`);
      const body = (await res.json()) as {
        items: AgentRecommendation[];
        source: AgentTeamRecommendation['source'];
        locale: RecommendationLocale;
        count?: number;
      };
      return {
        items: body.items,
        source: body.source,
        locale: body.locale,
        count: body.count,
      };
    },
  };
}
