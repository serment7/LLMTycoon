// 지시 #367441f0 — 대기 중인 사용자 지시 배지 + 드롭다운 리스트.
//
// 배치
//   App.tsx 의 상단 네비게이션(자동 개발 토글 근처) 에 마운트해, 자동 개발 ON 상태
//   에서 작업 중인 에이전트 때문에 큐에 적재된 사용자 지시 수를 숫자 배지로 보여준다.
//   배지를 누르면 큐 리스트가 펼쳐지고, 각 항목마다 취소 버튼이 붙는다.
//
// OFF 전환 정책
//   자동 개발 OFF 로 전환되는 순간, 호출자(App) 는 '보존/즉시 실행/폐기' 중 선택한
//   정책을 agentDispatcher.applyAutoDevOffPolicy 로 전달한다. 본 컴포넌트는 드롭다운
//   하단에 라디오 그룹을 두고 호출자에게 선택값을 보고한다(onPolicyChange).

import React, { useEffect, useState } from 'react';
import { Inbox, X, Trash2, AlertCircle } from 'lucide-react';
import {
  getPendingUserInstructionsStore,
  type PendingUserInstructionsStore,
  type InstructionQueueSnapshot,
  type PendingInstruction,
} from '../stores/pendingUserInstructionsStore';
import type { AutoDevOffPolicy } from '../services/agentDispatcher';

export interface PendingInstructionsBadgeProps {
  /** 스토어 주입 — 테스트/스토리북이 별도 인스턴스를 넘길 때 사용. */
  store?: PendingUserInstructionsStore;
  /** OFF 정책 선택값. 상위가 설정 UI 와 공유한다. */
  autoDevOffPolicy?: AutoDevOffPolicy;
  onPolicyChange?: (next: AutoDevOffPolicy) => void;
  className?: string;
}

const focusRing = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pixel-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black';

function relativeTime(ts: number, now: number): string {
  const delta = Math.max(0, now - ts);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  return `${hr}시간 전`;
}

function statusBadgeStyle(status: PendingInstruction['status']): React.CSSProperties {
  const palette: Record<PendingInstruction['status'], { bg: string; fg: string }> = {
    pending: { bg: 'rgba(59,130,246,0.2)', fg: '#93c5fd' },
    processing: { bg: 'rgba(234,179,8,0.2)', fg: '#fde68a' },
    done: { bg: 'rgba(74,222,128,0.2)', fg: '#86efac' },
    cancelled: { bg: 'rgba(148,163,184,0.2)', fg: '#cbd5e1' },
  };
  const { bg, fg } = palette[status];
  return {
    display: 'inline-block',
    padding: '0 6px',
    borderRadius: 3,
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    background: bg,
    color: fg,
  };
}

export function PendingInstructionsBadge(props: PendingInstructionsBadgeProps): React.ReactElement {
  const { store: injected, autoDevOffPolicy = 'keep', onPolicyChange, className } = props;
  const store = injected ?? getPendingUserInstructionsStore();
  const [snap, setSnap] = useState<InstructionQueueSnapshot>(() => store.snapshot());
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const unsub = store.subscribe((next) => setSnap(next));
    return unsub;
  }, [store]);

  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [open]);

  const pending = snap.pendingCount;
  const processing = snap.processingCount;
  const total = pending + processing;

  return (
    <div
      className={className}
      data-testid="pending-instructions-badge"
      style={{ position: 'relative', display: 'inline-flex' }}
    >
      <button
        type="button"
        aria-label={`대기 중인 지시 ${pending}건, 실행 중 ${processing}건`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        data-testid="pending-instructions-toggle"
        className={focusRing}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          background: total > 0 ? 'var(--pixel-accent)' : 'rgba(0,0,0,0.3)',
          color: total > 0 ? '#000' : 'rgba(255,255,255,0.8)',
          border: '2px solid var(--pixel-border)',
          cursor: 'pointer',
        }}
      >
        <Inbox size={12} aria-hidden />
        대기 {pending}건
        {processing > 0 && <span aria-hidden style={{ opacity: 0.8 }}>· 실행 {processing}</span>}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="대기 중인 지시 목록"
          data-testid="pending-instructions-list"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            width: 340,
            maxHeight: 420,
            overflow: 'auto',
            padding: 8,
            background: 'var(--pixel-card, #16213e)',
            border: '2px solid var(--pixel-border)',
            zIndex: 40,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <strong style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>대기 큐</strong>
            <button
              type="button"
              aria-label="닫기"
              onClick={() => setOpen(false)}
              className={focusRing}
              style={{ background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer' }}
            >
              <X size={14} aria-hidden />
            </button>
          </div>

          {snap.items.length === 0 && (
            <p style={{ margin: 0, padding: '16px 8px', fontSize: 11, opacity: 0.7, textAlign: 'center' }}>
              대기 중인 지시가 없습니다.
            </p>
          )}

          {snap.items.map((it) => (
            <article
              key={it.id}
              data-testid={`pending-instruction-${it.id}`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                padding: 8,
                background: 'rgba(0,0,0,0.25)',
                border: '1px solid var(--pixel-border)',
                fontSize: 11,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={statusBadgeStyle(it.status)}>{it.status}</span>
                <span style={{ opacity: 0.6, fontSize: 10 }}>{relativeTime(it.createdAt, now)}</span>
                <span style={{ flex: 1 }} />
                {it.status === 'pending' && (
                  <button
                    type="button"
                    aria-label={`${it.text.slice(0, 20)} 취소`}
                    data-testid={`pending-instruction-cancel-${it.id}`}
                    onClick={() => store.cancel(it.id)}
                    className={focusRing}
                    title="취소"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: 3,
                      background: 'rgba(248,113,113,0.15)',
                      border: '1px solid rgba(248,113,113,0.5)',
                      color: '#fecaca',
                      cursor: 'pointer',
                    }}
                  >
                    <Trash2 size={11} aria-hidden />
                  </button>
                )}
              </div>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{it.text}</p>
              {it.lastError && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#fca5a5', fontSize: 10 }}>
                  <AlertCircle size={10} aria-hidden /> {it.lastError}
                </div>
              )}
            </article>
          ))}

          <fieldset
            style={{
              marginTop: 4,
              padding: 8,
              border: '1px solid var(--pixel-border)',
              background: 'rgba(0,0,0,0.2)',
              fontSize: 11,
            }}
          >
            <legend style={{ padding: '0 6px', fontSize: 10, textTransform: 'uppercase' }}>
              자동 개발 OFF 전환 시
            </legend>
            {(['keep', 'flush-now', 'discard'] as const).map((p) => (
              <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
                <input
                  type="radio"
                  name="auto-dev-off-policy"
                  value={p}
                  checked={autoDevOffPolicy === p}
                  onChange={() => onPolicyChange?.(p)}
                  data-testid={`auto-dev-off-policy-${p}`}
                />
                {p === 'keep' && '큐 보존 (다음 ON 때 이어서 처리)'}
                {p === 'flush-now' && '즉시 실행 (순차 디스패치)'}
                {p === 'discard' && '폐기 (모든 대기 지시 취소)'}
              </label>
            ))}
          </fieldset>
        </div>
      )}
    </div>
  );
}
