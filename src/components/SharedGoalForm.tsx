import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Target, Save, Lock, Check, AlertTriangle } from 'lucide-react';
import type { SharedGoal, SharedGoalPriority } from '../types';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { useI18n } from '../i18n';

// 공동 목표(SharedGoal) 입력 폼. ProjectManagement 화면에서 항상 렌더되어
// 자동 개발 ON 의 전제조건(= 활성 목표 1건) 을 사용자가 "보고 입력" 할 수 있도록
// 한다. 저장은 사용자가 [목표 저장] 버튼을 명시적으로 눌렀을 때에만 수행해,
// 비동기 로드가 끝나기 전에 사용자의 편집을 덮어쓰는 하이드레이션 레이스를
// 구조적으로 제거한다(GitAutomationPanel 1587ea9 와 동일 교훈).
//
// 계약
//  - GET /api/projects/:id/shared-goal → 활성 1건 또는 null
//  - POST /api/projects/:id/shared-goal → 신규 목표(upsert) 반환, 서버가
//    기존 active 를 archived 로 내린다(server.ts line 985~1018).
//  - "미입력" 판정: title 4자 이상 + description 20자 이상(+trim) + status='active'.
//    tests/autoDevToggleSharedGoalModal.regression.test.ts 의 trimmedGoalText 계약과 일치.
//
// 디자인 토큰은 src/index.css 의 --shared-goal-* 을 그대로 소비한다.

interface Props {
  projectId: string | null;
  onLog: (text: string, from?: string) => void;
  /**
   * 읽기 전용 모드(#cdaaabf3) — 토큰 소진/구독 만료로 서버 세션 상태가 exhausted 일 때
   * 부모가 true 를 내려 준다. true 이면 저장 버튼(= 자동 개발 트리거)이 비활성화되어
   * 새 공동 목표 등록이 불가능해지며, 이미 저장돼 있던 목표의 표시·읽기는 정상 유지한다.
   */
  readOnlyMode?: boolean;
}

type LoadState = 'loading' | 'ready' | 'error';

const PRIORITY_TOKENS: Record<SharedGoalPriority, { token: string; labelKey: string }> = {
  high:   { token: 'var(--shared-goal-priority-p1)', labelKey: 'sharedGoal.priorityHigh' },
  normal: { token: 'var(--shared-goal-priority-p2)', labelKey: 'sharedGoal.priorityNormal' },
  low:    { token: 'var(--shared-goal-priority-p3)', labelKey: 'sharedGoal.priorityLow' },
};
const PRIORITY_VALUES: ReadonlyArray<SharedGoalPriority> = ['high', 'normal', 'low'];

const TITLE_MIN = 4;
const TITLE_MAX = 80;
const DESC_MIN = 20;
const DESC_MAX = 500;

