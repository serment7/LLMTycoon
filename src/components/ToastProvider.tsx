import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Check, Info, AlertTriangle, Ban, X } from 'lucide-react';

// ToastProvider · 공통 토스트/알림 일원화 컴포넌트.
// 시안: docs/toast-notification-visual-2026-04-19.md (2026-04-19 Designer).
//
// 설계 원칙 (시안 §2 T-01~T-12 발췌):
//   T-01 위치는 우상단 고정 — scroll 영향 없음.
//   T-02 상단바 배지와 겹치지 않음 — `--toast-safe-top` 72px (축약 88px).
//   T-04 지속 시간 — success 3s · info 4s · warning 6s · error 무기한.
//   T-05 pause-on-hover 기본.
//   T-06 닫기 `×` 상시 노출. Esc 로 최상단 토스트 닫힘.
//   T-08 동시 표시 최대 3, 초과분은 큐잉.
//   T-09 같은 id 는 병합(수명만 리셋).
//   T-10 success/info=polite · warning/error=assertive.
//   T-12 prefers-reduced-motion: reduce 대응.
//
// 외부 상단 루트에 `<ToastProvider>` 를 감싸 사용한다. Provider 가 없으면
// `useToast()` 는 no-op 을 돌려주어 호출 측 컴포넌트에 회귀를 유발하지 않는다.
// 이 방식으로 App.tsx 수정 없이 점진적 도입이 가능하다.

export type ToastVariant = 'success' | 'info' | 'warning' | 'error';

export interface ToastInput {
  id?: string;
  variant?: ToastVariant;
  title: string;
  description?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
}

export interface ToastItem extends Required<Pick<ToastInput, 'variant' | 'title'>> {
  id: string;
  description?: string;
  duration: number;
  action?: ToastInput['action'];
  createdAt: number;
}

export interface UseToast {
  push: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 3000,
  info: 4000,
  warning: 6000,
  error: 0,
};

const MAX_VISIBLE = 3;

// ────────────────────────────────────────────────────────────────────────────
// 순수 리듀서(#3773fc8d) — Node 테스트에서 React 없이 스택 동작을 잠근다.
// ────────────────────────────────────────────────────────────────────────────

export interface ToastStackState {
  items: ReadonlyArray<ToastItem>;
}

export type ToastStackAction =
  | { type: 'PUSH'; item: ToastItem }
  | { type: 'DISMISS'; id: string }
  | { type: 'CLEAR' };

export const EMPTY_TOAST_STACK: ToastStackState = Object.freeze({
  items: Object.freeze([]) as ReadonlyArray<ToastItem>,
}) as ToastStackState;

/**
 * 토스트 스택을 갱신하는 순수 리듀서. 동일 id 재방출은 **수명 리셋(merge)** —
 * 디자이너 시안 T-09 와 동일 계약. 실제 Provider 는 useState 기반이지만, 본
 * 리듀서는 "동일 스택 동작" 을 React 밖에서도 검증할 수 있도록 공개한다.
 */
