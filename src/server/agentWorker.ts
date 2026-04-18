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

export class AgentWorker {
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

  // 응답 본문에서 흔히 쓰이는 "개선 제안 / 후속 작업 / 다음에는 / TODO / FIXME /
  // follow-up" 패턴을 뽑아 리포트 seed 로 돌려준다. 단순 문자열 검색이라 오탐이
  // 전혀 없지는 않지만, createImprovementReport 가 summary/필드 유효성을 한 번 더
  // 검증하고 taskRunner 쪽에서 리더가 최종적으로 mode="reply" 로 흘려 보낼 수도
  // 있으므로, 과잉 감지를 두려워하지 않고 넓게 매칭한다. 관련 파일은 본문에서
  // "src/..." 혹은 백틱으로 감싼 파일 경로만 수집한다.
  private detectImprovementHint(text: string | undefined | null): {
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
    const focusFiles = this.extractFocusFiles(text);
    return {
      summary,
      detail: rest.length > 0 ? rest.join(' / ') : undefined,
      category: 'followup',
      focusFiles: focusFiles.length > 0 ? focusFiles : undefined,
    };
  }

  private extractFocusFiles(text: string): string[] {
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

  // 시스템 프롬프트가 "한국어로만 응답" 을 강제함에도 모델이 영어로 회귀하는
  // 사례가 관측된다. 결과 턴이 성공했을 때 자연어 영역만 샘플링해 한국어 비율을
  // 재확인하고, 임계값 아래면 경고 로그를 남긴다. 흐름은 막지 않는다 —
  // 오탐으로 실제 결과를 차단하면 사용자 손실이 더 크다.
  private warnIfLowKoreanRatio(text: string, taskId?: string): void {
    if (!text) return;
    const sample = collectNaturalLanguageSample(text);
    if (isMostlyKorean(sample)) return;
    const ratio = koreanRatio(sample);
    const preview = sample.replace(/\s+/g, ' ').slice(0, 120);
    console.warn(
      `[worker:${this.agentId}] korean ratio below threshold: ${ratio.toFixed(2)} < ${DEFAULT_KOREAN_THRESHOLD} (taskId=${taskId ?? 'n/a'}, sample="${preview}")`,
    );
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

// 에이전트 ID 를 키로 단일 워커를 유지. 동일 에이전트가 서로 다른 프로젝트의
// 지시를 받으면 컨텍스트가 오염되므로, projectId 가 바뀌면 기존 워커를 dispose
// 하고 새로 만든다(세션 리셋과 동등).
export class AgentWorkerRegistry {
  private workers = new Map<string, AgentWorker>();

  get(agentId: string): AgentWorker | undefined {
    return this.workers.get(agentId);
  }

  ensure(init: WorkerInit): AgentWorker {
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
    const worker = new AgentWorker(init);
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
