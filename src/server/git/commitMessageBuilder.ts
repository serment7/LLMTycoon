// 지시 #f907fb65 — "전원 idle 수렴" 자동 커밋 메시지를 실제 작업 내역이 드러나는
// 형태로 직렬화한다.
//
// 배경
//   server.ts::allAgentsCompletedWatcher 가 매번 고정 문구 `chore: all agents completed`
//   를 사용해 회고/리뷰 단계에서 어떤 에이전트가 무엇을 마쳤는지 한눈에 보이지 않았다.
//   기존 `src/server/autoCommitMessage.ts` 빌더는 단일 태스크 경로에 최적화돼 있고,
//   다중 태스크 경로에서도 "에이전트별 항목 + 변경 파일" 만 본문에 누적할 뿐 길이
//   상한·파일 축약 규칙을 강제하지 않는다.
//
//   본 모듈은 "에이전트 description 요약 + 워크스페이스 통합 변경 파일" 을 입력으로
//   받아 다음 규약을 단일 출처로 강제한다(우선순위 순):
//     1) 제목 최대 72자, 본문 라인당 최대 100자
//     2) 이모지 금지 — 입력에 섞여 들어오면 제거
//     3) 한국어 본문 허용(글자 수 산정은 String.length 기반)
//     4) 변경 파일이 5건 초과면 상위 5개만 노출하고 나머지는 `...외 N건`
//     5) description 의 본문만 사용 — 에이전트 응답 원문 전체를 그대로 받지 않는다
//        (호출자가 description 필드만 추려 넘기는 계약을 가진다 = 토큰 절약)
//
//   모든 판단은 순수 함수다. I/O 가 없으므로 단위 테스트가 jsdom 없이 동작한다.

export interface CompletedAgentTask {
  /** 에이전트 표시 이름. 빈 문자열·공백 전용은 'unknown' 으로 정규화. */
  readonly agent: string;
  /** 태스크 description 요약(원문). 토큰 절약 목적상 응답 본문은 받지 않는다. */
  readonly description: string;
  /**
   * 선택 — Conventional Commits type(feat/fix/...) 을 호출자가 강제할 때만 지정.
   * 지정되지 않으면 description 의 `"type:"` 접두어 → 기본 'chore' 폴백.
   */
  readonly type?: string;
}

export interface BuildAgentsCompletedCommitMessageInput {
  /** 직전 턴에 완료된 에이전트 태스크 목록. 입력 순서가 본문 순서로 보존된다. */
  readonly tasks: readonly CompletedAgentTask[];
  /** 워크스페이스 전체에서 staged/unstaged 변경된 파일 경로(통합). */
  readonly changedFiles: readonly string[];
  /** 0건 폴백 제목(기본 `chore: 변경 없음`). */
  readonly fallback?: string;
}

export interface AgentsCompletedCommitMessage {
  /** 첫 줄 — `git commit -m` 단일 인자로 사용 가능. 항상 ≤ 72자. */
  readonly subject: string;
  /** 두 번째 줄 이후 본문(개행 포함). 비어 있을 수 있다. 라인당 ≤ 100자. */
  readonly body: string;
  /** subject + 빈 줄 + body. body 가 비면 subject 만. */
  readonly full: string;
}

export const SUBJECT_MAX_LEN = 72;
export const BODY_LINE_MAX_LEN = 100;
const FILES_VISIBLE_MAX = 5;
const DEFAULT_FALLBACK = 'chore: 변경 없음';

/**
 * 이모지·기타 표시 폭이 큰 문자(BMP 외 확장 영역, 변형 셀렉터, ZWJ)를 제거한다.
 * 한글·CJK·라틴 알파벳·숫자·일반 문장부호는 그대로 둔다. 입력에 섞여 들어와도
 * 커밋 본문이 깨지지 않도록 호출자가 신경 쓰지 않게 한다.
 */
