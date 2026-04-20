// 지시 #9afd4247 · ResearchAdapter 실제 구현.
//
// 직전 라운드(#f64dc11e) 에서 Thanos 가 WebSearchAdapter 실구현을 완성해 단일
// 쿼리 파이프라인이 마련됐다. 본 파일은 그 위에 "다중 하위 질문 분해 → 병렬
// 검색 → 근거 정규화/중복 제거/신뢰도 점수 → 하위 질문별 요약 → ResearchReport
// 합성" 5 단계를 올린다. 디자이너 시안(`docs/designs/web-search-research-ux.md`)
// §5.5 의 ResearchReport 모양(목차 · 각주 인용 · 한계점) 을 공개 API 로 잠근다.
//
// 구성
//   (1) research(topic, options, runtime?): Promise<ResearchReport>
//       - decomposer 로 하위 질문을 만든다(모델 주입 가능, 기본은 휴리스틱).
//       - SearchProvider/WebSearchAdapter 병렬 호출 → 근거 수집.
//       - URL 기반 중복 제거 + 도메인 신뢰도 점수(0~5) + 기한(deadline) 필터.
//       - summarizer 주입(모델) 가능, 기본은 스니펫 concat 휴리스틱.
//       - ResearchReport { topic, sections, citations, toc, limitations, meta }.
//   (2) 진행률 onProgress({ stage: 'decompose'|'gather'|'synthesize'|'cite', ratio, message }).
//   (3) AbortSignal 존중 — 하위 질문 병렬 처리 중 취소되면 즉시 중단.
//   (4) 표준 오류 코드 — RESEARCH_DECOMPOSE_ERROR / RESEARCH_INSUFFICIENT_SOURCES /
//       RESEARCH_BUDGET_EXCEEDED. 부분 보고서는 `details.partial` 로 노출.
//   (5) MediaAdapter<'research'> 구현 — MultimediaRegistry 가 별칭 'research/deep'
//       로 등록한다(priority=-10 — 스켈레톤보다 우선).

import {
  MediaAdapterError,
  type MediaAdapter,
  type MediaAdapterDescriptor,
  type MediaAdapterFactory,
  type MediaAdapterInvocation,
  type MediaAdapterOutcome,
  type MediaAdapterOutput,
  type MultimediaAdapterConfig,
  type ResearchInput,
} from '../types';
import { WEB_SEARCH_REAL_ADAPTER_ID, type SearchResult, type WebSearchOptions } from './WebSearchAdapter';

export const RESEARCH_REAL_ADAPTER_ID = 'research-v1';
export const RESEARCH_ALIAS = 'research/deep';

// ────────────────────────────────────────────────────────────────────────────
// 공개 타입 — ResearchReport 등
// ────────────────────────────────────────────────────────────────────────────

export type ResearchDepth = 1 | 2 | 3;
export type ResearchProgressStage = 'decompose' | 'gather' | 'synthesize' | 'cite' | 'done';

export interface ResearchProgress {
  readonly stage: ResearchProgressStage;
  readonly ratio: number;
  readonly message?: string;
  /** gather 단계에서 현재 처리 중인 서브 쿼리 인덱스(1-base). */
  readonly subQueryIndex?: number;
  readonly subQueryTotal?: number;
}

export type ResearchProgressHandler = (progress: ResearchProgress) => void;

export interface ResearchOptions {
  readonly depth?: ResearchDepth;
  /** 하위 질문 수(기본: depth 에 따라 3/5/8). 직접 지정 시 decomposer 에게 전달. */
  readonly breadth?: number;
  readonly language?: string;
  /** ISO-8601 — 이 날짜 이후의 근거만 채택. 서버가 publishedAt 을 돌려줘야 효과. */
  readonly deadline?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: ResearchProgressHandler;
  /** 검색 옵션 기본값. 각 서브 쿼리가 공통으로 쓸 maxResults/region 등. */
  readonly searchDefaults?: WebSearchOptions;
  /** 인용 필수 여부. true 면 근거가 0 인 섹션은 보고서에서 제외한다. */
  readonly requireCitations?: boolean;
}

