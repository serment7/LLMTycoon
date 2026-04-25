/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Git 자동화 실패 알림. 종전에는 GitAutomationPanel 의 lastError 자리가
 * 단일 문자열 배너만 그려, stderr 가 비어 있는 spawn 실패 케이스에서 사용자가
 * 원인을 추정할 수 없는 문제가 있었다(#55bb8822). 이 컴포넌트는 서버가 emit
 * 하는 GitAutomationStepResult 를 그대로 받아 step/exit code/stderr/stdout 을
 * 분해해 보여주고, stderr 가 비었을 때는 "변경 사항 없음 가능성" 같은 추정
 * fallback 을 함께 노출한다. 메시지 키는 locales/{en,ko}.json 의
 * gitAutomation.failure.* 네임스페이스로 분리해 영어 디폴트 + 한국어 토글을
 * 그대로 따른다.
 *
 * 단위 테스트 가능하도록 i18n 의존을 함수 인자로 주입하는 buildFailureLines 를
 * 분리 export 한다 — node:test 환경에서 React 렌더링 없이도 메시지 조립
 * 규칙(특히 fallback 트리거)을 검증할 수 있다.
 */

import React from 'react';
import { XCircle, X } from 'lucide-react';
import type { GitAutomationStepResult } from '../utils/gitAutomation';
import { useI18n, translate, type Locale } from '../i18n';

export interface GitAutomationFailureNoticeProps {
  /** 서버에서 받은 실패 단계의 원본 결과. step/code/stderr/stdout 을 분리 표기. */
  failure?: GitAutomationStepResult | null;
  /** 단계 정보 없이 전달된 단순 메시지. failure 가 없을 때만 사용. */
  message?: string | null;
  /** 단계가 실행된 브랜치. 디버깅 단서로 표시. */
  branch?: string | null;
  /** 닫기 버튼이 필요할 때만 전달. 미전달 시 닫기 버튼이 노출되지 않는다. */
  onDismiss?: () => void;
  className?: string;
}

export interface FailureLine {
  /** 좌측 라벨(이미 번역된 문자열). */
  label: string;
  /** 우측 본문(코드/메시지). 비어 있으면 placeholder. */
  value: string;
  /** stdout 처럼 모노스페이스 코드 블록으로 표시할지 여부. */
  monospace?: boolean;
  /** 빈 stderr → fallback 로 대체된 라인인지 표시(스타일 분기용). */
  inferred?: boolean;
}

const FAILURE_KEYS = {
  title: 'gitAutomation.failure.title',
  step: 'gitAutomation.failure.step',
  exitCode: 'gitAutomation.failure.exitCode',
  branch: 'gitAutomation.failure.branch',
  stderrLabel: 'gitAutomation.failure.stderrLabel',
  stdoutLabel: 'gitAutomation.failure.stdoutLabel',
  noStderr: 'gitAutomation.failure.noStderr',
  emptyStderrFallback: 'gitAutomation.failure.emptyStderrFallback',
  spawnFailure: 'gitAutomation.failure.spawnFailure',
  dismiss: 'gitAutomation.failure.dismiss',
  fallbackMessage: 'gitAutomation.failure.fallbackMessage',
} as const;

export type FailureMessageKey = (typeof FAILURE_KEYS)[keyof typeof FAILURE_KEYS];

/**
 * 실패 결과 → UI 라인 배열. 메시지 키만 반환하면 React 외부에서도 검증 가능하다.
 *   - step / exit code / branch 는 값이 있을 때만 라인이 추가된다.
 *   - stderr 가 비어 있으면 emptyStderrFallback 으로 추정 사유를 끼워 넣는다.
 *     동시에 spawn 실패(code === null) 면 spawnFailure 안내도 끼운다.
 *   - stdout 은 비어 있지 않을 때만 마지막 라인으로 붙는다.
 */
export function buildFailureLines(
  args: {
    failure?: GitAutomationStepResult | null;
    branch?: string | null;
    message?: string | null;
  },
  t: (key: string) => string,
): FailureLine[] {
  const { failure, branch, message } = args;
  const lines: FailureLine[] = [];

  if (!failure) {
    if (message && message.trim()) {
      lines.push({ label: t(FAILURE_KEYS.stderrLabel), value: message.trim() });
    } else {
      lines.push({
        label: t(FAILURE_KEYS.stderrLabel),
        value: t(FAILURE_KEYS.fallbackMessage),
        inferred: true,
      });
    }
    return lines;
  }

  if (failure.label) {
    lines.push({ label: t(FAILURE_KEYS.step), value: failure.label });
  }
  // exitCode === null 은 spawn 자체가 죽은 경우 — 수치 대신 "null" 텍스트로 노출하면
  // 사용자가 "프로세스가 시작도 못했다" 는 사실을 즉시 알아챌 수 있다.
  if (failure.code !== undefined) {
    lines.push({
      label: t(FAILURE_KEYS.exitCode),
      value: failure.code === null ? 'null' : String(failure.code),
    });
  }
  if (branch && branch.trim()) {
    lines.push({ label: t(FAILURE_KEYS.branch), value: branch.trim() });
  }

  const stderr = failure.stderr?.trim();
  if (stderr) {
    lines.push({ label: t(FAILURE_KEYS.stderrLabel), value: stderr, monospace: true });
  } else {
    // 빈 stderr 케이스 — 사용자가 원인을 못 찾는 상황. fallback 안내를 추가한다.
    // commit 단계는 보통 "변경 사항 없음" 가능성이 높고, 그 외 단계에서 code===null
    // 이면 spawn 실패가 더 가능성이 높다. 두 단서를 분리 노출한다.
    lines.push({
      label: t(FAILURE_KEYS.stderrLabel),
      value: t(FAILURE_KEYS.noStderr),
    });
    lines.push({
      label: t(FAILURE_KEYS.stderrLabel),
      value: t(FAILURE_KEYS.emptyStderrFallback),
      inferred: true,
    });
    if (failure.code === null) {
      lines.push({
        label: t(FAILURE_KEYS.stderrLabel),
        value: t(FAILURE_KEYS.spawnFailure),
        inferred: true,
      });
    }
  }

  const stdout = failure.stdout?.trim();
  if (stdout) {
    lines.push({ label: t(FAILURE_KEYS.stdoutLabel), value: stdout, monospace: true });
  }

  return lines;
}

/** 테스트 편의용 — 특정 locale 로 바로 라인을 만들 때 사용. */
export function buildFailureLinesForLocale(
  args: {
    failure?: GitAutomationStepResult | null;
    branch?: string | null;
    message?: string | null;
  },
  locale: Locale,
): FailureLine[] {
  return buildFailureLines(args, key => translate(key, locale));
}

export function GitAutomationFailureNotice({
  failure,
  message,
  branch,
  onDismiss,
  className,
}: GitAutomationFailureNoticeProps): React.ReactElement | null {
  const { t } = useI18n();
  if (!failure && !message) return null;
  const lines = buildFailureLines({ failure, branch, message }, t);
  const cls = [
    'flex items-start gap-2 px-3 py-2 border-2 border-red-400 bg-red-500/15 text-red-100',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div role="alert" className={cls} data-testid="git-automation-failure-notice">
      <XCircle size={14} className="shrink-0 mt-0.5 text-red-300" aria-hidden />
      <div className="flex-1 min-w-0 space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-red-200/80 font-bold">
          {t(FAILURE_KEYS.title)}
        </div>
        <ul className="space-y-0.5">
          {lines.map((line, idx) => (
            <li
              key={idx}
              className="text-[11px] break-words flex gap-1.5"
              data-inferred={line.inferred ? 'true' : undefined}
            >
              <span className="text-red-200/70 shrink-0">{line.label}:</span>
              <span
                className={
                  line.monospace
                    ? 'font-mono text-red-50 whitespace-pre-wrap'
                    : line.inferred
                      ? 'italic text-red-100/80'
                      : 'text-red-50'
                }
              >
                {line.value}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t(FAILURE_KEYS.dismiss)}
          title={t(FAILURE_KEYS.dismiss)}
          className="shrink-0 p-1 border-2 border-red-400/50 text-red-200 hover:bg-red-500/25 hover:text-white transition-colors"
        >
          <X size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}

export default GitAutomationFailureNotice;