function stripEmojis(s: string): string {
  if (!s) return '';
  // 가장 흔한 이모지 영역(Emoji_Presentation 코드 포인트 다수)을 정규식으로 처리.
  // 한국어 문자(U+AC00–U+D7A3)·한자(U+4E00–U+9FFF)는 보존된다.
  return s
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 표시용 에이전트 이름 정규화 — 공백 압축, 빈 입력은 'unknown'. */
function normalizeAgent(name: string): string {
  const cleaned = stripEmojis((name ?? '').toString());
  return cleaned || 'unknown';
}

/** description 에서 `"type: 본문"` 의 본문만 추출(매치 실패 시 원문 반환). */
function stripTypePrefix(description: string): string {
  return description.replace(/^[a-zA-Z]+\s*:\s*/, '');
}

/** description 에서 type 접두어를 추출(없으면 undefined). */
function extractTypePrefix(description: string): string | undefined {
  const m = description.match(/^([a-zA-Z]+)\s*:\s*/);
  return m ? m[1].toLowerCase() : undefined;
}

/** 단일 태스크 description 을 한 줄 요약으로 정규화. 빈 입력은 'update'. */
function summarize(description: string): string {
  const cleaned = stripEmojis(stripTypePrefix(description ?? ''));
  return cleaned || 'update';
}

/**
 * 길이 상한을 강제. 길면 단어 경계에서 자르고 `…` 한 글자를 덧붙여 마감한다.
 * `…` 는 이모지가 아닌 일반 구두점(U+2026) 이라 규약 위반이 아니다. 단어 경계가
 * 너무 앞이면(전체 길이의 절반 미만) 하드 컷으로 폴백.
 */
function clampLine(line: string, max: number): string {
  if (line.length <= max) return line;
  const sliced = line.slice(0, max - 1);
  const lastSpace = sliced.lastIndexOf(' ');
  const head = lastSpace > Math.floor(max / 2) ? sliced.slice(0, lastSpace) : sliced;
  return `${head}…`;
}

/** 변경 파일 경로 표기 통일(역슬래시 → 슬래시, 공백 정규화, 이모지 제거). */
function normalizePath(p: string): string {
  const cleaned = stripEmojis((p ?? '').replace(/\\/g, '/'));
  return cleaned;
}

/**
 * 다중 태스크의 핵심 변경 요약. 첫 번째 태스크의 description 본문을 우선 사용하고,
 * 길이 상한을 넘으면 `clampLine` 이 자동 컷한다. 호출자가 미리 추린 description
 * 만 받아 토큰 비용을 추가로 늘리지 않는다.
 */
function buildSubject(tasks: readonly CompletedAgentTask[]): string {
  if (tasks.length === 1) {
    const t = tasks[0];
    const agent = normalizeAgent(t.agent);
    const summary = summarize(t.description);
    return clampLine(`chore(agents): ${agent} ${summary}`, SUBJECT_MAX_LEN);
  }
  // 2건 이상 — 대표 에이전트 1~2명 + 인원수 + 첫 태스크 요약.
  const heads = Array.from(new Set(tasks.map(t => normalizeAgent(t.agent)))).slice(0, 2);
  const total = new Set(tasks.map(t => normalizeAgent(t.agent))).size;
  const headLabel = heads.join(', ');
  const tail = total > heads.length ? ` 외 ${total - heads.length}명` : '';
  const lead = summarize(tasks[0].description);
  return clampLine(`chore(agents): ${headLabel}${tail} — ${lead}`, SUBJECT_MAX_LEN);
}

/**
 * 본문 — 에이전트별 한 줄(들여쓰기 없음) + "변경 파일" 섹션. 각 줄을 100자에서 자른다.
 * tasks 가 1건이면 본문은 비운다(제목만으로 충분).
 */
function buildBody(
  tasks: readonly CompletedAgentTask[],
  changedFiles: readonly string[],
): string {
  const lines: string[] = [];
  if (tasks.length >= 2) {
    for (const t of tasks) {
      const agent = normalizeAgent(t.agent);
      const summary = summarize(t.description);
      lines.push(clampLine(`- ${agent}: ${summary}`, BODY_LINE_MAX_LEN));
    }
  }
  const files = changedFiles
    .map(normalizePath)
    .filter(Boolean)
    // 동일 경로 중복 제거(스테이지·미스테이지 양쪽에서 잡힌 경우).
    .filter((p, i, arr) => arr.indexOf(p) === i);
  if (files.length > 0) {
    if (lines.length > 0) lines.push('');
    const total = files.length;
    const visible = files.slice(0, FILES_VISIBLE_MAX);
    lines.push(`변경 파일 (총 ${total}건${total > FILES_VISIBLE_MAX ? `, 상위 ${FILES_VISIBLE_MAX}` : ''}):`);
    for (const f of visible) {
      lines.push(clampLine(`  - ${f}`, BODY_LINE_MAX_LEN));
    }
    if (total > FILES_VISIBLE_MAX) {
      lines.push(`  ...외 ${total - FILES_VISIBLE_MAX}건`);
    }
  }
  return lines.join('\n');
}

/**
 * 자동 커밋 메시지 — 입력 정규화 → 제목 → 본문 → full 결합. 모든 길이 상한과 이모지
 * 제거가 본 함수 한 곳에서 일어나, 호출자는 타입 안전한 결과를 그대로 git 에 흘릴 수
 * 있다. tasks 가 0건이면 fallback 만 돌려준다.
 */
export function buildAgentsCompletedCommitMessage(
  input: BuildAgentsCompletedCommitMessageInput,
): AgentsCompletedCommitMessage {
  const tasks = (input.tasks ?? []).filter(t => t && (t.description ?? '').trim());
  const fallbackRaw = (input.fallback ?? DEFAULT_FALLBACK).trim() || DEFAULT_FALLBACK;
  const fallback = clampLine(stripEmojis(fallbackRaw), SUBJECT_MAX_LEN);
  if (tasks.length === 0) {
    return { subject: fallback, body: '', full: fallback };
  }
  const subject = buildSubject(tasks);
  const body = buildBody(tasks, input.changedFiles ?? []);
  const full = body ? `${subject}\n\n${body}` : subject;
  return { subject, body, full };
}

/**
 * 호출자가 description 외에 type 접두어 후보를 미리 골라 넘기고 싶을 때 쓰는 헬퍼.
 * 다수결로 type 을 결정하지만 본 빌더는 항상 `chore(agents)` scope 를 강제하므로
 * 결과는 메시지 헤더가 아닌 호출자 측 메타 로깅에 활용된다.
 */
export function dominantType(tasks: readonly CompletedAgentTask[]): string {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    const explicit = (t.type ?? '').trim().toLowerCase();
    const fromDesc = extractTypePrefix(t.description ?? '');
    const type = explicit || fromDesc || 'chore';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  let best = 'chore';
  let bestCount = 0;
  for (const [k, v] of counts) {
    if (v > bestCount) {
      best = k;
      bestCount = v;
    }
  }
  return best;
}
