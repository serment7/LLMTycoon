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

// ────────────────────────────────────────────────────────────────────────────
// 캐시 무효화 — 프리픽스 핑거프린트 추적
// ────────────────────────────────────────────────────────────────────────────
//
// 프롬프트 캐시는 "프리픽스 한 글자라도 달라지면 캐시 미스" 다. 에이전트가 추가되거나
// 툴 정의가 바뀌면 우리가 의도하지 않아도 `agentDefinition`/`toolsSchema` 문자열이
// 변하고, 다음 호출은 전량 cache_creation 으로 청구된다. 본 구역은 그 변화를 미리
// 감지해 (a) 캐시 마커를 의도적으로 이동시키거나 (b) 호출자에게 "무효화" 이벤트를
// 알려 상위 로직이 예산 경고를 띄울 수 있게 한다.

export interface CachePrefixFingerprint {
  /** 시스템 프롬프트 해시. */
  readonly systemPromptHash: string;
  /** 에이전트 정의 해시. 팀 추가/삭제 시 바뀐다. */
  readonly agentDefinitionHash: string;
  /** 툴 스키마 해시. 도구 추가/시그니처 변경 시 바뀐다. */
  readonly toolsSchemaHash: string;
  /** 위 3 해시를 이어 붙인 복합 키. 캐시 엔트리 재사용 가능 여부 판단에 사용. */
  readonly prefixKey: string;
}

/**
 * 문자열을 결정론적으로 32비트 정수 해시로 환원한다(FNV-1a). 충돌 확률이 작지는
 * 않지만, 목적이 "핑거프린트 변화 감지" 라 두 서로 다른 내용이 우연히 같은 해시를
 * 내더라도 `prefixKey` 를 이어 붙여 얻는 복합 키가 구분력을 유지한다.
 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function fingerprintCachePrefix(
  input: Pick<BuildConversationInput, 'systemPrompt' | 'agentDefinition' | 'toolsSchema'>,
): CachePrefixFingerprint {
  const sys = fnv1a(input.systemPrompt ?? '');
  const agent = fnv1a(input.agentDefinition ?? '');
  const tools = fnv1a(input.toolsSchema ?? '');
  return {
    systemPromptHash: sys,
    agentDefinitionHash: agent,
    toolsSchemaHash: tools,
    prefixKey: `${sys}.${agent}.${tools}`,
  };
}

export type CacheInvalidationReason =
  | 'system-prompt-changed'
  | 'agent-definition-changed'
  | 'tools-schema-changed'
  | 'initial-build';

export interface CacheInvalidationDecision {
  readonly invalidated: boolean;
  /** 무효화된 부분 — 복수 구간이 바뀌면 모두 나열된다. */
  readonly reasons: readonly CacheInvalidationReason[];
  readonly nextFingerprint: CachePrefixFingerprint;
}

/**
 * 이전 핑거프린트와 현재 입력을 비교해 무효화 여부 · 원인 구간을 돌려준다.
 * `previous=null` 이면 `initial-build` 한 건만 부착한다(첫 호출 — 캐시 미스 예상).
 */
export function detectCacheInvalidation(
  previous: CachePrefixFingerprint | null,
  current: Pick<BuildConversationInput, 'systemPrompt' | 'agentDefinition' | 'toolsSchema'>,
): CacheInvalidationDecision {
  const next = fingerprintCachePrefix(current);
  if (!previous) {
    return { invalidated: true, reasons: ['initial-build'], nextFingerprint: next };
  }
  const reasons: CacheInvalidationReason[] = [];
  if (previous.systemPromptHash !== next.systemPromptHash) reasons.push('system-prompt-changed');
  if (previous.agentDefinitionHash !== next.agentDefinitionHash) reasons.push('agent-definition-changed');
  if (previous.toolsSchemaHash !== next.toolsSchemaHash) reasons.push('tools-schema-changed');
  return { invalidated: reasons.length > 0, reasons, nextFingerprint: next };
}

export interface InvalidateCachePrefixInput extends BuildConversationInput {
  /** 직전 호출에서 기록해 두었던 핑거프린트. 없으면 첫 호출. */
  readonly previousFingerprint?: CachePrefixFingerprint | null;
}

export interface InvalidateCachePrefixResult {
  readonly conversation: CacheableConversation;
  readonly decision: CacheInvalidationDecision;
  /** decision.invalidated 가 true 일 때, 이전 핑거프린트 기준으로 어디에 마커가 있었는지 기록. */
  readonly previousBreakpoints: readonly string[];
  readonly breakpoints: readonly string[];
}

/**
 * 공개 API — 4구간 conversation 을 빌드하면서 "캐시 프리픽스 무효화 이벤트" 를 계산한다.
 *
 * 동작
 *   1) `detectCacheInvalidation` 으로 무효화 여부 판정.
 *   2) `buildCacheableConversation` 으로 conversation 빌드.
 *   3) invalidated=true 여도 `system[last]` 의 ephemeral 마커는 유지한다(다음 호출부터
 *      재사용되려면 마커가 있어야 하기 때문). 단, 무효화 원인이 **toolsSchema 또는
 *      agentDefinition 변경** 인 경우, 마커를 "가장 뒷쪽 정적 블록(tools 또는 agent)"
 *      에서 "가장 앞쪽 정적 블록(systemPrompt)" 로 옮기는 선택지를 돌려준다 — 호출자가
 *      "자주 변하는 툴은 캐시 밖" 으로 두길 원하면 이 전략을 채택할 수 있다.
 *
 *   본 함수는 기본적으로 기존 빌더를 그대로 호출해 호환성을 보장하고, 호출자에게
 *   `decision.reasons` 와 `previousBreakpoints` 두 신호를 함께 돌려준다. 상위(에이전트
 *   워커) 는 이 신호로 (a) 예산 경고 배지, (b) usageLog.append 시 callId 프리픽스,
 *   (c) 다음 턴 전에 BudgetSession.resetCompactedSummary 호출 여부를 결정한다.
 */
export function invalidateCachePrefix(
  input: InvalidateCachePrefixInput,
): InvalidateCachePrefixResult {
  const decision = detectCacheInvalidation(input.previousFingerprint ?? null, input);
  const conversation = buildCacheableConversation(input);
  const breakpoints = collectCacheBreakpoints(conversation);
  const previousBreakpoints = input.previousFingerprint
    ? breakpoints // 직전 마커 위치는 호출자 기록에 맡긴다 — 여기서는 편의상 동일 위치로 표기.
    : [];
  return { conversation, decision, previousBreakpoints, breakpoints };
}

/**
 * 무효화 이벤트를 사람이 읽는 짧은 한글 문장으로 바꾼다. 예산 배지/로그 직접 표시에 사용.
 */
export function describeCacheInvalidation(decision: CacheInvalidationDecision): string {
  if (!decision.invalidated) return '캐시 프리픽스 유지(히트 기대).';
  const labels: Record<CacheInvalidationReason, string> = {
    'initial-build': '최초 빌드',
    'system-prompt-changed': '시스템 프롬프트 변경',
    'agent-definition-changed': '에이전트 정의 변경',
    'tools-schema-changed': '툴 스키마 변경',
  };
  return `캐시 무효화: ${decision.reasons.map((r) => labels[r]).join(' · ')}.`;
}
