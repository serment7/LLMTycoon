// 지시 #dee6ec06 — 다중 에이전트 완료 집계용 자동 커밋 메시지 빌더.
//
// 배경
//   `server.ts` 의 "전원 idle 수렴" 자동 커밋(#a7b258fb) 은 현재 고정 문구
//   `chore: all agents completed` 를 사용한다. 어떤 에이전트가 무엇을 끝냈고
//   어느 파일이 바뀌었는지가 메시지에 남지 않아, 회고/리뷰 단계에서
//   `git log --stat` 로 본문을 다시 짜야 했다.
//
//   본 모듈은 "완료된 태스크 N건 + 변경 파일 매핑" 을 입력으로 받아
//   `chore: N agents completed` 같은 단일 라인 제목과, 에이전트별 항목과
//   변경 파일을 본문에 누락 없이 넣은 다중 라인 메시지를 생성한다.
//
// 결정 규칙(우선순위 순)
//   1) `tasks.length === 0` — 변경이 없으면 폴백 `"chore: no changes"` 만 반환.
//   2) `tasks.length === 1` — 기존 `buildTaskBoundaryCommitMessage` 와 같은
//      `"{type}: {summary}"` 한 줄을 반환(본문 없음). type 은 task 의 type
//      필드 → description 접두어 → 변경 파일 경로 추론 순으로 결정한다.
//   3) `tasks.length >= 2` — 제목은 `"chore: N agents completed"`, 본문은
//      에이전트별 항목 N줄 + 각 항목 아래 변경 파일을 들여쓴 목록.
//      에이전트는 입력 순서를 보존(불안정 정렬 금지) — 호출자가 정한 시간
//      순서가 곧 본문의 순서가 된다.
//
//   모든 판단은 순수 함수이며 외부 I/O 가 없다 — 동일 입력에 동일 출력을 보장.

import {
  buildTaskBoundaryCommitMessage,
  inferCommitTypeFromPaths,
  normalizeSummary,
} from './commitMessageTemplate';

export interface CompletedAgentTask {
  /** 에이전트 식별 이름(표시용). 빈 문자열이면 `unknown` 으로 치환. */
  readonly agent: string;
  /** 태스크 한 줄 요약(원문). description 또는 사용자 입력 그대로. */
  readonly summary: string;
  /** 변경된 파일 경로 목록(워크스페이스 루트 상대). */
  readonly changedFiles: readonly string[];
  /**
   * 선택 — Conventional Commits type 을 호출자가 직접 강제할 때만 지정.
   * 미지정이면 summary 의 `"type:"` 접두어 → 변경 파일 경로 추론 순으로 결정.
   */
  readonly type?: string;
}

export interface BuildAutoCommitMessageInput {
  readonly tasks: readonly CompletedAgentTask[];
  /** 0건 폴백 메시지(기본 `"chore: no changes"`). */
  readonly fallbackMessage?: string;
}

const DEFAULT_FALLBACK = 'chore: no changes';

/** "user" 영역에서 들어온 에이전트 표시 이름을 안전하게 정규화. */
function normalizeAgent(name: string): string {
  const trimmed = (name ?? '').replace(/\s+/g, ' ').trim();
  return trimmed || 'unknown';
}

/** 변경 파일 경로를 한 줄 표시용으로 통일(역슬래시 → 슬래시, 공백 정규화). */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
}

/** 단일 태스크의 type 결정 — 명시 type → summary 접두어 → 경로 추론. */
function resolveType(task: CompletedAgentTask): string {
  if (task.type && task.type.trim()) return task.type.trim().toLowerCase();
  const m = task.summary.match(/^([a-zA-Z]+)\s*:\s*/);
  if (m) return m[1].toLowerCase();
  return inferCommitTypeFromPaths(task.changedFiles);
}

/** summary 에 type 접두어가 있으면 본문만 잘라내 반환. */
function stripTypePrefix(summary: string): string {
  return summary.replace(/^[a-zA-Z]+\s*:\s*/, '');
}

/**
 * 단일 태스크용 짧은 메시지(제목 한 줄, 본문 없음). 다중 태스크 본문에서도
 * 항목 줄로 재사용한다.
 */
function buildSingleSubject(task: CompletedAgentTask): string {
  return buildTaskBoundaryCommitMessage({
    description: task.summary,
    changedFiles: task.changedFiles,
  });
}

/**
 * 다중 태스크 본문 — 에이전트별 항목 + 변경 파일 들여쓰기.
 * 형식 예:
 *   - Kai (test): tokenUsage.spec.ts 회귀 추가
 *     · spec/llm/tokenUsage.spec.ts
 *     · src/llm/promptCache.ts
 *   - Developer (feat): autoCommit 빌더 도입
 *     · src/server/autoCommitMessage.ts
 *
 * 변경 파일이 없는 항목은 "(파일 변경 없음)" 한 줄을 들여 써 누락임을 명시한다.
 */
function buildMultiBody(tasks: readonly CompletedAgentTask[]): string {
  const lines: string[] = [];
  for (const task of tasks) {
    const agent = normalizeAgent(task.agent);
    const type = resolveType(task);
    const summary = normalizeSummary(stripTypePrefix(task.summary)) || 'update';
    lines.push(`- ${agent} (${type}): ${summary}`);
    const files = task.changedFiles.map(normalizePath).filter(Boolean);
    if (files.length === 0) {
      lines.push('  · (파일 변경 없음)');
    } else {
      for (const f of files) lines.push(`  · ${f}`);
    }
  }
  return lines.join('\n');
}

export interface AutoCommitMessage {
  /** 첫 줄(제목). git commit -m 단일 인자로 그대로 사용 가능. */
  readonly subject: string;
  /** 두 번째 줄 이후 본문. 비어 있을 수 있음. */
  readonly body: string;
  /** subject + 빈 줄 + body 를 한 문자열로 연결한 결과. body 가 비면 subject 만. */
  readonly full: string;
}

export function buildAutoCommitMessage(input: BuildAutoCommitMessageInput): AutoCommitMessage {
  const tasks = input.tasks ?? [];
  const fallback = (input.fallbackMessage ?? DEFAULT_FALLBACK).trim() || DEFAULT_FALLBACK;

  if (tasks.length === 0) {
    return { subject: fallback, body: '', full: fallback };
  }

  if (tasks.length === 1) {
    const subject = buildSingleSubject(tasks[0]);
    return { subject, body: '', full: subject };
  }

  const subject = `chore: ${tasks.length} agents completed`;
  const body = buildMultiBody(tasks);
  const full = body ? `${subject}\n\n${body}` : subject;
  return { subject, body, full };
}

/**
 * 디버그/검증 용 — 메시지에 등장한 에이전트와 파일 경로를 추출해 호출자가 빠짐없이
 * 들어갔는지 직접 비교할 수 있게 한다. 회귀 테스트 시나리오 (3)·(4) 가 본 함수를
 * 사용해 메시지 매핑 정확성을 확인한다.
 */
export function extractCommitMessageMapping(message: string): {
  readonly agents: readonly string[];
  readonly files: readonly string[];
} {
  const agents: string[] = [];
  const files: string[] = [];
  const lines = message.split(/\r?\n/);
  for (const line of lines) {
    const agentMatch = line.match(/^-\s+([^()]+?)\s+\(/);
    if (agentMatch) agents.push(agentMatch[1].trim());
    const fileMatch = line.match(/^\s{2}·\s+(.+)$/);
    if (fileMatch && !/파일 변경 없음/.test(fileMatch[1])) {
      files.push(fileMatch[1].trim());
    }
  }
  return { agents, files };
}
