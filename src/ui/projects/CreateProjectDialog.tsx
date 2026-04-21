// 지시 #fdee74ae · 프로젝트 생성 다이얼로그 — 설명 입력 후 추천 에이전트 자동 호출.
//
// 기존 `NewProjectWizard` 가 "프로젝트가 이미 존재하는 상태에서 팀을 덧붙이는" 3단계
// 마법사였다면, 본 다이얼로그는 "프로젝트를 새로 만드는 시점" 의 진입점이다. 차이:
//   · 이름/설명/경로 입력란(프로젝트 문서 필드) 포함.
//   · 설명 textarea 는 400ms 디바운스 후 `RecommenderFetcher` 호출 — 프리뷰 카드 렌더.
//   · 각 카드에 "팀에 바로 추가" 버튼. projectId 가 아직 없을 때는 seed 큐에 넣어두고,
//     제출 시 `onSubmit({recommendedAgents: 큐})` 으로 서버에 전달해 생성 직후 seed.
//   · projectId 가 이미 있는 경우(재오픈 등) 버튼이 즉시 `applyRecommendedTeam` 호출.
//
// 핵심 원칙
//   · 서버 결합 없음 — `onSubmit` prop 이 실제 POST /api/projects 호출을 위임받는다.
//   · i18n 키는 `projects.recommend.*` 네임스페이스를 사용. 기존 `project.newProjectWizard.*`
//     키를 재활용하지 않아 텍스트가 새 UX 에 맞게 독립적으로 진화할 수 있다.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  applyRecommendedTeam,
  type ApplyRecommendedTeamOptions,
  type AppliedTeamResult,
} from '../../project/api';
import {
  recommendAgentTeam,
  type AgentRecommendation,
  type AgentTeamRecommendation,
  type RecommendationLocale,
} from '../../project/recommendAgentTeam';
import {
  createDebouncedRecommender,
  createRecommendationCache,
  sanitizeRationale,
  type DebouncedRecommender,
  type RecommendationCache,
  type RecommenderFetcher,
} from '../../project/recommendationClient';
import { translate, useLocale, type Locale } from '../../i18n';

// ────────────────────────────────────────────────────────────────────────────
// 공용 유틸
// ────────────────────────────────────────────────────────────────────────────

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    k in params ? String(params[k]) : `{${k}}`,
  );
}

