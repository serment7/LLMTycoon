// 지시 #c89384cd — 에이전트 공용 호출 헬퍼.
//
// 목적
//   모든 에이전트 호출부가 Claude 에 보낼 messages 봉투를 한 경로로 구성하도록
//   묶는다. 내부적으로는 기존 `buildCacheableMessages` 에 위임하되, 호출부는
//   "어느 블록에 cache_control 을 박아야 하는가" 를 신경 쓰지 않아도 되도록
//   한 줄로 감싼 인터페이스만 노출한다.
//
// 규칙
//   · system: 문자열 또는 문자열 배열. 빈/공백 항목은 조용히 제거.
//   · tools:  JSON.stringify 한 도구 스키마. 있으면 마지막 시스템 블록으로
//             편입되고 cache_control 마커가 그쪽으로 이동한다.
//   · user:   이번 턴 휘발성 입력. 마커 없음.
//
// 본 헬퍼는 docs/token-budget-strategy.md §1 과 1:1 로 대응한다 — 전략 문서를
// 수정하면 본 모듈의 주석과 타입 모양도 같이 손본다.
//
// 반환값에는 "어느 경로에 ephemeral 마커가 찍혔는가" 를 문자열 목록으로 함께
// 돌려준다. usageLog 의 callId 프리픽스나 디버그 배지에 그대로 쓰면 된다.

import {
  buildCacheableMessages,
  type CacheableClaudeMessages,
} from '../claudeClient';

export interface MessagesWithCacheInput {
  /** 시스템 프리픽스. 문자열 단일 또는 배열. 빈 항목은 조용히 제거된다. */
  readonly system: string | readonly string[];
  /** 이번 턴 사용자 입력. 휘발성 — 캐시 마커 없음. */
  readonly user: string;
  /**
   * 도구 스키마(JSON.stringify 결과). 지정하면 마지막 시스템 블록으로 편입되고
   * ephemeral 마커가 tools 블록으로 이동한다. 미지정 시 시스템 마지막 블록에 마커.
   */
  readonly tools?: string;
}

export interface MessagesWithCacheResult {
  /** SDK 전환 시 `anthropic.messages.create(messages)` 로 그대로 전달 가능. */
  readonly messages: CacheableClaudeMessages;
  /**
   * cache_control 이 찍힌 블록의 경로 목록. 예: `['system[2]']`.
   * 시스템/툴이 전부 비어 있으면 빈 배열 — 호출자가 "프리픽스 없음" 을 감지할 수 있다.
   */
  readonly cacheMarkedBlocks: readonly string[];
}

/**
 * 공용 퍼블릭 API — 에이전트 호출부가 반드시 이 함수를 거쳐 messages 를 만든다.
 *
 * 예
 * ```ts
 * const { messages } = messagesWithCache({
 *   system: [POLICY, FEW_SHOT],
 *   user: `설명: ${description}`,
 *   tools: JSON.stringify(TOOL_SCHEMA),
 * });
 * const raw = await invoker(messages);
 * ```
 */
export function messagesWithCache(
  input: MessagesWithCacheInput,
): MessagesWithCacheResult {
  const system: string | string[] = Array.isArray(input.system)
    ? Array.from(input.system)
    : input.system;
  const messages = buildCacheableMessages(system, input.user, input.tools);
  const cacheMarkedBlocks: string[] = [];
  messages.system.forEach((block, i) => {
    if (block.cache_control) cacheMarkedBlocks.push(`system[${i}]`);
  });
  return { messages, cacheMarkedBlocks };
}
