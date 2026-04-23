import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import {
  collectNaturalLanguageSample,
  isMostlyKorean,
  koreanRatio,
  DEFAULT_KOREAN_THRESHOLD,
} from '../utils/koreanRatio';
import {
  createImprovementReport,
  type ImprovementReport,
  type ImprovementReportCategory,
} from '../utils/leaderMessage';
import { emitUsageFromStreamJson } from './claudeClient';
import type {
  ClaudeSessionStatus,
  CommitStrategy,
  MediaAsset,
  MediaTimelineEvent,
  TaskBoundaryCommitConfig,
} from '../types';
import { DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG, mediaAssetToTimelineEvent } from '../types';
import { parseMediaToolRequests, type MediaToolName, type MediaToolRequest } from './prompts';
// LLM 프로바이더 추상화(#llm-provider-abstraction):
//   LocalAgentWorker 는 Ollama/vLLM 프로바이더에서 AgentWorker 와 동일한 public
//   API(AgentSession) 를 제공한다. AgentWorker 자체도 이 인터페이스를 만족하도록
//   implements 표기를 단다.
import { chatLoop, type ChatTransport } from './llm/local-chat';
import { OllamaTransport } from './llm/ollama-transport';
import { VllmTransport } from './llm/vllm-transport';
import { getToolDefinitions } from './llm/tools-adapter';
import { readLLMEnv, type LLMMessage, type AgentSession } from './llm/provider';

// ────────────────────────────────────────────────────────────────────────────
// MediaAsset → CollabTimeline 로그 브리지 (#b425328e §3)
// 에이전트 결과 파이프라인이 MediaAsset 을 만들어 내면(현재는 server.ts 의
// /api/media/generate 성공 경로가 직접 호출) `mediaAssetToTimelineEvent` 로
// 변환해 등록된 emitter 로 흘려 보낸다. CollabTimeline 또는 다른 관측자가
// `setMediaTimelineEmitter` 로 싱크를 꽂으면 된다.
// ────────────────────────────────────────────────────────────────────────────

export type MediaTimelineEmitter = (event: MediaTimelineEvent) => void;

let mediaTimelineEmitter: MediaTimelineEmitter | null = null;

export function setMediaTimelineEmitter(emitter: MediaTimelineEmitter | null): void {
  mediaTimelineEmitter = emitter;
}

/**
 * 에이전트(또는 에이전트를 대리하는 서버 경로) 가 MediaAsset 을 생성했을 때
 * 호출한다. 등록된 emitter 가 있으면 TimelineEvent 로 변환해 방출하고, 없으면
 * 조용히 무시한다(훅이 아직 연결되지 않은 초기 상태에서도 서버 경로가 안전).
 */
export function notifyAgentMediaGenerated(
  asset: MediaAsset,
  meta?: { from?: string; to?: string; reason?: 'generated' | 'queued-exhausted' },
): MediaTimelineEvent | null {
  if (!mediaTimelineEmitter) return null;
  const event = mediaAssetToTimelineEvent(asset, meta);
  try { mediaTimelineEmitter(event); } catch { /* emitter 예외는 파이프라인에 영향 주지 않는다 */ }
  return event;
}

/** 테스트 전용 — 싱크를 완전히 초기화. */
export function resetMediaTimelineEmitter(): void {
  mediaTimelineEmitter = null;
}

// ────────────────────────────────────────────────────────────────────────────
// 태스크 경계 커밋 훅 (#f3c0ea52)
// 에이전트가 `update_status='done'` 으로 태스크를 완료 보고하는 순간, 서버(또는
// taskRunner) 가 `notifyTaskBoundary(...)` 를 호출해 본 모듈에 "경계 이벤트" 를
// 전달한다. 본 모듈은 설정(`TaskBoundaryCommitConfig.commitStrategy`) 과 현재
// 세션 상태를 보고 3가지 결정을 내린다:
//   1) `commitStrategy === 'manual'`  → 훅이 작동하지 않는다(자동 커밋 억제).
//   2) `sessionStatus === 'exhausted' && queueOnExhausted`
//        → 실제 git 호출을 차단하고 큐에만 보관한다. 세션이 'active' 로 돌아오면
//          호출자가 `flushQueuedTaskBoundaries()` 로 되감아 처리한다.
//   3) 그 외 → 등록된 핸들러(서버 측 `mcp__llm-tycoon__trigger_git_automation`
//              어댑터)에게 이벤트를 바로 전달한다.
//
// 본 모듈은 실제 git 명령을 직접 실행하지 않는다 — 그것은 호출자(server.ts 또는
// taskRunner) 의 책임이다. 이 분리 덕분에 테스트는 핸들러를 스파이로 주입해 훅
// 흐름만 검증할 수 있다.
// ────────────────────────────────────────────────────────────────────────────

export interface TaskBoundaryEvent {
  taskId: string;
  agentId: string;
  projectId: string;
  /** 태스크 설명 원문. commitMessageTemplate 가 type 추론에 사용. */
  description?: string;
  /** 이 태스크 범위에서 stage 된 파일 목록(상대경로). 비어 있으면 스킵 신호. */
  changedFiles?: readonly string[];
  /** 이벤트 발생 시각(ISO 8601). 지정 안 하면 now 로 채운다. */
  at?: string;
}

export type TaskBoundaryHandler = (
  event: TaskBoundaryEvent,
  meta: { strategy: CommitStrategy; reason: 'immediate' | 'flush' },
) => void | Promise<void>;

let taskBoundaryHandler: TaskBoundaryHandler | null = null;
// 세션 exhausted 동안 쌓이는 FIFO 큐. 호출자가 flush 를 부를 때까지 순서 보존.
const queuedTaskBoundaries: Array<{ event: TaskBoundaryEvent; strategy: CommitStrategy }> = [];

export function setTaskBoundaryHandler(handler: TaskBoundaryHandler | null): void {
  taskBoundaryHandler = handler;
}

/** 테스트 전용 — 핸들러·큐를 완전히 초기화. */
export function resetTaskBoundaryHandler(): void {
  taskBoundaryHandler = null;
  queuedTaskBoundaries.length = 0;
}

