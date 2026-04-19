// ConversationSearch(#832360c2) — 대화 영역 전역 검색 오버레이.
//
// 상호작용
//   · Ctrl+F / Cmd+F — 열기. 입력 요소가 포커스돼 있어도 동작.
//   · Esc — 닫기. stopPropagation 으로 모달·토스트와 충돌 방지.
//   · Enter / ArrowDown — 다음 매치. Shift+Enter / ArrowUp — 이전 매치.
//
// 설계
//   · 검색어 정규화와 매치 계산은 `utils/conversationSearch` 순수 함수가 담당.
//   · 매치된 메시지 id 를 상위에 알려 `VirtualizedMessageList` 가 해당 행으로 점프하게 한다.
//   · OnboardingTour(z-index 1200) 보다 낮은 1100 에서 렌더해 겹치지 않는다.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';

import {
  findSearchMatches,
  moveMatchFocus,
  splitHighlightSegments,
  type MessageMatch,
  type SearchableMessage,
} from '../utils/conversationSearch';

/** 오버레이 단축키 — macOS: Cmd+F, 그 외: Ctrl+F. */
export function isOpenSearchShortcut(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  const k = (e.key ?? '').toLowerCase();
  if (k !== 'f') return false;
  return e.metaKey || e.ctrlKey;
}

export interface ConversationSearchProps {
  messages: ReadonlyArray<SearchableMessage>;
  /** 매치가 바뀌거나 사용자가 점프 버튼을 누를 때 호출. 상위가 가상 리스트에 전달. */
  onJumpToMessage?: (messageId: string) => void;
  /** 닫힘 시 복귀할 포커스 원상 컨테이너. 키보드 사용자 UX 개선. */
  returnFocusTo?: React.RefObject<HTMLElement>;
  className?: string;
}

export function ConversationSearch({
  messages,
  onJumpToMessage,
  returnFocusTo,
  className,
}: ConversationSearchProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const matches = useMemo<ReadonlyArray<MessageMatch>>(
    () => findSearchMatches(messages, query),
    [messages, query],
  );

  // Ctrl/Cmd+F 전역 청취 — 입력 요소 안에서도 열어야 한다(브라우저 기본 검색 방지).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (isOpenSearchShortcut({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey })) {
        e.preventDefault();
        setOpen(true);
        // 렌더 후 input 에 포커스.
        setTimeout(() => inputRef.current?.focus(), 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setFocus(0);
    if (returnFocusTo?.current) returnFocusTo.current.focus();
  }, [returnFocusTo]);

  const jumpTo = useCallback((idx: number) => {
    if (matches.length === 0) return;
    const clamped = Math.max(0, Math.min(matches.length - 1, idx));
    setFocus(clamped);
    onJumpToMessage?.(matches[clamped].messageId);
  }, [matches, onJumpToMessage]);

  // 매치 집합이 바뀌면 포커스 0 으로 당겨 첫 결과로 점프.
  useEffect(() => {
    if (matches.length === 0) { setFocus(0); return; }
    setFocus(0);
    onJumpToMessage?.(matches[0].messageId);
  }, [matches, onJumpToMessage]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      jumpTo(moveMatchFocus({ current: focus, total: matches.length, direction: 'next' }));
      return;
    }
    if (e.key === 'ArrowUp' || (e.shiftKey && e.key === 'Enter')) {
      e.preventDefault();
      jumpTo(moveMatchFocus({ current: focus, total: matches.length, direction: 'prev' }));
    }
  }, [close, jumpTo, focus, matches.length]);

  if (!open) return null;

  const total = matches.length;
  const current = total > 0 ? focus + 1 : 0;
  const activeMatch = matches[focus];
  // 결과 프리뷰: 활성 매치의 첫 ranges 로 스니펫 생성.
  const snippetSegments = activeMatch
    ? splitHighlightSegments(activeMatch.haystack, activeMatch.ranges)
    : [];

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="대화 검색"
      data-testid="conversation-search"
      className={`conversation-search${className ? ` ${className}` : ''}`}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        top: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        // OnboardingTour(1200) 보다 낮게 두어 온보딩 중에는 검색이 겹치지 않음.
        zIndex: 'var(--conversation-search-z-index, 1100)' as unknown as number,
        width: 'min(640px, calc(100% - 32px))',
        background: 'var(--color-surface)',
        color: 'var(--color-text)',
        border: '2px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
        padding: 'var(--space-md)',
      }}
    >
      <div className="flex items-center gap-2">
        <Search size={14} aria-hidden="true" style={{ color: 'var(--color-accent)' }} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="대화 검색 (Enter: 다음, Shift+Enter: 이전, Esc: 닫기)"
          aria-label="대화 검색 입력"
          data-testid="conversation-search-input"
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'var(--color-text)',
            fontSize: 'var(--font-size-sm)',
          }}
        />
        <span
          data-testid="conversation-search-count"
          style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}
        >
          {total > 0 ? `${current} / ${total}` : '일치 없음'}
        </span>
        <button
          type="button"
          aria-label="이전 일치"
          onClick={() => jumpTo(moveMatchFocus({ current: focus, total, direction: 'prev' }))}
          disabled={total === 0}
          data-testid="conversation-search-prev"
          style={{ background: 'transparent', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer' }}
        >
          <ChevronUp size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="다음 일치"
          onClick={() => jumpTo(moveMatchFocus({ current: focus, total, direction: 'next' }))}
          disabled={total === 0}
          data-testid="conversation-search-next"
          style={{ background: 'transparent', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer' }}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="검색 닫기"
          onClick={close}
          data-testid="conversation-search-close"
          style={{ background: 'transparent', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer' }}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {activeMatch ? (
        <div
          data-testid="conversation-search-snippet"
          className="mt-2 text-[12px] whitespace-pre-wrap"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {snippetSegments.map((seg, i) => (
            seg.kind === 'match' ? (
              <mark
                key={i}
                data-testid="conversation-search-mark"
                style={{
                  background: 'var(--color-warning-surface)',
                  color: 'var(--color-warning)',
                  padding: '0 2px',
                  borderRadius: 2,
                }}
              >
                {seg.text}
              </mark>
            ) : (
              <span key={i}>{seg.text}</span>
            )
          ))}
        </div>
      ) : null}
    </div>
  );
}
