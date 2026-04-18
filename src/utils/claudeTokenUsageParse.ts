// Claude CLI(`claude` bin) 의 stdout 에서 usage 블록을 best-effort 파싱하는
// 순수 유틸. 현재 본 프로젝트의 `callClaude` 는 plain text 출력을 쓰므로
// 대부분의 호출에서는 null 을 돌려준다. 추후 `--output-format json` 모드로
// 전환되면 본 파서가 즉시 실제 수치를 돌려주도록 설계했다.
//
// 파싱 전략 (가장 관대한 것부터 엄격한 것까지 순서대로 시도)
//   1) stdout 전체가 JSON 이면 `parse` → usage 블록 탐색.
//   2) stream-json 한 줄당 event 중 `type: "result"` 이벤트에 usage 가 붙는 경우.
//   3) stdout 의 "usage" 키가 포함된 첫 JSON-유사 중괄호 블록을 정규식으로 추출.
// 세 경로 모두 실패하면 null. 호출자는 null 을 "수집 불가" 로 간주한다.
//
// 본 파서는 네트워크 문자열을 다루므로 예외는 삼키고 null 을 돌려준다.

import type { ClaudeTokenUsage } from '../types';

interface UsageRaw {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

function toInt(n: unknown): number {
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return Math.floor(n);
  if (typeof n === 'string') {
    const parsed = parseInt(n, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
  return 0;
}

function normalizeUsage(raw: UsageRaw, model?: string): ClaudeTokenUsage {
  return {
    input_tokens: toInt(raw.input_tokens),
    output_tokens: toInt(raw.output_tokens),
    cache_read_input_tokens: toInt(raw.cache_read_input_tokens),
    cache_creation_input_tokens: toInt(raw.cache_creation_input_tokens),
    model: typeof model === 'string' && model.length > 0 ? model : undefined,
    at: new Date().toISOString(),
  };
}

/**
 * 주어진 stdout 문자열에서 Claude usage 를 추출한다. 성공 시 정규화된
 * ClaudeTokenUsage 를, 실패 시 null 을 돌려준다. input/output 모두 0 인
 * usage 는 "의미 없는 호출" 로 간주해 null 로 반환한다.
 */
export function parseClaudeUsageFromStdout(stdout: string): ClaudeTokenUsage | null {
  if (!stdout || typeof stdout !== 'string') return null;

  // 1) 전체 JSON 응답
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const usage = (obj.usage ?? (obj.message as Record<string, unknown> | undefined)?.usage) as UsageRaw | undefined;
      if (usage) {
        const model = typeof obj.model === 'string' ? obj.model : undefined;
        const normalized = normalizeUsage(usage, model);
        return isEmpty(normalized) ? null : normalized;
      }
    } catch { /* 다음 전략으로 내려간다 */ }
  }

  // 2) stream-json: 줄 단위 JSON 이벤트. `type: "result"` 또는 `usage` 필드 포함 줄을
  //    뒤에서부터 탐색해 마지막 result 만 취한다.
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const usage = (obj.usage ?? (obj.message as Record<string, unknown> | undefined)?.usage) as UsageRaw | undefined;
      if (usage) {
        const model = typeof obj.model === 'string'
          ? obj.model
          : ((obj.message as Record<string, unknown> | undefined)?.model as string | undefined);
        const normalized = normalizeUsage(usage, model);
        if (!isEmpty(normalized)) return normalized;
      }
    } catch { /* 다음 줄로 */ }
  }

  // 3) "usage" 키를 포함한 첫 중괄호 블록 정규식 추출.
  const match = trimmed.match(/"usage"\s*:\s*(\{[^{}]*\})/);
  if (match) {
    try {
      const usage = JSON.parse(match[1]) as UsageRaw;
      const normalized = normalizeUsage(usage, undefined);
      if (!isEmpty(normalized)) return normalized;
    } catch { /* 실패 시 null */ }
  }

  return null;
}

function isEmpty(u: ClaudeTokenUsage): boolean {
  return u.input_tokens === 0 && u.output_tokens === 0
    && u.cache_read_input_tokens === 0 && u.cache_creation_input_tokens === 0;
}