/** 현재 큐 길이(테스트·디버그 용). */
export function getQueuedTaskBoundaryCount(): number {
  return queuedTaskBoundaries.length;
}

/**
 * 태스크 경계 이벤트를 본 모듈에 알린다. 반환값은 실제 처리가 일어났는지 나타
 * 내는 문자열 상태로, 테스트가 큐잉/즉시/스킵 분기를 구분할 때 쓴다.
 */
export function notifyTaskBoundary(
  event: TaskBoundaryEvent,
  config: TaskBoundaryCommitConfig = DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG,
): 'skipped-manual' | 'skipped-no-changes' | 'queued-exhausted' | 'dispatched' | 'no-handler' {
  // 수동 모드: 자동 커밋을 완전히 억제.
  if (config.commitStrategy === 'manual') return 'skipped-manual';
  // 변경 없음: 빈 커밋 방지(지시 §1 "stage 된 변경이 있는지 확인").
  if (!event.changedFiles || event.changedFiles.length === 0) return 'skipped-no-changes';
  // 세션 소진: Joker 폴백 연동(지시 §4). 큐에 넣고 실제 호출은 보류.
  if (currentSessionStatus === 'exhausted') {
    queuedTaskBoundaries.push({ event, strategy: config.commitStrategy });
    return 'queued-exhausted';
  }
  // 정상 경로: 핸들러에 전달. 핸들러가 mcp__llm-tycoon__trigger_git_automation 을
  // 호출해 실제 커밋·푸시·PR 을 수행한다.
  if (!taskBoundaryHandler) return 'no-handler';
  try {
    const res = taskBoundaryHandler(event, { strategy: config.commitStrategy, reason: 'immediate' });
    if (res && typeof (res as Promise<void>).catch === 'function') {
      (res as Promise<void>).catch(err => {
        if (DEBUG_GIT_AUTO) console.warn('[task-boundary] handler rejected:', (err as Error).message);
      });
    }
  } catch (err) {
    if (DEBUG_GIT_AUTO) console.warn('[task-boundary] handler threw:', (err as Error).message);
  }
  return 'dispatched';
}

/**
 * 세션이 active 로 돌아왔을 때 큐에 쌓인 태스크 경계 이벤트를 FIFO 순으로
 * 핸들러에 흘려 보낸다. 돌려주는 값은 실제로 디스패치된 이벤트 개수.
 */
export function flushQueuedTaskBoundaries(): number {
  if (currentSessionStatus === 'exhausted') return 0;
  if (!taskBoundaryHandler) { queuedTaskBoundaries.length = 0; return 0; }
  let n = 0;
  while (queuedTaskBoundaries.length > 0) {
    const item = queuedTaskBoundaries.shift()!;
    try {
      taskBoundaryHandler(item.event, { strategy: item.strategy, reason: 'flush' });
      n += 1;
    } catch (err) {
      if (DEBUG_GIT_AUTO) console.warn('[task-boundary] flush handler threw:', (err as Error).message);
    }
  }
  return n;
}

// ────────────────────────────────────────────────────────────────────────────
// 매체 도구 디스패처 (#bc9843bb)
// 에이전트가 응답 본문에 `{"tool":"generate_pdf|pptx|video", "input":{...}}` JSON
// 블록을 남기면, 본 모듈이 `parseMediaToolRequests` 로 추출해 주입된 핸들러에
// 전달한다. 핸들러는 `mediaGenerator` 의 대응 메서드를 호출하고 MediaAsset 을
// 돌려 준다. 본 모듈은 mediaGenerator 를 직접 import 하지 않는다 — 핸들러 주입
// 패턴으로 분리해 테스트가 스파이만 꽂으면 전체 경로를 검증할 수 있게 한다.
//
// 세션 소진(exhausted) 정책:
//   · 호출 자체가 큐잉되고, 빈 MediaAsset 스텁을 사용해 `mediaAssetToTimelineEvent`
//     를 `reason='queued-exhausted'` 로 생성해 타임라인에 즉시 기록한다(사용자에게
//     "토큰이 없어 대기 중" 을 보여주기 위함).
//   · 세션이 'active' 로 복귀하면 호출자가 `flushQueuedMediaToolRequests()` 로 되감는다.
// ────────────────────────────────────────────────────────────────────────────

export interface MediaToolDispatchContext {
  agentId: string;
  projectId: string;
  taskId?: string;
}

export interface MediaToolDispatchOutcome {
  request: MediaToolRequest;
  result: 'dispatched' | 'queued-exhausted' | 'no-handler' | 'error';
  asset?: MediaAsset;
  event?: MediaTimelineEvent;
  error?: string;
}

export type MediaToolHandler = (
  request: MediaToolRequest,
  context: MediaToolDispatchContext,
) => Promise<MediaAsset>;

let mediaToolHandler: MediaToolHandler | null = null;
// 세션 소진 중 큐잉된 요청 FIFO. flush 호출 시 순서 보존.
const queuedMediaToolRequests: Array<{ request: MediaToolRequest; context: MediaToolDispatchContext }> = [];

export function setMediaToolHandler(handler: MediaToolHandler | null): void {
  mediaToolHandler = handler;
}

/** 테스트 전용 — 핸들러·큐를 완전히 초기화. */
export function resetMediaToolHandler(): void {
  mediaToolHandler = null;
  queuedMediaToolRequests.length = 0;
}

export function getQueuedMediaToolRequestCount(): number {
  return queuedMediaToolRequests.length;
}

/**
 * 에이전트 응답 텍스트에서 매체 도구 요청을 모두 추출해 순서대로 처리한다.
 * 각 요청의 처리 결과를 `MediaToolDispatchOutcome` 배열로 돌려주므로 서버 라우트
 * 또는 테스트가 그대로 소켓 브로드캐스트·회귀 검증에 쓸 수 있다.
 */
