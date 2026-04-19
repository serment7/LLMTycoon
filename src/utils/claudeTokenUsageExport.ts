// 토큰 사용 내역 내보내기 유틸. `selectRange` 로 뽑아낸 총계 + 과거 히스토리를
// CSV / JSON 문자열로 직렬화해 "다운로드" 버튼이 Blob/URL 로 감싸 내려보낼 수 있게
// 한다. 본 파일은 순수 함수만 포함하여 Node 환경에서도 테스트된다.

import type { TokenUsageStoreState, UsageRange } from './claudeTokenUsageStore';
import { selectRange, ensureErrorCounters } from './claudeTokenUsageStore';
import type { ClaudeTokenUsageTotals, ClaudeErrorCategory } from '../types';
import { CLAUDE_ERROR_CATEGORIES } from '../types';

export interface UsageExportRow {
  // 'today' 범위에서는 오늘 날짜 1줄, 'week' 에서는 최근 N일 각각 + 합계 1줄,
  // 'all' 에서는 전체 누적 1줄.
  date: string | '합계';
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
  cacheHitRate: number; // 0~1
  // 카테고리별 에러 누적. 필드명 접두 `err_` 로 다른 수치와 구분.
  err_rate_limit: number;
  err_overloaded: number;
  err_api_error: number;
  err_bad_request: number;
  err_auth: number;
  err_timeout: number;
  err_network: number;
}

function computeHitRate(t: ClaudeTokenUsageTotals): number {
  const denom = t.cacheReadTokens + t.inputTokens;
  if (denom <= 0) return 0;
  return t.cacheReadTokens / denom;
}

function totalsToRow(date: UsageExportRow['date'], t: ClaudeTokenUsageTotals): UsageExportRow {
  const errors = ensureErrorCounters(t.errors);
  return {
    date,
    callCount: t.callCount,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheCreationTokens: t.cacheCreationTokens,
    estimatedCostUsd: Number(t.estimatedCostUsd.toFixed(6)),
    cacheHitRate: Number(computeHitRate(t).toFixed(4)),
    err_rate_limit: errors.rate_limit,
    err_overloaded: errors.overloaded,
    err_api_error: errors.api_error,
    err_bad_request: errors.bad_request,
    err_auth: errors.auth,
    err_timeout: errors.timeout,
    err_network: errors.network,
  };
}

/**
 * 주어진 스토어 상태와 범위로 CSV/JSON 공용 행 배열을 만든다. 'week' 는 일별
 * 행 + 합계 행을 모두 포함해 사용자 측에서 엑셀 등으로 확인하기 좋게 한다.
 */
export function buildExportRows(state: TokenUsageStoreState, range: UsageRange): UsageExportRow[] {
  if (range === 'today') {
    return [totalsToRow(state.todayDate, state.today)];
  }
  if (range === 'all') {
    return [totalsToRow('합계', state.all)];
  }
  // week: 오늘 + 최근 6일 history 각각 + 합계
  const daily: UsageExportRow[] = [totalsToRow(state.todayDate, state.today)];
  for (const entry of state.history.slice(0, 6)) {
    daily.push(totalsToRow(entry.date, entry.totals));
  }
  const weekly = selectRange(state, 'week');
  daily.push(totalsToRow('합계', weekly));
  return daily;
}

// ────────────────────────────────────────────────────────────────────────────
// 직렬화
// ────────────────────────────────────────────────────────────────────────────

const CSV_HEADERS: Array<keyof UsageExportRow> = [
  'date', 'callCount', 'inputTokens', 'outputTokens',
  'cacheReadTokens', 'cacheCreationTokens', 'estimatedCostUsd', 'cacheHitRate',
  'err_rate_limit', 'err_overloaded', 'err_api_error',
  'err_bad_request', 'err_auth', 'err_timeout', 'err_network',
];

function escapeCsvCell(value: string | number): string {
  const s = String(value);
  // 쉼표·따옴표·개행이 있으면 따옴표로 감싸고 내부 따옴표는 이중화.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** RFC 4180 호환 CSV. 한국어/Excel 호환을 위해 UTF-8 BOM 을 선두에 붙인다. */
export function toCsv(rows: UsageExportRow[]): string {
  const header = CSV_HEADERS.join(',');
  const body = rows
    .map(r => CSV_HEADERS.map(k => escapeCsvCell(r[k])).join(','))
    .join('\r\n');
  return `\uFEFF${header}\r\n${body}${rows.length > 0 ? '\r\n' : ''}`;
}

/** JSON 은 기본 2칸 들여쓰기. 추출 범위/스냅샷 시각을 메타로 덧붙인다. */
export function toJson(rows: UsageExportRow[], meta: { range: UsageRange; exportedAt: string }): string {
  return JSON.stringify({
    schema: 'llmtycoon.tokenUsage.export/v1',
    range: meta.range,
    exportedAt: meta.exportedAt,
    rows,
  }, null, 2);
}

/**
 * 내려받을 파일의 권장 파일명. 범위·현재 시각 기반으로 충돌을 낮춘다.
 * Windows 금지 문자를 피하기 위해 `:` 대신 `-` 를 쓴다.
 */
export function suggestFilename(range: UsageRange, nowIso: string, ext: 'csv' | 'json'): string {
  const stamp = nowIso.replace(/[:.]/g, '-').replace('Z', 'Z');
  return `claude-token-usage_${range}_${stamp}.${ext}`;
}
