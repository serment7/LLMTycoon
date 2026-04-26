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
  translateRecommendations,
  type AgentRecommendation,
  type AgentTeamRecommendation,
  type RecommendationLocale,
  type TranslateRecommendationsOptions,
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
import {
  MAX_RECOMMEND_COUNT,
  MIN_RECOMMEND_COUNT,
  clampRecommendCount,
  useRecommendCount,
} from '../stores/recommendCountStore';
import {
  MIN_DESCRIPTION_LENGTH,
  RECOMMENDATION_DEBOUNCE_MS,
  isDescriptionLongEnough,
  mergeLockedRoles,
  useProjectCreateStore,
  type LastRecommendationSnapshot,
} from '../stores/projectCreateStore';

// ────────────────────────────────────────────────────────────────────────────
// 공용 유틸
// ────────────────────────────────────────────────────────────────────────────

/** {key} 플레이스홀더 간단 치환. i18n 모듈은 축 최소화 차원에서 interpolation 미지원. */
function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    k in params ? String(params[k]) : `{${k}}`,
  );
}

function fallbackFetcher(locale: RecommendationLocale): RecommenderFetcher {
  // 기본 fetcher — invoker 없이 recommendAgentTeam 호출(휴리스틱 폴백). locale·count 는 UI 에서 전달.
  return async ({ description, signal, count }) => {
    if (signal?.aborted) throw new Error('aborted');
    return recommendAgentTeam(description, { locale, count });
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
  /** 언어 전환 시 재번역을 위임할 translator. 미주입 시 heuristic 번역표로 폴백. */
  readonly translator?: TranslateRecommendationsOptions['invoker'];
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
  // 지시 #797538d6 — 추천 인원수 영속 스토어. 마법사·다이얼로그가 동일 키로 공유.
  const { count: recommendCount, setCount: setRecommendCount } = useRecommendCount();
  // 지시 #462fa5ec — 잠긴 역할/마지막 추천 영속 스토어.
  const {
    lockedRoles,
    lastRecommendation,
    toggleLockedRole,
    setLastRecommendation,
  } = useProjectCreateStore();

  // 캐시·디바운스된 요청기는 컴포넌트 생애에 1회만 생성(props.cache 가 오면 공유).
  const cache = useMemo<RecommendationCache>(
    () => props.cache ?? createRecommendationCache(8),
    [props.cache],
  );
  const fetcher = useMemo<RecommenderFetcher>(
    () => props.fetcher ?? fallbackFetcher(locale as RecommendationLocale),
    [props.fetcher, locale],
  );
  const recommenderRef = useRef<DebouncedRecommender | null>(null);
  if (recommenderRef.current === null) {
    // 지시 #462fa5ec — 디바운스 기본값을 600ms 로 상향. props 명시값은 그대로 사용.
    recommenderRef.current = createDebouncedRecommender({
      fetcher,
      cache,
      debounceMs: props.debounceMs ?? RECOMMENDATION_DEBOUNCE_MS,
    });
  }

  useEffect(() => {
    return () => {
      recommenderRef.current?.cancel();
    };
  }, []);

  // 지시 #462fa5ec — 마운트 직후 lastRecommendation 이 있으면 카드 영역을 즉시 복원.
  useEffect(() => {
    if (lastRecommendation && state.description.length === 0 && !state.team) {
      setState((prev) => ({
        ...prev,
        description: lastRecommendation.description,
        status: 'ready',
        team: {
          items: lastRecommendation.items,
          source: lastRecommendation.source,
          locale: lastRecommendation.locale,
        },
        selected: lastRecommendation.items.map((_, idx) => idx),
      }));
    }
    // 마운트 시점만 — 사용자가 입력 중일 때 덮어쓰지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 언어 전환 → 기존 추천을 버리지 않고 translateRecommendations 로 경량 재번역.
  // description 자체가 바뀌지 않았는데 locale 만 바뀐 경우에만 발동하며, 결과는
  // 같은 state.team 슬롯에 덮어쓴다(선택 상태 유지).
  useEffect(() => {
    const current = state.team;
    if (!current) return;
    if (current.locale === locale) return;
    let cancelled = false;
    translateRecommendations(current, locale as RecommendationLocale, {
      invoker: props.translator,
    })
      .then((next) => {
        if (cancelled) return;
        setState((prev) => ({ ...prev, team: next }));
      })
      .catch(() => {
        // translateRecommendations 는 fallbackOnError 기본 true 라 실제 도달 어렵지만
        // 혹시의 경우 원본 유지하고 에러 상태로 가지 않음 — UX 우선.
      });
    return () => {
      cancelled = true;
    };
  }, [locale, props.translator, state.team]);

  const triggerRecommendation = useCallback(
    (description: string, count: number) => {
      const recommender = recommenderRef.current;
      if (!recommender) return;
      if (description.trim().length === 0) {
        setState((prev) => ({ ...prev, status: 'idle', team: undefined, selected: [] }));
        return;
      }
      // 지시 #462fa5ec — 최소 글자 수 미만이면 호출 차단(토큰 절약). UI 는 idle 로 남고
      // 가이드 문구가 노출된다.
      if (!isDescriptionLongEnough(description)) {
        recommender.cancel();
        setState((prev) => ({ ...prev, status: 'idle', errorMessage: undefined }));
        return;
      }
      setState((prev) => ({ ...prev, status: 'loading', errorMessage: undefined }));
      recommender
        .request(description, count)
        .then((team) => {
          if (team === null) return;
          // 지시 #462fa5ec — 잠긴 역할은 새 응답 위에 머지.
          const merged = mergeLockedRoles(team.items, {
            lockedRoles,
            previous: state.team?.items ?? lastRecommendation?.items ?? null,
            count,
          });
          const nextTeam: AgentTeamRecommendation = { ...team, items: merged };
          setState((prev) => ({
            ...prev,
            status: 'ready',
            team: nextTeam,
            selected: nextTeam.items.map((_, idx) => idx),
          }));
          // 마지막 추천 스냅샷 영속화 — 새로고침 후 즉시 복원.
          const snapshot: LastRecommendationSnapshot = {
            description,
            count,
            locale: nextTeam.locale,
            source: nextTeam.source,
            items: nextTeam.items,
            storedAt: new Date().toISOString(),
          };
          setLastRecommendation(snapshot);
        })
        .catch((err: unknown) => {
          setState((prev) => ({
            ...prev,
            status: 'error',
            errorMessage: err instanceof Error ? err.message : t('project.newProjectWizard.error'),
          }));
        });
    },
    [t, lockedRoles, lastRecommendation, setLastRecommendation, state.team],
  );

  const onDescriptionChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setState((prev) => ({ ...prev, description: value }));
      triggerRecommendation(value, recommendCount);
    },
    [triggerRecommendation, recommendCount],
  );

  // 인원수 변경 — 영속 스토어 갱신 후 즉시 재요청. 디바운스/캐시는 내부에서 처리.
  const onRecommendCountChange = useCallback(
    (next: number) => {
      const clamped = clampRecommendCount(next);
      setRecommendCount(clamped);
      if (state.description.trim().length > 0) {
        triggerRecommendation(state.description, clamped);
      }
    },
    [setRecommendCount, state.description, triggerRecommendation],
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
        // 지시 #bf8ed192 — 적용 단계 사용자 가시 에러는 현재 locale 로 표기.
        const result = await applyRecommendedTeam(props.projectId, picks, {
          ...props.applyOptions,
          locale: props.applyOptions?.locale ?? locale,
        });
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

  // 부분 실패 재시도 — 실패한 추천 카드 하나만 다시 시도해 applied 결과를 병합.
  const retryOne = useCallback(
    async (rec: AgentRecommendation) => {
      setState((prev) => ({ ...prev, status: 'applying' }));
      try {
        const next = await applyRecommendedTeam(props.projectId, [rec], {
          ...props.applyOptions,
          locale: props.applyOptions?.locale ?? locale,
        });
        setState((prev) => {
          const base = prev.applied;
          if (!base) return { ...prev, status: 'ready', applied: next };
          const merged = base.items.map((it) => {
            if (it.recommendation.role === rec.role && it.recommendation.name === rec.name) {
              return next.items[0] ?? it;
            }
            return it;
          });
          return {
            ...prev,
            status: 'ready',
            applied: {
              projectId: base.projectId,
              items: merged,
              appliedCount: merged.filter((it) => it.ok).length,
            },
          };
        });
      } catch {
        setState((prev) => ({ ...prev, status: 'ready' }));
      }
    },
    [props.projectId, props.applyOptions, locale],
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
        <div className="npw-count-row">
          <label className="npw-count-field">
            <span>
              {interpolate(t('project.newProjectWizard.describe.countLabel'), {
                count: recommendCount,
              })}
            </span>
            <input
              type="range"
              className="npw-count-slider"
              min={MIN_RECOMMEND_COUNT}
              max={MAX_RECOMMEND_COUNT}
              step={1}
              value={recommendCount}
              onChange={(e) => onRecommendCountChange(Number(e.target.value))}
              aria-label={t('project.newProjectWizard.describe.countAriaLabel')}
              aria-valuemin={MIN_RECOMMEND_COUNT}
              aria-valuemax={MAX_RECOMMEND_COUNT}
              aria-valuenow={recommendCount}
            />
          </label>
          <button
            type="button"
            className="npw-describe-request"
            onClick={() => triggerRecommendation(state.description, recommendCount)}
            disabled={
              !isDescriptionLongEnough(state.description) || state.status === 'loading'
            }
          >
            {t('project.newProjectWizard.describe.requestButton')}
          </button>
        </div>
        {/* 지시 #462fa5ec — 최소 글자 수 미만일 때 가이드 노출. */}
        {state.description.length > 0
          && !isDescriptionLongEnough(state.description) && (
            <p className="npw-too-short" role="status" data-testid="npw-too-short-hint">
              {interpolate(t('project.newProjectWizard.describe.tooShort'), {
                min: MIN_DESCRIPTION_LENGTH,
                current: state.description.trim().length,
              })}
            </p>
          )}
      </label>

      {state.status === 'loading' && (
        <>
          <p role="status" className="npw-loading">
            {t('project.newProjectWizard.loading')}
          </p>
          {/* 지시 #797538d6 — 응답 도착 전에 인원수만큼 슬롯 placeholder 노출.
              레이아웃 점프 방지 + 사용자가 "몇 명이 올 예정인지" 즉시 인지. */}
          <ul className="npw-cards npw-cards-skeleton" role="list" aria-hidden="true">
            {Array.from({ length: recommendCount }, (_, idx) => (
              <li key={`npw-skeleton-${idx}`} className="npw-card-skeleton" data-card-status="loading">
                <span className="npw-skeleton-line npw-skeleton-role" />
                <span className="npw-skeleton-line npw-skeleton-name" />
                <span className="npw-skeleton-line npw-skeleton-rationale" />
              </li>
            ))}
          </ul>
        </>
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
              const appliedEntry = state.applied?.items.find(
                (it) => it.recommendation.role === rec.role && it.recommendation.name === rec.name,
              );
              const cardStatus: 'idle' | 'success' | 'failed' = appliedEntry
                ? appliedEntry.ok
                  ? 'success'
                  : 'failed'
                : 'idle';
              const isLocked = lockedRoles.includes(rec.role);
              return (
                <li
                  key={`${rec.role}-${idx}`}
                  data-card-status={cardStatus}
                  data-card-locked={isLocked || undefined}
                >
                  <label className="npw-card" data-selected={selected} role="option" aria-selected={selected}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleSelection(idx)}
                    />
                    <div className="npw-card-body">
                      <header className="npw-card-head">
                        <strong className="npw-role">{rec.role}</strong>
                        <span className="npw-name">{rec.name}</span>
                        {/* 지시 #462fa5ec — "이 역할 고정" 토글. label 안에 nested checkbox 가
                            이미 있으므로 본 버튼은 stopPropagation 으로 카드 선택과 분리한다. */}
                        <button
                          type="button"
                          className="npw-card-lock"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleLockedRole(rec.role);
                          }}
                          aria-pressed={isLocked}
                          aria-label={t(
                            isLocked
                              ? 'project.newProjectWizard.review.lock.aria.locked'
                              : 'project.newProjectWizard.review.lock.aria.unlocked',
                          )}
                        >
                          {t(
                            isLocked
                              ? 'project.newProjectWizard.review.lock.locked'
                              : 'project.newProjectWizard.review.lock.unlocked',
                          )}
                        </button>
                      </header>
                      <p className="npw-rationale">
                        {segments.map((s, si) =>
                          s.strong ? <strong key={si}>{s.text}</strong> : <span key={si}>{s.text}</span>,
                        )}
                      </p>
                      {/* 지시 #462fa5ec — Joker 가 채우는 reason 보강 텍스트. 비어 있으면 숨김. */}
                      {rec.reason && rec.reason.trim().length > 0 && (
                        <p className="npw-reason" data-testid="npw-card-reason">
                          <span className="npw-reason-label">
                            {t('project.newProjectWizard.review.reasonLabel')}
                          </span>
                          <span className="npw-reason-body">{rec.reason}</span>
                        </p>
                      )}
                      {rec.skills && rec.skills.length > 0 && (
                        <ul className="npw-skills" aria-label="skills">
                          {rec.skills.map((skill) => (
                            <li key={skill} className="npw-skill-chip">
                              {skill}
                            </li>
                          ))}
                        </ul>
                      )}
                      {cardStatus === 'success' && (
                        <span className="npw-card-status npw-card-success" aria-label={t('project.newProjectWizard.apply.successBadge')}>
                          ✓ {t('project.newProjectWizard.apply.successBadge')}
                        </span>
                      )}
                      {cardStatus === 'failed' && (
                        <div className="npw-card-status npw-card-failed" role="alert">
                          <span>{appliedEntry?.error ?? t('project.newProjectWizard.apply.failBadge')}</span>
                          <button
                            type="button"
                            className="npw-card-retry"
                            onClick={() => retryOne(rec)}
                            disabled={state.status === 'applying'}
                          >
                            {t('project.newProjectWizard.apply.retry')}
                          </button>
                        </div>
                      )}
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