export async function dispatchAgentToolUses(
  text: string,
  context: MediaToolDispatchContext,
): Promise<MediaToolDispatchOutcome[]> {
  const requests = parseMediaToolRequests(text);
  if (requests.length === 0) return [];
  const outcomes: MediaToolDispatchOutcome[] = [];
  for (const request of requests) {
    // 세션 소진: 실제 실행 차단, 큐잉 + 타임라인에 "토큰 소진" 으로 기록.
    if (currentSessionStatus === 'exhausted') {
      queuedMediaToolRequests.push({ request, context });
      const placeholder = makeQueuedPlaceholderAsset(request, context);
      const event = mediaAssetToTimelineEvent(placeholder, {
        from: context.agentId,
        reason: 'queued-exhausted',
      });
      if (mediaTimelineEmitter) {
        try { mediaTimelineEmitter(event); } catch { /* emitter 예외는 흐름에 영향 없음 */ }
      }
      outcomes.push({ request, result: 'queued-exhausted', event });
      continue;
    }
    // 정상 경로: 핸들러 호출 → MediaAsset → 타임라인 이벤트 방출.
    if (!mediaToolHandler) {
      outcomes.push({ request, result: 'no-handler' });
      continue;
    }
    try {
      const asset = await mediaToolHandler(request, context);
      const event = notifyAgentMediaGenerated(asset, {
        from: context.agentId,
        reason: 'generated',
      });
      outcomes.push({ request, result: 'dispatched', asset, event: event ?? undefined });
    } catch (err) {
      outcomes.push({ request, result: 'error', error: (err as Error).message });
    }
  }
  return outcomes;
}

/**
 * 세션 복구 후 큐잉된 도구 요청을 순서대로 재실행한다. 돌려주는 배열은 실제로
 * 핸들러가 실행된 결과(= dispatched / error) 만 포함한다.
 */
export async function flushQueuedMediaToolRequests(): Promise<MediaToolDispatchOutcome[]> {
  if (currentSessionStatus === 'exhausted') return [];
  if (!mediaToolHandler) { queuedMediaToolRequests.length = 0; return []; }
  const results: MediaToolDispatchOutcome[] = [];
  while (queuedMediaToolRequests.length > 0) {
    const item = queuedMediaToolRequests.shift()!;
    try {
      const asset = await mediaToolHandler(item.request, item.context);
      const event = notifyAgentMediaGenerated(asset, {
        from: item.context.agentId,
        reason: 'generated',
      });
      results.push({ request: item.request, result: 'dispatched', asset, event: event ?? undefined });
    } catch (err) {
      results.push({ request: item.request, result: 'error', error: (err as Error).message });
    }
  }
  return results;
}

/**
 * 세션 소진 중에 큐잉된 요청을 타임라인에 즉시 "대기" 로 보여주기 위한 placeholder
 * MediaAsset 을 만든다. 실제 파일이 아닌 표시용 메타이며, 본 asset id 는 `queued-`
 * 접두로 실 자산 id 와 구분된다.
 */
function makeQueuedPlaceholderAsset(
  request: MediaToolRequest,
  context: MediaToolDispatchContext,
): MediaAsset {
  const kind: MediaAsset['kind'] =
    request.tool === 'generate_pdf' ? 'pdf'
    : request.tool === 'generate_pptx' ? 'pptx'
    : 'video';
  const promptSeed = typeof request.input.prompt === 'string'
    ? request.input.prompt
    : typeof request.input.title === 'string'
      ? request.input.title
      : request.tool;
  return {
    id: `queued-${request.tool}-${Date.now()}`,
    projectId: context.projectId,
    kind,
    name: `${mediaToolNameToShort(request.tool)}-queued.${kind}`,
    mimeType: kind === 'pdf' ? 'application/pdf' : kind === 'pptx' ? 'application/vnd.ms-pptx' : 'video/mp4',
    sizeBytes: 0,
    createdAt: new Date().toISOString(),
    generatedBy: { adapter: `${request.tool}-queued`, prompt: promptSeed },
  };
}

function mediaToolNameToShort(name: MediaToolName): string {
  if (name === 'generate_pdf') return 'pdf';
  if (name === 'generate_pptx') return 'pptx';
  return 'video';
}

// 에이전트 1명 = 상시 실행되는 Claude CLI 자식 프로세스 1개.
// stdin/stdout 을 line-delimited stream-json 으로 유지하여 "유저 턴"을 큐잉으로
// 흘려 넣고, 결과 이벤트(result)가 올 때까지 다음 턴을 대기시킨다. 프로세스가
// 동일 세션을 이어가므로 이전 지시 맥락이 자연스럽게 누적된다.
//
// - crash 시: 진행 중이던 아이템은 에러 반환, 큐에 남은 아이템은 새 프로세스
//   spawn 해서 계속 처리. 단, 재spawn 은 새 세션이므로 이전 맥락은 끊긴다.
// - dispose 시: stdin close + SIGTERM. 큐/진행 중 아이템은 모두 에러 반환.

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DEBUG_CLAUDE = process.env.DEBUG_CLAUDE === '1';
// Git 자동화 트리거 경로 전용 디버그 스위치. 워커 → taskRunner → executeGitAutomation
// 흐름 중 어디서 누락됐는지 재현 로그로 좁혀 볼 때 켠다. 기본 OFF 이며 운영 노이즈
// 를 만들지 않는다.
const DEBUG_GIT_AUTO = process.env.DEBUG_GIT_AUTO === '1';
const DEFAULT_PORT = parseInt(process.env.PORT || '3000', 10);

// 디자이너: 워커에서 throw 되는 Error 메시지는 AgentStatusPanel 의 실패 단계 라벨,
// 로그 패널, 토스트에 그대로 노출될 수 있다. 한국어 UI 에 영어가 섞이지 않도록
// 사용자 가시 에러는 한국어 문자열로 단일 관리한다. 접두어는 서버 로그와 구분이
// 쉽도록 "[워커]" 로 통일하고, 디버깅용 메타데이터(code/stderr)는 본문 말미에 붙인다.
const WORKER_ERROR = {
  disposed: '[워커] 워커가 종료되어 처리가 중단되었습니다',
  spawnFailed: '[워커] Claude 워커 프로세스를 기동하지 못했습니다',
  repeatedFailure: '[워커] 연속 실패가 반복되어 워커 기동을 중단했습니다',
} as const;

