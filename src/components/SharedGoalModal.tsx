import React, { useEffect, useId, useRef, useState } from 'react';
import { Target, Check, X, AlertTriangle } from 'lucide-react';
import type { SharedGoal, SharedGoalPriority } from '../types';

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
}

const PRIORITY_OPTIONS: { value: SharedGoalPriority; label: string; token: string }[] = [
  { value: 'high',   label: 'P1-긴급', token: 'var(--shared-goal-priority-p1)' },
  { value: 'normal', label: 'P2-중요', token: 'var(--shared-goal-priority-p2)' },
  { value: 'low',    label: 'P3-일반', token: 'var(--shared-goal-priority-p3)' },
];

const TITLE_MIN = 4;
const TITLE_MAX = 80;
const DESC_MIN = 20;
const DESC_MAX = 500;

export function SharedGoalModal({ open, projectId, onClose, onEnabled, onLog }: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<SharedGoalPriority>('high');
  const [deadline, setDeadline] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const dialogId = useId();

  useEffect(() => {
    if (!open) {
      setTitle(''); setDescription(''); setPriority('high'); setDeadline('');
      setSaving(false); setSaveError(null);
      return;
    }
    // 시안 §4.2: 열자마자 제목 입력란 포커스. 키보드·스크린리더 사용자가 즉시
    // 타이핑/낭독을 시작할 수 있게 한다.
    const t = setTimeout(() => titleRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const trimmedTitle = title.trim();
  const trimmedDesc = description.trim();
  const titleValid = trimmedTitle.length >= TITLE_MIN && trimmedTitle.length <= TITLE_MAX;
  const descValid = trimmedDesc.length >= DESC_MIN && trimmedDesc.length <= DESC_MAX;
  const isValid = titleValid && descValid;
  const dirty = title.length > 0 || description.length > 0 || !!deadline;

  const handleEsc = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (dirty) {
      // 시안 §4.3: dirty 이면 확인 다이얼로그 — MVP 에서는 window.confirm 으로 축약.
      const ok = window.confirm('작성 중인 내용이 있습니다. 닫으면 입력이 사라집니다. 그래도 닫을까요?');
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
        return;
      }

      onLog(`공동 목표 저장 + 자동 개발 ON: ${saved.title}`);
      onEnabled(saved);
      onClose();
    } catch (err) {
      const msg = (err as Error).message || '알 수 없는 오류';
      setSaveError(msg);
      onLog(`공동 목표 저장 실패: ${msg}`);
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
            const ok = window.confirm('작성 중인 내용이 있습니다. 닫으면 입력이 사라집니다. 그래도 닫을까요?');
            if (!ok) return;
          }
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        data-testid="shared-goal-modal-dialog"
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
                공동 목표 등록이 필요합니다
              </h2>
              <p
                id={subtitleId}
                className="mt-1 text-[11px]"
                style={{ color: 'var(--shared-goal-modal-subtle-fg)' }}
              >
                자동 개발 ON 은 리더가 동료들에게 분배할 목표가 있어야 시작됩니다.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              if (dirty) {
                const ok = window.confirm('작성 중인 내용이 있습니다. 닫으면 입력이 사라집니다. 그래도 닫을까요?');
                if (!ok) return;
              }
              onClose();
            }}
            data-testid="shared-goal-modal-close"
            aria-label="닫기"
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
        >
          <label className="block">
            <span className="text-[11px]" style={{ color: 'var(--shared-goal-modal-subtle-fg)' }}>
              목표 제목 <span style={{ color: 'var(--shared-goal-modal-error-strip)' }}>*</span>
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
              data-testid="shared-goal-modal-title"
              placeholder="예) 결제 모듈 보안 강화"
              className="mt-1 w-full bg-black/20 text-[12px] px-2 py-1 focus:outline-none"
              style={{
                border: `2px solid var(--shared-goal-modal-field-border)`,
                color: 'var(--shared-goal-modal-header-fg)',
              }}
            />
            {title.length > 0 && !titleValid && (
              <span className="text-[10px] block mt-1" style={{ color: 'var(--shared-goal-modal-error-strip)' }}>
                {TITLE_MIN}자 이상 {TITLE_MAX}자 이하로 입력해주세요.
              </span>
            )}
          </label>

          <label className="block">
            <span className="text-[11px]" style={{ color: 'var(--shared-goal-modal-subtle-fg)' }}>
              상세 설명 <span style={{ color: 'var(--shared-goal-modal-error-strip)' }}>*</span>
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
              rows={4}
              data-testid="shared-goal-modal-description"
              placeholder="예) 토큰 검증·AES 암호화·PCI 감사로그 추가 — 리더가 분배할 맥락을 20자 이상으로 적어주세요."
              className="mt-1 w-full bg-black/20 text-[12px] px-2 py-1 focus:outline-none"
              style={{
                border: `2px solid var(--shared-goal-modal-field-border)`,
                color: 'var(--shared-goal-modal-header-fg)',
              }}
            />
            {description.length > 0 && !descValid && (
              <span className="text-[10px] block mt-1" style={{ color: 'var(--shared-goal-modal-error-strip)' }}>
                {DESC_MIN}자 이상 {DESC_MAX}자 이하로 입력해주세요.
              </span>
            )}
          </label>

          <div className="flex flex-wrap items-center gap-4">
            <fieldset className="flex items-center gap-3" role="radiogroup" aria-label="우선순위">
              <legend className="text-[11px] mr-1" style={{ color: 'var(--shared-goal-modal-subtle-fg)' }}>우선순위</legend>
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
              기한
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

        {/* FOOTER */}
        <div
          className="flex items-center justify-between gap-3 p-4"
          style={{ borderTop: `1px solid var(--shared-goal-modal-surface-border)` }}
        >
          <p className="text-[11px]" style={{ color: 'var(--shared-goal-modal-subtle-fg)' }}>
            💡 저장 직후 자동 개발이 ON 으로 전환되고 리더가 즉시 분배를 시작합니다.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                if (dirty) {
                  const ok = window.confirm('작성 중인 내용이 있습니다. 닫으면 입력이 사라집니다. 그래도 닫을까요?');
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
              취소
            </button>
            <button
              type="button"
              onClick={(e) => {
                const form = (e.currentTarget.closest('[role="dialog"]') as HTMLElement | null)?.querySelector('form');
                if (form) (form as HTMLFormElement).requestSubmit();
              }}
              disabled={!isValid || saving || !projectId}
              data-testid="shared-goal-modal-confirm"
              className="inline-flex items-center gap-1 px-3 py-1 text-[11px] font-bold uppercase tracking-wider disabled:cursor-not-allowed"
              style={{
                background: !isValid || saving || !projectId
                  ? 'var(--shared-goal-modal-confirm-disabled-bg)'
                  : 'var(--shared-goal-modal-confirm-bg)',
                border: `2px solid var(--shared-goal-modal-confirm-border)`,
                color: 'var(--shared-goal-modal-confirm-fg)',
              }}
            >
              <Check size={12} /> {saving ? '저장 중…' : '목표 저장 후 시작'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
