// Claude 호출의 공용 래퍼. 본 프로젝트는 `@anthropic-ai/sdk` 대신 Claude CLI 를
// spawn 하지만, 향후 SDK 전환을 대비해 "프롬프트 캐싱" 지시(cache_control: ephemeral)
// 를 한 곳에서 관리하기 위한 빌더 + stream-json 결과에서 usage 를 수집하는 훅을
// 제공한다.
//
// 세 공용 경로
//  1) `buildCacheableMessages(system, tools?, user)` — SDK 전환 시 messages 배열을
//     바로 반환하도록 설계. 현재(CLI 모드) 에서는 `system` 문자열을 별도로 꺼내
//     `--append-system-prompt` 인자에 주입하면 CLI 내부 캐싱이 자연스럽게 동작하고
//     나머지 블록은 user stdin 에 합쳐 전달한다.
//  2) `extractUsageFromStreamJsonResult(msg)` — `agentWorker::handleMessage` 의
//     `msg.type === 'result'` 분기가 stream-json 으로 받은 usage 필드를 이 유틸
//     하나로 추출한다. 필드 누락/음수/undefined 방어는 본 유틸이 책임진다.
//  3) `recordClaudeUsageFromStreamJson(msg, recorder)` — 추출 + 호출자 제공
//     recorder(delta) 호출을 묶은 편의 헬퍼.
//
// 본 파일은 순수 함수만 포함하여 서버/테스트 양쪽에서 재사용 가능하다. 실제
// 프로세스 호출은 이 래퍼 외부(기존 `server.ts::callClaude`·`agentWorker::spawn`)
// 에서 그대로 수행된다.

import type { ClaudeTokenUsage } from '../types';
import type { ClaudeErrorCategory } from '../types';

// ────────────────────────────────────────────────────────────────────────────
// 프롬프트 캐싱 빌더
// ────────────────────────────────────────────────────────────────────────────

export type CacheType = 'ephemeral';

/** SDK 네이티브 메시지 컨텐츠 블록 모양(프로젝트에 SDK 가 아직 없어 직접 선언). */
export interface CacheableTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: CacheType };
}

export interface CacheableClaudeMessages {
  // SDK 전환 시 system 배열을 그대로 `messages.create({ system, messages })` 에 넣으면
  // 마지막 block 에 붙은 cache_control 이 그 앞까지 프리픽스 캐시로 묶인다.
  system: CacheableTextBlock[];
  // assistant/user 교대 턴의 첫 user 턴. 휘발성이므로 cache_control 을 붙이지 않는다.
  messages: Array<{ role: 'user'; content: CacheableTextBlock[] }>;
  // 도구 정의 블록(선택). 본 프로젝트는 MCP 경로라 SDK tool 스키마가 없고, 문서화용
  // 고정 스키마 문자열을 넣어 CLI 내부 캐시가 동일 정의를 재사용하도록 유도한다.
  tools?: string;
}

/**
 * 공용 퍼블릭 API · SDK 전환 시 `anthropic.messages.create({ ...buildCacheableMessages(...) })`
 * 로 **수정 없이** 넘기기 위한 표준 입력 빌더. ephemeral 캐시 마커는 마지막 시스템
 * 블록에만 붙여, 앞의 모든 시스템 프리픽스가 한 캐시 블록으로 묶이는 SDK 계약을 보존한다.
 *
 * 인자
 *   - system: 시스템 프롬프트 원문. 문자열 단일 또는 **문자열 배열** 허용.
 *             배열을 주면 각 항목이 별도 블록으로 유지되며 구조 분리를 후속 단계까지 보존한다.
 *             빈 문자열·공백만 항목은 조용히 건너뛴다(빈 블록이 캐시 마커를 먹는 회귀 차단).
 *   - tools:  도구 정의 문자열(JSON.stringify 된 스키마). 미지정 시 시스템 블록만.
 *   - user:   이번 턴 사용자 지시(휘발성 — 캐시 마커 없음).
 */
