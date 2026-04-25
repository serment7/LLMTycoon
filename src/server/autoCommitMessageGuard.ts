// 지시 #98854d74 — 자동 커밋 메시지 가드 래퍼.
//
// 배경
//   buildAutoCommitMessage 는 "에이전트별 항목 + 변경 파일 들여쓰기" 본문을
//   원문 그대로 만든다. 그러나 git CLI/UI 토스트는 다음 제약을 추가로 요구한다:
//     · 제목은 72자 이내(GitHub 일관성, 줄 단위 가독성)
//     · 본문 bullet 은 태스크당 5건까지만 — 초과분은 `… 외 N건` 으로 축약
//     · description 안의 줄바꿈/제어문자는 안전하게 sanitize
//     · 한국어 우선 정책에 어긋나는 이모지/영어 전용 summary 는 경고 + 제거
//
//   회귀 테스트(tests/git-automation.commit-message.spec.ts)가 본 헬퍼를 단일
//   진입점으로 사용해, buildAutoCommitMessage 본체와 가드 정책을 한 곳에서
//   잠근다. 호출자(server.ts 의 자동 커밋 트리거)는 buildAutoCommitMessage 가
//   아니라 이 가드 래퍼를 통해 메시지를 만들어야 회귀 잠금이 의미를 갖는다.

import {
  buildAutoCommitMessage,
  type AutoCommitMessage,
  type BuildAutoCommitMessageInput,
  type CompletedAgentTask,
} from './autoCommitMessage';

export const SUBJECT_MAX_LEN = 72;
export const BODY_BULLET_LIMIT = 5;
export const DEFAULT_GUARD_FALLBACK = 'chore: all agents completed';
const ELLIPSIS = '…';

// 한글(자모/완성형) 한 글자라도 있으면 한국어 summary 로 본다.
const HANGUL_RE = /[가-힣ᄀ-ᇿ㄰-㆏]/;
// 광범위한 이모지 범위 — `.test()` 와 `.replace()` 가 lastIndex 충돌을 일으키지
// 않도록 두 인스턴스를 분리한다.
const EMOJI_TEST_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}]/u;
const EMOJI_REPLACE_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}]/gu;
// LF 는 본문 줄 분리에 필요해 보존하지만, sanitizeLine 에서는 공백으로 치환한다
// (description 한 줄 안에 들어온 LF 를 제거해 제목·항목 라인이 깨지지 않게 함).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x09\x0B-\x1F\x7F]/g;

export interface GuardedAutoCommitMessage extends AutoCommitMessage {
  /** 가드가 발견한 정책 위반(이모지·영어 전용 summary). 빈 배열이면 위반 없음. */
  readonly warnings: readonly string[];
  /** 본문에서 잘려 나간 bullet 수 합계 — 호출자/테스트가 축약 강도 확인용으로 본다. */
  readonly truncatedBullets: number;
  /** 제목이 72자 초과로 잘렸다면 true. */
  readonly subjectTruncated: boolean;
}

export interface BuildGuardedAutoCommitMessageInput
  extends Omit<BuildAutoCommitMessageInput, 'fallbackMessage'> {
  /** 0건 폴백. 미지정 시 'chore: all agents completed'(server.ts 트리거 규약과 동일). */
  readonly fallbackMessage?: string;
}

function sanitizeLine(value: string): string {
  return (value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(CONTROL_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 이모지만 제거하고 줄/들여쓰기 구조는 그대로 보존한다. 본문(다중 라인) 처리에 사용.
function stripEmojiPreserve(value: string): string {
  return value.replace(EMOJI_REPLACE_RE, '');
}

// 단일 라인용 — 이모지 제거 + 다중 공백 정규화 + trim. 제목/요약에 사용.
function stripEmojiCollapse(value: string): string {
  return stripEmojiPreserve(value).replace(/\s{2,}/g, ' ').trim();
}

function truncateSubject(subject: string): { value: string; truncated: boolean } {
  // 글자 단위(코드 포인트) 로 절단해 surrogate pair 가 깨지지 않게 한다.
  const cps = Array.from(subject);
  if (cps.length <= SUBJECT_MAX_LEN) return { value: subject, truncated: false };
  return { value: cps.slice(0, SUBJECT_MAX_LEN - 1).join('') + ELLIPSIS, truncated: true };
}

function shrinkBody(body: string): { body: string; truncatedBullets: number } {
  if (!body) return { body: '', truncatedBullets: 0 };
  const lines = body.split('\n');
  const out: string[] = [];
  let buffer: string[] = [];
  let truncatedBullets = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    if (buffer.length <= BODY_BULLET_LIMIT) {
      out.push(...buffer);
    } else {
      out.push(...buffer.slice(0, BODY_BULLET_LIMIT));
      const overflow = buffer.length - BODY_BULLET_LIMIT;
      out.push(`  · …외 ${overflow}건`);
      truncatedBullets += overflow;
    }
    buffer = [];
  };

  for (const line of lines) {
    if (line.startsWith('  · ')) {
      buffer.push(line);
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return { body: out.join('\n'), truncatedBullets };
}

function detectWarnings(tasks: readonly CompletedAgentTask[]): string[] {
  const warnings: string[] = [];
  for (const t of tasks) {
    const agent = (t.agent || '').trim() || 'unknown';
    const summary = t.summary || '';
    if (EMOJI_TEST_RE.test(summary)) warnings.push(`emoji-in-summary:${agent}`);
    const trimmed = summary.trim();
    if (trimmed.length > 0 && !HANGUL_RE.test(trimmed)) {
      warnings.push(`english-only-summary:${agent}`);
    }
  }
  return warnings;
}

export function buildGuardedAutoCommitMessage(
  input: BuildGuardedAutoCommitMessageInput,
): GuardedAutoCommitMessage {
  const tasks = input.tasks ?? [];
  const warnings = detectWarnings(tasks);

  // 입력 sanitize: summary 의 줄바꿈/제어문자를 공백화하고 이모지를 제거한 뒤
  // 변경 파일 경로의 공백/이모지도 같은 규칙으로 정리해 buildAutoCommitMessage 에 위임.
  const sanitizedTasks: CompletedAgentTask[] = tasks.map(t => ({
    ...t,
    // summary 와 파일 경로는 모두 단일 라인 — collapse 변형으로 정규화한다.
    summary: stripEmojiCollapse(sanitizeLine(t.summary)),
    changedFiles: t.changedFiles
      .map(f => stripEmojiCollapse(sanitizeLine(f)))
      .filter(f => f.length > 0),
  }));

  const fallback = (input.fallbackMessage ?? DEFAULT_GUARD_FALLBACK).trim() || DEFAULT_GUARD_FALLBACK;
  const built = buildAutoCommitMessage({ tasks: sanitizedTasks, fallbackMessage: fallback });

  // 후처리: 제목은 단일 라인이라 collapse, 본문은 라인/들여쓰기를 보존해야 하므로
  // preserve 변형으로 이모지만 제거한다(들여쓰기 두 칸이 한 칸으로 합쳐지면
  // shrinkBody 의 bullet 인식이 깨진다).
  const subjectClean = stripEmojiCollapse(built.subject);
  const { value: subject, truncated: subjectTruncated } = truncateSubject(subjectClean);
  const { body: shrunk, truncatedBullets } = shrinkBody(stripEmojiPreserve(built.body));
  const full = shrunk ? `${subject}\n\n${shrunk}` : subject;

  return {
    subject,
    body: shrunk,
    full,
    warnings,
    truncatedBullets,
    subjectTruncated,
  };
}