function toInputDate(iso: string | undefined): string {
  if (!iso) return '';
  // ISO 타임스탬프가 오면 날짜 부분만 잘라 <input type="date"> 에 맞춘다.
  // 이미 YYYY-MM-DD 형식이면 그대로 통과.
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

export function SharedGoalForm({ projectId, onLog, readOnlyMode }: Props) {
  const { t } = useI18n();
  const priorityOptions = useMemo(
    () => PRIORITY_VALUES.map(value => ({
      value,
      token: PRIORITY_TOKENS[value].token,
      label: t(PRIORITY_TOKENS[value].labelKey),
    })),
    [t],
  );
  const [loadState, setLoadState] = useState<LoadState>(projectId ? 'loading' : 'ready');
  const [savedGoal, setSavedGoal] = useState<SharedGoal | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<SharedGoalPriority>('normal');
  const [deadline, setDeadline] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 로드 시점 이후 사용자가 입력을 건드렸는지 추적. 저장 전/후 배지 분기에 쓴다.
  const [dirty, setDirty] = useState(false);
  const loadSeqRef = useRef(0);

  useEffect(() => {
    if (!projectId) {
      setLoadState('ready');
      setSavedGoal(null);
      setTitle(''); setDescription(''); setPriority('normal'); setDeadline('');
      setDirty(false);
      return;
    }
    const seq = ++loadSeqRef.current;
    setLoadState('loading');
    setSaveError(null);
    fetch(`/api/projects/${projectId}/shared-goal`)
      .then(async res => {
        if (seq !== loadSeqRef.current) return;
        if (!res.ok) {
          setLoadState('error');
          return;
        }
        const data = (await res.json()) as SharedGoal | null;
        if (seq !== loadSeqRef.current) return;
        if (data && data.status === 'active') {
          setSavedGoal(data);
          setTitle(data.title ?? '');
          setDescription(data.description ?? '');
          setPriority(data.priority ?? 'normal');
          setDeadline(toInputDate(data.deadline));
        } else {
          setSavedGoal(null);
          setTitle(''); setDescription(''); setPriority('normal'); setDeadline('');
        }
        setDirty(false);
        setLoadState('ready');
      })
      .catch(() => {
        if (seq !== loadSeqRef.current) return;
        setLoadState('error');
      });
  }, [projectId]);

  const trimmedTitle = title.trim();
  const trimmedDesc = description.trim();
  const titleValid = trimmedTitle.length >= TITLE_MIN && trimmedTitle.length <= TITLE_MAX;
  const descValid = trimmedDesc.length >= DESC_MIN && trimmedDesc.length <= DESC_MAX;
  const isValid = titleValid && descValid;

  const state: 'empty' | 'editing' | 'saved' =
    loadState === 'loading' ? 'empty' :
    dirty ? 'editing' :
    savedGoal ? 'saved' : 'empty';

  const borderToken =
    state === 'saved' ? 'var(--shared-goal-border-saved)' :
    state === 'editing' ? 'var(--shared-goal-border-editing)' :
    'var(--shared-goal-border-empty)';
  const bgToken =
    state === 'saved' ? 'var(--shared-goal-bg-saved)' :
    state === 'editing' ? 'var(--shared-goal-bg-editing)' :
    'var(--shared-goal-bg-empty)';

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!projectId || !isValid || saving) return;
    // 세션 폴백(#cdaaabf3) — 토큰 소진/구독 만료 상태에서는 저장 자체를 차단한다.
    // 저장이 성공하면 서버 측이 자동 개발 루프를 돌릴 근거로 삼으므로, 사용자가 실수로
    // 비활성 버튼을 우회해 form submit 을 전송하더라도 네트워크 호출 전에 멈춘다.
    if (readOnlyMode) {
      setSaveError(t('sharedGoal.errors.readOnlyBlocked'));
      onLog(t('sharedGoal.log.readOnlyBlocked'));
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/shared-goal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: trimmedTitle,
          description: trimmedDesc,
          priority,
          deadline: deadline || undefined,
          status: 'active',
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = (body as { error?: string }).error || t('sharedGoal.errors.saveHttp').replace('{status}', String(res.status));
        setSaveError(msg);
        onLog(t('sharedGoal.log.saveFailed').replace('{message}', msg));
        return;
      }
      const saved = (await res.json()) as SharedGoal;
      setSavedGoal(saved);
      setDirty(false);
      onLog(t('sharedGoal.log.saved').replace('{title}', saved.title));
    } catch (err) {
      const msg = (err as Error).message || t('sharedGoal.errors.unknown');
      setSaveError(msg);
      onLog(t('sharedGoal.log.saveFailed').replace('{message}', msg));
    } finally {
      setSaving(false);
    }
  };

  const headingId = 'shared-goal-heading';

  return (
    <section
      role="group"
      aria-labelledby={headingId}
      data-testid="shared-goal-form"
      data-goal-state={state}
      data-read-only={readOnlyMode ? 'true' : 'false'}
      aria-readonly={readOnlyMode || undefined}
      className="p-4 space-y-3"
      style={{
        border: `2px ${state === 'empty' ? 'dashed' : 'solid'} ${borderToken}`,
        background: bgToken,
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Target size={14} className="text-[var(--pixel-accent)]" />
          <h3 id={headingId} className="text-[12px] font-bold tracking-wider text-white uppercase">
            {t('sharedGoal.title')}
          </h3>
        </div>
        <StatusBadge state={state} t={t} />
      </div>
      <p className="text-[11px]" style={{ color: 'var(--shared-goal-hint-fg)' }}>
        {t('sharedGoal.intro')}
      </p>

      {loadState === 'loading' && (
        <EmptyState
          variant="loading"
          title={t('sharedGoal.loadingTitle')}
          description={t('sharedGoal.loadingDescription')}
          fillMinHeight={false}
          testId="shared-goal-form-loading"
        />
      )}

      {loadState === 'error' && (
        <ErrorState
          title={t('sharedGoal.loadErrorTitle')}
          description={t('sharedGoal.loadErrorDescription')}
          testId="shared-goal-form-load-error"
        />
      )}

      {!projectId && (
        <EmptyState
          variant="empty"
          icon={<Lock size={24} style={{ color: 'var(--empty-state-icon-fg)' }} />}
          title={t('sharedGoal.noProjectTitle')}
          description={t('sharedGoal.noProjectDescription')}
          fillMinHeight={false}
          testId="shared-goal-form-no-project"
        />
      )}

      {projectId && loadState !== 'loading' && (
        <form className="space-y-3" onSubmit={submit} noValidate>
          <label className="block">
            <span className="text-[11px] text-white/70">
              {t('sharedGoal.titleLabel')} <span className="text-[var(--shared-goal-priority-p1)]">*</span>
              <span className="ml-2 text-white/40">{trimmedTitle.length}/{TITLE_MAX}</span>
            </span>
            <input
              type="text"
              value={title}
              onChange={e => { setTitle(e.target.value); setDirty(true); }}
              maxLength={TITLE_MAX}
              required
              aria-required="true"
              aria-invalid={title.length > 0 && !titleValid}
              data-testid="shared-goal-title"
              placeholder={t('sharedGoal.titlePlaceholder')}
              className="mt-1 w-full bg-black/30 border-2 border-[var(--pixel-border)] text-[12px] text-white px-2 py-1 focus:outline-none focus:border-[var(--pixel-accent)]"
            />
            {title.length > 0 && !titleValid && (
              <span className="text-[10px] text-red-300 block mt-1">
                {t('sharedGoal.titleRange').replace('{min}', String(TITLE_MIN)).replace('{max}', String(TITLE_MAX))}
              </span>
            )}
          </label>

          <label className="block">
            <span className="text-[11px] text-white/70">
              {t('sharedGoal.descriptionLabel')} <span className="text-[var(--shared-goal-priority-p1)]">*</span>
              <span className="ml-2 text-white/40">{trimmedDesc.length}/{DESC_MAX}</span>
            </span>
            <textarea
              value={description}
              onChange={e => { setDescription(e.target.value); setDirty(true); }}
              maxLength={DESC_MAX}
              required
              aria-required="true"
              aria-invalid={description.length > 0 && !descValid}
              rows={4}
              data-testid="shared-goal-description"
              placeholder={t('sharedGoal.descriptionPlaceholder')}
              className="mt-1 w-full bg-black/30 border-2 border-[var(--pixel-border)] text-[12px] text-white px-2 py-1 focus:outline-none focus:border-[var(--pixel-accent)]"
            />
            {description.length > 0 && !descValid && (
              <span className="text-[10px] text-red-300 block mt-1">
                {t('sharedGoal.descriptionRange').replace('{min}', String(DESC_MIN)).replace('{max}', String(DESC_MAX))}
              </span>
            )}
          </label>

          <div className="flex flex-wrap items-center gap-4">
            <fieldset className="flex items-center gap-3" role="radiogroup" aria-label={t('sharedGoal.priorityAria')}>
              <legend className="text-[11px] text-white/70 mr-1">{t('sharedGoal.priorityLegend')}</legend>
              {priorityOptions.map(opt => (
                <label key={opt.value} className="flex items-center gap-1 text-[11px] text-white/80 cursor-pointer">
                  <input
                    type="radio"
                    name="shared-goal-priority"
                    value={opt.value}
                    checked={priority === opt.value}
                    onChange={() => { setPriority(opt.value); setDirty(true); }}
                    data-testid={`shared-goal-priority-${opt.value}`}
                    className="accent-[var(--pixel-accent)]"
                  />
                  <span style={{ color: opt.token }}>{opt.label}</span>
                </label>
              ))}
            </fieldset>

            <label className="flex items-center gap-2 text-[11px] text-white/70">
              {t('sharedGoal.deadline')}
              <input
                type="date"
                value={deadline}
                onChange={e => { setDeadline(e.target.value); setDirty(true); }}
                data-testid="shared-goal-deadline"
                className="bg-black/30 border-2 border-[var(--pixel-border)] text-[11px] text-white px-2 py-1 focus:outline-none focus:border-[var(--pixel-accent)]"
              />
            </label>
          </div>

          {saveError && (
            <div
              role="alert"
              data-testid="shared-goal-save-error"
              className="text-[11px] text-red-300 flex items-center gap-1"
            >
              <AlertTriangle size={12} /> {saveError}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="submit"
              disabled={!isValid || saving || !!readOnlyMode}
              data-testid="shared-goal-save"
              data-read-only={readOnlyMode ? 'true' : 'false'}
              aria-label={readOnlyMode ? t('sharedGoal.readOnlySaveAria') : undefined}
              title={readOnlyMode ? t('sharedGoal.readOnlyTitle') : undefined}
              className="inline-flex items-center gap-1 px-3 py-1 border-2 border-[var(--pixel-accent)] bg-[var(--pixel-accent)]/20 text-[11px] text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--pixel-accent)]/30"
            >
              <Save size={12} /> {saving ? t('sharedGoal.saving') : t('sharedGoal.save')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function StatusBadge({ state, t }: { state: 'empty' | 'editing' | 'saved'; t: (key: string) => string }) {
  if (state === 'saved') {
    return (
      <span
        role="status"
        aria-live="polite"
        data-testid="shared-goal-badge-saved"
        className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider"
        style={{ color: 'var(--shared-goal-border-saved)' }}
      >
        <Check size={10} /> {t('sharedGoal.savedBadge')}
      </span>
    );
  }
  if (state === 'editing') {
    return (
      <span
        role="status"
        data-testid="shared-goal-badge-editing"
        className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider"
        style={{ color: 'var(--shared-goal-border-editing)' }}
      >
        <AlertTriangle size={10} /> {t('sharedGoal.editingBadge')}
      </span>
    );
  }
  return (
    <span
      role="status"
      data-testid="shared-goal-badge-empty"
      className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider"
      style={{ color: 'var(--shared-goal-lock-fg)' }}
    >
      <Lock size={10} /> {t('sharedGoal.emptyBadge')}
    </span>
  );
}