export function buildCacheableMessages(
  system: string | string[],
  user: string,
  tools?: string,
): CacheableClaudeMessages {
  const systemBlocks: CacheableTextBlock[] = [];
  const systemParts: string[] = Array.isArray(system) ? system : [system];
  for (const part of systemParts) {
    if (typeof part === 'string' && part.trim().length > 0) {
      systemBlocks.push({ type: 'text', text: part });
    }
  }
  if (tools && tools.trim().length > 0) {
    systemBlocks.push({ type: 'text', text: tools });
  }
  // 마지막 시스템 블록에 캐시 마커를 한 번만 붙인다. 시스템이 완전히 비어 있으면
  // 마커도 생략(빈 배열). 중간 블록에는 마커가 붙지 않아 "한 캐시 = 마지막 마커의 프리픽스
  // 전부" SDK 계약을 깨지 않는다.
  if (systemBlocks.length > 0) {
    systemBlocks[systemBlocks.length - 1] = {
      ...systemBlocks[systemBlocks.length - 1],
      cache_control: { type: 'ephemeral' },
    };
  }
  return {
    system: systemBlocks,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    tools,
  };
}

/** CLI 모드 호환: 위 메시지 배열을 단일 문자열로 결합해 stdin 으로 보낼 때 사용. */
export function flattenMessagesForCli(messages: CacheableClaudeMessages): {
  systemPrompt: string;
  userPrompt: string;
} {
  const systemPrompt = messages.system.map(b => b.text).join('\n\n');
  const userPrompt = messages.messages[0]?.content.map(b => b.text).join('\n\n') ?? '';
  return { systemPrompt, userPrompt };
}

// ────────────────────────────────────────────────────────────────────────────
// stream-json 결과 → usage 추출
// ────────────────────────────────────────────────────────────────────────────

/**
 * 공용 퍼블릭 API · stream-json result 이벤트 → 정규화된 `ClaudeTokenUsage` 변환.
 * 누락·음수·비숫자는 0 으로 클램프하고, 네 필드 전부 0 인 "의미 없는 이벤트" 는 null.
 */
export function extractUsageFromStreamJsonResult(msg: unknown): ClaudeTokenUsage | null {
  if (!msg || typeof msg !== 'object') return null;
  const root = msg as Record<string, unknown>;
  // 다양한 CLI 버전 호환: 최상위 usage / message.usage 두 경로 지원.
  const raw = (root.usage ?? (root.message as Record<string, unknown> | undefined)?.usage) as
    | { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown }
    | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const toInt = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
  const usage: ClaudeTokenUsage = {
    input_tokens: toInt(raw.input_tokens),
    output_tokens: toInt(raw.output_tokens),
    cache_read_input_tokens: toInt(raw.cache_read_input_tokens),
    cache_creation_input_tokens: toInt(raw.cache_creation_input_tokens),
    model: typeof root.model === 'string'
      ? root.model
      : (typeof (root.message as Record<string, unknown> | undefined)?.model === 'string'
         ? (root.message as { model: string }).model
         : undefined),
    at: new Date().toISOString(),
  };
  // 네 필드 모두 0 이면 "의미 없는 이벤트" 로 간주하고 null.
  if (usage.input_tokens === 0 && usage.output_tokens === 0
      && usage.cache_read_input_tokens === 0 && usage.cache_creation_input_tokens === 0) {
    return null;
  }
  return usage;
}

/**
 * stream-json 이벤트가 `type === 'result'` 일 때 usage 를 추출하고 recorder 콜백에
 * 넘긴다. `agentWorker::handleMessage` 의 result 분기에 한 줄만 추가하면 배선 완료.
 */
export function recordClaudeUsageFromStreamJson(
  msg: unknown,
  recorder: (usage: ClaudeTokenUsage) => void,
): void {
  const usage = extractUsageFromStreamJsonResult(msg);
  if (!usage) return;
  try { recorder(usage); } catch { /* recorder 실패는 호출 흐름을 막지 않는다 */ }
}

