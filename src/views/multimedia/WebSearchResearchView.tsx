// 지시 #e1c566ad · 멀티미디어 허브 '웹검색·리서치' 통합 세부 뷰.
//
// 디자이너 시안(docs/designs/web-search-research-ux.md) 의 tablist(검색/리서치) + 3 영역
// 구조를 Thanos 의 WebSearchAdapter/ResearchAdapter 와 결합한다. 본 뷰는 두 어댑터의
// 공개 API(search() · research()) 와 직접 통신하되, 테스트 가능성을 위해 API 는 props
// 로 주입 가능하게 두고 기본값은 레지스트리에서 꺼내 쓴다.
//
// 라우트는 /multimedia/search 로 등록(MultimediaHub 에서 직접 매핑) · 모드는 상태로만
// 관리. 'research' 카드에서 진입 시 initialMode='research' 가 들어온다.
//
// 본 컴포넌트의 책임 경계
//   · 네트워크 호출: props.search / props.research 를 통해 위임. 기본 주입은 레지스트리
//     에서 resolveByKind('web-search'|'research').invoke() 를 감싸는 어댑터 함수.
//   · 상태(쿼리·필터·페이지·즐겨찾기·인용 카트·리서치 단계) 는 모두 로컬 state. 서버
//     영속화는 후속 PR 에서 useMultimediaJobs.store 와 병합.
//   · 장시간 리서치는 useMultimediaJobs 에 job 으로 등록해 전역 작업 큐 패널(디자이너
//     병렬 작업) 과 자동 연결된다.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  Compass,
  Filter as FilterIcon,
  Star,
  Bookmark,
  ExternalLink,
  RotateCw,
  AlertTriangle,
  Clock,
  FileDown,
  Play,
  Pause,
  X,
} from 'lucide-react';

import type {
  SearchResult,
  SafeSearchLevel,
  FreshnessFilter,
  WebSearchOptions,
} from '../../services/multimedia/adapters/WebSearchAdapter';
import type {
  ResearchReport,
  ResearchProgress,
  ResearchDepth,
} from '../../services/multimedia/adapters/ResearchAdapter';
import { MediaAdapterError } from '../../services/multimedia';
import { MultimediaAdapterShell } from './MultimediaAdapterShell';
import type { MultimediaCardMeta } from './routes';
import { useMultimediaJobs, type MultimediaJob } from './useMultimediaJobs';

// ────────────────────────────────────────────────────────────────────────────
// 외부 주입 API
// ────────────────────────────────────────────────────────────────────────────

export type WebSearchRunner = (
  query: string,
  opts: WebSearchOptions & { page?: number },
) => Promise<SearchResult[]>;

export type ResearchRunner = (
  topic: string,
  opts: {
    depth: ResearchDepth;
    requireCitations: boolean;
    language?: string;
    signal?: AbortSignal;
    onProgress?: (p: ResearchProgress) => void;
  },
) => Promise<ResearchReport>;

export type ReportExporter = (
  report: ResearchReport,
  format: 'md' | 'pdf',
) => Promise<{ filename: string }>;

export interface WebSearchResearchViewProps {
  readonly card: MultimediaCardMeta;
  readonly onClose?: () => void;
  readonly initialMode?: 'search' | 'research';
  readonly initialQuery?: string;
  readonly search: WebSearchRunner;
  readonly research: ResearchRunner;
  readonly exportReport?: ReportExporter;
  readonly autoLoadPageLimit?: number;
  /** UI 테스트에서 시간 주입. */
  readonly now?: () => number;
}

// ────────────────────────────────────────────────────────────────────────────
// 필터 · 쿼리 상태 모델
// ────────────────────────────────────────────────────────────────────────────

export interface QueryFilters {
  readonly region: 'auto' | 'KR' | 'US' | 'JP' | string;
  readonly freshness: FreshnessFilter;
  readonly sources: ReadonlyArray<'news' | 'academic' | 'blog' | 'official' | 'github'>;
  readonly safeSearch: SafeSearchLevel;
  readonly site: string;
}

const DEFAULT_FILTERS: QueryFilters = {
  region: 'auto',
  freshness: 'any',
  sources: [],
  safeSearch: 'moderate',
  site: '',
};

export function countActiveFilters(filters: QueryFilters): number {
  let n = 0;
  if (filters.region !== 'auto') n += 1;
  if (filters.freshness !== 'any') n += 1;
  if (filters.sources.length > 0) n += 1;
  if (filters.safeSearch !== 'moderate') n += 1;
  if (filters.site.trim().length > 0) n += 1;
  return n;
}

