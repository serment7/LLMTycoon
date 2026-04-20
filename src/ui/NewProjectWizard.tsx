// 지시 #d5acb8a5 · 신규 프로젝트 마법사(3단계: 설명 입력 → 추천 카드 → 바로 추가).
//
// UI 스펙(디자이너 합의)
//   단계 1 "설명"   — textarea 입력. `onChange` 마다 400ms 디바운스 후 추천을 요청한다.
//                     동일 description 은 RecommendationCache 로 즉시 응답(토큰 절약).
//   단계 2 "검토"   — 추천 카드 그리드. 각 카드는 개별 체크박스 + 근거 문장.
//                     근거 문자열은 `sanitizeRationale` 가 `**bold**` 만 허용.
//   단계 3 "추가"   — "선택한 N명 추가" 버튼이 `applyRecommendedTeam` 호출.
//                     "모두 추가" 숏컷은 체크 상태와 무관하게 전원을 반영한다.
//
// 본 컴포넌트는 기존 프로젝트 생성 모달(`src/components/ProjectManagement.tsx`) 과
// 분리된 신규 진입점이며, 기존 회귀를 건드리지 않도록 src/ui/ 하위에 독립 배치한다.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  applyRecommendedTeam,
  type ApplyRecommendedTeamOptions,
  type AppliedTeamResult,
} from '../project/api';
import {
  recommendAgentTeam,
  type AgentRecommendation,
  type AgentTeamRecommendation,
} from '../project/recommendAgentTeam';
import {
  createDebouncedRecommender,
  createRecommendationCache,
  sanitizeRationale,
  type DebouncedRecommender,
  type RecommendationCache,
  type RecommenderFetcher,
} from '../project/recommendationClient';
import { translate, useLocale, type Locale } from '../i18n';

// ────────────────────────────────────────────────────────────────────────────
// 공용 유틸
// ────────────────────────────────────────────────────────────────────────────

/** {key} 플레이스홀더 간단 치환. i18n 모듈은 축 최소화 차원에서 interpolation 미지원. */
function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    k in params ? String(params[k]) : `{${k}}`,
  );
}

