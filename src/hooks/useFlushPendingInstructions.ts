// 지시 #367441f0 — "팀 전원 idle 전이" 를 감시해 대기 큐를 flush 하는 훅.
//
// 동작
//   · agents 목록에서 status==='working' 개수를 매 렌더 계산.
//   · 이전 프레임에 working > 0 이었고 현재 working === 0 이면 "방금 모든 태스크가
//     끝났다" 는 전이를 감지, flushPendingInstructions 를 호출한다.
//   · 자동 개발이 OFF 여도 큐에 쌓인 지시가 있으면 flush 를 진행한다(사용자가 OFF
//     로 바꿔도 이미 쌓인 건은 '보존' 정책 기본값대로 동작하도록 훅은 policy 를 몰라도 된다).
//
// 경쟁 상태
//   · flushPendingInstructions 는 큐 store 의 beginNextPending 으로 원자 전환을 수행
//     하므로, 같은 idle 전이 프레임에 여러 훅 인스턴스가 있더라도 단일 승자만 뽑힌다.
//   · 훅이 언마운트된 직후에 비동기 flush 가 성공/실패 콜백을 던지면, 본 훅은 아무
//     상태도 건드리지 않고(큐 store 가 자체 관리) 종료한다.

import { useEffect, useRef } from 'react';
import type { Agent } from '../types';
import { flushPendingInstructions } from '../services/agentDispatcher';

export interface UseFlushPendingInstructionsOptions {
  /** 자동 flush 를 일시 정지. 설정 변경 모달이 열려 있을 때 등 호출자가 잠그고 싶을 때 사용. */
  paused?: boolean;
  /** 각 flush 시도 후 호출. 로그/토스트 훅이 붙는다. */
  onFlushed?: (text: string) => void;
  /** flush 함수 주입 — 테스트는 스파이를 넣는다. 미지정 시 모듈 기본. */
  flush?: () => Promise<unknown>;
}

/**
 * agents 스냅샷만 전달받아 working→idle 전이를 감지한다. React 훅이지만 실제 계약은
 * `detectIdleTransition` 순수 함수에 있어 테스트가 DOM 없이도 모든 분기를 잠글 수 있다.
 */
export function useFlushPendingInstructions(
  agents: readonly Agent[],
  options: UseFlushPendingInstructionsOptions = {},
): void {
  const paused = options.paused === true;
  const flush = options.flush ?? flushPendingInstructions;
  const onFlushed = options.onFlushed;
  const prevWorkingRef = useRef<number>(0);

  useEffect(() => {
    const current = countWorking(agents);
    const prev = prevWorkingRef.current;
    prevWorkingRef.current = current;
    if (paused) return;
    if (!detectIdleTransition(prev, current)) return;

    void (async () => {
      try {
        const res = await flush();
        // flushPendingInstructions 의 반환 타입은 외부 주입 경우 모르는 형상일 수 있어
        // 값이 { kind:'flushed', item:{ text } } 일 때만 소모한다.
        if (res && typeof res === 'object' && 'kind' in res) {
          const r = res as { kind: string; item?: { text?: string } };
          if (r.kind === 'flushed' && r.item?.text && onFlushed) onFlushed(r.item.text);
        }
      } catch {
        // 훅은 실패를 흡수한다 — 큐 store 가 markFailed 로 상태를 되돌리므로 다음
        // idle 전이 기회에 재시도된다.
      }
    })();
  }, [agents, paused, flush, onFlushed]);
}

/** 매 렌더 working 에이전트 개수. meeting/thinking 은 즉시 태스크가 아니므로 제외. */
export function countWorking(agents: readonly Agent[]): number {
  let n = 0;
  for (const a of agents) if (a.status === 'working') n += 1;
  return n;
}

/** "이전 프레임에 working > 0 이었고 현재 0" 인 엄격한 전이만 true. */
export function detectIdleTransition(prev: number, curr: number): boolean {
  return prev > 0 && curr === 0;
}
