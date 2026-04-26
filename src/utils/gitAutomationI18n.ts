// 지시 #a933c3c9 — Git 자동화 백엔드(`buildGitAutomationLogEntries`) 가 채운
// `errorKey` + `errorParams` 를 UI 가 t() 로 번역하기 위한 얇은 헬퍼.
//
// 정책
//   1) `errorKey` 가 있으면 항상 우선해 번역하고, errorParams 의 placeholder 를 치환한다.
//   2) `errorKey` 가 없으면 `errorMessage` 폴백을 그대로 돌려준다(레거시 / 서버 raw error 경로).
//   3) 어떤 입력에서도 throw 하지 않는다 — UI 침묵을 막기 위해 마지막엔 undefined 가 아닌
//      "(메시지 없음)" 폴백 옵션을 호출자가 선택할 수 있게 한다.

import type { GitAutomationLogEntry } from '../types';

export interface TranslatableLogFields {
  readonly errorKey?: string;
  readonly errorParams?: Record<string, string | number>;
  readonly errorMessage?: string;
}

export type TranslateFn = (key: string) => string;

function fillTemplate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    key in params ? String(params[key]) : `{${key}}`,
  );
}

/**
 * GitAutomationLogEntry 의 사용자 노출 문구를 현재 locale 로 풀어낸다.
 * errorKey 가 있으면 t() 번역 → placeholder 치환, 없으면 errorMessage 폴백.
 */
export function resolveGitAutomationLogMessage(
  entry: TranslatableLogFields | undefined,
  t: TranslateFn,
): string | undefined {
  if (!entry) return undefined;
  if (entry.errorKey) {
    const template = t(entry.errorKey);
    return entry.errorParams ? fillTemplate(template, entry.errorParams) : template;
  }
  return entry.errorMessage;
}

/** GitAutomationLogEntry 전용 편의 래퍼. 타입을 좁혀 호출부 가독성을 올린다. */
export function resolveLogEntryMessage(
  entry: GitAutomationLogEntry | undefined,
  t: TranslateFn,
): string | undefined {
  return resolveGitAutomationLogMessage(entry, t);
}