export interface ResearchCitation {
  readonly n: number;
  readonly url: string;
  readonly title: string;
  readonly publishedAt?: string;
  readonly source: string;
  /** 0~5 — 도메인 가중치 기반 신뢰도. */
  readonly trust: number;
}

export interface ResearchSection {
  readonly id: string;
  readonly subQuery: string;
  readonly level: 2 | 3;
  readonly title: string;
  readonly body: string;
  /** 이 섹션이 인용한 citations[].n 배열. */
  readonly citationNumbers: readonly number[];
}

export interface ResearchTocItem {
  readonly id: string;
  readonly title: string;
  readonly level: 2 | 3;
}

export interface ResearchReportMeta {
  readonly topic: string;
  readonly depth: ResearchDepth;
  readonly breadth: number;
  readonly model: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly durationMs: number;
  readonly tokensEstimated: number;
  readonly language?: string;
  readonly deadline?: string;
}

export interface ResearchReport {
  readonly topic: string;
  readonly sections: readonly ResearchSection[];
  readonly citations: readonly ResearchCitation[];
  readonly toc: readonly ResearchTocItem[];
  /** 휴리스틱·데이터 부재·API 실패로 인한 한계점 — 사용자에게 고지할 문장들. */
  readonly limitations: readonly string[];
  readonly meta: ResearchReportMeta;
  /** 서버/서밋 친화 — 마크다운 합성 본문. UI 가 바로 렌더하도록. */
  readonly markdown: string;
}

export type ResearchErrorCode =
  | 'RESEARCH_DECOMPOSE_ERROR'
  | 'RESEARCH_INSUFFICIENT_SOURCES'
  | 'RESEARCH_BUDGET_EXCEEDED';

// ────────────────────────────────────────────────────────────────────────────
// 주입 가능한 전략 — decomposer / searchRunner / summarizer
// ────────────────────────────────────────────────────────────────────────────

export interface DecomposeRequest {
  readonly topic: string;
  readonly depth: ResearchDepth;
  readonly breadth?: number;
  readonly language?: string;
  readonly signal?: AbortSignal;
}

export interface DecomposedSubQuery {
  /** 사람이 읽을 질문. 섹션 제목으로 재사용. */
  readonly question: string;
  /** 검색엔진에 넣을 질의 문자열(보통 question 과 유사). */
  readonly searchQuery: string;
}

/** 하위 질문 분해 전략. 기본 휴리스틱은 단순 템플릿. 모델 호출로 교체 가능. */
export type Decomposer = (req: DecomposeRequest) => Promise<DecomposedSubQuery[]>;

export interface SearchRunnerRequest {
  readonly subQuery: DecomposedSubQuery;
  readonly options: WebSearchOptions;
  readonly signal?: AbortSignal;
}

/** 단일 하위 질문을 실제 검색으로 돌리는 함수. WebSearchAdapter.search 를 감싸는 게 보통. */
export type SearchRunner = (req: SearchRunnerRequest) => Promise<SearchResult[]>;

export interface SummarizeRequest {
  readonly subQuery: DecomposedSubQuery;
  readonly evidences: readonly ResearchCitation[];
  readonly rawResults: readonly SearchResult[];
  readonly language?: string;
  readonly signal?: AbortSignal;
}

export interface SummarizeResponse {
  readonly body: string;
  readonly citationNumbers: readonly number[];
}

/** 섹션 요약 전략. 기본은 상위 3 건 스니펫 concat 휴리스틱. */
export type Summarizer = (req: SummarizeRequest) => Promise<SummarizeResponse>;

// ────────────────────────────────────────────────────────────────────────────
// 예산 · 신뢰도 · 기본 휴리스틱
// ────────────────────────────────────────────────────────────────────────────

export interface ResearchBudget {
  readonly maxTokens: number;
  readonly maxSearchCalls: number;
}

export const DEFAULT_BUDGET: ResearchBudget = Object.freeze({
  maxTokens: 20_000,
  maxSearchCalls: 12,
});

