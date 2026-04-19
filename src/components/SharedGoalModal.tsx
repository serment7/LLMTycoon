import React, { useEffect, useId, useRef, useState } from 'react';
import { Target, Check, X, AlertTriangle } from 'lucide-react';
import type { SharedGoal, SharedGoalPriority, CommitStrategy } from '../types';
import { COMMIT_STRATEGY_LABEL, DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG } from '../types';
import { useToast } from './ToastProvider';
import { sharedGoalModalKo as COPY } from '../i18n/sharedGoalModal.ko';

// SharedGoalModal · 자동 개발 OFF→ON 시 활성 공동 목표가 없을 때 뜨는 on-ramp.
// 시안: tests/shared-goal-modal-mockup.md (2026-04-19).
//
// 핵심 계약(시안 §1 원자성):
//   1) POST /api/projects/:id/shared-goal 가 200 으로 돌아온 **뒤에만**
//   2) PATCH /api/auto-dev { enabled: true, projectId } 를 호출한다.
//   목표 저장이 실패하면 토글은 OFF 를 유지해야 하므로 원자 순서를 지킨다.
//
// 기존 App.tsx 의 단순 "안내" 모달(프로젝트 관리 탭으로 보내고 끝)을 교체하여,
// 사용자가 모달 안에서 목표를 바로 입력·저장하고 자동 개발을 시작할 수 있게
// on-ramp 역할을 수행한다. 탭 이동 경로는 ProjectManagement 의 SharedGoalForm
// 이 여전히 대안으로 남아 있으므로, 사용자는 두 경로 중 편한 쪽을 선택한다.

interface Props {
  open: boolean;
  projectId: string | null;
  onClose: () => void;
  // 저장 + 자동 개발 ON 이 모두 성공했을 때만 호출. App 은 이 콜백에서
  // autoDevEnabled state 를 true 로 맞춘다. 모달은 이후 onClose 를 스스로 부른다.
  onEnabled: (goal: SharedGoal) => void;
  onLog: (text: string, from?: string) => void;
  // 태스크 경계 커밋(#f1d5ce51) — 자동 개발 ON 확정 전에 현재 커밋 정책을 사용자가
  // 인지할 수 있도록 모달 확인 버튼 옆에 요약 라벨을 표시한다. App 이 GitAutomationPanel
  // 설정에서 읽어 넘겨 주며, 값이 없으면 DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG 로 폴백.
  commitStrategy?: CommitStrategy;
}

const PRIORITY_OPTIONS: { value: SharedGoalPriority; label: string; token: string }[] = [
  { value: 'high',   label: COPY.priority.options.high,   token: 'var(--shared-goal-priority-p1)' },
  { value: 'normal', label: COPY.priority.options.normal, token: 'var(--shared-goal-priority-p2)' },
  { value: 'low',    label: COPY.priority.options.low,    token: 'var(--shared-goal-priority-p3)' },
];

const TITLE_MIN = 4;
const TITLE_MAX = 80;
const DESC_MIN = 20;
const DESC_MAX = 500;

