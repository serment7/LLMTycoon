// 사용자 임계값(ClaudeTokenUsageThresholds) 의 localStorage 직렬화·파싱·입력 검증을
// 모아둔 순수 유틸. 스토어(claudeTokenUsageStore) 와 UI 패널이 공용으로 소비하도록
// 모듈 레벨 상태를 갖지 않는다.
//
// 저장 키: `llmtycoon.tokenUsage.thresholds.v1`
// 저장 shape:
//   { schemaVersion: 1, thresholds: ClaudeTokenUsageThresholds, savedAt: ISO }
//
// severity 해석은 claudeTokenUsageStore.ts::resolveUsageSeverity 가 수행한다.

import type { ClaudeTokenUsageThresholds } from '../types';
import { EMPTY_THRESHOLDS } from './claudeTokenUsageStore';

export const TOKEN_USAGE_THRESHOLDS_STORAGE_KEY = 'llmtycoon.tokenUsage.thresholds.v1';

interface PersistedThresholds {
  schemaVersion: 1;
  thresholds: ClaudeTokenUsageThresholds;
  savedAt: string;
}

function normalizeEntry(raw: unknown): { tokens?: number; usd?: number } {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as { tokens?: unknown; usd?: unknown };
  const out: { tokens?: number; usd?: number } = {};
  if (typeof r.tokens === 'number' && Number.isFinite(r.tokens) && r.tokens > 0) out.tokens = r.tokens;
  if (typeof r.usd === 'number' && Number.isFinite(r.usd) && r.usd > 0) out.usd = r.usd;
  return out;
}

/** 저장된 문자열(또는 null)을 ClaudeTokenUsageThresholds 로 파싱. 실패 시 EMPTY_THRESHOLDS. */
export function deserializeThresholds(raw: string | null): ClaudeTokenUsageThresholds {
  if (!raw || typeof raw !== 'string') return EMPTY_THRESHOLDS;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedThresholds> | null;
    if (!parsed || typeof parsed !== 'object') return EMPTY_THRESHOLDS;
    if (parsed.schemaVersion !== 1 || !parsed.thresholds) return EMPTY_THRESHOLDS;
    return {
      caution: normalizeEntry(parsed.thresholds.caution),
      warning: normalizeEntry(parsed.thresholds.warning),
    };
  } catch {
    return EMPTY_THRESHOLDS;
  }
}

export function serializeThresholds(thresholds: ClaudeTokenUsageThresholds, nowIso: string = new Date().toISOString()): string {
  const payload: PersistedThresholds = {
    schemaVersion: 1,
    thresholds: {
      caution: normalizeEntry(thresholds.caution),
      warning: normalizeEntry(thresholds.warning),
    },
    savedAt: nowIso,
  };
  return JSON.stringify(payload);
}

export function loadThresholdsFromStorage(): ClaudeTokenUsageThresholds {
  try {
    if (typeof window === 'undefined') return EMPTY_THRESHOLDS;
    return deserializeThresholds(window.localStorage?.getItem(TOKEN_USAGE_THRESHOLDS_STORAGE_KEY) ?? null);
  } catch {
    return EMPTY_THRESHOLDS;
  }
}

/**
 * localStorage 저장 성공 여부를 `boolean` 으로 돌려준다. SSR 환경(window 미존재) 은
 * 저장할 곳이 없으므로 false. `QuotaExceededError`·사생활 보호 모드 등도 false.
 * 기존 void 계약을 기대하는 호출자는 반환값을 무시하면 되므로 하위호환 안전.
 */
export function saveThresholdsToStorage(thresholds: ClaudeTokenUsageThresholds): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const storage = window.localStorage;
    if (!storage) return false;
    storage.setItem(TOKEN_USAGE_THRESHOLDS_STORAGE_KEY, serializeThresholds(thresholds));
    return true;
  } catch {
    return false;
  }
}

/**
 * 폼 입력 문자열(부분 숫자 또는 빈 값) 을 ClaudeTokenUsageThresholds entry 로 변환.
 * 빈 문자열·비숫자·음수는 "임계값 미설정" 으로 처리(필드 미포함).
 */
export function parseThresholdInput(input: { tokens?: string; usd?: string }): { tokens?: number; usd?: number } {
  const out: { tokens?: number; usd?: number } = {};
  const tk = input.tokens?.trim();
  const us = input.usd?.trim();
  if (tk) {
    const n = Number(tk);
    if (Number.isFinite(n) && n > 0) out.tokens = Math.floor(n);
  }
  if (us) {
    const n = Number(us);
    if (Number.isFinite(n) && n > 0) out.usd = n;
  }
  return out;
}

/**
 * 사용자가 caution > warning 처럼 반대로 입력한 경우에도 내부 정합성을 유지하도록
 * 검증 결과를 돌려준다. UI 에서 경고 배너 + 저장 차단에 사용.
 */
export function validateThresholds(thresholds: ClaudeTokenUsageThresholds): {
  ok: boolean;
  error: string | null;
} {
  const c = thresholds.caution;
  const w = thresholds.warning;
  if (typeof c.tokens === 'number' && typeof w.tokens === 'number' && c.tokens >= w.tokens) {
    return { ok: false, error: '주의 임계값(토큰)은 경고 임계값보다 작아야 합니다.' };
  }
  if (typeof c.usd === 'number' && typeof w.usd === 'number' && c.usd >= w.usd) {
    return { ok: false, error: '주의 임계값(비용)은 경고 임계값보다 작아야 합니다.' };
  }
  return { ok: true, error: null };
}