export function defaultBreadth(depth: ResearchDepth): number {
  if (depth === 1) return 3;
  if (depth === 3) return 8;
  return 5;
}

const DOMAIN_WEIGHT: Record<string, number> = {
  'official': 5,
  'academic': 5,
  'news': 4,
  'standard': 4,
  'blog': 2,
  'social': 1,
};

/** URL 의 호스트를 매우 대략적으로 분류해 가중치를 매긴다. UI 시안 §3.3 과 같은 축. */
export function trustScoreForUrl(url: string): number {
  let host = '';
  try { host = new URL(url).host.toLowerCase(); } catch { return 3; }
  if (/\.gov$|\.gov\.|europa\.eu$|un\.org$/.test(host)) return DOMAIN_WEIGHT.official;
  if (/\.edu$|arxiv\.org$|doi\.org$|nature\.com$|sciencedirect\.com$|acm\.org$|ieee\.org$/.test(host)) return DOMAIN_WEIGHT.academic;
  if (/nytimes\.com$|bbc\.co\.uk$|bbc\.com$|reuters\.com$|apnews\.com$|theguardian\.com$|bloomberg\.com$|wsj\.com$|hani\.co\.kr$|chosun\.com$|donga\.com$/.test(host)) return DOMAIN_WEIGHT.news;
  if (/w3\.org$|ietf\.org$|iso\.org$/.test(host)) return DOMAIN_WEIGHT.standard;
  if (/medium\.com$|substack\.com$|tistory\.com$|velog\.io$|brunch\.co\.kr$/.test(host)) return DOMAIN_WEIGHT.blog;
  if (/twitter\.com$|x\.com$|reddit\.com$|facebook\.com$/.test(host)) return DOMAIN_WEIGHT.social;
  return 3;
}

/** 기본 분해기 — 휴리스틱. "{topic}" 를 깊이별 고정 프레임에 끼운다. */
export const defaultDecomposer: Decomposer = async ({ topic, depth, breadth }) => {
  const frames = depth === 1
    ? ['요약 및 현황', '주요 논점', '관련 자료']
    : depth === 3
      ? ['정의 및 배경', '최근 동향', '사례 연구 A', '사례 연구 B', '기술적 제약', '규제/정책', '반대 의견', '향후 전망']
      : ['개요', '핵심 논점', '찬반 주장', '관련 사례', '출처 정리'];
  const n = Math.max(1, Math.min(12, breadth ?? frames.length));
  return frames.slice(0, n).map((label) => ({
    question: `${topic} — ${label}`,
    searchQuery: `${topic} ${label}`,
  }));
};

/** 기본 요약기 — 상위 3 건 스니펫 concat. 모델 없이 돌아가는 최후의 폴백. */
export const defaultSummarizer: Summarizer = async ({ subQuery, evidences, rawResults }) => {
  const top = rawResults.slice(0, 3);
  const lines: string[] = [];
  lines.push(`${subQuery.question} 에 대한 주요 근거는 다음과 같다.`);
  const findCitationNumber = (rawUrl: string): number | undefined => {
    const key = normalizeUrl(rawUrl);
    return evidences.find((c) => normalizeUrl(c.url) === key)?.n;
  };
  top.forEach((r) => {
    const num = findCitationNumber(r.url);
    const marker = num ? `[${num}]` : '';
    lines.push(`- ${r.snippet || r.title}${marker}`);
  });
  const uniqueNumbers = Array.from(new Set(
    top.map((r) => findCitationNumber(r.url)).filter((n): n is number => typeof n === 'number'),
  ));
  return {
    body: lines.join('\n'),
    citationNumbers: uniqueNumbers,
  };
};

// ────────────────────────────────────────────────────────────────────────────
// 내부 헬퍼 — 정규화 · 중복 제거 · 진행률 · 중단
// ────────────────────────────────────────────────────────────────────────────

