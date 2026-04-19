// 전역 에러 바운더리(#3773fc8d) — 렌더 오류/Promise 거부/전역 예외를 한 곳에서
// 수집해 (1) 하위 트리 대신 복구 UI 를 보여주고 (2) 토스트 버스로 알림을 방출한다.
//
// 접근법
//  · React `getDerivedStateFromError` 는 정적 메서드라 순수 호출로 테스트 가능
//    (Node 환경에서도 검증할 수 있게 별도 `deriveErrorState` 로도 노출).
//  · `componentDidCatch` 는 React 18+ 에서 비 async 에러만 잡히므로, Provider 가
//    마운트되면 `window.unhandledrejection` · `window.error` 도 함께 구독해 트리
//    바깥에서 터진 오류까지 토스트로 흘려보낸다.
//  · 복구 버튼은 내부 state 를 `null` 로 되돌린다. 동일 렌더 사이클에 같은 오류가
//    바로 재발하면 React 가 한 번 더 throw 하므로 자연스럽게 영속 에러 UI 가 유지된다.
//
// 접근성
//  · 복구 UI 는 role="alert" + aria-live="assertive" — 시각·스크린리더 양쪽에서 즉시
//    감지된다. 본 UI 는 재시도 · 새로고침 두 선택지를 제공한다.

import React from 'react';
import { AlertTriangle, RotateCcw, RefreshCw } from 'lucide-react';

import { mapUnknownError, type UserFacingMessage } from '../utils/errorMessages';
import { toastBus } from './ToastProvider';

export interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 순수 파생 함수. React 의 `getDerivedStateFromError` 와 동일 계약을 돌려주되
 * Node 단위 테스트에서 React 없이 호출해 잠글 수 있다.
 */
export function deriveErrorState(error: unknown): ErrorBoundaryState {
  if (error instanceof Error) return { error };
  if (typeof error === 'string') return { error: new Error(error) };
  try {
    return { error: new Error(JSON.stringify(error)) };
  } catch {
    return { error: new Error('Unknown error') };
  }
}

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** 복구 UI 를 커스터마이즈. 미지정 시 기본 fallback. */
  fallback?: (params: { error: Error; reset: () => void; message: UserFacingMessage }) => React.ReactNode;
  /** 진단 로깅/원격 전송 훅. 기본 동작(토스트 방출) 은 그대로 유지. */
  onError?: (error: Error, info?: React.ErrorInfo) => void;
  /** 트리 외부 오류(unhandledrejection, window.error) 도 토스트로 방출할지. 기본 true. */
  captureGlobal?: boolean;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  private unhandledRejection?: (e: PromiseRejectionEvent) => void;
  private windowError?: (e: ErrorEvent) => void;

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return deriveErrorState(error);
  }

  componentDidMount(): void {
    if (this.props.captureGlobal === false) return;
    if (typeof window === 'undefined') return;
    this.unhandledRejection = (e: PromiseRejectionEvent) => {
      // 트리 밖 Promise 거부: 바운더리 상태는 건드리지 않고 토스트로만 고지.
      this.emitToastFor(e.reason);
    };
    this.windowError = (e: ErrorEvent) => {
      this.emitToastFor(e.error ?? e.message);
    };
    window.addEventListener('unhandledrejection', this.unhandledRejection);
    window.addEventListener('error', this.windowError);
  }

  componentWillUnmount(): void {
    if (typeof window === 'undefined') return;
    if (this.unhandledRejection) window.removeEventListener('unhandledrejection', this.unhandledRejection);
    if (this.windowError) window.removeEventListener('error', this.windowError);
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.onError?.(error, info);
    this.emitToastFor(error);
  }

  private emitToastFor(err: unknown): void {
    const msg = mapUnknownError(err);
    toastBus.emit({
      variant: msg.severity,
      title: msg.title,
      description: msg.body,
    });
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    const message = mapUnknownError(this.state.error);
    if (this.props.fallback) {
      return this.props.fallback({ error: this.state.error, reset: this.reset, message });
    }
    return (
      <div
        role="alert"
        aria-live="assertive"
        data-testid="error-boundary-fallback"
        className="min-h-screen flex items-center justify-center p-6"
        style={{ background: 'var(--pixel-bg)', color: 'var(--shared-goal-modal-header-fg)' }}
      >
        <div
          className="max-w-md w-full border-2 border-l-[6px] p-6 flex flex-col gap-3"
          style={{
            background: 'var(--error-state-bg)',
            borderColor: 'var(--pixel-border)',
            borderLeftColor: 'var(--error-state-border)',
          }}
        >
          <div className="flex items-center gap-2" style={{ color: 'var(--error-state-title-fg)' }}>
            <AlertTriangle size={18} aria-hidden="true" />
            <span className="font-bold text-[14px]">{message.title}</span>
          </div>
          {message.body ? (
            <p className="text-[12px] text-white/80 whitespace-pre-wrap">{message.body}</p>
          ) : null}
          <div className="flex gap-2 mt-2">
            <button
              type="button"
              onClick={this.reset}
              className="px-3 py-2 bg-[var(--pixel-accent)] text-black text-[11px] font-bold uppercase border-b-2 border-[#0099cc] flex items-center gap-1 hover:brightness-110"
            >
              <RotateCcw size={12} aria-hidden="true" /> 다시 시도
            </button>
            <button
              type="button"
              onClick={() => { if (typeof window !== 'undefined') window.location.reload(); }}
              className="px-3 py-2 bg-black/30 border-2 border-[var(--pixel-border)] text-[11px] font-bold uppercase flex items-center gap-1 hover:border-white/60"
            >
              <RefreshCw size={12} aria-hidden="true" /> 새로고침
            </button>
          </div>
        </div>
      </div>
    );
  }
}
