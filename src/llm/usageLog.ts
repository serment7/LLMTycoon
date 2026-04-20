// 지시 #a0fe127e — Claude 토큰 사용량 JSON lines 로그 기록기.
//
// 목적
//   `src/server/claudeClient.ts` 의 usage 옵저버가 흘리는 `ClaudeTokenUsage` 를
//   **한 줄 = 하나의 JSON** 형식으로 기록해, QA 의 `tests/token-budget/*.spec.ts` 시나리오가
//   로그 파일을 읽어 시계열 분석(적중률, 압축 빈도, 비용 추이) 을 할 수 있게 한다.
//
// 기록 스키마(QA 스펙 S5 계약)
//   { ts, model, input, output, cacheRead, cacheCreation, callId? }
//   · ts         — usage.at ?? new Date().toISOString()
//   · model      — usage.model ?? 'unknown'
//   · input      — usage.input_tokens
//   · output     — usage.output_tokens
//   · cacheRead  — usage.cache_read_input_tokens
//   · cacheCreation — usage.cache_creation_input_tokens
//   · callId     — 선택(미지정 시 키 자체가 생략됨)
//
// 파일/메모리 기록기
//   · `createInMemoryUsageLog()` — 테스트에서 라인 배열을 직접 검증.
//   · `createFileUsageLog(path)` — Node 런타임에서 `fs.promises.appendFile` 로 기록.
//   두 기록기 모두 비동기 `append(usage, callId?)` 를 공개한다.

import type { ClaudeTokenUsage } from '../types';

/**
 * usageLog 카테고리 상수 — 지시 #21a88a06 에서 "recommend_agents" 캐시 히트/미스를
 * 기록하기 위해 도입. 기존 라인은 카테고리가 없으므로 optional.
 */
export const USAGE_CATEGORY_RECOMMEND_AGENTS = 'recommend_agents';
export type UsageLogCategory = typeof USAGE_CATEGORY_RECOMMEND_AGENTS | string;

export interface UsageLogLine {
  readonly ts: string;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
  readonly callId?: string;
  /** 선택 필드 — 카테고리별 집계(캐시 히트/미스 분석) 에 사용. */
  readonly category?: UsageLogCategory;
}

/**
 * 로그 라인 직렬화. 개행을 포함하지 않는다(JSON lines 계약). callId 가 비어 있으면
 * 출력 키에 포함되지 않아 파서 스키마를 최소화한다.
 */
export function formatUsageLogLine(
  usage: ClaudeTokenUsage,
  callId?: string,
  options: { category?: UsageLogCategory } = {},
): string {
  const safe = (n: number | undefined) =>
    (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0);
  const line: UsageLogLine = {
    ts: usage.at ?? new Date().toISOString(),
    model: usage.model ?? 'unknown',
    input: safe(usage.input_tokens),
    output: safe(usage.output_tokens),
    cacheRead: safe(usage.cache_read_input_tokens),
    cacheCreation: safe(usage.cache_creation_input_tokens),
    ...(callId ? { callId } : {}),
    ...(options.category ? { category: options.category } : {}),
  };
  return JSON.stringify(line);
}

/**
 * 한 줄 파서. 음수/비숫자/결측 필드는 `null` 을 돌려 QA 스펙 S5-3 계약을 만족한다.
 */
export function parseUsageLogLine(line: string): UsageLogLine | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (typeof obj.ts !== 'string' || typeof obj.model !== 'string') return null;
    const num = (v: unknown) =>
      (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    const input = num(obj.input);
    const output = num(obj.output);
    const cacheRead = num(obj.cacheRead);
    const cacheCreation = num(obj.cacheCreation);
    if (input === null || output === null || cacheRead === null || cacheCreation === null) return null;
    return {
      ts: obj.ts,
      model: obj.model,
      input,
      output,
      cacheRead,
      cacheCreation,
      ...(typeof obj.callId === 'string' ? { callId: obj.callId } : {}),
      ...(typeof obj.category === 'string' ? { category: obj.category } : {}),
    };
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 기록기 — 메모리/파일 두 어댑터
// ────────────────────────────────────────────────────────────────────────────

export interface UsageLogSink {
  /** 단건 로그 라인 append. */
  append(usage: ClaudeTokenUsage, callId?: string): Promise<void>;
  /** 직렬화된 라인 본문을 직접 기록(테스트·변환 경로에서 활용). */
  appendLine(line: string): Promise<void>;
  /** 현재까지 기록된 라인 수(메모리 싱크에서는 길이, 파일 싱크에서는 로컬 카운터). */
  size(): number;
  /** 전체 덤프(메모리 싱크 전용 — 파일 싱크는 빈 배열 반환). */
  snapshot(): readonly string[];
}

export function createInMemoryUsageLog(): UsageLogSink {
  const lines: string[] = [];
  return {
    async append(usage, callId) {
      lines.push(formatUsageLogLine(usage, callId));
    },
    async appendLine(line) {
      if (typeof line === 'string' && line.length > 0 && !line.includes('\n')) {
        lines.push(line);
      }
    },
    size() { return lines.length; },
    snapshot() { return lines.slice(); },
  };
}

export interface FileUsageLogOptions {
  /** 기록을 건너뛸지 결정하는 가드. 기본 true. */
  readonly enabled?: boolean;
  /**
   * `fs.promises.appendFile` 과 동일한 시그니처의 주입 훅. 테스트에서 가짜 IO 로 교체.
   * 미지정 시 런타임에 동적으로 `node:fs/promises` 를 가져온다.
   */
  readonly appendFile?: (path: string, data: string) => Promise<void>;
}

export function createFileUsageLog(
  path: string,
  options: FileUsageLogOptions = {},
): UsageLogSink {
  let count = 0;
  const enabled = options.enabled ?? true;

  const resolveAppendFile = async (): Promise<(p: string, d: string) => Promise<void>> => {
    if (options.appendFile) return options.appendFile;
    const mod = await import('node:fs/promises');
    return (p, d) => mod.appendFile(p, d, { encoding: 'utf8' });
  };

  async function writeLine(line: string): Promise<void> {
    if (!enabled) return;
    const writer = await resolveAppendFile();
    await writer(path, `${line}\n`);
    count += 1;
  }

  return {
    async append(usage, callId) {
      await writeLine(formatUsageLogLine(usage, callId));
    },
    async appendLine(line) {
      if (!line || line.includes('\n')) return;
      await writeLine(line);
    },
    size() { return count; },
    snapshot() { return []; },
  };
}