// 디자이너: 워커 자식 프로세스가 비정상 종료됐을 때의 에러 본문. stderr 는 최근 300자만
// 보존해 상세는 개발자 로그에 남기고, 사용자 UI 에는 한 줄 요약으로 떨어진다.
function formatChildExitMessage(code: number, stderr: string): string {
  const tail = stderr.trim().slice(-300);
  const suffix = tail ? ` · stderr: ${tail}` : '';
  return `[워커] 자식 프로세스가 종료되었습니다 (code=${code})${suffix}`;
}

// ────────────────────────────────────────────────────────────────────────────
// 세션 폴백 가드(#cdaaabf3)
//
// server.ts 가 `claudeSessionStatus` 를 exhausted 로 전이시키면 `setAgentWorkerSessionStatus`
// 를 호출해 본 모듈의 플래그도 함께 세팅한다. 이 이후 도착하는 `enqueue` 는 즉시
// 거부되어 신규 태스크 디스패치가 중단되고, 이미 큐에 쌓인 항목은 그대로 드레인된다.
// 테스트는 `getAgentWorkerSessionStatus()` 로 현재 값을 관찰할 수 있다.
// ────────────────────────────────────────────────────────────────────────────
let currentSessionStatus: ClaudeSessionStatus = 'active';

export function setAgentWorkerSessionStatus(status: ClaudeSessionStatus): void {
  currentSessionStatus = status;
}

export function getAgentWorkerSessionStatus(): ClaudeSessionStatus {
  return currentSessionStatus;
}

export const WORKER_SESSION_EXHAUSTED_MESSAGE =
  '[워커] 토큰이 소진되어 신규 작업 디스패치를 중단했습니다. 기존 큐만 드레인합니다.';

interface QueueItem {
  prompt: string;
  taskId?: string;
  onResult: (text: string) => void;
  onError: (err: Error) => void;
}

// 태스크 턴이 성공적으로 결과(result.subtype === 'success')를 돌려줄 때 워커가
// 바깥에 노출하는 페이로드 형태. 과거에는 에이전트 본인이 이 정보를 그대로 들고
// Git 자동화 파이프라인을 개시하는 per-agent 트리거 훅의 인자였으나, 리더 단일
// 브랜치 경로로 통합되면서 에이전트 단위 트리거 훅은 제거됐다. 지금은
// reportImprovementToLeader 가 리더 큐로 리포트를 넘길 때 참조하는 데이터 셰이프
// 로만 남아 있다.
export interface TaskCompleteInfo {
  agentId: string;
  projectId: string;
  taskId?: string;
  text: string;
}

// 에이전트가 턴 종료 직후 자체 개선점을 뽑아 리더 큐로 흘려 보낼 때 쓰는 훅.
// taskRunner 는 이 핸들러를 받아 리더 태스크로 재발행한다. 훅이 throw 해도 워커
// 루프는 계속 돌아야 하므로 소비자가 try/catch 로 감싸든 워커 내부에서 감싸든
// 예외가 바깥으로 새어 나가면 안 된다.
export type ImprovementReportHandler = (report: ImprovementReport) => void;

interface WorkerInit {
  agentId: string;
  projectId: string;
  workspacePath: string;
  port?: number;
  systemPrompt?: string;
  // 턴 종료 직후 reportImprovementToLeader 가 리포트를 만들었을 때 호출되는 훅.
  // taskRunner 의 handleImprovementReport 가 이 경로로 리더 큐에 태스크를 투입한다.
  // 리더 단일 브랜치 경로로 통합된 이후에는 Git 자동화 개시도 여기서 파생된 리더
  // 태스크 흐름이 전담하므로, 에이전트 단위 완료 훅은 더 이상 존재하지 않는다.
  onImprovementReport?: ImprovementReportHandler;
}

type WorkerStatus = 'idle' | 'busy';

export class AgentWorker implements AgentSession {
  readonly agentId: string;
  projectId: string;
  workspacePath: string;
  private port: number;
  private systemPrompt?: string;

  private child: ChildProcessWithoutNullStreams | null = null;
  private mcpConfigPath: string | null = null;
  private onImprovementReport?: ImprovementReportHandler;

  private queue: QueueItem[] = [];
  private processing: QueueItem | null = null;

  private stdoutBuf = '';
  private stderrTail = '';
  private currentTurnText: string[] = [];
  private closed = false;

  // 동일 에이전트에 대해 연속 spawn 실패가 이어지면 무한 루프에 빠지지 않도록
  // 백오프를 둔다. 성공적으로 한 턴을 끝내면 reset.
  private consecutiveSpawnFailures = 0;

  constructor(init: WorkerInit) {
    this.agentId = init.agentId;
    this.projectId = init.projectId;
    this.workspacePath = init.workspacePath;
    this.port = init.port ?? DEFAULT_PORT;
    this.systemPrompt = init.systemPrompt;
    this.onImprovementReport = init.onImprovementReport;
  }

  // 개선 보고 훅은 워커 재사용 경로에서 교체 가능해야 한다. ensure() 가 이미
  // 존재하는 워커를 돌려줄 때 이 setter 로 최신 TaskRunner 바인딩을 덮어쓴다.
  setOnImprovementReport(handler: ImprovementReportHandler | undefined) {
    this.onImprovementReport = handler;
  }

  status(): WorkerStatus {
    return this.processing || this.queue.length > 0 ? 'busy' : 'idle';
  }

  queueLength(): number {
    return this.queue.length + (this.processing ? 1 : 0);
  }

  isIdle(): boolean {
    return !this.processing && this.queue.length === 0;
  }

  updateSystemPrompt(next: string | undefined) {
    this.systemPrompt = next;
  }