/**
 * URL 정규화 — hash 제거, 대표적 추적 파라미터(utm_*, fbclid, gclid, ref, ref_src) 제거,
 * 끝 슬래시 제거. 정규화 실패 시 trim 된 원문을 돌려준다. 중복 제거·증거 매칭 양쪽이
 * 같은 기준을 공유하도록 export.
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    // 추적 파라미터 제거. 완벽하진 않지만 대부분의 중복 케이스를 잡는다.
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_|^fbclid$|^gclid$|^ref$|^ref_src$/.test(k)) u.searchParams.delete(k);
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return url.trim();
  }
}

function deduplicateByUrl(results: readonly SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const key = normalizeUrl(r.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function applyDeadlineFilter(results: readonly SearchResult[], deadline?: string): SearchResult[] {
  if (!deadline) return [...results];
  const cutoff = Date.parse(deadline);
  if (!Number.isFinite(cutoff)) return [...results];
  return results.filter((r) => {
    if (!r.publishedAt) return true; // publishedAt 없는 결과는 보수적으로 포함
    const t = Date.parse(r.publishedAt);
    return !Number.isFinite(t) || t >= cutoff;
  });
}

function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 4);
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new MediaAdapterError('ABORTED', '심층 조사가 취소되었습니다.', {
      adapterId: RESEARCH_REAL_ADAPTER_ID,
    });
  }
}

/** 외부 주입 훅(summarizer 등) 이 던진 표준 AbortError 를 감지. */
function isAbortError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; code?: string };
  return e.name === 'AbortError' || e.code === 'ABORT_ERR';
}