/** 문자열 site 입력("example.com, -spam.io") 을 WebSearchOptions 의 include/exclude 로 분해. */
export function parseSiteFilter(raw: string): { include?: string; exclude?: string[] } {
  const tokens = raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  const exclude: string[] = [];
  let include: string | undefined;
  for (const t of tokens) {
    if (t.startsWith('-')) exclude.push(t.slice(1));
    else if (!include) include = t;
  }
  return {
    ...(include ? { include } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 인용 카트 · 즐겨찾기
// ────────────────────────────────────────────────────────────────────────────

export interface CitationCartItem {
  readonly url: string;
  readonly title: string;
  readonly domain: string;
  readonly snippet?: string;
  readonly addedAtMs: number;
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname; }
  catch { return url; }
}

// ────────────────────────────────────────────────────────────────────────────
// 보고서 목차 / 메타 렌더링
// ────────────────────────────────────────────────────────────────────────────

function formatRelativeTime(iso: string | undefined, nowMs: number): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const diff = Math.max(0, nowMs - then);
  const days = Math.floor(diff / (24 * 3600_000));
  if (days < 1) return '오늘';
  if (days < 7) return `${days}일 전`;
  if (days < 30) return `${Math.floor(days / 7)}주 전`;
  if (days < 365) return `${Math.floor(days / 30)}개월 전`;
  return `${Math.floor(days / 365)}년 전`;
}

// ────────────────────────────────────────────────────────────────────────────
// 메인 컴포넌트
// ────────────────────────────────────────────────────────────────────────────

export function WebSearchResearchView(props: WebSearchResearchViewProps): React.ReactElement {
  const {
    card,
    onClose,
    initialMode = 'search',
    initialQuery = '',
    autoLoadPageLimit = 3,
  } = props;

  const nowFn = props.now ?? Date.now;
  const jobs = useMultimediaJobs();

  const [mode, setMode] = useState<'search' | 'research'>(initialMode);
  const [query, setQuery] = useState<string>(initialQuery);
  const [filters, setFilters] = useState<QueryFilters>(DEFAULT_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState<boolean>(false);

  // 검색 상태
  const [results, setResults] = useState<readonly SearchResult[]>([]);
  const [page, setPage] = useState<number>(0);
  const [searchBusy, setSearchBusy] = useState<boolean>(false);
  const [searchError, setSearchError] = useState<{ code: string; retryAfterMs?: number } | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);

  // 인용 카트 / 즐겨찾기
  const [favorites, setFavorites] = useState<ReadonlyMap<string, CitationCartItem>>(new Map());
  const [citations, setCitations] = useState<ReadonlyMap<string, CitationCartItem>>(new Map());

  // 리서치 상태
  const [researchDepth, setResearchDepth] = useState<ResearchDepth>(2);
  const [requireCitations, setRequireCitations] = useState<boolean>(true);
  const [researchJobId, setResearchJobId] = useState<string | null>(null);
  const [researchReport, setResearchReport] = useState<ResearchReport | null>(null);
  const [researchPaused, setResearchPaused] = useState<boolean>(false);
  const researchAbortRef = useRef<AbortController | null>(null);

  // ── 검색 경로 ──────────────────────────────────────────────────────────
  const toOptions = useCallback((p: number): WebSearchOptions & { page?: number } => {
    const site = parseSiteFilter(filters.site);
    return {
      page: p,
      maxResults: 10,
      region: filters.region === 'auto' ? undefined : filters.region,
      freshness: filters.freshness,
      safeSearch: filters.safeSearch,
      site: site.include,
    };
  }, [filters]);

  const runSearch = useCallback(async (opts: { reset: boolean; pageOverride?: number }) => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setSearchError({ code: 'WEB_SEARCH_EMPTY' });
      return;
    }
    setSearchBusy(true);
    setSearchError(null);
    try {
      const targetPage = opts.pageOverride ?? (opts.reset ? 1 : page + 1);
      const next = await props.search(trimmed, toOptions(targetPage));
      setResults((prev) => (opts.reset ? next : [...prev, ...next]));
      setPage(targetPage);
    } catch (err) {
      if (err instanceof MediaAdapterError) {
        const d = err.details as { webSearchCode?: string; waitMs?: number; partial?: SearchResult[] } | undefined;
        const code = d?.webSearchCode ?? err.code ?? 'WEB_SEARCH_PROVIDER_ERROR';
        setSearchError({ code, retryAfterMs: d?.waitMs });
        // 부분 성공(W-05) — partial 을 기존 결과와 병합 유지.
        if (Array.isArray(d?.partial) && d!.partial.length > 0) {
          setResults((prev) => (opts.reset ? d!.partial : [...prev, ...d!.partial]));
        }
      } else {
        setSearchError({ code: 'WEB_SEARCH_PROVIDER_ERROR' });
      }
    } finally {
      setSearchBusy(false);
    }
  }, [query, page, toOptions, props.search]);

  const onSubmitQuery = useCallback(() => {
    if (mode === 'search') {
      runSearch({ reset: true, pageOverride: 1 });
    }
  }, [mode, runSearch]);

  // 전역 단축키 '/' → 쿼리 입력 포커스
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
        if (typing) return;
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 결과 카드 단축키 j/k/s/c
  useEffect(() => {
    if (mode !== 'search') return;
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j') { e.preventDefault(); setSelectedIndex((i) => Math.min(results.length - 1, i + 1)); }
      else if (e.key === 'k') { e.preventDefault(); setSelectedIndex((i) => Math.max(0, i - 1)); }
      else if (e.key === 's' && selectedIndex >= 0) {
        e.preventDefault();
        toggleFavorite(results[selectedIndex]);
      } else if (e.key === 'c' && selectedIndex >= 0) {
        e.preventDefault();
        addCitation(results[selectedIndex]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, results, selectedIndex]);

  // 인용/즐겨찾기 토글
  const toggleFavorite = useCallback((r: SearchResult): void => {
    setFavorites((prev) => {
      const next = new Map(prev);
      if (next.has(r.url)) next.delete(r.url);
      else next.set(r.url, {
        url: r.url, title: r.title, domain: extractDomain(r.url),
        snippet: r.snippet, addedAtMs: nowFn(),
      });
      return next;
    });
  }, [nowFn]);

  const addCitation = useCallback((r: SearchResult): void => {
    setCitations((prev) => {
      if (prev.has(r.url)) return prev;
      const next = new Map(prev);
      next.set(r.url, {
        url: r.url, title: r.title, domain: extractDomain(r.url),
        snippet: r.snippet, addedAtMs: nowFn(),
      });
      return next;
    });
  }, [nowFn]);

  const removeCitation = useCallback((url: string): void => {
    setCitations((prev) => {
      if (!prev.has(url)) return prev;
      const next = new Map(prev);
      next.delete(url);
      return next;
    });
  }, []);

  // ── 리서치 경로 ─────────────────────────────────────────────────────────
  const activeResearchJob: MultimediaJob | undefined = useMemo(() => {
    if (!researchJobId) return undefined;
    return jobs.jobs.find((j) => j.id === researchJobId);
  }, [jobs.jobs, researchJobId]);

  const startResearch = useCallback(async () => {
    const topic = query.trim();
    if (topic.length === 0) {
      setSearchError({ code: 'WEB_SEARCH_EMPTY' });
      return;
    }
    setResearchReport(null);
    setResearchPaused(false);
    const controller = new AbortController();
    researchAbortRef.current = controller;
    const jobId = jobs.store.start({ kind: 'research', title: topic });
    setResearchJobId(jobId);
    jobs.store.update(jobId, { status: 'running', phase: 'plan', progress: 0.05 });

    try {
      const report = await props.research(topic, {
        depth: researchDepth,
        requireCitations,
        signal: controller.signal,
        onProgress: (p) => {
          jobs.store.update(jobId, {
            phase: p.stage,
            progress: clamp01((p.subQueryIndex ?? 0) / Math.max(1, p.subQueryTotal ?? 1)),
          });
        },
      });
      setResearchReport(report);
      jobs.store.complete(jobId, `${report.sections.length} 섹션 · ${report.citations.length} 인용`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      jobs.store.fail(jobId, msg);
      setSearchError({ code: 'RESEARCH_FAILED' });
    }
  }, [query, researchDepth, requireCitations, jobs.store, props.research]);

  const cancelResearch = useCallback(() => {
    researchAbortRef.current?.abort();
    if (researchJobId) jobs.store.cancel(researchJobId);
  }, [researchJobId, jobs.store]);

  const pauseResearch = useCallback(() => {
    setResearchPaused((p) => !p);
  }, []);

  // ── 내보내기 ────────────────────────────────────────────────────────────
  const onExport = useCallback(async (format: 'md' | 'pdf'): Promise<void> => {
    if (!researchReport || !props.exportReport) return;
    try { await props.exportReport(researchReport, format); } catch { /* 실패는 배너로 */ }
  }, [researchReport, props.exportReport]);

  // ── phase 결정(Shell 계약) ─────────────────────────────────────────────
  const phase = searchError
    ? 'error'
    : activeResearchJob && activeResearchJob.status === 'running'
      ? 'loading'
      : researchReport
        ? 'success'
        : results.length > 0
          ? 'form' // 검색 결과 있음 — form 자리에 결과 렌더
          : 'form';

  return (
    <MultimediaAdapterShell
      card={card}
      phase={phase}
      onClose={onClose}
      runningJob={activeResearchJob}
      errorCode={searchError?.code}
      errorMessage={errorCopy(searchError?.code, searchError?.retryAfterMs)}
      onRetry={searchError ? () => (mode === 'search' ? runSearch({ reset: true, pageOverride: 1 }) : startResearch()) : undefined}
      formSlot={
        <div data-testid="websearch-research-root" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <ModeTabs mode={mode} onChange={setMode} reportReady={!!researchReport} onExport={onExport} />
          <QueryBar
            value={query}
            onChange={setQuery}
            onSubmit={mode === 'search' ? onSubmitQuery : startResearch}
            filtersOpen={filtersOpen}
            onToggleFilters={() => setFiltersOpen((o) => !o)}
            activeFilterCount={countActiveFilters(filters)}
            busy={searchBusy || (activeResearchJob?.status === 'running')}
            inputRef={inputRef}
          />
          {filtersOpen ? <FilterPanel value={filters} onChange={setFilters} /> : null}
          {filters.safeSearch === 'off' ? <SafeSearchOffBanner /> : null}

          {mode === 'search' ? (
            <SearchResultsList
              results={results}
              selectedIndex={selectedIndex}
              onSelect={setSelectedIndex}
              favorites={favorites}
              citations={citations}
              onToggleFavorite={toggleFavorite}
              onAddCitation={addCitation}
              nowMs={nowFn()}
              busy={searchBusy}
              page={page}
              autoLoadLimit={autoLoadPageLimit}
              onLoadMore={() => runSearch({ reset: false })}
            />
          ) : (
            <ResearchPanel
              depth={researchDepth}
              onDepthChange={setResearchDepth}
              requireCitations={requireCitations}
              onRequireCitationsChange={setRequireCitations}
              job={activeResearchJob}
              report={researchReport}
              paused={researchPaused}
              onStart={startResearch}
              onCancel={cancelResearch}
              onPause={pauseResearch}
              onExport={onExport}
              citations={citations}
              onRemoveCitation={removeCitation}
            />
          )}
        </div>
      }
    />
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 하위 컴포넌트
// ────────────────────────────────────────────────────────────────────────────

const ModeTabs: React.FC<{
  mode: 'search' | 'research';
  onChange: (m: 'search' | 'research') => void;
  reportReady: boolean;
  onExport: (f: 'md' | 'pdf') => void;
}> = ({ mode, onChange, reportReady, onExport }) => (
  <div
    role="tablist"
    aria-label="검색 모드 선택"
    data-testid="websearch-research-tabs"
    style={{ display: 'flex', alignItems: 'center', gap: 4, padding: 4, background: 'var(--pixel-card-muted, rgba(0,0,0,0.3))', border: '2px solid var(--pixel-border)', width: 'fit-content' }}
  >
    {(['search', 'research'] as const).map((m) => {
      const selected = m === mode;
      const Icon = m === 'search' ? Search : Compass;
      return (
        <button
          key={m}
          role="tab"
          type="button"
          aria-selected={selected}
          data-testid={`websearch-research-tab-${m}`}
          onClick={() => onChange(m)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px',
            fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
            background: selected ? 'var(--pixel-accent)' : 'transparent',
            color: selected ? '#000' : 'rgba(255,255,255,0.8)',
            border: 'none', cursor: 'pointer',
          }}
        >
          <Icon size={12} aria-hidden={true} />
          {m === 'search' ? '검색' : '리서치'}
        </button>
      );
    })}
    {mode === 'research' && reportReady ? (
      <div style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
        <button
          type="button"
          data-testid="websearch-research-export-md"
          onClick={() => onExport('md')}
          style={exportBtnStyle()}
        >
          <FileDown size={10} aria-hidden={true} /> .md
        </button>
        <button
          type="button"
          data-testid="websearch-research-export-pdf"
          onClick={() => onExport('pdf')}
          style={exportBtnStyle()}
        >
          <FileDown size={10} aria-hidden={true} /> .pdf
        </button>
      </div>
    ) : null}
  </div>
);

const QueryBar: React.FC<{
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  filtersOpen: boolean;
  onToggleFilters: () => void;
  activeFilterCount: number;
  busy: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
}> = ({ value, onChange, onSubmit, filtersOpen, onToggleFilters, activeFilterCount, busy, inputRef }) => (
  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
    <input
      ref={inputRef}
      type="text"
      data-testid="websearch-research-query-input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
      placeholder='예: "Sora 영상 해상도 제한"'
      aria-label="검색어"
      style={{
        flex: 1, height: 'var(--web-search-query-bar-h, 48px)',
        padding: '0 12px', fontSize: 13,
        background: 'var(--shared-goal-modal-field-bg, rgba(0,0,0,0.3))',
        color: 'var(--shared-goal-modal-header-fg, #fff)',
        border: '1px solid var(--attachment-preview-border)',
        outline: 'none',
      }}
    />
    <button
      type="button"
      data-testid="websearch-research-submit"
      onClick={onSubmit}
      disabled={busy || value.trim().length === 0}
      aria-label="검색"
      style={{ padding: '0 14px', height: 48, fontSize: 12, fontWeight: 700, background: 'var(--pixel-accent)', color: '#000', border: 'none', cursor: busy ? 'not-allowed' : 'pointer' }}
    >
      <Search size={14} aria-hidden={true} />
    </button>
    <button
      type="button"
      data-testid="websearch-research-filter-toggle"
      aria-expanded={filtersOpen}
      onClick={onToggleFilters}
      style={{ padding: '0 12px', height: 48, fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', color: 'rgba(255,255,255,0.85)', border: '1px solid var(--attachment-preview-border)', cursor: 'pointer' }}
    >
      <FilterIcon size={12} aria-hidden={true} /> 필터
      {activeFilterCount > 0 ? (
        <span
          data-testid="websearch-research-filter-badge"
          style={{ marginLeft: 4, display: 'inline-flex', minWidth: 18, justifyContent: 'center', padding: '1px 4px', fontSize: 10, background: 'var(--shared-goal-modal-field-focus)', color: '#000' }}
        >
          {activeFilterCount}
        </span>
      ) : null}
    </button>
  </div>
);

const FilterPanel: React.FC<{
  value: QueryFilters;
  onChange: (next: QueryFilters) => void;
}> = ({ value, onChange }) => {
  const update = <K extends keyof QueryFilters>(k: K, v: QueryFilters[K]): void => {
    onChange({ ...value, [k]: v });
  };
  return (
    <fieldset
      data-testid="websearch-research-filters"
      style={{ padding: 12, border: '1px solid var(--attachment-preview-border)', display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, fontSize: 11 }}
    >
      <label>지역</label>
      <select value={value.region} onChange={(e) => update('region', e.target.value as QueryFilters['region'])} data-testid="websearch-research-filter-region">
        <option value="auto">자동</option>
        <option value="KR">한국</option>
        <option value="US">미국</option>
        <option value="JP">일본</option>
      </select>
      <label>기간</label>
      <select value={value.freshness} onChange={(e) => update('freshness', e.target.value as FreshnessFilter)} data-testid="websearch-research-filter-freshness">
        <option value="any">전체</option>
        <option value="day">24h</option>
        <option value="week">1주</option>
        <option value="month">1개월</option>
        <option value="year">1년</option>
      </select>
      <label>출처</label>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} data-testid="websearch-research-filter-sources">
        {(['news', 'academic', 'blog', 'official', 'github'] as const).map((s) => {
          const on = value.sources.includes(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => update('sources', on ? value.sources.filter((x) => x !== s) : [...value.sources, s])}
              aria-pressed={on}
              style={{ padding: '2px 8px', fontSize: 10, background: on ? 'var(--shared-goal-modal-field-focus)' : 'transparent', color: on ? '#000' : 'rgba(255,255,255,0.8)', border: '1px solid var(--attachment-preview-border)', cursor: 'pointer' }}
            >
              {s}
            </button>
          );
        })}
      </div>
      <label>세이프서치</label>
      <div style={{ display: 'flex', gap: 6 }}>
        {(['strict', 'moderate', 'off'] as const).map((v) => (
          <label key={v} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <input
              type="radio"
              name="safesearch"
              value={v}
              checked={value.safeSearch === v}
              onChange={() => update('safeSearch', v)}
              data-testid={`websearch-research-filter-safesearch-${v}`}
            />
            {v === 'strict' ? '엄격' : v === 'moderate' ? '보통' : '끔'}
          </label>
        ))}
      </div>
      <label>사이트</label>
      <input
        type="text"
        value={value.site}
        onChange={(e) => update('site', e.target.value)}
        placeholder="예: example.com, -spam.io"
        data-testid="websearch-research-filter-site"
        style={{ padding: '4px 8px', background: 'var(--shared-goal-modal-field-bg, rgba(0,0,0,0.3))', color: 'inherit', border: '1px solid var(--attachment-preview-border)' }}
      />
    </fieldset>
  );
};

const SafeSearchOffBanner: React.FC = () => (
  <div
    role="status"
    data-testid="websearch-research-safesearch-off-banner"
    style={{
      padding: 8,
      fontSize: 11,
      background: 'var(--toast-warning-bg, rgba(251,191,36,0.12))',
      border: '1px solid var(--toast-warning-border, rgba(251,191,36,0.45))',
      borderLeft: '4px solid var(--toast-warning-strip, #fbbf24)',
    }}
  >
    <AlertTriangle size={12} aria-hidden={true} /> 성인 콘텐츠가 결과에 포함될 수 있어요. 이 선택은 이 세션에만 적용됩니다.
  </div>
);

const SearchResultsList: React.FC<{
  results: readonly SearchResult[];
  selectedIndex: number;
  onSelect: (i: number) => void;
  favorites: ReadonlyMap<string, CitationCartItem>;
  citations: ReadonlyMap<string, CitationCartItem>;
  onToggleFavorite: (r: SearchResult) => void;
  onAddCitation: (r: SearchResult) => void;
  nowMs: number;
  busy: boolean;
  page: number;
  autoLoadLimit: number;
  onLoadMore: () => void;
}> = ({ results, selectedIndex, onSelect, favorites, citations, onToggleFavorite, onAddCitation, nowMs, busy, page, autoLoadLimit, onLoadMore }) => {
  if (results.length === 0 && !busy) {
    return (
      <div
        role="status"
        data-testid="websearch-research-empty"
        style={{ padding: 24, textAlign: 'center', color: 'var(--empty-state-subtle-fg, rgba(255,255,255,0.6))' }}
      >
        <Search size={20} aria-hidden={true} />
        <p style={{ margin: '6px 0 0 0', fontSize: 12 }}>검색어를 입력해 결과를 받아 보세요.</p>
      </div>
    );
  }
  return (
    <ul
      role="list"
      aria-label="검색 결과"
      data-testid="websearch-research-results"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--web-search-result-gap, 12px)', listStyle: 'none', margin: 0, padding: 0 }}
    >
      {results.map((r, idx) => {
        const selected = idx === selectedIndex;
        const fav = favorites.has(r.url);
        const cited = citations.has(r.url);
        return (
          <li
            key={r.url}
            data-testid={`websearch-research-result-${idx}`}
            data-selected={selected || undefined}
            style={{
              padding: 12,
              minHeight: 'var(--web-search-card-min-h, 120px)',
              background: 'var(--media-asset-surface-bg)',
              border: '1px solid var(--attachment-preview-border)',
              borderLeft: selected ? '4px solid var(--shared-goal-modal-field-focus)' : undefined,
              display: 'flex', flexDirection: 'column', gap: 4,
              cursor: 'pointer',
            }}
            onClick={() => onSelect(idx)}
          >
            <header style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{r.title}</span>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
                <button
                  type="button"
                  data-testid={`websearch-research-result-${idx}-favorite`}
                  aria-pressed={fav}
                  aria-label="즐겨찾기"
                  onClick={(e) => { e.stopPropagation(); onToggleFavorite(r); }}
                  style={iconBtn(fav ? '#fbbf24' : 'rgba(255,255,255,0.55)')}
                >
                  <Star size={12} aria-hidden={true} />
                </button>
                <button
                  type="button"
                  data-testid={`websearch-research-result-${idx}-cite`}
                  aria-pressed={cited}
                  aria-label="인용 담기"
                  onClick={(e) => { e.stopPropagation(); onAddCitation(r); }}
                  style={iconBtn(cited ? 'var(--shared-goal-modal-confirm-bg, #34d399)' : 'rgba(255,255,255,0.55)')}
                >
                  <Bookmark size={12} aria-hidden={true} />
                </button>
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  data-testid={`websearch-research-result-${idx}-open`}
                  onClick={(e) => e.stopPropagation()}
                  style={{ ...iconBtn('rgba(255,255,255,0.8)'), display: 'inline-flex', alignItems: 'center' }}
                  aria-label="새 탭에서 열기"
                >
                  <ExternalLink size={12} aria-hidden={true} />
                </a>
              </span>
            </header>
            <p style={{ margin: 0, fontSize: 11, opacity: 0.85, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{extractDomain(r.url)}</span>
              <span style={{ opacity: 0.6 }}>·</span>
              <span title={r.publishedAt}>{formatRelativeTime(r.publishedAt, nowMs) || '출처'}</span>
            </p>
            <p style={{ margin: 0, fontSize: 12, lineHeight: 1.4 }}>{r.snippet}</p>
          </li>
        );
      })}
      {page > 0 && page < autoLoadLimit ? (
        <li>
          <button
            type="button"
            data-testid="websearch-research-load-more"
            onClick={onLoadMore}
            disabled={busy}
            style={{ padding: '6px 12px', fontSize: 11, width: '100%', background: 'transparent', color: 'var(--pixel-accent)', border: '1px dashed var(--attachment-preview-border)', cursor: busy ? 'not-allowed' : 'pointer' }}
          >
            {busy ? '불러오는 중…' : '더 보기'}
          </button>
        </li>
      ) : null}
      {page >= autoLoadLimit ? (
        <li
          role="status"
          data-testid="websearch-research-auto-load-gate"
          style={{ padding: 8, fontSize: 10, textAlign: 'center', color: 'var(--empty-state-subtle-fg)' }}
        >
          자동 로드가 멈췄어요. 결과를 좁히려면 검색어를 조정해 주세요.
        </li>
      ) : null}
    </ul>
  );
};

const ResearchPanel: React.FC<{
  depth: ResearchDepth;
  onDepthChange: (d: ResearchDepth) => void;
  requireCitations: boolean;
  onRequireCitationsChange: (v: boolean) => void;
  job?: MultimediaJob;
  report: ResearchReport | null;
  paused: boolean;
  onStart: () => void;
  onCancel: () => void;
  onPause: () => void;
  onExport: (f: 'md' | 'pdf') => void;
  citations: ReadonlyMap<string, CitationCartItem>;
  onRemoveCitation: (url: string) => void;
}> = ({ depth, onDepthChange, requireCitations, onRequireCitationsChange, job, report, paused, onStart, onCancel, onPause, onExport, citations, onRemoveCitation }) => {
  const running = job?.status === 'running' || job?.status === 'queued';
  const estimatedTokens = depth === 1 ? 3200 : depth === 2 ? 8400 : 16000;
  return (
    <section
      data-testid="websearch-research-research-panel"
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      {!running && !report ? (
        <form
          data-testid="websearch-research-research-form"
          onSubmit={(e) => { e.preventDefault(); onStart(); }}
          style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: '1px solid var(--attachment-preview-border)' }}
        >
          <label style={{ fontSize: 11 }}>깊이</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {([1, 2, 3] as const).map((d) => (
              <label key={d} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <input
                  type="radio"
                  name="research-depth"
                  value={d}
                  checked={depth === d}
                  onChange={() => onDepthChange(d)}
                  data-testid={`websearch-research-depth-${d}`}
                />
                {d === 1 ? '1. 요약' : d === 2 ? '2. 다관점' : '3. 심층 비교'}
              </label>
            ))}
          </div>
          <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 11 }}>
            <input
              type="checkbox"
              checked={requireCitations}
              onChange={(e) => onRequireCitationsChange(e.target.checked)}
              data-testid="websearch-research-require-citations"
            />
            모든 주장에 출처 URL 강제 포함
          </label>
          <p style={{ margin: 0, fontSize: 11, opacity: 0.75 }}>
            예상 단계 4 · 예상 토큰 ~{estimatedTokens.toLocaleString()}
          </p>
          <button
            type="submit"
            data-testid="websearch-research-start"
            style={{ padding: '6px 12px', fontSize: 11, fontWeight: 700, background: 'var(--shared-goal-modal-confirm-bg)', color: 'var(--shared-goal-modal-confirm-fg)', border: '1px solid var(--attachment-preview-border)', cursor: 'pointer', alignSelf: 'flex-start' }}
          >
            <Play size={10} aria-hidden={true} /> 시작 →
          </button>
        </form>
      ) : null}

      {running ? (
        <div data-testid="websearch-research-research-timeline" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: '1px solid var(--attachment-preview-border)' }}>
          <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Clock size={14} aria-hidden={true} />
            <span style={{ fontSize: 12, fontWeight: 700 }}>
              리서치 진행 중 · {job?.phase ?? 'plan'} · {Math.round((job?.progress ?? 0) * 100)}%
            </span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
              <button type="button" data-testid="websearch-research-pause" onClick={onPause} style={iconBtn('rgba(255,255,255,0.8)')}>
                <Pause size={12} aria-hidden={true} /> {paused ? '재개' : '일시정지'}
              </button>
              <button type="button" data-testid="websearch-research-cancel" onClick={onCancel} style={iconBtn('var(--error-state-fg, #fecaca)')}>
                <X size={12} aria-hidden={true} /> 중단
              </button>
            </span>
          </header>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(['plan', 'gather', 'synthesize', 'cite'] as const).map((p) => {
              const current = (job?.phase ?? 'plan') === p;
              return (
                <li key={p} style={{ fontSize: 11, opacity: current ? 1 : 0.55 }}>
                  {current ? '◔' : '○'} {p}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {report ? (
        <article data-testid="websearch-research-report" style={{ padding: 12, border: '1px solid var(--attachment-preview-border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <header>
            <h3 style={{ margin: 0, fontSize: 14 }}>{report.topic}</h3>
            <p style={{ margin: '4px 0 0 0', fontSize: 11, opacity: 0.7 }}>
              depth {report.meta.depth} · {report.meta.model} · {Math.round(report.meta.durationMs / 1000)}초
            </p>
          </header>
          <nav aria-label="목차" data-testid="websearch-research-report-toc">
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 11 }}>
              {report.toc.map((t) => (
                <li key={t.id}>
                  <a href={`#${t.id}`}>{t.title}</a>
                </li>
              ))}
            </ol>
          </nav>
          {report.sections.map((s) => (
            <section key={s.id} id={s.id}>
              <h4 style={{ margin: '8px 0 4px 0', fontSize: 12 }}>{s.title}</h4>
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{s.body}</p>
            </section>
          ))}
          {report.limitations.length > 0 ? (
            <section data-testid="websearch-research-report-limitations" style={{ padding: 8, background: 'var(--toast-warning-bg, rgba(251,191,36,0.12))', border: '1px solid var(--toast-warning-border, rgba(251,191,36,0.45))' }}>
              <h4 style={{ margin: '0 0 4px 0', fontSize: 12 }}>한계점</h4>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11 }}>
                {report.limitations.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            </section>
          ) : null}
          <footer data-testid="websearch-research-report-footer" style={{ display: 'flex', gap: 6 }}>
            <button type="button" data-testid="websearch-research-report-export-md" onClick={() => onExport('md')} style={exportBtnStyle()}>
              <FileDown size={10} aria-hidden={true} /> .md
            </button>
            <button type="button" data-testid="websearch-research-report-export-pdf" onClick={() => onExport('pdf')} style={exportBtnStyle()}>
              <FileDown size={10} aria-hidden={true} /> .pdf
            </button>
          </footer>
        </article>
      ) : null}

      <section data-testid="websearch-research-citation-cart" style={{ padding: 8, border: '1px dashed var(--attachment-preview-border)' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Bookmark size={12} aria-hidden={true} />
          <span style={{ fontSize: 11, fontWeight: 700 }}>인용 카트 · {citations.size}건</span>
        </header>
        {citations.size === 0 ? (
          <p style={{ margin: '4px 0 0 0', fontSize: 11, opacity: 0.65 }}>
            검색 결과에서 "인용 담기" 를 누르면 여기에 쌓여요.
          </p>
        ) : (
          <ul style={{ margin: '4px 0 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {Array.from(citations.values()).map((it) => (
              <li key={it.url} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <span style={{ flex: 1 }}>{it.title} · {it.domain}</span>
                <button type="button" onClick={() => onRemoveCitation(it.url)} style={iconBtn('rgba(255,255,255,0.7)')} aria-label="인용 제거">
                  <X size={10} aria-hidden={true} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// 헬퍼 · 스타일
// ────────────────────────────────────────────────────────────────────────────

function iconBtn(color: string): React.CSSProperties {
  return {
    padding: '2px 6px',
    fontSize: 10,
    background: 'transparent',
    color,
    border: '1px solid var(--attachment-preview-border)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
  };
}

function exportBtnStyle(): React.CSSProperties {
  return {
    padding: '4px 8px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4,
    background: 'var(--shared-goal-modal-confirm-bg)',
    color: 'var(--shared-goal-modal-confirm-fg)',
    border: '1px solid var(--attachment-preview-border)',
    cursor: 'pointer',
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function errorCopy(code: string | undefined, retryAfterMs?: number): string {
  switch (code) {
    case 'WEB_SEARCH_RATE_LIMIT':
      return `요청이 잠시 제한됐어요. 약 ${Math.max(1, Math.round((retryAfterMs ?? 30_000) / 1000))}초 후 자동으로 다시 시도할 수 있어요.`;
    case 'WEB_SEARCH_PROVIDER_ERROR':
      return '검색 공급자가 응답하지 않았어요. 잠시 후 다시 시도해 주세요.';
    case 'WEB_SEARCH_EMPTY':
      return '결과가 없어요. 검색어를 넓히거나 필터를 줄여 보세요.';
    case 'PERMISSION_DENIED':
      return '웹 검색 자격 증명이 없어요. 프로젝트 설정에서 API 키를 추가해 주세요.';
    case 'ADAPTER_NOT_REGISTERED':
      return '검색 엔진이 준비되지 않았어요. 드라이버 설치 후 다시 시도해 주세요.';
    case 'RESEARCH_FAILED':
      return '리서치 도중 오류가 발생했어요. 재시도하거나 depth 를 낮춰 보세요.';
    default:
      return '일시 오류예요. 잠시 후 다시 시도해 주세요.';
  }
}