function fallbackFetcher(): RecommenderFetcher {
  // 기본 fetcher — invoker 없이 recommendAgentTeam 호출(휴리스틱 폴백).
  return async ({ description, signal }) => {
    if (signal?.aborted) throw new Error('aborted');
    return recommendAgentTeam(description);
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Props · 컨텍스트
// ────────────────────────────────────────────────────────────────────────────

export interface NewProjectWizardProps {
  readonly projectId: string;
  /** 추천 결과를 얻기 위한 fetcher. 미주입 시 휴리스틱 폴백. */
  readonly fetcher?: RecommenderFetcher;
  /** 적용 결과 콜백 — 상위가 토스트/모달 닫기를 트리거. */
  readonly onApplied?: (result: AppliedTeamResult) => void;
  /** 테스트·스토리북 훅 — 디바운스 구간, 캐시 용량, 적용 옵션 주입. */
  readonly debounceMs?: number;
  readonly cache?: RecommendationCache;
  readonly applyOptions?: ApplyRecommendedTeamOptions;
  /** 테스트 결정성 위해 locale 강제. 미주입 시 useLocale. */
  readonly forceLocale?: Locale;
}

interface WizardState {
  readonly description: string;
  readonly status: 'idle' | 'loading' | 'ready' | 'error' | 'applying';
  readonly team?: AgentTeamRecommendation;
  readonly selected: ReadonlyArray<number>;
  readonly errorMessage?: string;
  readonly applied?: AppliedTeamResult;
}

const INITIAL_STATE: WizardState = {
  description: '',
  status: 'idle',
  selected: [],
};

// ────────────────────────────────────────────────────────────────────────────
// 컴포넌트
// ────────────────────────────────────────────────────────────────────────────

export function NewProjectWizard(props: NewProjectWizardProps): React.ReactElement {
  const hookLocale = useLocale();
  const locale = props.forceLocale ?? hookLocale.locale;
  const t = useCallback((key: string) => translate(key, locale), [locale]);

  const [state, setState] = useState<WizardState>(INITIAL_STATE);

  // 캐시·디바운스된 요청기는 컴포넌트 생애에 1회만 생성(props.cache 가 오면 공유).
  const cache = useMemo<RecommendationCache>(
    () => props.cache ?? createRecommendationCache(8),
    [props.cache],
  );
  const fetcher = useMemo<RecommenderFetcher>(
    () => props.fetcher ?? fallbackFetcher(),
    [props.fetcher],
  );
  const recommenderRef = useRef<DebouncedRecommender | null>(null);
  if (recommenderRef.current === null) {
    recommenderRef.current = createDebouncedRecommender({
      fetcher,
      cache,
      debounceMs: props.debounceMs ?? 400,
    });
  }

  useEffect(() => {
    return () => {
      recommenderRef.current?.cancel();
    };
  }, []);

  const triggerRecommendation = useCallback(
    (description: string) => {
      const recommender = recommenderRef.current;
      if (!recommender) return;
      if (description.trim().length === 0) {
        setState((prev) => ({ ...prev, status: 'idle', team: undefined, selected: [] }));
        return;
      }
      setState((prev) => ({ ...prev, status: 'loading', errorMessage: undefined }));
      recommender
        .request(description)
        .then((team) => {
          if (team === null) return;
          setState((prev) => ({
            ...prev,
            status: 'ready',
            team,
            selected: team.items.map((_, idx) => idx),
          }));
        })
        .catch((err: unknown) => {
          setState((prev) => ({
            ...prev,
            status: 'error',
            errorMessage: err instanceof Error ? err.message : t('project.newProjectWizard.error'),
          }));
        });
    },
    [t],
  );

  const onDescriptionChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setState((prev) => ({ ...prev, description: value }));
      triggerRecommendation(value);
    },
    [triggerRecommendation],
  );

  const toggleSelection = useCallback((index: number) => {
    setState((prev) => {
      const selected = prev.selected.includes(index)
        ? prev.selected.filter((i) => i !== index)
        : [...prev.selected, index].sort((a, b) => a - b);
      return { ...prev, selected };
    });
  }, []);

  const selectAll = useCallback(() => {
    setState((prev) => ({
      ...prev,
      selected: prev.team ? prev.team.items.map((_, idx) => idx) : [],
    }));
  }, []);

  const clearSelection = useCallback(() => {
    setState((prev) => ({ ...prev, selected: [] }));
  }, []);

  const applyTeam = useCallback(
    async (mode: 'selected' | 'all') => {
      const team = state.team;
      if (!team || team.items.length === 0) return;
      const picks: AgentRecommendation[] =
        mode === 'all'
          ? [...team.items]
          : state.selected.map((i) => team.items[i]).filter((r): r is AgentRecommendation => Boolean(r));
      if (picks.length === 0) return;
      setState((prev) => ({ ...prev, status: 'applying' }));
      try {
        const result = await applyRecommendedTeam(props.projectId, picks, props.applyOptions);
        setState((prev) => ({ ...prev, status: 'ready', applied: result }));
        props.onApplied?.(result);
      } catch (err) {
        setState((prev) => ({
          ...prev,
          status: 'error',
          errorMessage: err instanceof Error ? err.message : t('project.newProjectWizard.apply.failToast'),
        }));
      }
    },
    [state.selected, state.team, props, t],
  );

  // ── 렌더 ──────────────────────────────────────────────────────────────────

  const selectedCount = state.selected.length;
  const applyButtonLabel = interpolate(t('project.newProjectWizard.apply.button'), {
    count: selectedCount,
  });

  return (
    <section aria-label={t('project.newProjectWizard.steps.describe')} className="new-project-wizard">
      <ol className="npw-steps" aria-label="wizard-steps">
        <li data-active={state.description.length === 0}>
          {t('project.newProjectWizard.steps.describe')}
        </li>
        <li data-active={state.status === 'loading' || state.status === 'ready'}>
          {t('project.newProjectWizard.steps.review')}
        </li>
        <li data-active={state.status === 'applying' || Boolean(state.applied)}>
          {t('project.newProjectWizard.steps.apply')}
        </li>
      </ol>

      <label className="npw-describe">
        <span>{t('project.newProjectWizard.describe.label')}</span>
        <textarea
          value={state.description}
          onChange={onDescriptionChange}
          placeholder={t('project.newProjectWizard.describe.placeholder')}
          aria-describedby="npw-describe-hint"
          rows={4}
        />
        <small id="npw-describe-hint">
          {t('project.newProjectWizard.describe.hint')}
        </small>
      </label>

      {state.status === 'loading' && (
        <p role="status" className="npw-loading">
          {t('project.newProjectWizard.loading')}
        </p>
      )}

      {state.status === 'error' && (
        <p role="alert" className="npw-error">
          {state.errorMessage ?? t('project.newProjectWizard.error')}
        </p>
      )}

      {state.status === 'idle' && state.description.length === 0 && (
        <p className="npw-empty">{t('project.newProjectWizard.empty')}</p>
      )}

      {state.team && state.team.items.length > 0 && (
        <>
          <header className="npw-review-head">
            <h3>{t('project.newProjectWizard.review.title')}</h3>
            <span className="npw-source-badge" data-source={state.team.source}>
              {t(`project.newProjectWizard.review.source.${state.team.source}`)}
            </span>
            <div className="npw-bulk-actions">
              <button type="button" onClick={selectAll}>
                {t('project.newProjectWizard.review.selectAll')}
              </button>
              <button type="button" onClick={clearSelection}>
                {t('project.newProjectWizard.review.clear')}
              </button>
            </div>
          </header>

          <ul className="npw-cards" role="listbox" aria-multiselectable="true">
            {state.team.items.map((rec, idx) => {
              const selected = state.selected.includes(idx);
              const segments = sanitizeRationale(rec.rationale);
              return (
                <li key={`${rec.role}-${idx}`}>
                  <label className="npw-card" data-selected={selected} role="option" aria-selected={selected}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleSelection(idx)}
                    />
                    <div className="npw-card-body">
                      <strong className="npw-role">{rec.role}</strong>
                      <span className="npw-name">{rec.name}</span>
                      <p className="npw-rationale">
                        {segments.map((s, si) =>
                          s.strong ? <strong key={si}>{s.text}</strong> : <span key={si}>{s.text}</span>,
                        )}
                      </p>
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>

          <footer className="npw-apply">
            <button
              type="button"
              disabled={selectedCount === 0 || state.status === 'applying'}
              onClick={() => applyTeam('selected')}
              title={
                selectedCount === 0
                  ? t('project.newProjectWizard.apply.disabled')
                  : undefined
              }
            >
              {applyButtonLabel}
            </button>
            <button
              type="button"
              disabled={state.status === 'applying'}
              onClick={() => applyTeam('all')}
            >
              {t('project.newProjectWizard.apply.addAll')}
            </button>
          </footer>
        </>
      )}
    </section>
  );
}
