import type { Agent } from '../types';

// 프로젝트 단위 완료 감시기. 모든 에이전트 상태가 idle 로 수렴한 "전이 순간" 에만
// Git 자동화를 1회 발사하기 위한 rising-edge 게이트를 제공한다.
//
// 왜 순수 함수로 분리하는가:
//   - server.ts 는 MongoDB / socket.io 를 import 하는 순간 번들이 부풀어
//     node:test 로 단독 실행하기 까다롭다.
//   - 상태 전이 판정을 외부 I/O 와 분리해 두면 leaderDispatch.test.ts 에서
//     "busy → completed 전이에서 딱 한 번만 fire 한다" 불변을 검증할 수 있다.
//   - 실제 자동화 호출은 server.ts 쪽 closure 가 소유하므로, 여기서는 "발사
//     여부" 플래그만 돌려준다.

export type CompletionPhase = 'busy' | 'completed';

export interface CompletionEvaluation {
  // 다음 tick 에서 비교할 현재 관측값. 호출부는 이 값을 프로젝트별 맵에 저장한다.
  nextPhase: CompletionPhase;
  // busy → completed 로 처음 전이한 순간에만 true. 동일 completed 구간이
  // 계속 이어지면 false 로 내려가 중복 트리거를 막는다.
  fire: boolean;
}

// 프로젝트에 속한 모든 에이전트 상태 배열을 받아 현재 phase 와 "이번 호출에서
// 자동화를 발사할지" 를 반환한다. statuses 가 비어 있으면 "비교 대상 자체가
// 없다" 로 보고 이전 phase 를 유지한 채 발사하지 않는다 — 프로젝트에 에이전트가
// 배정되기 전의 빈 상태가 "완료"로 오인되어 자동화가 의미 없이 도는 것을 막는다.
export function evaluateAgentsCompletion(
  previousPhase: CompletionPhase | undefined,
  statuses: ReadonlyArray<Agent['status']>,
): CompletionEvaluation {
  if (statuses.length === 0) {
    return { nextPhase: previousPhase ?? 'completed', fire: false };
  }
  const allIdle = statuses.every(s => s === 'idle');
  const nextPhase: CompletionPhase = allIdle ? 'completed' : 'busy';
  const fire = previousPhase === 'busy' && nextPhase === 'completed';
  return { nextPhase, fire };
}

// phase 맵을 내부에 숨겨 "프로젝트 ID 하나만 넘기면 전이 판정" 을 하게 해 주는
// 편의 클래스. server.ts 는 이 인스턴스를 하나만 가지고 모든 프로젝트 전이를
// 추적한다. 테스트는 evaluateAgentsCompletion 을 직접 쓰거나, 이 트래커로 동일
// rising-edge 계약을 검증할 수 있다.
export class ProjectCompletionTracker {
  private phaseByProject = new Map<string, CompletionPhase>();

  observe(projectId: string, statuses: ReadonlyArray<Agent['status']>): CompletionEvaluation {
    const previous = this.phaseByProject.get(projectId);
    const evaluation = evaluateAgentsCompletion(previous, statuses);
    this.phaseByProject.set(projectId, evaluation.nextPhase);
    return evaluation;
  }

  // 프로젝트가 삭제되거나 에이전트 편성이 바뀔 때 phase 기록을 비운다. 다음 관측은
  // previousPhase=undefined 로 다시 시작하므로, 재활성 직후의 첫 completed 관측은
  // fire 를 내리지 않는다(의미 없는 자동 커밋 방지).
  reset(projectId: string): void {
    this.phaseByProject.delete(projectId);
  }

  peek(projectId: string): CompletionPhase | undefined {
    return this.phaseByProject.get(projectId);
  }
}