  // Git 자동화 실패처럼 "에이전트 외부"에서 생긴 오류를 이 워커 컨텍스트에 귀속시켜
  // 기록한다. TaskRunner 가 실패 단계(label)와 stderr 요약을 함께 넘기면 여기서
  // 접두어를 통일해 stderr 로그로 남기고, 가장 최근 한 건은 조회 가능하게 둔다.
  private lastFailureLog: string | null = null;
  logFailure(entry: string): void {
    const clipped = entry.trim().slice(0, 600);
    this.lastFailureLog = clipped;
    console.warn(`[worker:${this.agentId}] git-automation failure: ${clipped}`);
  }
  getLastFailureLog(): string | null {
    return this.lastFailureLog;
  }

  enqueue(prompt: string, taskId?: string): Promise<string> {
    if (this.closed) return Promise.reject(new Error(WORKER_ERROR.disposed));
    // 세션 폴백(#cdaaabf3) — 토큰 소진 이후 도착한 신규 태스크는 즉시 거부한다.
    // 이미 큐에 쌓여 있던 항목은 그대로 드레인되므로 현재 진행 중인 작업은 끊지 않는다.
    if (currentSessionStatus === 'exhausted') {
      return Promise.reject(new Error(WORKER_SESSION_EXHAUSTED_MESSAGE));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, taskId, onResult: resolve, onError: reject });
      this.drain();
    });
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.queue];
    this.queue = [];
    for (const item of pending) item.onError(new Error(WORKER_ERROR.disposed));
    if (this.processing) {
      this.processing.onError(new Error(WORKER_ERROR.disposed));
      this.processing = null;
    }
    this.killChild();
  }

  private writeMcpConfig(): string {
    const tsxBin = path.resolve(
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
    );
    const mcpScript = path.resolve('mcp-agent-server.ts');
    const config = {
      mcpServers: {
        'llm-tycoon': {
          command: tsxBin,
          args: [mcpScript],
          env: {
            API_URL: `http://localhost:${this.port}`,
            AGENT_ID: this.agentId,
            PROJECT_ID: this.projectId,
          },
        },
      },
    };
    const configPath = path.join(
      tmpdir(),
      `claude-mcp-worker-${this.agentId}-${Date.now()}.json`,
    );
    writeFileSync(configPath, JSON.stringify(config), 'utf8');
    return configPath;
  }

  private spawnChild(): boolean {
    if (this.child) return true;
    if (this.closed) return false;
    try {
      mkdirSync(this.workspacePath, { recursive: true });
    } catch (e) {
      console.error(`[worker:${this.agentId}] mkdir failed:`, (e as Error).message);
    }
    try {
      this.mcpConfigPath = this.writeMcpConfig();
    } catch (e) {
      console.error(`[worker:${this.agentId}] mcp config write failed:`, (e as Error).message);
      return false;
    }

    // -p(print) + stream-json I/O 조합이 Claude Code CLI 의 멀티턴 헤드리스 모드.
    // stdin 을 열어둔 채 유저 턴을 여러 개 보낼 수 있고, 각 턴마다 `result` 이벤트가 나온다.
    const args = [
      '-p',
      '--dangerously-skip-permissions',
      '--mcp-config', this.mcpConfigPath,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
    ];
    if (this.systemPrompt) {
      args.push('--append-system-prompt', this.systemPrompt);
    }

    const env: Record<string, string | undefined> = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      LANG: 'en_US.UTF-8',
    };
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    if (DEBUG_CLAUDE) {
      console.log(`[worker:${this.agentId}] spawn`, CLAUDE_BIN, args.map(a => a.length > 80 ? a.slice(0, 80) + '…' : a));
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(CLAUDE_BIN, args, {
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        cwd: this.workspacePath,
      }) as ChildProcessWithoutNullStreams;
    } catch (e) {
      console.error(`[worker:${this.agentId}] spawn threw:`, (e as Error).message);
      this.cleanupMcpConfig();
      return false;
    }

    this.child = child;
    this.stdoutBuf = '';
    this.stderrTail = '';
    this.currentTurnText = [];

    child.stdout.on('data', d => this.handleStdout(d.toString('utf8')));
    child.stderr.on('data', d => {
      const chunk = d.toString('utf8');
      // stderr 는 최근 600자만 유지해 메모리 누수/거대 로그 방지.
      this.stderrTail = (this.stderrTail + chunk).slice(-600);
    });
    child.on('error', err => {
      console.error(`[worker:${this.agentId}] child error:`, err.message);
      this.handleExit(-1);
    });
    child.on('close', code => {
      if (DEBUG_CLAUDE) {
        console.warn(`[worker:${this.agentId}] child closed code=${code} stderr=${this.stderrTail.slice(-200)}`);
      }
      this.handleExit(code ?? -1);
    });

    return true;
  }

  private handleStdout(chunk: string) {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch {
        if (DEBUG_CLAUDE) console.warn(`[worker:${this.agentId}] non-json line: ${line.slice(0, 120)}`);
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: any) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'assistant' && msg.message?.content && Array.isArray(msg.message.content)) {
      for (const c of msg.message.content) {
        if (c?.type === 'text' && typeof c.text === 'string') {
          this.currentTurnText.push(c.text);
        }
      }
      return;
    }
    if (msg.type === 'result') {
      // stream-json 의 result 이벤트에 실려 오는 usage(input/output/cache_* tokens)
      // 를 전역 옵저버로 흘린다. server.ts 가 기동 시 onClaudeUsage(recordClaudeUsage)
      // 를 한 번 구독하므로, 여기서는 단 한 줄로 전체 에이전트 경로의 토큰 집계가
      // 상단바 위젯까지 배선된다. usage 가 없거나 전부 0 이면 추출 단계에서 no-op.
      emitUsageFromStreamJson(msg);
      const item = this.processing;
      const text = this.currentTurnText.join('\n').trim();
      this.currentTurnText = [];
      this.processing = null;
      if (item) {
        if (msg.subtype === 'success') {
          this.consecutiveSpawnFailures = 0;
          this.warnIfLowKoreanRatio(text, item.taskId);
          item.onResult(text);
          // 리더 단일 브랜치 경로 통합 이후, 에이전트 본인은 Git 자동화를 개시하지
          // 않는다. 성공 턴 직후에는 오직 "개선 보고 → 리더 큐" 경로만 발사해,
          // 커밋/푸시/PR 은 전적으로 리더 태스크 흐름이 책임지게 한다.
          if (DEBUG_GIT_AUTO) {
            console.log(
              `[git-auto] worker success (no per-agent trigger) agent=${this.agentId} task=${item.taskId ?? 'n/a'} len=${text.length}`,
            );
          }
          this.reportImprovementToLeader({
            agentId: this.agentId,
            projectId: this.projectId,
            taskId: item.taskId,
            text,
          });
          // #bc9843bb: 에이전트가 응답 본문에 매체 생성 도구 호출 JSON 을 남겼으면
          // 그대로 디스패처로 흘려 보낸다. 핸들러 미등록·빈 요청이면 no-op 으로 종료.
          // result 핸들러 흐름을 끊지 않도록 fire-and-forget.
          dispatchAgentToolUses(text, {
            agentId: this.agentId,
            projectId: this.projectId,
            taskId: item.taskId,
          }).catch(err => {
            if (DEBUG_CLAUDE) console.warn(`[worker:${this.agentId}] media tool dispatch error: ${(err as Error).message}`);
          });
        } else {
          const errText = typeof msg.result === 'string' && msg.result
            ? msg.result
            : `claude result ${msg.subtype || 'error'}`;
          item.onError(new Error(errText));
        }
      }
      // 다음 턴은 비동기로 드래인 — 핸들러 안에서 동기 spawn/write 체인을 짧게 유지.
      setImmediate(() => this.drain());
    }
  }

  private handleExit(code: number) {
    const died = this.child;
    this.child = null;
    if (!died) return;
    this.cleanupMcpConfig();
    const item = this.processing;
    this.processing = null;
    if (item) {
      item.onError(new Error(formatChildExitMessage(code, this.stderrTail)));
    }
    this.currentTurnText = [];
    this.stdoutBuf = '';
    if (this.closed) return;
    // 지수 백오프: 연속 실패 3회 이상이면 큐에 남은 것도 실패로 반환.
    this.consecutiveSpawnFailures++;
    if (this.consecutiveSpawnFailures >= 3) {
      const pending = [...this.queue];
      this.queue = [];
      for (const p of pending) p.onError(new Error(WORKER_ERROR.repeatedFailure));
      this.consecutiveSpawnFailures = 0;
      return;
    }
    if (this.queue.length > 0) {
      const delay = Math.min(2000, 250 * 2 ** (this.consecutiveSpawnFailures - 1));
      setTimeout(() => this.drain(), delay);
    }
  }

  private drain() {
    if (this.closed) return;
    if (this.processing) return;
    if (this.queue.length === 0) return;
    if (!this.child) {
      const ok = this.spawnChild();
      if (!ok) {
        // spawn 자체 실패 → 큐 첫 항목 실패 처리 후 재시도 방지.
        const head = this.queue.shift();
        if (head) head.onError(new Error(WORKER_ERROR.spawnFailed));
        return;
      }
    }
    if (!this.child) return;

    const item = this.queue.shift()!;
    this.processing = item;
    const userMsg = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: item.prompt.replace(/\r\n/g, '\n') }],
      },
    };
    try {
      this.child.stdin.write(JSON.stringify(userMsg) + '\n');
    } catch (e) {
      this.processing = null;
      item.onError(e as Error);
      setImmediate(() => this.drain());
    }
  }

  // 에이전트가 한 턴을 마치며 남긴 출력에서 "다음에 손볼 거리" 를 탐지해 리더 큐로
  // 밀어 넣는 협업 훅. 정상 경로는 result.success 직후 자동 호출되며, 외부(예:
  // taskRunner 의 테스트) 에서도 직접 호출해 리포트를 재발행할 수 있도록 public
  // 으로 열어 둔다. override 를 전달하면 본문 탐색을 건너뛰고 그대로 리포트를
  // 조립한다 — 호출자가 이미 보고서 메타데이터를 확보한 경우의 지름길.
  //
  // 반환값:
  //   - 성공 시 ImprovementReport (onImprovementReport 훅도 호출).
  //   - 힌트를 찾지 못했거나 summary 가 비면 null — 훅은 호출되지 않는다.
  reportImprovementToLeader(
    info: TaskCompleteInfo,
    override?: {
      summary?: string;
      detail?: string;
      category?: ImprovementReportCategory;
      focusFiles?: string[];
      agentName?: string;
      role?: string;
    },
  ): ImprovementReport | null {
    const suggestion = override?.summary
      ? {
          summary: override.summary,
          detail: override.detail,
          category: override.category ?? 'followup',
          focusFiles: override.focusFiles,
        }
      : this.detectImprovementHint(info.text);
    if (!suggestion) return null;
    const report = createImprovementReport({
      agentId: info.agentId || this.agentId,
      projectId: info.projectId || this.projectId,
      taskId: info.taskId,
      agentName: override?.agentName,
      role: override?.role,
      summary: suggestion.summary,
      detail: suggestion.detail,
      category: suggestion.category,
      focusFiles: suggestion.focusFiles,
    });
    if (!report) return null;
    if (this.onImprovementReport) {
      try {
        this.onImprovementReport(report);
      } catch (e) {
        console.warn(
          `[worker:${this.agentId}] onImprovementReport threw:`,
          (e as Error).message,
        );
      }
    }
    return report;
  }

  private detectImprovementHint(text: string | undefined | null) {
    return detectImprovementHintShared(text);
  }

  private warnIfLowKoreanRatio(text: string, taskId?: string): void {
    warnIfLowKoreanRatioShared(this.agentId, text, taskId);
  }

  private killChild() {
    if (!this.child) return;
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill('SIGTERM'); } catch {}
    this.child = null;
    this.cleanupMcpConfig();
  }

  private cleanupMcpConfig() {
    if (!this.mcpConfigPath) return;
    try { unlinkSync(this.mcpConfigPath); } catch {}
    this.mcpConfigPath = null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 공통 헬퍼 (#llm-provider-abstraction)
// ClaudeCLI 기반 AgentWorker 와 로컬 모델 기반 LocalAgentWorker 가 동일 로직을 공유
// 해야 하는 부분을 top-level 함수로 뽑아 둔다. 인스턴스 상태에 의존하지 않거나,
// 의존하더라도 인자로 주입받는 형태만 남긴다.
// ────────────────────────────────────────────────────────────────────────────

function detectImprovementHintShared(text: string | undefined | null): {
  summary: string;
  detail?: string;
  category: ImprovementReportCategory;
  focusFiles?: string[];
} | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const HINT_RE = /^(?:[-*•]\s*)?(?:개선\s*제안|후속\s*작업|다음에는|todo|fixme|follow[-\s]?up|improvement)\s*[::\-]\s*(.+)$/i;
  const hits: string[] = [];
  for (const l of lines) {
    const m = l.match(HINT_RE);
    if (m && m[1]) hits.push(m[1].trim());
  }
  if (hits.length === 0) return null;
  const [summary, ...rest] = hits;
  const focusFiles = extractFocusFilesShared(text);
  return {
    summary,
    detail: rest.length > 0 ? rest.join(' / ') : undefined,
    category: 'followup',
    focusFiles: focusFiles.length > 0 ? focusFiles : undefined,
  };
}

function extractFocusFilesShared(text: string): string[] {
  const found = new Set<string>();
  const pathRe = /`([^`\s]+?\.(?:tsx?|jsx?|css|md|json))`|\b((?:src|tests|scripts)\/[\w./\-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(text)) !== null) {
    const captured = (m[1] || m[2] || '').trim();
    if (captured) found.add(captured);
    if (found.size >= 16) break;
  }
  return Array.from(found);
}

function warnIfLowKoreanRatioShared(agentId: string, text: string, taskId?: string): void {
  if (!text) return;
  const sample = collectNaturalLanguageSample(text);
  if (isMostlyKorean(sample)) return;
  const ratio = koreanRatio(sample);
  const preview = sample.replace(/\s+/g, ' ').slice(0, 120);
  console.warn(
    `[worker:${agentId}] korean ratio below threshold: ${ratio.toFixed(2)} < ${DEFAULT_KOREAN_THRESHOLD} (taskId=${taskId ?? 'n/a'}, sample="${preview}")`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 로컬 모델 (Ollama / vLLM) 기반 에이전트 세션 (#llm-provider-abstraction)
//
// Claude CLI 와 달리 로컬 모델은 stdin/stdout 스트림이 아닌 HTTP 요청/응답으로
// 한 턴씩 주고받는다. 따라서 "동일 세션 유지" 는 자식 프로세스가 아니라 이 객체가
// 소유한 `messages` 배열로 구현된다. 시스템 프롬프트가 갱신되면 messages[0] 를
// 교체하고, 각 턴의 user/assistant/tool 메시지는 히스토리에 누적한다.
//
// 구현 초점:
//   - public API 는 AgentWorker 와 동일(AgentSession 인터페이스). 외부(TaskRunner,
//     server.ts) 는 클래스 구분 없이 동일하게 다룰 수 있다.
//   - 도구 실행: LOCAL_TOOL_DEFINITIONS 를 열고, 콜이 오면 executeLocalTool 로 REST
//     프록시. mcp-agent-server.ts 와 1:1 동등.
//   - 세션 소진 가드(currentSessionStatus==='exhausted') / 태스크 경계 이벤트 훅 /
//     개선 보고 / 매체 도구 디스패처 — 모두 AgentWorker 경로와 동일한 훅을 호출.
// ────────────────────────────────────────────────────────────────────────────

interface LocalQueueItem {
  prompt: string;
  taskId?: string;
  onResult: (text: string) => void;
  onError: (err: Error) => void;
}

export class LocalAgentWorker implements AgentSession {
  readonly agentId: string;
  projectId: string;
  workspacePath: string;
  private port: number;
  private systemPrompt?: string;
  private onImprovementReport?: ImprovementReportHandler;

  private transport: ChatTransport;
  private messages: LLMMessage[] = [];

  private queue: LocalQueueItem[] = [];
  private processing: LocalQueueItem | null = null;
  private closed = false;
  private lastFailureLog: string | null = null;

  private maxToolIterations: number;

  constructor(init: WorkerInit) {
    this.agentId = init.agentId;
    this.projectId = init.projectId;
    this.workspacePath = init.workspacePath;
    this.port = init.port ?? DEFAULT_PORT;
    this.systemPrompt = init.systemPrompt;
    this.onImprovementReport = init.onImprovementReport;

    const env = readLLMEnv();
    this.maxToolIterations = env.maxToolIterations;
    if (env.provider === 'ollama') {
      this.transport = new OllamaTransport(env.baseUrl, env.model, env.requestTimeoutMs);
    } else if (env.provider === 'vllm') {
      this.transport = new VllmTransport(env.baseUrl, env.model, env.apiKey, env.requestTimeoutMs);
    } else {
      throw new Error(`LocalAgentWorker 는 claude-cli 프로바이더와 호환되지 않습니다 (LLM_PROVIDER=${env.provider})`);
    }
    this.applySystemMessage();
    // workspace 디렉토리는 AgentWorker 와 동일하게 구현체가 보장한다 — 파일 작성 도구가
    // 상대경로를 기대할 수 있어 워커 생성 시점에 만들어 둔다.
    try { mkdirSync(this.workspacePath, { recursive: true }); } catch { /* 무해 */ }
  }

  private applySystemMessage() {
    const sys = this.systemPrompt?.trim();
    if (!sys) {
      if (this.messages[0]?.role === 'system') this.messages.shift();
      return;
    }
    if (this.messages[0]?.role === 'system') {
      this.messages[0] = { role: 'system', content: sys };
    } else {
      this.messages.unshift({ role: 'system', content: sys });
    }
  }

  setOnImprovementReport(handler: ImprovementReportHandler | undefined) {
    this.onImprovementReport = handler;
  }

  status(): WorkerStatus {
    return this.processing || this.queue.length > 0 ? 'busy' : 'idle';
  }

  queueLength(): number {
    return this.queue.length + (this.processing ? 1 : 0);
  }

  isIdle(): boolean {
    return !this.processing && this.queue.length === 0;
  }

  updateSystemPrompt(next: string | undefined) {
    this.systemPrompt = next;
    this.applySystemMessage();
  }

  logFailure(entry: string): void {
    const clipped = entry.trim().slice(0, 600);
    this.lastFailureLog = clipped;
    console.warn(`[worker:${this.agentId}] git-automation failure: ${clipped}`);
  }

  getLastFailureLog(): string | null {
    return this.lastFailureLog;
  }

  enqueue(prompt: string, taskId?: string): Promise<string> {
    if (this.closed) return Promise.reject(new Error(WORKER_ERROR.disposed));
    if (currentSessionStatus === 'exhausted') {
      return Promise.reject(new Error(WORKER_SESSION_EXHAUSTED_MESSAGE));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, taskId, onResult: resolve, onError: reject });
      this.drain();
    });
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.queue];
    this.queue = [];
    for (const item of pending) item.onError(new Error(WORKER_ERROR.disposed));
    if (this.processing) {
      this.processing.onError(new Error(WORKER_ERROR.disposed));
      this.processing = null;
    }
  }

  private async drain() {
    if (this.closed || this.processing || this.queue.length === 0) return;
    const item = this.queue.shift()!;
    this.processing = item;
    try {
      // 이번 턴 user 메시지를 히스토리에 추가. chatLoop 가 assistant/tool 메시지를
      // in-place 로 이어 붙인다 — 즉 동일 세션이 계속 누적된다.
      this.messages.push({ role: 'user', content: item.prompt.replace(/\r\n/g, '\n') });
      const toolContext = {
        agentId: this.agentId,
        projectId: this.projectId,
        port: this.port,
        workspacePath: this.workspacePath,
      };
      const text = await chatLoop(this.transport, this.messages, {
        maxToolIterations: this.maxToolIterations,
        toolContext,
        tools: getToolDefinitions(toolContext),
      });

      warnIfLowKoreanRatioShared(this.agentId, text, item.taskId);
      item.onResult(text);

      // AgentWorker 와 동일하게 개선 보고 → 리더 큐 / 매체 도구 디스패처 훅 호출.
      this.reportImprovementToLeader({
        agentId: this.agentId,
        projectId: this.projectId,
        taskId: item.taskId,
        text,
      });
      dispatchAgentToolUses(text, {
        agentId: this.agentId,
        projectId: this.projectId,
        taskId: item.taskId,
      }).catch(err => {
        console.warn(`[worker:${this.agentId}] media tool dispatch error: ${(err as Error).message}`);
      });
    } catch (err) {
      item.onError(err as Error);
    } finally {
      this.processing = null;
      // 다음 턴은 비동기 드레인 — 핸들러 호출 체인을 짧게 유지한다.
      setImmediate(() => this.drain());
    }
  }

  reportImprovementToLeader(
    info: TaskCompleteInfo,
    override?: {
      summary?: string;
      detail?: string;
      category?: ImprovementReportCategory;
      focusFiles?: string[];
      agentName?: string;
      role?: string;
    },
  ): ImprovementReport | null {
    const suggestion = override?.summary
      ? {
          summary: override.summary,
          detail: override.detail,
          category: override.category ?? 'followup',
          focusFiles: override.focusFiles,
        }
      : detectImprovementHintShared(info.text);
    if (!suggestion) return null;
    const report = createImprovementReport({
      agentId: info.agentId || this.agentId,
      projectId: info.projectId || this.projectId,
      taskId: info.taskId,
      agentName: override?.agentName,
      role: override?.role,
      summary: suggestion.summary,
      detail: suggestion.detail,
      category: suggestion.category,
      focusFiles: suggestion.focusFiles,
    });
    if (!report) return null;
    if (this.onImprovementReport) {
      try {
        this.onImprovementReport(report);
      } catch (e) {
        console.warn(
          `[worker:${this.agentId}] onImprovementReport threw:`,
          (e as Error).message,
        );
      }
    }
    return report;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 레지스트리 — env `LLM_PROVIDER` 에 따라 AgentWorker(claude-cli) 또는 LocalAgentWorker
// 를 스폰한다. 외부 소비자(TaskRunner) 는 AgentSession 타입만 보므로 구분이 없다.
// ────────────────────────────────────────────────────────────────────────────

// 에이전트 ID 를 키로 단일 워커를 유지. 동일 에이전트가 서로 다른 프로젝트의
// 지시를 받으면 컨텍스트가 오염되므로, projectId 가 바뀌면 기존 워커를 dispose
// 하고 새로 만든다(세션 리셋과 동등).
export class AgentWorkerRegistry {
  private workers = new Map<string, AgentSession>();

  get(agentId: string): AgentSession | undefined {
    return this.workers.get(agentId);
  }

  ensure(init: WorkerInit): AgentSession {
    const existing = this.workers.get(init.agentId);
    if (existing) {
      if (existing.projectId === init.projectId && existing.workspacePath === init.workspacePath) {
        existing.updateSystemPrompt(init.systemPrompt);
        existing.setOnImprovementReport(init.onImprovementReport);
        return existing;
      }
      existing.dispose();
      this.workers.delete(init.agentId);
    }
    // env LLM_PROVIDER 에 따라 구현체 선택. claude-cli 는 기존 AgentWorker(자식 프로세스 +
    // stream-json), ollama/vllm 은 LocalAgentWorker(HTTP + tool-call 루프).
    const providerName = readLLMEnv().provider;
    const worker: AgentSession = providerName === 'claude-cli'
      ? new AgentWorker(init)
      : new LocalAgentWorker(init);
    this.workers.set(init.agentId, worker);
    return worker;
  }

  dispose(agentId: string) {
    const w = this.workers.get(agentId);
    if (!w) return;
    w.dispose();
    this.workers.delete(agentId);
  }

  disposeAll() {
    for (const w of this.workers.values()) w.dispose();
    this.workers.clear();
  }

  listAgentIds(): string[] {
    return Array.from(this.workers.keys());
  }
}