// ────────────────────────────────────────────────────────────────────────────
// 전역 usage 옵저버 — 모듈 간 순환 의존 없이 agentWorker / callClaude 양쪽이
// 단일 `recordClaudeUsage` (server.ts 소유) 로 usage 를 흘리도록 하는 경량 pub/sub.
// server 기동 시 `onClaudeUsage(recordClaudeUsage)` 한 번 등록하면 모든 경로가
// 자동 배선된다. 테스트는 `resetClaudeUsageListeners()` 로 초기화 가능.
// ────────────────────────────────────────────────────────────────────────────

type UsageListener = (usage: ClaudeTokenUsage) => void;
const usageListeners = new Set<UsageListener>();

/** 공용 퍼블릭 API · 전역 usage 이벤트 구독. 반환 함수로 해제 가능. server 기동 시 1회만 등록 권장. */
export function onClaudeUsage(listener: UsageListener): () => void {
  usageListeners.add(listener);
  return () => { usageListeners.delete(listener); };
}

/** 공용 퍼블릭 API · stream-json 메시지 → 구독자 전원에게 usage 전파(실패 격리). */
export function emitUsageFromStreamJson(msg: unknown): void {
  const usage = extractUsageFromStreamJsonResult(msg);
  if (!usage) return;
  for (const l of usageListeners) {
    try { l(usage); } catch { /* 개별 구독자 실패는 격리 */ }
  }
}

/** 테스트 전용: 등록된 모든 리스너를 제거한다. */
export function resetClaudeUsageListeners(): void {
  usageListeners.clear();
}

// ────────────────────────────────────────────────────────────────────────────
// 토큰 소진/구독 만료 이벤트 버스 (#cdaaabf3)
// ────────────────────────────────────────────────────────────────────────────
//
// `classifyClaudeError` 가 `token_exhausted` 또는 `subscription_expired` 카테고리로
// 수렴한 실패가 관측되면, 호출 측이 `emitTokenExhausted({ category, message })` 를 한 번
// 호출한다. `server.ts` 가 기동 시 `onTokenExhausted(listener)` 로 구독해 서버 측
// `claudeSessionStatus` 를 'exhausted' 로 전이시키고, REST/socket 경로로 클라이언트에
// 방송한다. 재시도 정책은 `claudeErrors.ts::retryPolicyFor` 가 이미 `retriable=false`
// 로 막지만, 본 이벤트는 "UI 읽기 전용 전환" 축을 별개로 가진다.

export interface TokenExhaustedEvent {
  category: 'token_exhausted' | 'subscription_expired';
  message: string;
  at: string; // ISO
}

type TokenExhaustedListener = (event: TokenExhaustedEvent) => void;
const tokenExhaustedListeners = new Set<TokenExhaustedListener>();

/** 공용 퍼블릭 API · 토큰 소진/구독 만료 이벤트 구독. 반환 함수로 해제 가능. */
export function onTokenExhausted(listener: TokenExhaustedListener): () => void {
  tokenExhaustedListeners.add(listener);
  return () => { tokenExhaustedListeners.delete(listener); };
}

/**
 * 공용 퍼블릭 API · 토큰 소진/구독 만료 상태를 구독자 전원에게 방송한다.
 * 개별 리스너 실패는 격리해 다른 구독자가 영향받지 않게 한다.
 */
export function emitTokenExhausted(event: { category: ClaudeErrorCategory; message: string }): void {
  if (event.category !== 'token_exhausted' && event.category !== 'subscription_expired') return;
  const payload: TokenExhaustedEvent = {
    category: event.category,
    message: event.message || (event.category === 'token_exhausted' ? '토큰이 소진되었습니다' : '구독이 만료되었습니다'),
    at: new Date().toISOString(),
  };
  for (const l of tokenExhaustedListeners) {
    try { l(payload); } catch { /* 개별 구독자 실패는 격리 */ }
  }
}

/** 테스트 전용: 등록된 모든 세션 폴백 리스너를 제거한다. */
export function resetTokenExhaustedListeners(): void {
  tokenExhaustedListeners.clear();
}