export function toastStackReducer(state: ToastStackState, action: ToastStackAction): ToastStackState {
  switch (action.type) {
    case 'PUSH': {
      const idx = state.items.findIndex(t => t.id === action.item.id);
      if (idx >= 0) {
        // T-09: 동일 id 는 병합(수명만 리셋). DOM 항목은 그대로, 데이터만 교체.
        const next = state.items.slice();
        next[idx] = action.item;
        return { items: next };
      }
      return { items: [...state.items, action.item] };
    }
    case 'DISMISS':
      if (!state.items.some(t => t.id === action.id)) return state;
      return { items: state.items.filter(t => t.id !== action.id) };
    case 'CLEAR':
      return state.items.length === 0 ? state : EMPTY_TOAST_STACK;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 토스트 버스(#3773fc8d) — 비 React 맥락(ErrorBoundary·소켓 핸들러·순수 유틸)
// 에서도 토스트를 쏘아 올릴 수 있는 모듈 레벨 pub/sub. Provider 가 마운트되면
// 자동으로 구독해 같은 스택에 합친다. Provider 가 없으면 조용히 버려진다.
// ────────────────────────────────────────────────────────────────────────────

type ToastBusListener = (input: ToastInput) => void;
const busListeners = new Set<ToastBusListener>();

export const toastBus = {
  emit(input: ToastInput): void {
    for (const l of busListeners) {
      try { l(input); } catch { /* 개별 리스너 실패는 나머지에 영향 없음 */ }
    }
  },
  subscribe(listener: ToastBusListener): () => void {
    busListeners.add(listener);
    return () => { busListeners.delete(listener); };
  },
  // 테스트 전용.
  __resetForTest(): void { busListeners.clear(); },
};

const ToastContext = createContext<UseToast | null>(null);

// Provider 가 없을 때도 useToast() 호출이 터지지 않도록 no-op 을 돌려준다.
// 서버사이드·단위 테스트 환경에서도 동일하게 동작.
const NO_OP_TOAST: UseToast = {
  push: () => '',
  dismiss: () => {},
  dismissAll: () => {},
};

export function useToast(): UseToast {
  return useContext(ToastContext) ?? NO_OP_TOAST;
}

interface ProviderProps {
  children: React.ReactNode;
}

export function ToastProvider({ children }: ProviderProps) {
  const [queue, setQueue] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setQueue(prev => prev.filter(t => t.id !== id));
  }, []);

  const dismissAll = useCallback(() => {
    setQueue([]);
  }, []);

  const push = useCallback((input: ToastInput): string => {
    const variant: ToastVariant = input.variant ?? 'info';
    const id = input.id ?? `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const duration = input.duration ?? DEFAULT_DURATION[variant];
    const item: ToastItem = {
      id,
      variant,
      title: input.title,
      description: input.description,
      duration,
      action: input.action,
      createdAt: Date.now(),
    };
    setQueue(prev => {
      // T-09 중복 병합: 같은 id 가 있으면 수명만 리셋(DOM 추가 없음).
      const idx = prev.findIndex(t => t.id === id);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = item;
        return next;
      }
      return [...prev, item];
    });
    return id;
  }, []);

  const api = useMemo<UseToast>(() => ({ push, dismiss, dismissAll }), [push, dismiss, dismissAll]);

  // 모듈 버스 구독(#3773fc8d) — ErrorBoundary·소켓 핸들러 등 비 React 경로에서
  // `toastBus.emit(...)` 으로 쏜 메시지를 같은 Provider 스택에 병합한다. Provider 가
  // 마운트돼 있지 않은 SSR·테스트에서는 자연스럽게 발화된 메시지가 버려진다.
  useEffect(() => {
    const off = toastBus.subscribe(input => { push(input); });
    return () => { off(); };
  }, [push]);

  // T-08: 동시 표시 3개 + 나머지 큐잉. 가장 오래된 것이 먼저 노출된다.
  const visible = queue.slice(0, MAX_VISIBLE);

  // Esc 로 최상단(가장 최근) 토스트 닫힘(T-06 보조). 모달 내부에서 이미 preventDefault
  // 되면 capture 단에서 동작하지 않도록 document level 으로 등록한다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (visible.length === 0) return;
      const top = visible[visible.length - 1];
      dismiss(top.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastContainer items={visible} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

interface ContainerProps {
  items: ToastItem[];
  onDismiss: (id: string) => void;
}

// T-01 · T-02 위치 고정 컨테이너. z-index 는 토큰으로 제어.
function ToastContainer({ items, onDismiss }: ContainerProps) {
  return (
    <div
      data-testid="toast-container"
      aria-live="off"
      style={{
        position: 'fixed',
        top: 'var(--toast-safe-top)',
        right: 'var(--toast-safe-right)',
        zIndex: 'var(--toast-z-index)' as unknown as number,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--toast-stack-gap)',
        pointerEvents: 'none',
      }}
    >
      {items.map(item => (
        // Fragment 로 key 를 감싼다 — 자식 Toast 의 props 타입(ToastViewProps) 에
        // key 필드가 없어 엄격 모드 tsc 가 거부하기 때문(React 내부 리스트 추적용
        // prop 을 컴포넌트 props 로 오인). #cc0c9e0c 빌드 품질 정리 과정에서
        // 이번 라운드(ToastProvider 병합) 에 새로 드러난 에러를 구조 변경 없이 해소.
        <React.Fragment key={item.id}>
          <Toast item={item} onDismiss={onDismiss} />
        </React.Fragment>
      ))}
    </div>
  );
}

const VARIANT_ICON: Record<ToastVariant, React.ReactNode> = {
  success: <Check size={16} aria-hidden="true" />,
  info: <Info size={16} aria-hidden="true" />,
  warning: <AlertTriangle size={16} aria-hidden="true" />,
  error: <Ban size={16} aria-hidden="true" />,
};

interface ToastViewProps {
  item: ToastItem;
  onDismiss: (id: string) => void;
}

function Toast({ item, onDismiss }: ToastViewProps) {
  const { id, variant, title, description, duration, action } = item;
  const [paused, setPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = useRef(duration);
  const lastStartRef = useRef(Date.now());

  // T-04/T-05: duration>0 일 때만 자동 닫힘. pause-on-hover 면 타이머 일시정지.
  useEffect(() => {
    if (duration <= 0 || paused) return;
    lastStartRef.current = Date.now();
    timerRef.current = setTimeout(() => onDismiss(id), remainingRef.current);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        remainingRef.current -= Date.now() - lastStartRef.current;
        if (remainingRef.current < 0) remainingRef.current = 0;
      }
    };
  }, [paused, duration, id, onDismiss]);

  const isAssertive = variant === 'warning' || variant === 'error';
  // 배경/테두리/스트립/아이콘 색은 data-toast-variant 속성으로 CSS 가 고르게
  // 적용되지만, 컴포넌트 자체에서도 fallback 으로 토큰을 직접 var() 로 꽂아
  // data 속성 기반 규칙이 로드되지 않아도 시각이 깨지지 않게 한다.
  const palette = {
    success: { bg: 'var(--toast-success-bg)', border: 'var(--toast-success-border)', strip: 'var(--toast-success-strip)', icon: 'var(--toast-success-icon-fg)', title: 'var(--toast-success-title-fg)' },
    info:    { bg: 'var(--toast-info-bg)',    border: 'var(--toast-info-border)',    strip: 'var(--toast-info-strip)',    icon: 'var(--toast-info-icon-fg)',    title: 'var(--toast-info-title-fg)' },
    warning: { bg: 'var(--toast-warning-bg)', border: 'var(--toast-warning-border)', strip: 'var(--toast-warning-strip)', icon: 'var(--toast-warning-icon-fg)', title: 'var(--toast-warning-title-fg)' },
    error:   { bg: 'var(--toast-error-bg)',   border: 'var(--toast-error-border)',   strip: 'var(--toast-error-strip)',   icon: 'var(--toast-error-icon-fg)',   title: 'var(--toast-error-title-fg)' },
  }[variant];

  return (
    <div
      role={isAssertive ? 'alert' : 'status'}
      aria-live={isAssertive ? 'assertive' : 'polite'}
      data-testid={`toast-${variant}`}
      data-toast-variant={variant}
      data-toast-id={id}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      style={{
        pointerEvents: 'auto',
        minWidth: 'var(--toast-width-min)',
        maxWidth: 'var(--toast-width-max)',
        padding: 'var(--toast-padding)',
        borderRadius: 'var(--toast-radius)',
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderLeft: `var(--toast-strip-width) solid ${palette.strip}`,
        boxShadow: 'var(--toast-shadow)',
        zIndex: variant === 'error' ? ('var(--toast-z-index-error)' as unknown as number) : undefined,
        display: 'flex',
        gap: 'var(--toast-gap)',
        alignItems: 'flex-start',
      }}
    >
      <span style={{ color: palette.icon, marginTop: 2 }}>
        {VARIANT_ICON[variant]}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="text-[12px] font-bold"
          style={{ color: palette.title }}
        >
          {title}
        </div>
        {description && (
          <div
            className="mt-1 text-[11px] leading-relaxed"
            style={{ color: 'var(--toast-subtle-fg)' }}
          >
            {description}
          </div>
        )}
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            data-testid={`toast-${variant}-action`}
            className="mt-2 px-2 py-1 text-[11px] font-bold uppercase tracking-wider"
            style={{
              background: variant === 'error' ? 'var(--toast-error-retry-bg)' : 'transparent',
              color: variant === 'error' ? 'var(--toast-error-retry-fg)' : palette.title,
              border: `1px solid ${variant === 'error' ? 'var(--toast-error-retry-border)' : palette.border}`,
              borderRadius: 4,
            }}
          >
            {action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(id)}
        data-testid={`toast-${variant}-close`}
        aria-label="닫기"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--toast-close-fg)',
          cursor: 'pointer',
          padding: 2,
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
