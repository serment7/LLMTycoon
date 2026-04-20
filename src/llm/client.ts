// 지시 #a0fe127e — Anthropic 프롬프트 캐싱 특화 메시지 빌더.
//
// 목적
//   Claude 호출 페이로드를 다음 4구간으로 나누고 각 경계에 올바른 `cache_control`
//   블록을 부착해 프롬프트 캐시 적중률을 최대화한다.
//     1) 시스템 프롬프트(정적 인스트럭션) — `system[0]`
//     2) 에이전트 정의(팀 구성 · 역할 · 자동 개발 규칙) — `system[1]`
//     3) 툴 스키마(JSON) — `system[2]`
//     4) 대화 히스토리 + 이번 사용자 턴 — `messages[*]`
//
//   Anthropic 의 "마지막 `cache_control` 프리픽스까지가 캐시 대상" 규칙에 맞춰,
//   정적 구간(1~3) 의 맨 끝에 ephemeral 마커를 부착해 프리픽스가 한 블록으로 묶이도록
//   한다. 반복되는 대화 히스토리에서는 "마지막 사용자 메시지 직전" 지점에도 캐시
//   브레이크포인트를 두어, 두 번째 호출부터는 histo­ry 전체가 cache_read 로 들어온다.
//
// 본 모듈은 `src/server/claudeClient.ts` 의 단일 블록 캐시 계약을 파괴하지 않는다 —
// 기존 `buildCacheableMessages(system, user, tools?)` 는 그대로 유지되고, 여기서는
// 히스토리 인지 빌더(`buildCacheableConversation`) 와 3구간 분리 입력 타입을 추가한다.

import type { ConversationTurn } from './tokenBudget';

export interface CacheableTextBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: { type: 'ephemeral' };
}

export interface CacheableUserMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly CacheableTextBlock[];
}

export interface CacheableConversation {
  readonly system: readonly CacheableTextBlock[];
  readonly messages: readonly CacheableUserMessage[];
  readonly tools?: string;
}

export interface BuildConversationInput {
  /** 1구간 — 정적 시스템 프롬프트. 비어 있으면 블록을 생성하지 않는다. */
  readonly systemPrompt?: string;
  /** 2구간 — 팀 · 역할 정의. 자주 바뀌지 않도록 단일 문자열로 받는다. */
  readonly agentDefinition?: string;
  /** 3구간 — 툴 스키마(JSON.stringify 결과). 미지정 시 블록 생략. */
  readonly toolsSchema?: string;
  /**
   * 4구간 — 이전 대화 히스토리(최신순 오름차순). 마지막 항목은 user 여야 한다 —
   * 그렇지 않으면 캐시 브레이크포인트가 엉뚱한 assistant 메시지 뒤에 붙는다.
   */
  readonly history?: readonly ConversationTurn[];
  /** 이번 턴 사용자 입력. history 의 마지막 user 메시지와 동일하면 중복 없이 1회만 전송. */
  readonly user: string;
  /** 압축된 요약(있으면 systemPrompt 바로 뒤에 "요약 블록" 으로 삽입). */
  readonly compactedSummary?: string;
}

function textBlock(text: string, cache = false): CacheableTextBlock {
  return cache ? { type: 'text', text, cache_control: { type: 'ephemeral' } } : { type: 'text', text };
}

/**
 * 3구간 정적 프리픽스(시스템/에이전트/툴) 에 한 번만 ephemeral 마커를 붙인다.
 * `system[last].cache_control = ephemeral` — 앞의 모든 블록이 한 캐시 엔트리로 묶임.
 */
function buildSystemBlocks(input: BuildConversationInput): CacheableTextBlock[] {
  const blocks: CacheableTextBlock[] = [];
  if (input.systemPrompt && input.systemPrompt.trim()) blocks.push(textBlock(input.systemPrompt));
  if (input.compactedSummary && input.compactedSummary.trim()) {
    blocks.push(textBlock(`[과거 대화 요약]\n${input.compactedSummary}`));
  }
  if (input.agentDefinition && input.agentDefinition.trim()) blocks.push(textBlock(input.agentDefinition));
  if (input.toolsSchema && input.toolsSchema.trim()) blocks.push(textBlock(input.toolsSchema));
  if (blocks.length > 0) {
    blocks[blocks.length - 1] = {
      ...blocks[blocks.length - 1],
      cache_control: { type: 'ephemeral' },
    };
  }
  return blocks;
}

/**
 * 히스토리를 messages 배열로 직렬화한다. "마지막 사용자 메시지 직전" 지점에 캐시
 * 브레이크포인트를 둔다 — 즉, history 의 맨 끝이 user 면 그 직전의 assistant 에
 * ephemeral 마커를 붙여, 다음 호출에서 history 전체가 cache_read 로 들어온다.
 *
 * history 가 비어 있거나 마지막이 user 가 아니면 마커를 붙이지 않고(휘발성 user 턴이
 * 가장 마지막이 되도록), 호출자는 `user` 인자로 새 질문을 전달한다.
 */
function buildMessages(
  history: readonly ConversationTurn[] | undefined,
  user: string,
): CacheableUserMessage[] {
  const messages: CacheableUserMessage[] = [];
  const turns = history ?? [];
  if (turns.length > 0) {
    // 마지막 user 직전에 캐시 마커를 박을 인덱스(없으면 -1).
    let breakpoint = -1;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      if (turns[i].role === 'user') {
        // i 바로 앞(assistant) 에 마커 부착 — 그 지점까지가 정적 프리픽스로 재사용됨.
        breakpoint = i - 1;
        break;
      }
    }
    turns.forEach((t, idx) => {
      const mark = idx === breakpoint;
      messages.push({ role: t.role, content: [textBlock(t.content, mark)] });
    });
  }
  messages.push({ role: 'user', content: [textBlock(user)] });
  return messages;
}

/**
 * 공개 API — 4구간 구조를 갖춘 캐시 친화 메시지 객체를 만든다. Anthropic SDK 로
 * 전환 시 `anthropic.messages.create({ ...buildCacheableConversation(...) })` 로 바로 전달 가능.
 */
export function buildCacheableConversation(
  input: BuildConversationInput,
): CacheableConversation {
  return {
    system: buildSystemBlocks(input),
    messages: buildMessages(input.history, input.user),
    tools: input.toolsSchema,
  };
}

/**
 * 캐시 마커가 부착된 블록의 경로 목록. 테스트/디버깅 전용 — 어디에 브레이크포인트가
 * 박혔는지 한눈에 확인할 수 있다.
 */
export function collectCacheBreakpoints(conversation: CacheableConversation): string[] {
  const paths: string[] = [];
  conversation.system.forEach((b, i) => {
    if (b.cache_control) paths.push(`system[${i}]`);
  });
  conversation.messages.forEach((m, i) => {
    m.content.forEach((b, j) => {
      if (b.cache_control) paths.push(`messages[${i}].content[${j}]`);
    });
  });
  return paths;
}