function slugifyHeading(text: string, fallback: string): string {
  const slug = text.toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

function researchError(
  code: ResearchErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): MediaAdapterError {
  const mapped = code === 'RESEARCH_BUDGET_EXCEEDED' ? 'QUOTA_EXCEEDED'
    : code === 'RESEARCH_INSUFFICIENT_SOURCES' ? 'INPUT_INVALID'
    : 'INTERNAL';
  return new MediaAdapterError(mapped, message, {
    adapterId: RESEARCH_REAL_ADAPTER_ID,
    details: { researchCode: code, ...details },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// research() — 최상위 공개 함수
// ────────────────────────────────────────────────────────────────────────────

export interface ResearchRuntime {
  readonly decomposer?: Decomposer;
  readonly searchRunner?: SearchRunner;
  readonly summarizer?: Summarizer;
  readonly budget?: ResearchBudget;
  /** 결과 합성에 포함될 최소 근거 수. 미만이면 INSUFFICIENT_SOURCES. 기본 2. */
  readonly minEvidenceCount?: number;
  /** summarizer/decomposer 가 소비할 모델 식별자. 메타에 기록된다. */
  readonly modelId?: string;
}

export async function research(
  topic: string,
  options: ResearchOptions = {},
  runtime: ResearchRuntime = {},
): Promise<ResearchReport> {
  ensureNotAborted(options.signal);
  const normalizedTopic = topic?.trim();
  if (!normalizedTopic) {
    throw researchError('RESEARCH_DECOMPOSE_ERROR', '조사 주제가 비어 있습니다.');
  }

  const depth: ResearchDepth = options.depth ?? 2;
  const breadth = options.breadth ?? defaultBreadth(depth);
  const budget = runtime.budget ?? DEFAULT_BUDGET;
  const minEvidence = Math.max(1, runtime.minEvidenceCount ?? 2);
  const modelId = runtime.modelId ?? 'heuristic-v1';
  const decomposer = runtime.decomposer ?? defaultDecomposer;
  const summarizer = runtime.summarizer ?? defaultSummarizer;
  const startedAtMs = Date.now();

  if (breadth > budget.maxSearchCalls) {
    throw researchError(
      'RESEARCH_BUDGET_EXCEEDED',
      `요청된 하위 질문 수(${breadth}) 가 최대 검색 호출 예산(${budget.maxSearchCalls}) 을 초과합니다.`,
      { breadth, maxSearchCalls: budget.maxSearchCalls },
    );
  }

  options.onProgress?.({ stage: 'decompose', ratio: 0, message: '하위 질문 분해 시작' });

  // 1) 분해.
  let subQueries: DecomposedSubQuery[];
  try {
    subQueries = await decomposer({
      topic: normalizedTopic,
      depth,
      breadth,
      language: options.language,
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof MediaAdapterError && err.code === 'ABORTED') throw err;
    throw researchError(
      'RESEARCH_DECOMPOSE_ERROR',
      `하위 질문 분해 실패: ${errorMessage(err)}`,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
  if (!subQueries || subQueries.length === 0) {
    throw researchError('RESEARCH_DECOMPOSE_ERROR', '하위 질문이 0개로 분해됐습니다.');
  }
  if (subQueries.length > budget.maxSearchCalls) {
    throw researchError(
      'RESEARCH_BUDGET_EXCEEDED',
      `분해된 하위 질문 수(${subQueries.length}) 가 최대 검색 호출 예산(${budget.maxSearchCalls}) 을 초과합니다.`,
      { subQueries: subQueries.length, maxSearchCalls: budget.maxSearchCalls },
    );
  }
  options.onProgress?.({ stage: 'decompose', ratio: 1, message: `하위 질문 ${subQueries.length}개 확정` });

  if (!runtime.searchRunner) {
    throw researchError(
      'RESEARCH_DECOMPOSE_ERROR',
      'searchRunner 가 주입되지 않았습니다. WebSearchAdapter 를 연결해야 합니다.',
    );
  }
  const runner = runtime.searchRunner;

  // 2) 병렬 검색 — Promise.allSettled 로 한 서브쿼리의 실패가 전체를 무너뜨리지 않게.
  const limitations: string[] = [];
  const perQueryRaw: Array<{ sub: DecomposedSubQuery; raw: SearchResult[] }> = [];
  const searchOptions: WebSearchOptions = { ...options.searchDefaults };

  options.onProgress?.({ stage: 'gather', ratio: 0, message: '근거 수집 시작', subQueryTotal: subQueries.length });

  const settled = await Promise.allSettled(subQueries.map(async (sub, idx) => {
    ensureNotAborted(options.signal);
    const results = await runner({
      subQuery: sub,
      options: searchOptions,
      signal: options.signal,
    });
    options.onProgress?.({
      stage: 'gather',
      ratio: (idx + 1) / subQueries.length,
      subQueryIndex: idx + 1,
      subQueryTotal: subQueries.length,
      message: `${sub.question} — ${results.length}건`,
    });
    return { sub, raw: results };
  }));

  for (let i = 0; i < settled.length; i += 1) {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      perQueryRaw.push(s.value);
    } else {
      const reason = s.reason;
      if (reason instanceof MediaAdapterError && reason.code === 'ABORTED') throw reason;
      limitations.push(`하위 질문 "${subQueries[i].question}" 의 검색이 실패했습니다: ${errorMessage(reason)}`);
    }
  }

  ensureNotAborted(options.signal);

  // 3) 정규화·중복 제거·기한 필터·신뢰도 점수 → citations 확정.
  const allRaw = perQueryRaw.flatMap((q) => q.raw);
  const dedup = deduplicateByUrl(allRaw);
  const filtered = applyDeadlineFilter(dedup, options.deadline);

  if (filtered.length < minEvidence) {
    throw researchError(
      'RESEARCH_INSUFFICIENT_SOURCES',
      `필요한 최소 근거 수(${minEvidence}) 를 충족하지 못했습니다. 확보된 근거 ${filtered.length}건.`,
      {
        partial: buildPartial(
          normalizedTopic, depth, breadth, modelId, startedAtMs,
          subQueries, filtered, limitations, [], [],
          { language: options.language, deadline: options.deadline },
        ),
      },
    );
  }

  const citations: ResearchCitation[] = filtered.map((r, idx) => ({
    n: idx + 1,
    url: r.url,
    title: r.title || r.url,
    publishedAt: r.publishedAt,
    source: r.source,
    trust: trustScoreForUrl(r.url),
  }));

  options.onProgress?.({ stage: 'synthesize', ratio: 0, message: '섹션 요약 시작' });

  // 4) 섹션별 요약.
  const sections: ResearchSection[] = [];
  let tokensUsed = 0;
  const usedIds = new Set<string>();
  for (let i = 0; i < perQueryRaw.length; i += 1) {
    ensureNotAborted(options.signal);
    const { sub, raw } = perQueryRaw[i];
    // dedup 은 normalizeUrl 기준이므로 citation 에는 첫 번째로 본 원본 URL 이 남는다.
    // 두 번째 서브쿼리가 같은 자원을 다른 추적 파라미터로 가져왔다면 원본 URL 이
    // 서로 달라 잘못 매칭 누락이 생길 수 있으므로, 증거 매칭도 같은 정규화 기준을 쓴다.
    const localEvidence = citations.filter((c) => {
      const key = normalizeUrl(c.url);
      return raw.some((r) => normalizeUrl(r.url) === key);
    });
    if (localEvidence.length === 0) {
      // 근거 0 인 서브쿼리는 requireCitations 와 무관하게 한계점으로 사용자에게
      // 고지한다. 섹션 생략은 requireCitations=true 일 때만 수행 — 기존 계약 유지.
      if (options.requireCitations) {
        limitations.push(`"${sub.question}" 에 대한 근거가 부족해 섹션을 생략했습니다.`);
        continue;
      }
      limitations.push(`"${sub.question}" 에 대한 근거가 부족합니다. 요약은 제한적 신뢰도입니다.`);
    }
    let body: string;
    let citationNumbers: readonly number[];
    try {
      const summary = await summarizer({
        subQuery: sub,
        evidences: localEvidence,
        rawResults: raw,
        language: options.language,
        signal: options.signal,
      });
      body = summary.body;
      citationNumbers = summary.citationNumbers;
    } catch (err) {
      if (err instanceof MediaAdapterError && err.code === 'ABORTED') throw err;
      if (isAbortError(err) || options.signal?.aborted) {
        throw new MediaAdapterError('ABORTED', '심층 조사가 취소되었습니다.', {
          adapterId: RESEARCH_REAL_ADAPTER_ID,
          cause: err,
        });
      }
      throw err;
    }
    // 예산 초과 시 이미 완성된 섹션들(sections) 은 partial 로 돌려주되, 현재 섹션은
    // 반영하지 않는다 — 본문이 통째로 잘렸음을 한계점으로 기록한다.
    const tokensAfter = tokensUsed + estimateTokensFromText(body);
    if (tokensAfter > budget.maxTokens) {
      limitations.push(`"${sub.question}" 요약이 토큰 예산 초과로 잘렸습니다.`);
      throw researchError(
        'RESEARCH_BUDGET_EXCEEDED',
        `요약 본문 토큰 합계(${tokensAfter}) 가 예산(${budget.maxTokens}) 을 초과했습니다.`,
        {
          tokensUsed: tokensAfter,
          maxTokens: budget.maxTokens,
          partial: buildPartial(
            normalizedTopic, depth, breadth, modelId, startedAtMs,
            subQueries, filtered, limitations, sections, citations,
            { language: options.language, deadline: options.deadline },
          ),
        },
      );
    }
    tokensUsed = tokensAfter;
    let id = slugifyHeading(sub.question, `section-${i + 1}`);
    let suffix = 1;
    while (usedIds.has(id)) { suffix += 1; id = `${slugifyHeading(sub.question, `section-${i + 1}`)}-${suffix}`; }
    usedIds.add(id);
    sections.push({
      id,
      subQuery: sub.searchQuery,
      level: 2,
      title: sub.question,
      body,
      citationNumbers,
    });
    options.onProgress?.({
      stage: 'synthesize',
      ratio: (i + 1) / perQueryRaw.length,
      message: `${sub.question} 요약 완료`,
      subQueryIndex: i + 1,
      subQueryTotal: perQueryRaw.length,
    });
  }

  if (sections.length === 0) {
    throw researchError(
      'RESEARCH_INSUFFICIENT_SOURCES',
      '요약할 섹션이 없습니다. 근거가 모든 하위 질문에서 부족했을 가능성이 있습니다.',
      {
        partial: buildPartial(
          normalizedTopic, depth, breadth, modelId, startedAtMs,
          subQueries, filtered, limitations, [], [],
          { language: options.language, deadline: options.deadline },
        ),
      },
    );
  }

  options.onProgress?.({ stage: 'cite', ratio: 0.5, message: '인용/목차 결합' });

  const finishedAtMs = Date.now();
  const report: ResearchReport = {
    topic: normalizedTopic,
    sections,
    citations,
    toc: sections.map((s) => ({ id: s.id, title: s.title, level: s.level })),
    limitations,
    meta: {
      topic: normalizedTopic,
      depth,
      breadth,
      model: modelId,
      startedAtMs,
      finishedAtMs,
      durationMs: finishedAtMs - startedAtMs,
      tokensEstimated: tokensUsed,
      language: options.language,
      deadline: options.deadline,
    },
    markdown: renderMarkdown(normalizedTopic, sections, citations, limitations, {
      depth, breadth, model: modelId, durationMs: finishedAtMs - startedAtMs, tokensEstimated: tokensUsed,
    }),
  };

  options.onProgress?.({ stage: 'done', ratio: 1, message: '보고서 합성 완료' });
  return report;
}

// ────────────────────────────────────────────────────────────────────────────
// 내부 — 부분 보고서 합성(예산 초과/근거 부족 오류 시 details.partial 로 노출)
// ────────────────────────────────────────────────────────────────────────────

function buildPartial(
  topic: string,
  depth: ResearchDepth,
  breadth: number,
  modelId: string,
  startedAtMs: number,
  subQueries: readonly DecomposedSubQuery[],
  filteredResults: readonly SearchResult[],
  limitations: readonly string[],
  sections: readonly ResearchSection[] = [],
  citations: readonly ResearchCitation[] = [],
  extra: { language?: string; deadline?: string } = {},
): Partial<ResearchReport> {
  // finishedAtMs 와 durationMs 는 같은 Date.now() 스냅샷에서 파생되어야 meta 내
  // 시간값이 1ms 이상 어긋나지 않는다. 이전에는 Date.now() 두 번 호출로 미세
  // 드리프트가 있어 회귀 추적을 방해했다.
  const finishedAtMs = Date.now();
  return {
    topic,
    sections,
    citations: citations.length > 0 ? citations : filteredResults.map((r, idx) => ({
      n: idx + 1,
      url: r.url,
      title: r.title || r.url,
      publishedAt: r.publishedAt,
      source: r.source,
      trust: trustScoreForUrl(r.url),
    })),
    toc: sections.map((s) => ({ id: s.id, title: s.title, level: s.level as 2 | 3 })),
    limitations: [...limitations, `보고서가 중도 중단됐습니다. 하위 질문 ${subQueries.length}개 중 ${sections.length}개만 합성됨.`],
    meta: {
      topic, depth, breadth, model: modelId,
      startedAtMs, finishedAtMs,
      durationMs: finishedAtMs - startedAtMs,
      tokensEstimated: sections.reduce((acc, s) => acc + estimateTokensFromText(s.body), 0),
      language: extra.language,
      deadline: extra.deadline,
    },
  };
}

function renderMarkdown(
  topic: string,
  sections: readonly ResearchSection[],
  citations: readonly ResearchCitation[],
  limitations: readonly string[],
  meta: { depth: ResearchDepth; breadth: number; model: string; durationMs: number; tokensEstimated: number },
): string {
  const lines: string[] = [];
  lines.push(`# ${topic}`);
  lines.push('');
  lines.push(`> 깊이 ${meta.depth} · 하위 질문 ${meta.breadth}개 · 모델 ${meta.model} · 소요 ${Math.round(meta.durationMs / 1000)}초 · 예상 토큰 ${meta.tokensEstimated}`);
  lines.push('');
  lines.push('## 목차');
  sections.forEach((s, i) => lines.push(`${i + 1}. [${s.title}](#${s.id})`));
  lines.push('');
  for (const s of sections) {
    lines.push(`## ${s.title}`);
    lines.push('');
    lines.push(s.body);
    lines.push('');
  }
  if (limitations.length > 0) {
    lines.push('## 한계점');
    for (const l of limitations) lines.push(`- ${l}`);
    lines.push('');
  }
  lines.push('## 출처');
  for (const c of citations) {
    const date = c.publishedAt ? ` · ${c.publishedAt}` : '';
    lines.push(`[${c.n}] [${c.title}](${c.url})${date} — 신뢰도 ${c.trust}/5 · ${c.source}`);
  }
  return lines.join('\n');
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

// ────────────────────────────────────────────────────────────────────────────
// MediaAdapter<'research'> 구현
// ────────────────────────────────────────────────────────────────────────────

function createDescriptor(): MediaAdapterDescriptor {
  return {
    kind: 'research',
    id: RESEARCH_REAL_ADAPTER_ID,
    displayName: '심층 조사 어댑터(실구현)',
    supportedInputMimes: [],
    producedOutputMimes: ['text/markdown'],
    capabilities: {
      canParse: false,
      canGenerate: true,
      streamsProgress: true,
      worksOffline: false,
      requiresUserConsent: false,
    },
    priority: -10,
    // 웹 검색 실구현에 의존(지시 #f64dc11e 의 id). 스켈레톤(builtin-web-search) 은
    // 레지스트리 기본 구성에서 더 이상 직접 등록되지 않는다.
    dependsOn: [WEB_SEARCH_REAL_ADAPTER_ID],
  };
}

export interface ResearchAdapterOptions {
  readonly runtime?: ResearchRuntime;
}

export class ResearchAdapter implements MediaAdapter<'research'> {
  readonly descriptor: MediaAdapterDescriptor = createDescriptor();
  private readonly config: MultimediaAdapterConfig;
  private readonly runtime: ResearchRuntime;

  constructor(config: MultimediaAdapterConfig, options: ResearchAdapterOptions = {}) {
    this.config = config;
    this.runtime = options.runtime ?? {};
  }

  canHandle(input: ResearchInput): boolean {
    return Boolean(input && typeof input.topic === 'string' && input.topic.trim().length > 0);
  }

  /** UI 친화 공개 메서드 — ResearchReport 전체를 돌려준다. */
  async research(topic: string, options: ResearchOptions = {}): Promise<ResearchReport> {
    return research(topic, options, this.runtime);
  }

  /** MediaAdapter 계약 — OutputMap 에 맞춰 summary+citations 만 축약 반환. */
  async invoke(
    call: MediaAdapterInvocation<'research'>,
  ): Promise<MediaAdapterOutcome<MediaAdapterOutput<'research'>>> {
    void this.config.timeoutMs;
    const startedAtMs = Date.now();
    const report = await this.research(call.input.topic, {
      depth: call.input.depth ?? 2,
      requireCitations: call.input.requireCitations,
      signal: call.signal,
      onProgress: (p) => call.onProgress?.({
        phase: p.stage === 'done' ? 'finalize' : 'upload',
        ratio: p.ratio,
        message: p.message,
      }),
    });
    return {
      adapterId: this.descriptor.id,
      startedAtMs,
      finishedAtMs: Date.now(),
      result: {
        summary: report.markdown,
        citations: report.citations.map((c) => c.url),
      },
      warnings: report.limitations.length > 0 ? report.limitations : undefined,
    };
  }
}

export const createResearchRealAdapter: MediaAdapterFactory<'research'> =
  (config) => new ResearchAdapter(config);

/** 지시문이 명시한 별칭 'research/deep' 로 레지스트리에 올리기 위한 헬퍼. */
export function registerResearchAdapter(
  register: (factory: MediaAdapterFactory<'research'>, descriptor: MediaAdapterDescriptor) => void,
  options: { alias?: string } = {},
): void {
  const probe = new ResearchAdapter({ maxBytes: 0, timeoutMs: 0 });
  const descriptor: MediaAdapterDescriptor = {
    ...probe.descriptor,
    displayName: `${probe.descriptor.displayName} (${options.alias ?? RESEARCH_ALIAS})`,
  };
  register(createResearchRealAdapter, descriptor);
}
