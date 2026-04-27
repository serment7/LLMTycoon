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
import { DEFAULT_DOC_STORAGE, type DocStorageMode } from '../../utils/docStorage';
import {
  MAX_RECOMMEND_COUNT,
  MIN_RECOMMEND_COUNT,
  clampRecommendCount,
  useRecommendCount,
} from '../../stores/recommendCountStore';
import {
  MIN_DESCRIPTION_LENGTH,
  RECOMMENDATION_DEBOUNCE_MS,
  isDescriptionLongEnough,
  mergeLockedRoles,
  useProjectCreateStore,
  type LastRecommendationSnapshot,
} from '../../stores/projectCreateStore';
import { ROLE_CATALOG } from '../../project/recommendAgentTeam';
import type { AgentRole } from '../../types';

// ────────────────────────────────────────────────────────────────────────────
// 공용 유틸
// ────────────────────────────────────────────────────────────────────────────

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    k in params ? String(params[k]) : `{${k}}`,
  );
}

function fallbackFetcher(locale: RecommendationLocale): RecommenderFetcher {
  // 지시 #797538d6 — count 가 디바운서에서 흘러 오면 LLM 호출에 그대로 전달.
  return async ({ description, signal, count }) => {
    if (signal?.aborted) throw new Error('aborted');
    return recommendAgentTeam(description, { locale, count });
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
  /**
   * 문서('docs/') 저장 위치. 'workspace' = 프로젝트 폴더 안에 저장(기존 동작),
   * 'central' = LLMTycoon 자체 저장소(.llmtycoon/projects/<id>/docs)에 격리.
   * 미지정이면 서버가 'workspace' 로 폴백한다.
   */
  readonly docStorageMode?: DocStorageMode;
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
  readonly docStorageMode: DocStorageMode;
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
  docStorageMode: DEFAULT_DOC_STORAGE.mode,
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
  // 지시 #797538d6 — 추천 인원수 영속 스토어. 마지막 선택값을 localStorage 에서 복원하고,
  // 변경 시 다음 세션에도 유지된다. 디바운서·캐시 키 모두 본 값에 의존한다.
  const { count: recommendCount, setCount: setRecommendCount } = useRecommendCount();
  // 지시 #462fa5ec — 잠긴 역할 + 마지막 추천 스냅샷 영속 스토어. 두 상태 모두 새로고침
  // 후에도 사용자의 직전 작업 화면을 즉시 복원해 준다.
  const {
    lockedRoles,
    lastRecommendation,
    toggleLockedRole,
    setLastRecommendation,
  } = useProjectCreateStore();

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
    // 지시 #462fa5ec — 디바운스 기본값을 600ms 로 상향(토큰 절약). props 가 명시값을 주면
    // 그대로 사용해 테스트·스토리북의 결정성을 유지한다.
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
  // 사용자의 description 도 함께 복원해 입력 → 추천 흐름이 끊기지 않는다.
  useEffect(() => {
    if (!props.isOpen) return;
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
      }));
    }
    // 의도적으로 props.isOpen 만 트리거 — 사용자가 입력 중일 때 덮어쓰지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.isOpen]);

  const triggerRecommendation = useCallback(
    (description: string, count: number) => {
      const recommender = recommenderRef.current;
      if (!recommender) return;
      if (description.trim().length === 0) {
        setState((prev) => ({ ...prev, status: 'idle', team: undefined, seedQueue: [] }));
        return;
      }
      // 지시 #462fa5ec — 최소 글자 수 미만이면 LLM 호출 자체를 차단해 토큰을 아낀다.
      // UI 는 'idle' 상태로 머물고, 별도 가이드 문구가 노출된다.
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
          // 지시 #462fa5ec — 잠긴 역할은 새 응답 위에 머지. fresh 에 같은 역할이 있으면
          // 응답값(LLM 의 갱신된 카피) 채택, 없으면 직전 카드 보존.
          const merged = mergeLockedRoles(team.items, {
            lockedRoles,
            previous: state.team?.items ?? lastRecommendation?.items ?? null,
            count,
          });
          const nextTeam: AgentTeamRecommendation = { ...team, items: merged };
          setState((prev) => ({ ...prev, status: 'ready', team: nextTeam }));
          // 마지막 추천 스냅샷은 user settings 에 저장 — 새로고침 후 즉시 복원.
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
            errorMessage: err instanceof Error ? err.message : t('projects.recommend.error'),
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

  // 인원수 변경 핸들러 — 디바운스는 createDebouncedRecommender 내부에서 잡혀 있으므로,
  // 여기서는 상태만 갱신하고 즉시 재요청을 트리거한다(설명이 비어 있으면 no-op).
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
    triggerRecommendation(state.description, recommendCount);
  }, [cache, state.description, recommendCount, triggerRecommendation]);

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
          docStorageMode: state.docStorageMode,
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
              onClick={() => triggerRecommendation(state.description, recommendCount)}
              disabled={
                !isDescriptionLongEnough(state.description)
                || state.status === 'loading'
              }
            >
              {t('projects.recommend.cta')}
            </button>
            <small id="cpd-recommend-cta-hint" className="cpd-cta-hint">
              {t('projects.recommend.ctaHint')}
            </small>
            {/* 지시 #462fa5ec — 최소 글자 수 미만일 때 사용자에게 명시적 가이드. 입력란에
                포커스가 있는 상태에서 카드가 갱신되지 않는 이유를 즉시 알 수 있다. */}
            {state.description.length > 0
              && !isDescriptionLongEnough(state.description) && (
                <p
                  className="cpd-recommend-too-short"
                  role="status"
                  data-testid="cpd-too-short-hint"
                >
                  {interpolate(t('projects.recommend.tooShort'), {
                    min: MIN_DESCRIPTION_LENGTH,
                    current: state.description.trim().length,
                  })}
                </p>
              )}
            <label className="cpd-count-field">
              <span>
                {interpolate(t('projects.recommend.countLabel'), { count: recommendCount })}
              </span>
              <input
                type="range"
                className="cpd-count-slider"
                min={MIN_RECOMMEND_COUNT}
                max={MAX_RECOMMEND_COUNT}
                step={1}
                value={recommendCount}
                onChange={(e) => onRecommendCountChange(Number(e.target.value))}
                aria-label={t('projects.recommend.countAriaLabel')}
                aria-valuemin={MIN_RECOMMEND_COUNT}
                aria-valuemax={MAX_RECOMMEND_COUNT}
                aria-valuenow={recommendCount}
              />
            </label>
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
          {/* 문서 저장 위치 — 'workspace'(프로젝트 폴더 안) vs 'central'(LLMTycoon 격리).
              생성 시점은 마이그레이션 대상 파일이 없으니 단순 라디오로 충분하고, 추후
              SettingsDrawer 의 동일 컨트롤이 마이그레이션 모달까지 책임진다. */}
          <fieldset className="cpd-field cpd-doc-storage" data-testid="cpd-doc-storage">
            <legend>{t('projects.create.docStorage.title')}</legend>
            <p className="cpd-doc-storage-intro">{t('projects.create.docStorage.intro')}</p>
            <div role="radiogroup" aria-label={t('projects.create.docStorage.title')} className="cpd-doc-storage-options">
              {(['workspace', 'central'] as DocStorageMode[]).map((mode) => {
                const checked = state.docStorageMode === mode;
                return (
                  <label key={mode} className="cpd-doc-storage-option" data-checked={checked || undefined}>
                    <input
                      type="radio"
                      name="cpd-doc-storage"
                      value={mode}
                      checked={checked}
                      onChange={() => setState((prev) => ({ ...prev, docStorageMode: mode }))}
                    />
                    <span className="cpd-doc-storage-label">
                      <strong>{t(`projects.create.docStorage.${mode}.title`)}</strong>
                      <small>{t(`projects.create.docStorage.${mode}.hint`)}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        </fieldset>

        <section className="cpd-recommend" aria-label={t('projects.recommend.title')}>
          <header className="cpd-recommend-head">
            <h3>{t('projects.recommend.title')}</h3>
            <p className="cpd-recommend-intro">{t('projects.recommend.intro')}</p>
          </header>

          {state.status === 'loading' && (
            <>
              <p role="status" className="cpd-recommend-loading">
                {t('projects.recommend.loading')}
              </p>
              {/* 지시 #797538d6 — 응답 도착 전에 인원수만큼 빈 슬롯을 미리 그려 둔다.
                  레이아웃 점프를 줄이고, 사용자가 "몇 명이 올 예정인지" 한눈에 알 수 있게 한다. */}
              <ul className="cpd-cards cpd-cards-skeleton" role="list" aria-hidden="true">
                {Array.from({ length: recommendCount }, (_, idx) => (
                  <li key={`skeleton-${idx}`} className="cpd-card cpd-card-skeleton" data-card-status="loading">
                    <div className="cpd-card-body">
                      <span className="cpd-skeleton-line cpd-skeleton-role" />
                      <span className="cpd-skeleton-line cpd-skeleton-name" />
                      <span className="cpd-skeleton-line cpd-skeleton-rationale" />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {state.status === 'error' && (
            <p role="alert" className="cpd-recommend-error">
              {state.errorMessage ?? t('projects.recommend.error')}
              <button type="button" onClick={() => triggerRecommendation(state.description, recommendCount)}>
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
                  const isLocked = lockedRoles.includes(rec.role);
                  return (
                    <li
                      key={`${rec.role}-${idx}`}
                      className="cpd-card"
                      data-card-status={cardStatus}
                      data-card-locked={isLocked || undefined}
                    >
                      <div className="cpd-card-body">
                        <header className="cpd-card-head">
                          <strong className="cpd-role">{rec.role}</strong>
                          <span className="cpd-name">{rec.name}</span>
                          {/* 지시 #462fa5ec — "이 역할 고정" 토글. 잠긴 카드는 다음 추천
                              새로고침에서 동일 역할이 응답에 포함되면 새 카피로 갱신되고,
                              없으면 기존 카드를 그대로 보존한다. */}
                          <button
                            type="button"
                            className="cpd-card-lock"
                            onClick={() => toggleLockedRole(rec.role)}
                            aria-pressed={isLocked}
                            aria-label={t(
                              isLocked
                                ? 'projects.recommend.lock.aria.locked'
                                : 'projects.recommend.lock.aria.unlocked',
                            )}
                          >
                            {t(
                              isLocked
                                ? 'projects.recommend.lock.locked'
                                : 'projects.recommend.lock.unlocked',
                            )}
                          </button>
                        </header>
                        <p className="cpd-rationale">
                          {segments.map((s, si) =>
                            s.strong ? <strong key={si}>{s.text}</strong> : <span key={si}>{s.text}</span>,
                          )}
                        </p>
                        {/* 지시 #462fa5ec — Joker 가 추가한 "추천 이유" 보강 텍스트.
                            응답·휴리스틱이 reason 을 안 채우면 영역 자체를 숨겨 레이아웃이
                            튀지 않는다. */}
                        {rec.reason && rec.reason.trim().length > 0 && (
                          <p className="cpd-reason" data-testid="cpd-card-reason">
                            <span className="cpd-reason-label">
                              {t('projects.recommend.reasonLabel')}
                            </span>
                            <span className="cpd-reason-body">{rec.reason}</span>
                          </p>
                        )}
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