function fallbackFetcher(locale: RecommendationLocale): RecommenderFetcher {
  return async ({ description, signal }) => {
    if (signal?.aborted) throw new Error('aborted');
    return recommendAgentTeam(description, { locale });
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Props · 상태
// ────────────────────────────────────────────────────────────────────────────

export interface CreateProjectDialogSubmit {
  readonly name: string;
  readonly description: string;
  readonly workspacePath?: string;
  readonly locale: RecommendationLocale;
  /** 사용자가 "팀에 바로 추가" 로 선택한 추천 항목. 서버가 생성 직후 seed 한다. */
  readonly recommendedAgents: readonly AgentRecommendation[];
}

export interface CreateProjectDialogResult {
  readonly projectId: string;
  readonly seeded?: AppliedTeamResult;
}

export interface CreateProjectDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  /** 제출 핸들러 — 상위가 서버 POST /api/projects 에 위임. */
  readonly onSubmit: (input: CreateProjectDialogSubmit) => Promise<CreateProjectDialogResult>;
  /** 기존 프로젝트에 덧붙이는 모드라면 주입 — 즉시 seed 호출이 가능해진다. */
  readonly existingProjectId?: string;
  /** 테스트·스토리북 훅. 미주입 시 휴리스틱 폴백 fetcher 사용. */
  readonly fetcher?: RecommenderFetcher;
  readonly debounceMs?: number;
  readonly cache?: RecommendationCache;
  readonly applyOptions?: ApplyRecommendedTeamOptions;
  /** 테스트 결정성 위해 locale 강제. */
  readonly forceLocale?: Locale;
}

type RecommendStatus = 'idle' | 'loading' | 'ready' | 'error';

interface DialogState {
  readonly name: string;
  readonly description: string;
  readonly workspacePath: string;
  readonly status: RecommendStatus;
  readonly team?: AgentTeamRecommendation;
  /** 생성 시 seed 대상으로 선택된 추천의 인덱스 집합. */
  readonly seedQueue: ReadonlyArray<number>;
  /** existingProjectId 모드에서 바로 적용된 결과(카드별 뱃지 표시용). */
  readonly applied?: AppliedTeamResult;
  readonly errorMessage?: string;
  readonly submitting: boolean;
}

const INITIAL_STATE: DialogState = {
  name: '',
  description: '',
  workspacePath: '',
  status: 'idle',
  seedQueue: [],
  submitting: false,
};

// ────────────────────────────────────────────────────────────────────────────
// 컴포넌트
// ────────────────────────────────────────────────────────────────────────────

export function CreateProjectDialog(props: CreateProjectDialogProps): React.ReactElement | null {
  const hookLocale = useLocale();
  const locale = props.forceLocale ?? hookLocale.locale;
  const t = useCallback((key: string) => translate(key, locale), [locale]);

  const [state, setState] = useState<DialogState>(INITIAL_STATE);

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
        setState((prev) => ({ ...prev, status: 'idle', team: undefined, seedQueue: [] }));
        return;
      }
      setState((prev) => ({ ...prev, status: 'loading', errorMessage: undefined }));
      recommender
        .request(description)
        .then((team) => {
          if (team === null) return;
          setState((prev) => ({ ...prev, status: 'ready', team }));
        })
        .catch((err: unknown) => {
          setState((prev) => ({
            ...prev,
            status: 'error',
            errorMessage: err instanceof Error ? err.message : t('projects.recommend.error'),
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

  // "팀에 바로 추가" — existingProjectId 가 있으면 즉시 apply, 없으면 seedQueue 에 누적.
  const addToTeam = useCallback(
    async (index: number, rec: AgentRecommendation) => {
      if (props.existingProjectId) {
        setState((prev) => ({ ...prev, submitting: true }));
        try {
          const result = await applyRecommendedTeam(
            props.existingProjectId,
            [rec],
            props.applyOptions,
          );
          setState((prev) => {
            const base = prev.applied;
            if (!base) return { ...prev, submitting: false, applied: result };
            return {
              ...prev,
              submitting: false,
              applied: {
                projectId: base.projectId,
                items: [...base.items, ...result.items],
                appliedCount: base.appliedCount + result.appliedCount,
              },
            };
          });
        } catch (err) {
          setState((prev) => ({
            ...prev,
            submitting: false,
            errorMessage: err instanceof Error ? err.message : t('projects.recommend.error'),
          }));
        }
        return;
      }
      setState((prev) => {
        if (prev.seedQueue.includes(index)) return prev;
        return { ...prev, seedQueue: [...prev.seedQueue, index].sort((a, b) => a - b) };
      });
    },
    [props.existingProjectId, props.applyOptions, t],
  );

  const addAllToQueue = useCallback(() => {
    setState((prev) => {
      if (!prev.team) return prev;
      return { ...prev, seedQueue: prev.team.items.map((_, idx) => idx) };
    });
  }, []);

  const regenerate = useCallback(() => {
    cache.clear();
    triggerRecommendation(state.description);
  }, [cache, state.description, triggerRecommendation]);

  const canSubmit =
    state.name.trim().length > 0 && !state.submitting;

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!canSubmit) return;
      const team = state.team;
      const picked: readonly AgentRecommendation[] =
        team && state.seedQueue.length > 0
          ? state.seedQueue
              .map((i) => team.items[i])
              .filter((r): r is AgentRecommendation => Boolean(r))
          : [];
      setState((prev) => ({ ...prev, submitting: true, errorMessage: undefined }));
      try {
        await props.onSubmit({
          name: state.name.trim(),
          description: state.description.trim(),
          workspacePath: state.workspacePath.trim() || undefined,
          locale: locale as RecommendationLocale,
          recommendedAgents: picked,
        });
        setState(INITIAL_STATE);
        props.onClose();
      } catch (err) {
        setState((prev) => ({
          ...prev,
          submitting: false,
          errorMessage:
            err instanceof Error ? err.message : t('projects.create.errors.unknown'),
        }));
      }
    },
    [canSubmit, state, props, locale, t],
  );

  if (!props.isOpen) return null;

  const seedCountLabel = interpolate(t('projects.recommend.seedCount'), {
    count: state.seedQueue.length,
  });

  return (
    <div className="cpd-backdrop" role="dialog" aria-modal="true" aria-label={t('projects.create.modalTitle')}>
      <form className="cpd-dialog" onSubmit={onSubmit}>
        <header className="cpd-header">
          <h2>{t('projects.create.modalTitle')}</h2>
          <button
            type="button"
            onClick={props.onClose}
            aria-label={t('common.close')}
            className="cpd-close"
          >
            ×
          </button>
        </header>

        <fieldset className="cpd-fields" disabled={state.submitting}>
          <label className="cpd-field">
            <span>{t('projects.create.name')}</span>
            <input
              type="text"
              value={state.name}
              onChange={(e) => setState((prev) => ({ ...prev, name: e.target.value }))}
              placeholder={t('projects.create.namePlaceholder')}
              maxLength={80}
              required
            />
          </label>
          <label className="cpd-field">
            <span>{t('projects.create.description')}</span>
            <textarea
              value={state.description}
              onChange={onDescriptionChange}
              placeholder={t('projects.create.descriptionPlaceholder')}
              rows={4}
              maxLength={2000}
              aria-describedby="cpd-recommend-cta-hint"
            />
          </label>
          <div className="cpd-cta">
            <button
              type="button"
              className="cpd-cta-primary"
              onClick={() => triggerRecommendation(state.description)}
              disabled={
                state.description.trim().length === 0 || state.status === 'loading'
              }
            >
              {t('projects.recommend.cta')}
            </button>
            <small id="cpd-recommend-cta-hint" className="cpd-cta-hint">
              {t('projects.recommend.ctaHint')}
            </small>
          </div>
          <label className="cpd-field">
            <span>{t('projects.create.workspacePath')}</span>
            <input
              type="text"
              value={state.workspacePath}
              onChange={(e) => setState((prev) => ({ ...prev, workspacePath: e.target.value }))}
              placeholder={t('projects.create.workspacePathHint')}
            />
          </label>
        </fieldset>

        <section className="cpd-recommend" aria-label={t('projects.recommend.title')}>
          <header className="cpd-recommend-head">
            <h3>{t('projects.recommend.title')}</h3>
            <p className="cpd-recommend-intro">{t('projects.recommend.intro')}</p>
          </header>

          {state.status === 'loading' && (
            <p role="status" className="cpd-recommend-loading">
              {t('projects.recommend.loading')}
            </p>
          )}
          {state.status === 'error' && (
            <p role="alert" className="cpd-recommend-error">
              {state.errorMessage ?? t('projects.recommend.error')}
              <button type="button" onClick={() => triggerRecommendation(state.description)}>
                {t('projects.recommend.retry')}
              </button>
            </p>
          )}
          {state.status === 'idle' && state.description.trim().length === 0 && (
            <p className="cpd-recommend-empty">{t('projects.recommend.empty')}</p>
          )}

          {state.team && state.team.items.length > 0 && (
            <>
              <div className="cpd-recommend-meta">
                <span className="cpd-source-badge" data-source={state.team.source}>
                  {t(`projects.recommend.source.${state.team.source}`)}
                </span>
                <div className="cpd-recommend-actions">
                  <button type="button" onClick={addAllToQueue} disabled={Boolean(props.existingProjectId)}>
                    {t('projects.recommend.addAll')}
                  </button>
                  <button type="button" onClick={regenerate}>
                    {t('projects.recommend.regenerate')}
                  </button>
                </div>
              </div>
              <ul className="cpd-cards" role="list">
                {state.team.items.map((rec, idx) => {
                  const queued = state.seedQueue.includes(idx);
                  const segments = sanitizeRationale(rec.rationale);
                  const appliedEntry = state.applied?.items.find(
                    (it) =>
                      it.recommendation.role === rec.role &&
                      it.recommendation.name === rec.name,
                  );
                  const cardStatus: 'idle' | 'queued' | 'success' | 'failed' = appliedEntry
                    ? appliedEntry.ok
                      ? 'success'
                      : 'failed'
                    : queued
                      ? 'queued'
                      : 'idle';
                  return (
                    <li
                      key={`${rec.role}-${idx}`}
                      className="cpd-card"
                      data-card-status={cardStatus}
                    >
                      <div className="cpd-card-body">
                        <strong className="cpd-role">{rec.role}</strong>
                        <span className="cpd-name">{rec.name}</span>
                        <p className="cpd-rationale">
                          {segments.map((s, si) =>
                            s.strong ? <strong key={si}>{s.text}</strong> : <span key={si}>{s.text}</span>,
                          )}
                        </p>
                        {rec.skills && rec.skills.length > 0 && (
                          <ul className="cpd-skills" aria-label="skills">
                            {rec.skills.map((skill) => (
                              <li key={skill} className="cpd-skill-chip">
                                {skill}
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className="cpd-card-actions">
                          {cardStatus === 'success' && (
                            <span className="cpd-card-success" aria-label={t('projects.recommend.addedBadge')}>
                              ✓ {t('projects.recommend.addedBadge')}
                            </span>
                          )}
                          {cardStatus === 'failed' && (
                            <span className="cpd-card-failed" role="alert">
                              {appliedEntry?.error ?? t('projects.recommend.failedBadge')}
                            </span>
                          )}
                          {cardStatus === 'queued' && (
                            <span className="cpd-card-queued" aria-label={t('projects.recommend.pendingSeed')}>
                              {t('projects.recommend.pendingSeed')}
                            </span>
                          )}
                          {cardStatus !== 'success' && (
                            <button
                              type="button"
                              className="cpd-card-add"
                              onClick={() => addToTeam(idx, rec)}
                              disabled={state.submitting || (queued && !props.existingProjectId)}
                            >
                              {t('projects.recommend.addToTeam')}
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {!props.existingProjectId && state.seedQueue.length > 0 && (
                <p className="cpd-seed-summary" aria-live="polite">
                  {seedCountLabel}
                </p>
              )}
            </>
          )}
        </section>

        {state.errorMessage && state.status !== 'error' && (
          <p role="alert" className="cpd-submit-error">
            {state.errorMessage}
          </p>
        )}

        <footer className="cpd-footer">
          <button type="button" onClick={props.onClose} disabled={state.submitting}>
            {t('projects.create.cancel')}
          </button>
          <button type="submit" disabled={!canSubmit}>
            {t('projects.create.submit')}
          </button>
        </footer>
      </form>
    </div>
  );
}