export function SharedGoalModal({ open, projectId, onClose, onEnabled, onLog, commitStrategy }: Props) {
  // 현재 커밋 전략 요약 라벨 — 기본값은 types.ts 의 상수에서 가져와 단일 출처를 지킨다.
  const effectiveCommitStrategy: CommitStrategy =
    commitStrategy ?? DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG.commitStrategy;
  const commitStrategyLabel = COMMIT_STRATEGY_LABEL[effectiveCommitStrategy];
  // ToastProvider 가 트리에 없으면 no-op fallback 이 반환되므로, 별도 가드 없이
  // 안전하게 호출 가능하다(docs/toast-notification-visual-2026-04-19.md §4 API).
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<SharedGoalPriority>('high');
  const [deadline, setDeadline] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // 모달이 열리기 직전에 포커스가 있던 요소. 시안 §4.1 포커스 트랩 규약에 따라
  // 모달이 닫힐 때 이 요소로 포커스를 복원해, 자동 개발 토글을 눌렀던 위치로
  // 돌아가게 한다. 키보드 사용자가 "어디에 있었는지" 를 잃지 않는 장치.
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const dialogId = useId();

  useEffect(() => {
    if (!open) {
      setTitle(''); setDescription(''); setPriority('high'); setDeadline('');
      setSaving(false); setSaveError(null);
      // 모달이 방금 닫혔으면 저장해 둔 이전 포커스로 복원한다. try 로 감싸
      // 해당 요소가 이미 DOM 에서 사라진 경우(탭 전환 등)에도 조용히 넘어간다.
      if (lastFocusRef.current) {
        try { lastFocusRef.current.focus(); } catch { /* ignore */ }
        lastFocusRef.current = null;
      }
      return;
    }
    // 시안 §4.1: 열릴 때 현재 포커스 요소를 lastFocus 로 저장. 이후 §4.2 에 따라
    // 제목 입력란으로 포커스를 이동시켜 즉시 타이핑/낭독이 가능하게 한다.
    lastFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    const t = setTimeout(() => titleRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // 시안 §4.1 포커스 트랩 + §4.3 Ctrl/⌘+Enter 단축키를 하나의 dialog-level
  // 키 핸들러로 통합한다. Tab 순환은 모달 바깥(backdrop · 문서 body) 으로
  // 포커스가 빠지는 것을 원천 차단하고, Ctrl/⌘+Enter 는 타이핑 중에도
  // 마우스 없이 primary 를 즉시 트리거한다. 하나의 함수에 두 계약을 묶어
  // onKeyDown 이 여러 핸들러로 분기하지 않도록(회귀 테스트와 호환) 한다.
  const handleDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // 시안 §4.3 단축키 맵: Ctrl/Cmd + Enter 로 primary 를 즉시 트리거.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      if (!isValid || saving || !projectId) return;
      e.preventDefault();
      const form = dialogRef.current?.querySelector('form');
      if (form) (form as HTMLFormElement).requestSubmit();
      return;
    }
    if (e.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const selector = [
      'a[href]',
      'button:not([disabled])',
      'textarea:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const nodes = dialog.querySelectorAll<HTMLElement>(selector);
    const focusable: HTMLElement[] = [];
    nodes.forEach((el) => {
      if (!el.hasAttribute('aria-hidden') && el.offsetParent !== null) focusable.push(el);
    });
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || !dialog.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  const trimmedTitle = title.trim();
  const trimmedDesc = description.trim();
  const titleValid = trimmedTitle.length >= TITLE_MIN && trimmedTitle.length <= TITLE_MAX;
  const descValid = trimmedDesc.length >= DESC_MIN && trimmedDesc.length <= DESC_MAX;
  const isValid = titleValid && descValid;
  const dirty = title.length > 0 || description.length > 0 || !!deadline;
  // 시안 §2B.1 empty-create 상태: 모달이 방금 열렸고 아직 한 글자도 입력/선택되지
  // 않은 순간. 상단 📝 안내 배너를 이 때만 노출하며, 첫 키 입력이 들어오면
  // dirty=true 로 전환되며 배너는 자연스럽게 사라진다. 우선순위 라디오는 기본값
  // 'high' 이므로 dirty 판정에서 제외되어 "진짜로 아무것도 안 건드린" 상태만 잡힌다.
  const emptyCreate = !dirty;

  const handleEsc = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (dirty) {
      // 시안 §4.3: dirty 이면 확인 다이얼로그 — MVP 에서는 window.confirm 으로 축약.
      const ok = window.confirm(COPY.confirmClose);
      if (!ok) return;
    }
    onClose();
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!projectId || !isValid || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      // 1) 목표 저장
      const saveRes = await fetch(`/api/projects/${projectId}/shared-goal`, {
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
      if (!saveRes.ok) {
        const body = await saveRes.json().catch(() => ({}));
        const msg = (body as { error?: string }).error || `목표 저장 실패 (HTTP ${saveRes.status})`;
        setSaveError(msg);
        onLog(`공동 목표 저장 실패: ${msg}`);
        toast.push({
          id: 'shared-goal-modal-save-error',
          variant: 'error',
          title: '공동 목표 저장 실패',
          description: msg,
          action: { label: '재시도', onClick: () => (e.target as HTMLFormElement).requestSubmit() },
        });
        return;
      }
      const saved = (await saveRes.json()) as SharedGoal;

      // 2) 목표 저장 성공 후에만 자동 개발 ON — 시안 §1 원자성.
      const patchRes = await fetch('/api/auto-dev', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, projectId }),
      });
      if (!patchRes.ok) {
        const body = await patchRes.json().catch(() => ({}));
        const msg = (body as { error?: string }).error || `자동 개발 시작 실패 (HTTP ${patchRes.status})`;
        setSaveError(`목표는 저장됐지만 자동 개발 시작에 실패했습니다: ${msg}`);
        onLog(`자동 개발 시작 실패: ${msg}`);
        toast.push({
          id: 'shared-goal-modal-auto-dev-error',
          variant: 'error',
          title: '자동 개발 시작 실패',
          description: `목표는 저장됐지만 자동 개발 ON 전환이 실패했습니다: ${msg}`,
        });
        return;
      }

      onLog(`공동 목표 저장 + 자동 개발 ON: ${saved.title}`);
      toast.push({
        id: 'shared-goal-modal-save-success',
        variant: 'success',
        title: '목표가 저장됐어요',
        description: '자동 개발이 곧 시작됩니다.',
      });
      onEnabled(saved);
      onClose();
    } catch (err) {
      const msg = (err as Error).message || '알 수 없는 오류';
      setSaveError(msg);
      onLog(`공동 목표 저장 실패: ${msg}`);
      toast.push({
        id: 'shared-goal-modal-save-error',
        variant: 'error',
        title: '공동 목표 저장 실패',
        description: msg,
      });
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const titleId = `${dialogId}-title`;
  const subtitleId = `${dialogId}-subtitle`;

  return (
    <div
      role="presentation"
      data-testid="shared-goal-modal-backdrop"
      onKeyDown={handleEsc}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'var(--shared-goal-modal-backdrop)',
        backdropFilter: `blur(var(--shared-goal-modal-backdrop-blur))`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
      onClick={(e) => {
        // backdrop 클릭 시 닫기 — dialog 내부 클릭은 stopPropagation 으로 흡수.
        if (e.target === e.currentTarget) {
          if (dirty) {
            const ok = window.confirm(COPY.confirmClose);
            if (!ok) return;
          }
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        data-testid="shared-goal-modal-dialog"
        onKeyDown={handleDialogKeyDown}
        style={{
          background: 'var(--shared-goal-modal-surface)',
          border: `2px solid var(--shared-goal-modal-surface-border)`,
          borderRadius: 'var(--shared-goal-modal-radius)',
          boxShadow: 'var(--shared-goal-modal-shadow)',
          maxWidth: 640,
          width: '100%',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* HEADER */}
        <div
          className="flex items-start justify-between gap-3 p-4"
          style={{ borderBottom: `1px solid var(--shared-goal-modal-surface-border)` }}
        >
          <div className="flex items-start gap-2 min-w-0">
            <Target size={16} style={{ color: 'var(--shared-goal-modal-field-focus)' }} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <h2
                id={titleId}
                className="text-[14px] font-bold uppercase tracking-wider"
                style={{ color: 'var(--shared-goal-modal-header-fg)' }}
              >
                {COPY.header.title}
              </h2>
              <p
                id={subtitleId}
                className="mt-1 text-[11px]"
                style={{ color: 'var(--shared-goal-modal-subtle-fg)' }}
              >
                {COPY.header.subtitle}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              if (dirty) {
                const ok = window.confirm(COPY.confirmClose);
                if (!ok) return;
              }
              onClose();
            }}
            data-testid="shared-goal-modal-close"
            aria-label={COPY.header.closeAriaLabel}
            className="shrink-0 p-1 hover:bg-white/10 rounded"
            style={{ color: 'var(--shared-goal-modal-subtle-fg)' }}
          >
            <X size={16} />
          </button>
        </div>

        {/* BODY */}
        <form
          onSubmit={submit}
          noValidate
          className="flex-1 overflow-y-auto p-4 space-y-4"
          data-testid="shared-goal-modal-form"
          style={{
            // 시안 §2B.1: 두 상태(empty-create ↔ editing) 모두 BODY 높이를 동일하게
            // 고정해 layout shift 0 을 보장. 배너가 사라져도 BODY 자체는 출렁이지 않는다.
            minHeight: 'var(--shared-goal-modal-body-min-height)',
          }}
        >
          {/* 시안 §2B.3: empty-create 전용 📝 빈 상태 배너.
              dirty=false 인 첫 진입 순간에만 표시되며, 첫 키 입력이 들어오면 자연스럽게
              사라진다. role="status" + aria-live="polite" 로 스크린리더에 1회 낭독.
              '폼이 없는 것처럼 보이는' 과거 회귀를 카피 수준에서 차단하는 장치다. */}
          {emptyCreate && (
            <div
              data-testid="shared-goal-modal-empty-banner"
              role="status"
              aria-live="polite"
              className="flex items-start gap-2 px-3 py-2"
              style={{
                height: 'var(--shared-goal-modal-banner-height)',
                background: 'var(--shared-goal-modal-banner-bg)',
                borderLeft: '2px solid var(--shared-goal-modal-banner-strip)',
              }}
            >
              <span aria-hidden="true" style={{ fontSize: 16, lineHeight: '16px' }}>📝</span>
              <div className="min-w-0">
                <p
                  className="text-[12px] font-bold"
                  style={{ color: 'var(--shared-goal-modal-header-fg)' }}
                >
                  {COPY.banner.title}
                </p>
                <p
                  className="text-[11px] mt-0.5"
                  style={{ color: 'var(--shared-goal-modal-subtle-fg)' }}
                >
                  {COPY.banner.body}
                </p>
              </div>
            </div>
          )}

          <label className="block">
            <span className="text-[11px]" style={{ color: 'var(--shared-goal-modal-subtle-fg)' }}>
              {COPY.title.label} <span style={{ color: 'var(--shared-goal-modal-error-strip)' }}>*</span>
              <span
                className="ml-2"
                style={{
                  color: title.length > TITLE_MAX || (title.length > 0 && !titleValid)
                    ? 'var(--shared-goal-modal-counter-error-fg)'
                    : 'var(--shared-goal-modal-counter-fg)',
                }}
              >
                {trimmedTitle.length}/{TITLE_MAX}
              </span>
            </span>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={TITLE_MAX}
              required
              aria-required="true"
              aria-invalid={title.length > 0 && !titleValid}
              aria-describedby={`${dialogId}-title-hint`}
              data-testid="shared-goal-modal-title"
              placeholder={COPY.title.placeholder}
              className="mt-1 w-full bg-black/20 text-[12px] px-2 py-1 focus:outline-none"
              style={{
                border: `2px solid var(--shared-goal-modal-field-border)`,
                color: 'var(--shared-goal-modal-header-fg)',
              }}
            />
            {/* 시안 §2A.1 보조 힌트: placeholder 가 사라진 뒤에도 규칙/목적을 남겨
                두는 영속 텍스트. `aria-describedby` 로 input 과 연결해 iOS VoiceOver
                의 레이블 이중 낭독 문제(§2A.3) 를 회피한다. */}
            <span
              id={`${dialogId}-title-hint`}
              data-testid="shared-goal-modal-title-hint"
              className="text-[10px] block mt-1"
              style={{ color: 'var(--shared-goal-modal-subtle-fg)' }}
            >
              {COPY.title.hint}
            </span>
            {title.length > 0 && !titleValid && (
              <span className="text-[10px] block mt-1" style={{ color: 'var(--shared-goal-modal-error-strip)' }}>
                {COPY.validation.rangeError(TITLE_MIN, TITLE_MAX)}
              </span>
            )}
          </label>

          <label className="block">
            <span className="text-[11px]" style={{ color: 'var(--shared-goal-modal-subtle-fg)' }}>
              {COPY.description.label} <span style={{ color: 'var(--shared-goal-modal-error-strip)' }}>*</span>
              <span
                className="ml-2"
                style={{
                  color: description.length > 0 && !descValid
                    ? 'var(--shared-goal-modal-counter-error-fg)'
                    : 'var(--shared-goal-modal-counter-fg)',
                }}
              >
                {trimmedDesc.length}/{DESC_MAX}
              </span>
            </span>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              maxLength={DESC_MAX}
              required
              aria-required="true"
              aria-invalid={description.length > 0 && !descValid}
              aria-describedby={`${dialogId}-desc-hint`}
              rows={4}
              data-testid="shared-goal-modal-description"
              placeholder={COPY.description.placeholder}
              className="mt-1 w-full bg-black/20 text-[12px] px-2 py-1 focus:outline-none"
              style={{
                border: `2px solid var(--shared-goal-modal-field-border)`,
                color: 'var(--shared-goal-modal-header-fg)',
              }}
            />
            <span
              id={`${dialogId}-desc-hint`}
              data-testid="shared-goal-modal-desc-hint"
              className="text-[10px] block mt-1"
              style={{ color: 'var(--shared-goal-modal-subtle-fg)' }}
            >
              {COPY.description.hint(DESC_MIN, DESC_MAX)}
            </span>
            {description.length > 0 && !descValid && (
              <span className="text-[10px] block mt-1" style={{ color: 'var(--shared-goal-modal-error-strip)' }}>
                {COPY.validation.rangeError(DESC_MIN, DESC_MAX)}
              </span>
            )}
          </label>

          <div className="flex flex-wrap items-center gap-4">
            <fieldset className="flex items-center gap-3" role="radiogroup" aria-label={COPY.priority.label}>
              <legend className="text-[11px] mr-1" style={{ color: 'var(--shared-goal-modal-subtle-fg)' }}>{COPY.priority.label}</legend>
              {PRIORITY_OPTIONS.map(opt => (
                <label key={opt.value} className="flex items-center gap-1 text-[11px] cursor-pointer" style={{ color: 'var(--shared-goal-modal-header-fg)' }}>
                  <input
                    type="radio"
                    name="shared-goal-modal-priority"
                    value={opt.value}
                    checked={priority === opt.value}
                    onChange={() => setPriority(opt.value)}
                    data-testid={`shared-goal-modal-priority-${opt.value}`}
                  />
                  <span style={{ color: opt.token }}>{opt.label}</span>
                </label>
              ))}
            </fieldset>

            <label className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--shared-goal-modal-subtle-fg)' }}>
              {COPY.deadline.label}
              <input
                type="date"
                value={deadline}
                onChange={e => setDeadline(e.target.value)}
                data-testid="shared-goal-modal-deadline"
                className="bg-black/20 text-[11px] px-2 py-1 focus:outline-none"
                style={{
                  border: `2px solid var(--shared-goal-modal-field-border)`,
                  color: 'var(--shared-goal-modal-header-fg)',
                }}
              />
            </label>
          </div>

          {/* 리더 분배 미리보기 (시안 §2 BODY) */}
          {isValid && (
            <div
              className="text-[11px] px-3 py-2"
              data-testid="shared-goal-modal-preview"
              style={{
                background: 'var(--shared-goal-modal-banner-bg)',
                borderLeft: `2px solid var(--shared-goal-modal-banner-strip)`,
                color: 'var(--shared-goal-modal-header-fg)',
              }}
            >
              🤖 "{trimmedTitle.slice(0, 30)}{trimmedTitle.length > 30 ? '…' : ''}" ·{' '}
              {priority === 'high' ? 'P1-긴급' : priority === 'low' ? 'P3-일반' : 'P2-중요'}
              {deadline ? ` · ~${deadline}` : ' · 기한 없음'} 로 리더가 분배할 예정입니다.
            </div>
          )}

          {saveError && (
            <div
              role="alert"
              data-testid="shared-goal-modal-error"
              className="text-[11px] flex items-start gap-1 px-3 py-2"
              style={{
                color: 'var(--shared-goal-modal-error-strip)',
                borderLeft: `2px solid var(--shared-goal-modal-error-strip)`,
                background: 'rgba(248, 113, 113, 0.08)',
              }}
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>{saveError}</span>
            </div>
          )}
        </form>

        {/* FOOTER
            반응형(지시 #f4929720): 414px 같은 좁은 뷰포트에서 도움말 문구와
            취소/확정 버튼 그룹이 가로로 맞물리면 문구가 잘리거나 버튼이 줄어
            보인다. flex-wrap 으로 좁은 폭에서 두 줄로 자연스럽게 쌓이게 하고,
            도움말 문구는 `basis-full sm:basis-auto sm:flex-1` 로 모바일에서는
            한 줄을 통째로 차지하게 한다. sm(≥640px) 이상에서는 기존처럼
            좌측 문구 + 우측 버튼 가로 배치. */}
        <div
          data-testid="shared-goal-modal-footer"
          className="flex flex-wrap items-center justify-end sm:justify-between gap-3 p-4"
          style={{ borderTop: `1px solid var(--shared-goal-modal-surface-border)` }}
        >
          <p
            className="text-[11px] basis-full sm:basis-auto sm:flex-1 sm:min-w-0"
            style={{ color: 'var(--shared-goal-modal-subtle-fg)' }}
          >
            {COPY.footer.hint}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">
            {/*
              태스크 경계 커밋(#f1d5ce51) — 자동 개발 ON 직전에 "이 프로젝트가 어떤
              커밋 정책으로 돌아가는지" 를 사용자가 한 번 더 상기시키는 요약 라벨.
              확인 버튼 바로 옆에 배치해 눈길이 머무는 위치를 공유하면서도 본 토글
              행위와 결합되지 않도록 별개 span 으로 분리한다.
            */}
            <span
              data-testid="shared-goal-modal-commit-strategy"
              data-commit-strategy={effectiveCommitStrategy}
              className="text-[10px] px-2 py-1 uppercase tracking-wider"
              style={{
                color: 'var(--shared-goal-modal-subtle-fg)',
                border: `1px solid var(--shared-goal-modal-field-border)`,
                background: 'var(--shared-goal-modal-banner-bg)',
              }}
              aria-label={`현재 커밋 전략: ${commitStrategyLabel}`}
              title={commitStrategyLabel}
            >
              커밋 전략: {commitStrategyLabel}
            </span>
            <button
              type="button"
              onClick={() => {
                if (dirty) {
                  const ok = window.confirm(COPY.confirmClose);
                  if (!ok) return;
                }
                onClose();
              }}
              data-testid="shared-goal-modal-cancel"
              className="px-3 py-1 text-[11px] uppercase tracking-wider"
              style={{
                background: 'transparent',
                border: `2px solid var(--shared-goal-modal-cancel-border)`,
                color: 'var(--shared-goal-modal-cancel-fg)',
              }}
            >
              {COPY.footer.cancel}
            </button>
            <button
              type="button"
              onClick={(e) => {
                const form = (e.currentTarget.closest('[role="dialog"]') as HTMLElement | null)?.querySelector('form');
                if (form) (form as HTMLFormElement).requestSubmit();
              }}
              disabled={!isValid || saving || !projectId}
              data-testid="shared-goal-modal-confirm"
              data-focus-tone="success"
              aria-busy={saving || undefined}
              aria-live="polite"
              className="inline-flex items-center gap-1 px-3 py-1 text-[11px] font-bold uppercase tracking-wider disabled:cursor-not-allowed"
              style={{
                background: !isValid || saving || !projectId
                  ? 'var(--shared-goal-modal-confirm-disabled-bg)'
                  : 'var(--shared-goal-modal-confirm-bg)',
                border: `2px solid var(--shared-goal-modal-confirm-border)`,
                color: 'var(--shared-goal-modal-confirm-fg)',
              }}
            >
              <Check size={12} /> {saving ? COPY.footer.saving : COPY.footer.confirm}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
