import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

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
const DEFAULT_PORT = parseInt(process.env.PORT || '3000', 10);

interface QueueItem {
  prompt: string;
  taskId?: string;
  onResult: (text: string) => void;
  onError: (err: Error) => void;
}

interface WorkerInit {
  agentId: string;
  projectId: string;
  workspacePath: string;
  port?: number;
  systemPrompt?: string;
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

  enqueue(prompt: string, taskId?: string): Promise<string> {
    if (this.closed) return Promise.reject(new Error('worker disposed'));
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
    for (const item of pending) item.onError(new Error('worker disposed'));
    if (this.processing) {
      this.processing.onError(new Error('worker disposed'));
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
        shell: false,
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
          item.onResult(text);
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
      const stderr = this.stderrTail.trim();
      const msg = `worker child exited code=${code}${stderr ? ` stderr: ${stderr.slice(-300)}` : ''}`;
      item.onError(new Error(msg));
    }
    this.currentTurnText = [];
    this.stdoutBuf = '';
    if (this.closed) return;
    // 지수 백오프: 연속 실패 3회 이상이면 큐에 남은 것도 실패로 반환.
    this.consecutiveSpawnFailures++;
    if (this.consecutiveSpawnFailures >= 3) {
      const pending = [...this.queue];
      this.queue = [];
      for (const p of pending) p.onError(new Error('worker repeatedly failed to start'));
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
        if (head) head.onError(new Error('failed to spawn claude worker'));
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
