import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { MongoClient, Db } from 'mongodb';
import multer from 'multer';
import { Agent, Project, GameState, CodeFile, CodeDependency, Task, SourceIntegration, ManagedProject, SourceProvider, GitAutomationSettings, GitAutomationBranchStrategy, GIT_AUTOMATION_BRANCH_STRATEGY_VALUES, GitCredential, GitCredentialRedacted, SharedGoal, SharedGoalPriority, SharedGoalStatus, ProjectOptionsUpdate, PROJECT_OPTION_DEFAULTS, ClaudeTokenUsage, ClaudeTokenUsageTotals, MediaAsset, MediaKind } from './src/types';
import { EMPTY_TOTALS as EMPTY_CLAUDE_USAGE_TOTALS, mergeUsage as mergeClaudeUsageTotals, recordErrorToTotals, emptyErrorCounters } from './src/utils/claudeTokenUsageStore';
import { parseClaudeUsageFromStdout } from './src/utils/claudeTokenUsageParse';
import { onClaudeUsage, onTokenExhausted, emitTokenExhausted } from './src/server/claudeClient';
import { classifyClaudeError, type ClaudeErrorCategory } from './src/server/claudeErrors';
import { setAgentWorkerSessionStatus, notifyAgentMediaGenerated } from './src/server/agentWorker';
import type { ClaudeSessionStatus } from './src/types';
import { AgentWorkerRegistry } from './src/server/agentWorker';
import { TaskRunner } from './src/server/taskRunner';
// LLM 프로바이더 추상화(#llm-provider-abstraction):
//   - callLLMOneshot: LLM_PROVIDER 설정에 따라 claude-cli/ollama/vllm 중 하나로 분기
//   - setClaudeCliOneshot: claude-cli 경로 구현체를 내부 모듈에 주입
// 아래에서 callClaude 가 정의되자마자 setClaudeCliOneshot(callClaude) 로 배선한다.
import { callLLMOneshot, setClaudeCliOneshot } from './src/server/llm/oneshot';
import { processDirectiveFile } from './src/server/fileProcessor';
import {
  createMediaProcessor,
  inferMediaKind,
  NotImplementedMediaError,
} from './src/server/mediaProcessor';
import {
  createMediaGenerator,
  ExhaustedBlockedError,
  type PdfReportTemplate,
  type PptxSlide,
} from './src/server/mediaGenerator';
import { getMediaAssetStore } from './src/server/mediaAssetStore';
import { ProjectCompletionTracker } from './src/server/completionWatcher';
import { parseEntry, type LedgerEntry } from './src/utils/handoffLedger';
import { inferFileType, isExcludedFromCodeGraph, normalizeCodeGraphPath } from './src/utils/codeGraphFilter';
import {
  ProjectOptionsValidationError,
  hasAnyUpdate,
  projectOptionsView,
  updateProjectOptionsSchema,
} from './src/utils/projectOptions';
import {
  DEFAULT_GIT_AUTOMATION_CONFIG,
  formatCommitMessage,
  formatPrTitle,
  reconcileCommitOutcome,
  renderBranchName,
  shouldAutoCommit,
  shouldAutoOpenPR,
  shouldAutoPush,
  validateGitAutomationConfig,
  type GitAutomationRunResult,
  type GitAutomationStepResult,
} from './src/utils/gitAutomation';
import { ActiveBranchCache, resolveBranch } from './src/utils/branchResolver';
import {
  decryptToken,
  encryptToken,
  injectTokenIntoRemoteUrl,
  redactRemoteUrl,
} from './src/utils/projectGitCredentials';
import { spawnSync } from 'child_process';
import {
  aggregateUsageFromJsonlRoots,
  DEFAULT_JSONL_BASELINE_PATH,
  resolveClaudeCodeJsonlRoots,
  syncJsonlUsageDeltas,
} from './src/server/claudeJsonlUsage';
import type { OAuthUsageFetchResult } from './src/server/claudeOAuthUsage';
import { loadOAuthUsageFromDisk } from './src/server/claudeOAuthUsage';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DEBUG_CLAUDE = process.env.DEBUG_CLAUDE === '1';
const PORT = parseInt(process.env.PORT || '3000', 10);

// Git 자동화 트리거의 기본 브랜치 분기 모드. 설정 row 가 이 필드를 모르는 레거시
// 프로젝트 응답과, MCP/REST 에서 명시 값 없이 들어온 트리거 요청에 모두 이 기본값을
// 적용한다. 환경변수로 운영팀이 배치 단위로 "new 브랜치로 발사" 대 "현재 HEAD 유지"
// 를 뒤집을 수 있게 한다.
const GIT_AUTO_DEFAULT_BRANCH_STRATEGY: GitAutomationBranchStrategy =
  process.env.GIT_AUTO_BRANCH_STRATEGY === 'current' ? 'current' : 'new';
const GIT_AUTO_DEFAULT_BRANCH_NAME: string =
  typeof process.env.GIT_AUTO_BRANCH_NAME === 'string' ? process.env.GIT_AUTO_BRANCH_NAME : '';

// 프로세스 단위 활성 브랜치 캐시. per-session 전략에서 resolveBranch 가 같은
// 프로젝트의 연속 호출에 같은 이름을 돌려주도록 한다. 재기동 시에는
// projects.currentAutoBranch 로부터 복원된다.
const activeBranchCache = new ActiveBranchCache();

function shellQuote(s: string): string {
  const cleaned = s.replace(/\r?\n/g, ' ');
  if (process.platform === 'win32') {
    // cmd.exe: escape internal " as \" (handled by MSVCRT arg parser). Backslashes stay literal.
    return `"${cleaned.replace(/"/g, '\\"')}"`;
  }
  return `'${cleaned.replace(/'/g, `'\\''`)}'`;
}

interface AgentContext { agentId: string; projectId: string; workspacePath?: string; }

function resolveWorkspace(workspacePath: string): string {
  const abs = path.isAbsolute(workspacePath)
    ? workspacePath
    : path.resolve(process.cwd(), workspacePath);
  try { mkdirSync(abs, { recursive: true }); } catch (e) {
    console.error(`[workspace] mkdir failed for ${abs}:`, (e as Error).message);
  }
  return abs;
}

/** Windows 탐색기 / macOS Finder / Linux 기본 파일 관리자에서 폴더를 연다. */
function openFolderInOsFileManager(absPath: string): Promise<{ ok: boolean; error?: string }> {
  const normalized = path.normalize(absPath);
  return new Promise((resolve) => {
    if (!existsSync(normalized)) {
      resolve({ ok: false, error: 'path_not_found' });
      return;
    }
    let settled = false;
    const finish = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const opts = { detached: true, stdio: 'ignore' as const };
      let child: ReturnType<typeof spawn>;
      if (process.platform === 'win32') {
        const explorer = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
        child = spawn(explorer, [normalized], opts);
      } else if (process.platform === 'darwin') {
        child = spawn('open', [normalized], opts);
      } else {
        child = spawn('xdg-open', [normalized], opts);
      }
      child.once('error', (err) => finish({ ok: false, error: err.message }));
      child.unref();
      setImmediate(() => finish({ ok: true }));
    } catch (e) {
      finish({ ok: false, error: (e as Error).message });
    }
  });
}

type WorkspaceIdeCli = 'code' | 'cursor';

/** VS Code(`code`) 또는 Cursor(`cursor`) CLI 로 워크스페이스 폴더를 연다. PATH 에 CLI 가 있어야 한다. */
function openWorkspaceInIdeCli(absPath: string, ide: WorkspaceIdeCli): Promise<{ ok: boolean; error?: string }> {
  const normalized = path.normalize(absPath);
  return new Promise((resolve) => {
    if (!existsSync(normalized)) {
      resolve({ ok: false, error: 'path_not_found' });
      return;
    }
    const bin = ide === 'code' ? 'code' : 'cursor';
    let settled = false;
    const finish = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const opts = {
        detached: true,
        stdio: 'ignore' as const,
        // Windows 에서 PATH 의 code.cmd / Cursor.cmd 를 찾기 위해
        shell: process.platform === 'win32',
      };
      const child = spawn(bin, [normalized], opts);
      child.once('error', (err) => finish({ ok: false, error: err.message }));
      child.unref();
      setImmediate(() => finish({ ok: true }));
    } catch (e) {
      finish({ ok: false, error: (e as Error).message });
    }
  });
}

function writeMcpConfig(ctx: AgentContext): string {
  const tsxBin = path.resolve(
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
  );
  const mcpScript = path.resolve('mcp-agent-server.ts');
  const config = {
    mcpServers: {
      'llm-tycoon': {
        command: tsxBin,
        args: [mcpScript],
        env: {
          API_URL: `http://localhost:${PORT}`,
          AGENT_ID: ctx.agentId,
          PROJECT_ID: ctx.projectId,
        },
      },
    },
  };
  const configPath = path.join(tmpdir(), `claude-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(configPath, JSON.stringify(config), 'utf8');
  return configPath;
}

// Claude CLI 동시 실행 큐: 구독 세션 기반 CLI는 동시에 여러 프로세스가 설정 파일에
// 접근하면 "설정을 찾을 수 없습니다" 에러가 발생할 수 있다. 한 번에 하나씩 실행.
const claudeQueue: Array<() => void> = [];
let claudeRunning = 0;
const CLAUDE_CONCURRENCY = 10;

// 프로세스 수명 동안의 Claude 토큰 사용량 누적. 서버 재기동 시 0 으로 초기화되고,
// 클라이언트는 최초 `GET /api/claude/token-usage` + socket `claude-usage:updated`
// push 로 동기화한다. 직접 쓰지 말고 `recordClaudeUsage` 를 통해 갱신할 것.
let claudeUsageTotals: ClaudeTokenUsageTotals = { ...EMPTY_CLAUDE_USAGE_TOTALS, byModel: {}, errors: emptyErrorCounters() };
// socket.io 인스턴스는 startServer 내부에서 생성되므로, 그 시점에 주입한다.
// startServer 진입 전에 recordClaudeUsage 가 호출될 일은 없다(CLI 호출은 서버 준비 후).
let claudeUsageBroadcaster: ((totals: ClaudeTokenUsageTotals, delta: ClaudeTokenUsage) => void) | null = null;

// 세션 토큰 가용 상태(#cdaaabf3) — 기본 'active'. classifyClaudeError 가 token_exhausted
// 또는 subscription_expired 를 돌려주면 exhausted 로 전이하고, socket `claude-session:status`
// 이벤트로 전 클라이언트에 푸시한다. REST `/api/claude/session-status` 조회 결과도 이 값.
let claudeSessionStatus: ClaudeSessionStatus = 'active';
let claudeSessionStatusReason: string | undefined;
let claudeSessionStatusUpdatedAt: string = new Date().toISOString();
let claudeSessionStatusBroadcaster: ((payload: { status: ClaudeSessionStatus; reason?: string; at: string }) => void) | null = null;

function setClaudeSessionStatus(status: ClaudeSessionStatus, reason?: string): void {
  if (claudeSessionStatus === status && claudeSessionStatusReason === reason) return;
  claudeSessionStatus = status;
  claudeSessionStatusReason = reason;
  claudeSessionStatusUpdatedAt = new Date().toISOString();
  // agentWorker 모듈도 동일 상태를 공유해 신규 enqueue 를 거부할 수 있도록 한다.
  try { setAgentWorkerSessionStatus(status); } catch { /* 동기화 실패는 회로의 다른 축에 영향 없음 */ }
  if (claudeSessionStatusBroadcaster) {
    claudeSessionStatusBroadcaster({ status, reason, at: claudeSessionStatusUpdatedAt });
  }
}

function recordClaudeUsage(usage: ClaudeTokenUsage) {
  const stamped: ClaudeTokenUsage = { ...usage, at: usage.at ?? new Date().toISOString() };
  claudeUsageTotals = mergeClaudeUsageTotals(claudeUsageTotals, stamped);
  if (claudeUsageBroadcaster) claudeUsageBroadcaster(claudeUsageTotals, stamped);
}

const CLAUDE_JSONL_BASELINE_PATH = process.env.CLAUDE_JSONL_BASELINE_PATH || DEFAULT_JSONL_BASELINE_PATH;

function runLocalJsonlUsageSync() {
  return syncJsonlUsageDeltas({
    baselinePath: CLAUDE_JSONL_BASELINE_PATH,
    record: recordClaudeUsage,
  });
}

/** OAuth /usage 동등 API 응답 캐시 — 짧은 TTL 로 앤트로픽 호출 빈도 제한 */
let oauthUsageCache: { t: number; payload: OAuthUsageFetchResult } | null = null;
const OAUTH_USAGE_CACHE_MS = 60_000;

async function getOAuthUsageCached(): Promise<OAuthUsageFetchResult> {
  const now = Date.now();
  if (oauthUsageCache && now - oauthUsageCache.t < OAUTH_USAGE_CACHE_MS) {
    return oauthUsageCache.payload;
  }
  const payload = await loadOAuthUsageFromDisk();
  oauthUsageCache = { t: now, payload };
  return payload;
}

// 카테고리별 에러 누적(server in-memory totals.errors). 브로드캐스터가 있으면
// 바로 클라이언트 전원에 push 해 위젯의 errors 배지가 실데이터로 갱신되게 한다.
// `classifyClaudeError` 가 이미 수행된 카테고리만 받아 의도되지 않은 분류 중복을 차단.
function recordClaudeError(category: ClaudeErrorCategory) {
  claudeUsageTotals = recordErrorToTotals(claudeUsageTotals, category);
  if (claudeUsageBroadcaster) claudeUsageBroadcaster(claudeUsageTotals, {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    at: new Date().toISOString(),
  });
  // 구독 세션 폴백(#cdaaabf3) — 토큰 소진/만료 카테고리는 에러 카운터 누적과 별개로
  // 전역 이벤트 버스에 한 번 방송해 UI 배너/워커 가드/세션 상태 엔드포인트를 동기화한다.
  if (category === 'token_exhausted' || category === 'subscription_expired') {
    emitTokenExhausted({ category, message: '' });
  }
}

function drainClaudeQueue() {
  while (claudeRunning < CLAUDE_CONCURRENCY && claudeQueue.length > 0) {
    claudeRunning++;
    const next = claudeQueue.shift()!;
    next();
  }
}

function callClaude(prompt: string, ctx?: AgentContext): Promise<string> {
  return new Promise((resolve, reject) => {
    const run = () => {
      let mcpConfigPath: string | null = null;
      if (ctx && ctx.agentId && ctx.projectId) {
        mcpConfigPath = writeMcpConfig(ctx);
      }
      // 한글 프롬프트를 cmd.exe 인자로 넘기면 PC마다 코드 페이지 차이로 깨진다.
      // stdin으로 파이프하면 셸 파싱을 완전히 우회한다.
      const args = ['--dangerously-skip-permissions'];
      if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
      if (DEBUG_CLAUDE) console.log('[claude] spawn', CLAUDE_BIN, args, '| stdin:', prompt.slice(0, 80));
      const env: Record<string, string | undefined> = {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        LANG: 'en_US.UTF-8',
      };
      delete env.ANTHROPIC_API_KEY;
      delete env.CLAUDE_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      const cleanup = () => {
        if (mcpConfigPath) { try { unlinkSync(mcpConfigPath); } catch {} }
        claudeRunning--;
        drainClaudeQueue();
      };
      const cwd = ctx?.workspacePath ? resolveWorkspace(ctx.workspacePath) : undefined;
      if (DEBUG_CLAUDE && cwd) console.log('[claude] cwd =', cwd);
      const child = spawn(CLAUDE_BIN, args, {
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        cwd,
      });
      // 프롬프트를 stdin으로 전달하고 즉시 닫아 EOF 신호를 보낸다
      child.stdin.write(prompt, 'utf8');
      child.stdin.end();
      let stdout = '';
      const stderrChunks: Buffer[] = [];
      child.stdout?.on('data', d => { stdout += d.toString('utf8'); });
      child.stderr?.on('data', d => { stderrChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)); });
      child.on('error', err => {
        cleanup();
        // spawn 단계의 에러는 대부분 ENOENT(CLAUDE_BIN 미설치)·EPIPE·ECONNRESET 계열이다.
        // classifyClaudeError 가 이를 network/api_error 로 수렴시키고, 서버 totals.errors
        // 에 카테고리별 1건을 누적해 내보내기·상단바 배지가 실데이터를 보도록 한다.
        try { recordClaudeError(classifyClaudeError(err).category); } catch { /* 누적 실패는 메인 흐름에 영향 없음 */ }
        reject(err);
      });
      child.on('close', code => {
        cleanup();
        if (code === 0) {
          // best-effort usage 수집: CLI 가 JSON/stream-json 모드로 호출됐을 때
          // stdout 에 usage 블록이 섞여 들어오면 상단바 위젯에 반영한다. plain text
          // 모드에서는 조용히 null 을 반환해 아무 일도 일어나지 않는다. 파싱은
          // try/catch 로 보호해 메인 경로의 resolve 를 절대 막지 않는다.
          try {
            const usage = parseClaudeUsageFromStdout(stdout);
            if (usage) recordClaudeUsage(usage);
          } catch { /* 수집 실패는 기능 동작에 영향 없음 */ }
          resolve(stdout.trim());
          return;
        }
        // Windows cp949 stderr → UTF-8 디코딩 시도
        const rawBuf = Buffer.concat(stderrChunks);
        let stderrText = rawBuf.toString('utf8');
        // UTF-8로 읽었을 때 replacement char(�)이 많으면 cp949로 재시도
        if ((stderrText.match(/\uFFFD/g) || []).length > 2) {
          try {
            // cp949 수동 디코딩: iconv-lite 없이 child_process로 변환
            const conv = spawnSync('powershell', [
              '-NoProfile', '-Command',
              `[System.Text.Encoding]::GetEncoding(949).GetString([byte[]](${Array.from(rawBuf).join(',')}))`,
            ], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
            if (conv.status === 0 && conv.stdout?.trim()) {
              stderrText = conv.stdout.trim();
            }
          } catch { /* 변환 실패 시 원본 유지 */ }
        }
        const parts: string[] = [`claude exit ${code}`];
        if (stderrText.trim()) parts.push(`stderr: ${stderrText.trim().slice(0, 600)}`);
        if (stdout.trim()) parts.push(`stdout: ${stdout.trim().slice(0, 600)}`);
        const msg = parts.join(' | ');
        console.error('[claude]', msg);
        // stderr 본문에서 rate_limit/overloaded/auth 단서가 잡히면 그에 맞는 카테고리로
        // 분류한다. 단서가 없으면 폴백 경로가 api_error 로 수렴.
        try { recordClaudeError(classifyClaudeError({ message: msg }).category); } catch { /* 누적 실패는 메인 흐름에 영향 없음 */ }
        reject(new Error(msg));
      });
    };

    claudeQueue.push(run);
    drainClaudeQueue();
  });
}

// 프로바이더 추상화 경로가 claude-cli 구현을 호출할 수 있도록 훅을 걸어 둔다.
// 함수 선언은 호이스팅되므로 이 모듈 상단에서 callClaude 를 참조해도 안전하다.
setClaudeCliOneshot(callClaude);

async function diagnoseLLM() {
  // 프로바이더별로 진단 대상이 다르므로 메시지도 분기. 진단 실패는 서버 기동을
  // 막지 않는다(fire-and-forget). 첫 호출은 로컬 모델 로드/콜드스타트에 수십 초가
  // 걸릴 수 있어 가이드만 남기고 조용히 물러난다.
  const providerRaw = (process.env.LLM_PROVIDER || 'claude-cli').trim();
  const label = providerRaw === 'claude-cli' ? 'claude' : providerRaw;
  try {
    const out = await callLLMOneshot('한 단어만 답하세요: ping');
    console.log(`[${label}] OK — response: "${out.slice(0, 80).replace(/\s+/g, ' ')}"`);
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`[${label}] UNAVAILABLE: ${msg}`);
    if (providerRaw === 'claude-cli') {
      console.error('[claude] 점검 항목:');
      console.error('  1) "claude --version" 이 터미널에서 동작하는지');
      console.error('  2) "claude login" 으로 구독 세션 인증 완료했는지');
      console.error('  3) 환경변수 CLAUDE_BIN 으로 절대경로 지정 필요 여부');
      console.error('  4) DEBUG_CLAUDE=1 로 재실행하면 실제 명령어 로그 확인');
    } else if (providerRaw === 'ollama') {
      console.error('[ollama] 점검 항목:');
      console.error('  1) "ollama ps" 로 데몬이 떠 있는지 확인');
      console.error(`  2) "ollama list" 에 ${process.env.LLM_MODEL || '(LLM_MODEL 미설정)'} 이 있는지`);
      console.error(`  3) LLM_BASE_URL=${process.env.LLM_BASE_URL || 'http://localhost:11434'} 가 접근 가능한지`);
      console.error('  4) reasoning 모델(qwen3 등)은 thinking 토큰 때문에 초회 응답이 길다 — LLM_REQUEST_TIMEOUT_MS=600000 권장');
      console.error('  5) 컨텍스트 소진이 자주 나면 LLM_NUM_CTX=16384 정도로 확장');
    } else if (providerRaw === 'vllm') {
      console.error('[vllm] 점검 항목:');
      console.error(`  1) LLM_BASE_URL=${process.env.LLM_BASE_URL || 'http://localhost:8000'} /v1/chat/completions 가 떠 있는지`);
      console.error('  2) LLM_API_KEY 토큰이 필요한 배포인지');
      console.error(`  3) LLM_MODEL=${process.env.LLM_MODEL || '(미설정)'} 이 서버에 등록된 ID 인지`);
    }
  }
}

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const MONGODB_DB = process.env.MONGODB_DB || 'llm-tycoon';

async function startServer() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db: Db = client.db(MONGODB_DB);

  const projectsCol = db.collection<Project>('projects');
  const agentsCol = db.collection<Agent>('agents');
  const tasksCol = db.collection<Task>('tasks');
  const filesCol = db.collection<CodeFile>('files');
  const depsCol = db.collection<CodeDependency>('dependencies');
  const integrationsCol = db.collection<SourceIntegration>('source_integrations');
  const managedProjectsCol = db.collection<ManagedProject>('managed_projects');
  // 프로젝트별 Git 자격증명(provider + username + PAT). projectId 를 논리적 주키로
  // 쓰고 한 프로젝트당 한 쌍만 허용 — 저장소 임포트용 source_integrations 와 별개의
  // "설정 화면 1:1 바인딩" 모델이라 인덱스와 컬렉션을 분리했다.
  const gitCredentialsCol = db.collection<GitCredential>('git_credentials');
  await gitCredentialsCol.createIndex({ projectId: 1 }, { unique: true });
  // 프로젝트별 Git 자동화 설정. projectId 를 논리적 주키로 쓰고, upsert 로만 갱신한다.
  // 리더 에이전트가 태스크 완료 이벤트마다 이 컬렉션을 조회해 auto-commit/push/PR 여부를 판정.
  const gitAutomationSettingsCol = db.collection<GitAutomationSettings>('git_automation_settings');
  await gitAutomationSettingsCol.createIndex({ projectId: 1 }, { unique: true });
  // 프로젝트별 공동 목표(sharedGoal). projectId 당 활성 1건 원칙이며, 새 목표를
  // insert 할 때 기존 active 를 archived 로 내려 불변식을 유지한다. 자동 개발
  // 루프는 활성 목표가 있는 프로젝트만 돌린다.
  const sharedGoalsCol = db.collection<SharedGoal>('shared_goals');
  await sharedGoalsCol.createIndex({ projectId: 1, status: 1, createdAt: -1 });
  // 관리 메뉴(연동·가져온 저장소)는 프로젝트별로 격리한다. 전역 컬렉션을 공유하면
  // 한 프로젝트가 PR 대상으로 지정한 외부 저장소가 다른 프로젝트 화면에 섞여 나와
  // "어느 게임 프로젝트에 속한 것인지" 구분이 흐려진다. projectId 필드를 필수 키로
  // 두고 조회/쓰기는 모두 해당 스코프 안에서만 돌게 만든다.
  await integrationsCol.createIndex({ projectId: 1 });
  await managedProjectsCol.createIndex({ projectId: 1 });
  // 같은 프로젝트 안에서 동일 파일명은 단 하나의 노드만 허용. 에이전트가
  // add_file 을 두 번 호출해도 두 번째는 중복키 에러로 막고, 기존 노드를 반환해
  // 그래프에 유령 노드가 쌓이지 않게 한다.
  await filesCol.createIndex({ projectId: 1, name: 1 }, { unique: true });

  console.log(`Connected to MongoDB at ${MONGODB_URI}/${MONGODB_DB}`);
  diagnoseLLM();

  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);

  // 에이전트별 상시 실행 워커 레지스트리. 각 워커는 Claude CLI 프로세스 1개를
  // 유지하며 stream-json 으로 유저 턴을 큐잉한다. 에이전트 간 컨텍스트는 격리되고
  // 동일 에이전트에 대한 연속 지시는 같은 세션에서 이어진다.
  const workerRegistry = new AgentWorkerRegistry();
  // 프로젝트 단위 "모든 에이전트 idle 수렴" 전이 추적기. 개별 태스크 완료마다
  // git 자동화를 돌리는 기존 훅과 별개로, 한 묶음의 지시가 모두 끝난 시점을
  // rising-edge 로 잡아 마무리 커밋/PR 을 한 번 더 정리한다. busy → completed
  // 전이에서만 1회 발사되고, 이어지는 같은 completed tick 은 무시된다.
  const completionTracker = new ProjectCompletionTracker();
  // 리더 루프가 같은 세션 안에서 브랜치를 재사용하도록 하는 메모리 캐시.
  // 프로세스 재기동 시에는 projects.currentAutoBranch 에서 복원된다.
  const activeBranchCache = new ActiveBranchCache();
  const taskRunner = new TaskRunner({
    db,
    io,
    registry: workerRegistry,
    port: PORT,
    resolveWorkspace,
    runGitAutomation: (projectId, ctx) => executeGitAutomation(projectId, ctx),
    getGameState: () => getGameState(),
    getTasks: () => getTasks(),
    onAgentStateChanged: (projectId) => {
      allAgentsCompletedWatcher(projectId).catch(err =>
        console.error('[all-agents-watcher] tick failed:', (err as Error).message),
      );
    },
  });
  await taskRunner.init();

  // 서버 재기동 시 in-progress 로 남아있던 태스크는 유실된 컨텍스트를 되살릴 수
  // 없으므로 pending 으로 되돌려 auto-dev 또는 클라이언트 재지시로 재착수되게 둔다.
  await tasksCol.updateMany(
    { status: 'in-progress' },
    { $set: { status: 'pending' } },
  );
  await agentsCol.updateMany(
    { status: 'working' },
    { $set: { status: 'idle', currentTask: '' } },
  );

  app.use(express.json());

  // 지시 업로드: 메모리 버퍼로 받아 fileProcessor 가 PDF 텍스트/이미지/UTF-8 텍스트
  // 어느 경로로든 통일된 레코드({fileId,name,type,extractedText,images[]})로 저장한다.
  // 디스크 임시 파일을 거치지 않으므로 cleanup 누수가 없다.
  const directiveUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  app.post('/api/directive/upload', directiveUpload.single('file'), async (req, res) => {
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }
    if (!req.file) { res.status(400).json({ error: 'file required' }); return; }
    const project = await projectsCol.findOne({ id: projectId });
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    try {
      const record = await processDirectiveFile({
        projectId,
        originalName: req.file.originalname,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
      });
      res.json(record);
    } catch (e: any) {
      // 서버 측엔 원본 스택을 그대로 남겨 운영자가 파서·디스크 I/O 원인을 추적할
      // 수 있게 한다. 반면 클라이언트에는 내부 구현 세부를 흘리지 않고, 파일 타입
      // 기반으로 단일화한 사용자 친화 문구만 돌려준다. PDF 경로는 fileProcessor
      // 단계에서 이미 폴백하므로 여기 도달했다면 디스크 저장 등 복구 불가 실패다.
      console.error('[directive/upload] failed:', e?.stack || e?.message || e);
      const originalName = req.file?.originalname || '';
      const ext = originalName.toLowerCase().split('.').pop() || '';
      const isPdf = ext === 'pdf' || req.file?.mimetype === 'application/pdf';
      const friendly = isPdf
        ? 'PDF 해석에 실패했습니다. 다른 파일을 시도해 주세요.'
        : '파일 업로드에 실패했습니다. 다른 파일을 시도해 주세요.';
      res.status(500).json({ error: friendly });
    }
  });

  // ─── 멀티미디어 엔드포인트 (지시 #f6052a91, 1차 스켈레톤) ─────────────────
  // `/api/media/upload` — PDF/PPT/이미지/영상을 받아 MediaAsset 을 돌려준다.
  // `/api/media/generate` — 프롬프트 기반 영상 생성 요청. VideoGenAdapter 가
  //   등록되지 않은 기본 상태에서는 503 으로 수렴해, 운영자가 어댑터를 붙이기
  //   전까지 UI 가 "등록되지 않음" 피드백만 받도록 설계한다. 영상 외 kind 는 501.
  //
  // 본 두 엔드포인트는 아직 DB 영속·객체 스토리지 업로드를 하지 않는다 — 다음
  // 사이클에서 `mediaAssetsCol` 과 workspace 파일 저장을 덧붙일 예정.
  const mediaUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 }, // 영상 포함 최대 200MB. 대용량은 추후 스트리밍 전환.
  });
  const mediaProcessor = createMediaProcessor();

  app.post('/api/media/upload', mediaUpload.single('file'), async (req, res) => {
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }
    if (!req.file)  { res.status(400).json({ error: 'file required' }); return; }
    const project = await projectsCol.findOne({ id: projectId });
    if (!project)   { res.status(404).json({ error: 'project not found' }); return; }

    const kind: MediaKind | null = inferMediaKind(req.file.originalname, req.file.mimetype);
    if (!kind) {
      res.status(415).json({ error: '지원하지 않는 미디어 형식입니다.' });
      return;
    }

    try {
      const parseResult = await mediaProcessor.parse({
        buffer: req.file.buffer,
        name: req.file.originalname,
        mimeType: req.file.mimetype,
      });
      const asset: MediaAsset = {
        id: uuidv4(),
        projectId,
        kind,
        name: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        createdAt: new Date().toISOString(),
        extractedText: parseResult.extractedText,
        thumbnails: parseResult.thumbnails,
      };
      // 업로드 경로도 프로젝트 단위 자료 축(mediaAssetStore)에 적재해 FileHistoryPanel 이
      // 최신순 리스트를 그릴 수 있게 한다. generate 경로와 같은 저장소를 공유한다.
      mediaAssetStore.save(asset);
      res.json(asset);
    } catch (e) {
      if (e instanceof NotImplementedMediaError) {
        // 미구현 어댑터(PPT 등)는 501 로 돌려 UI 가 "지원 예정" 을 명시할 수 있게 한다.
        res.status(501).json({ error: e.message });
        return;
      }
      console.error('[media/upload] failed:', (e as Error)?.stack || (e as Error)?.message || e);
      res.status(500).json({ error: '미디어 업로드에 실패했습니다.' });
    }
  });

  // FileHistoryPanel(#472c5b8d) — 프로젝트별 업로드/생성 파일 내역을 최신순으로 돌려 준다.
  // 클라이언트는 `src/utils/listProjectFiles.ts` 래퍼로 호출한다. 서버는 mediaAssetStore
  // 에서 프로젝트 단위 목록을 그대로 투영한다(버퍼·스토리지 URL 은 별도 경로).
  app.get('/api/projects/:id/files', async (req, res) => {
    const projectId = typeof req.params?.id === 'string' ? req.params.id.trim() : '';
    if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }
    const project = await projectsCol.findOne({ id: projectId });
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    const items = mediaAssetStore.listByProject(projectId);
    res.json({ items });
  });

  // 개별 파일 삭제 — FileHistoryPanel 의 삭제 버튼이 호출. 서버 영속은 인메모리 저장소
  // 뿐이라 삭제는 즉시 반영되며, Mongo 이관 시 본 경로에서 DB 삭제를 덧붙이면 된다.
  app.delete('/api/projects/:id/files/:fileId', async (req, res) => {
    const projectId = typeof req.params?.id === 'string' ? req.params.id.trim() : '';
    const fileId = typeof req.params?.fileId === 'string' ? req.params.fileId.trim() : '';
    if (!projectId || !fileId) { res.status(400).json({ error: 'projectId and fileId required' }); return; }
    const existing = mediaAssetStore.get(fileId);
    if (!existing || existing.projectId !== projectId) {
      res.status(404).json({ error: 'file not found' });
      return;
    }
    const removed = mediaAssetStore.delete(fileId);
    res.json({ ok: removed });
  });

  // 지시 #b425328e §1~§2 — 생성 축 실제 라우팅.
  // 서버 기동 시 한 번 만든 mediaGenerator 인스턴스를 `/api/media/generate` 요청마다
  // 재사용한다. `sessionStatusProvider` 로 claudeSessionStatus 를 주입해 exhausted
  // 상태에서 외부 영상 API 호출이 자동 차단되게 한다(§4 폴백 가드 연동).
  const mediaGenerator = createMediaGenerator({
    sessionStatusProvider: () => claudeSessionStatus,
  });
  const mediaAssetStore = getMediaAssetStore();

  app.post('/api/media/generate', async (req, res) => {
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const prompt    = typeof req.body?.prompt    === 'string' ? req.body.prompt.trim()    : '';
    const rawKind   = typeof req.body?.kind      === 'string' ? req.body.kind.trim()      : '';
    if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }
    const project = await projectsCol.findOne({ id: projectId });
    if (!project)   { res.status(404).json({ error: 'project not found' }); return; }

    try {
      if (rawKind === 'video') {
        if (!prompt) { res.status(400).json({ error: 'prompt required' }); return; }
        const asset = await mediaGenerator.generateVideo({ prompt, projectId });
        mediaAssetStore.save(asset);
        // §3: 생성 성공 시 CollabTimeline 훅에 알림(emitter 미등록 시 no-op).
        notifyAgentMediaGenerated(asset, { from: 'system', to: 'leader' });
        res.json(asset);
        return;
      }

      if (rawKind === 'pdf') {
        // 요청 본문에서 리포트 템플릿을 받되 최소 필드(title) 만 강제.
        const template: PdfReportTemplate = {
          title: typeof req.body?.template?.title === 'string' && req.body.template.title.trim()
            ? req.body.template.title.trim()
            : (prompt || '보고서'),
          sections: Array.isArray(req.body?.template?.sections)
            ? req.body.template.sections
                .filter((s: unknown): s is { heading: unknown; body: unknown } => !!s && typeof s === 'object')
                .map((s: { heading: unknown; body: unknown }) => ({
                  heading: typeof s.heading === 'string' ? s.heading : '',
                  body: typeof s.body === 'string' ? s.body : '',
                }))
            : [],
        };
        const attachedIds: string[] = Array.isArray(req.body?.assetIds) ? req.body.assetIds.filter((x: unknown) => typeof x === 'string') : [];
        const assets = attachedIds
          .map(id => mediaAssetStore.get(id))
          .filter((a): a is NonNullable<typeof a> => !!a);
        const asset = await mediaGenerator.generatePdfReport({ assets, template, projectId });
        mediaAssetStore.save(asset);
        // §3: 생성 성공 시 CollabTimeline 훅에 알림(emitter 미등록 시 no-op).
        notifyAgentMediaGenerated(asset, { from: 'system', to: 'leader' });
        res.json(asset);
        return;
      }

      if (rawKind === 'pptx') {
        const rawSlides = Array.isArray(req.body?.slides) ? req.body.slides : [];
        const slides: PptxSlide[] = rawSlides
          .filter((s: unknown): s is { title: unknown; body?: unknown } => !!s && typeof s === 'object')
          .map((s: { title: unknown; body?: unknown }) => ({
            title: typeof s.title === 'string' ? s.title : '',
            body: typeof s.body === 'string' ? s.body : undefined,
          }));
        if (slides.length === 0) {
          res.status(400).json({ error: 'slides required (배열에 title 포함 항목이 있어야 합니다)' });
          return;
        }
        const asset = await mediaGenerator.generatePptxDeck({ slides, projectId });
        mediaAssetStore.save(asset);
        // §3: 생성 성공 시 CollabTimeline 훅에 알림(emitter 미등록 시 no-op).
        notifyAgentMediaGenerated(asset, { from: 'system', to: 'leader' });
        res.json(asset);
        return;
      }

      res.status(501).json({ error: `생성 미구현: kind=${rawKind || '(미지정)'}` });
    } catch (e) {
      if (e instanceof ExhaustedBlockedError) {
        // §4 가드 — 사용자 UX 에서 "세션 소진" 배너 경로로 수렴.
        res.status(503).json({ error: e.message, category: e.category });
        return;
      }
      console.error('[media/generate] failed:', (e as Error)?.stack || (e as Error)?.message || e);
      res.status(500).json({ error: '미디어 생성에 실패했습니다.' });
    }
  });

  // Helper to get full state
  const getGameState = async (): Promise<GameState> => {
    const [projects, agents, files, dependencies] = await Promise.all([
      projectsCol.find({}, { projection: { _id: 0 } }).toArray(),
      agentsCol.find({}, { projection: { _id: 0 } }).toArray(),
      filesCol.find({}, { projection: { _id: 0 } }).toArray(),
      depsCol.find({}, { projection: { _id: 0 } }).toArray(),
    ]);
    return {
      projects: projects as Project[],
      agents: agents as Agent[],
      files: files as CodeFile[],
      dependencies: dependencies as CodeDependency[],
    };
  };

  const getTasks = async () =>
    tasksCol.find({}, { projection: { _id: 0 } }).toArray();

  // API Routes
  app.get('/api/state', async (req, res) => {
    res.json(await getGameState());
  });

  // 에이전트 상태 전용 엔드포인트. 클라이언트가 새로고침 직후 소켓 연결 전에
  // currentTask / status / lastActiveTask 를 즉시 복원해 "working 중이던 카드가
  // 빈 상태로 그려지는 1프레임 플래시" 를 막는다. DB 가 유일 진원이므로 서버
  // 재기동 후에도 동일 페이로드를 돌려준다.
  app.get('/api/agents', async (_req, res) => {
    const agents = await agentsCol.find({}, { projection: { _id: 0 } }).toArray();
    res.json(agents);
  });

  app.get('/api/tasks', async (req, res) => {
    res.json(await getTasks());
  });

  app.post('/api/tasks', async (req, res) => {
    const { projectId, assignedTo, description, source } = req.body;
    const task: Task = {
      id: uuidv4(),
      projectId,
      assignedTo,
      description,
      status: 'pending',
      source: source === 'leader' || source === 'auto-dev' ? source : 'user',
    };
    await tasksCol.insertOne(task);
    io.emit('tasks:updated', await getTasks());
    res.json(task);
    // 서버가 직접 워커 큐에 dispatch 한다. 에이전트별 상시 프로세스가
    // 유지되므로 새 지시는 기존 세션에 이어져 컨텍스트가 누적된다.
    taskRunner.dispatchTask(task).catch(err =>
      console.error('[tasks] dispatch failed:', (err as Error).message),
    );
  });

  app.patch('/api/tasks/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!status) { res.status(400).json({ error: 'status required' }); return; }

    const task = await tasksCol.findOne({ id });
    if (!task) { res.status(404).json({ error: 'task not found' }); return; }

    await tasksCol.updateOne({ id }, { $set: { status } });

    // 태스크 착수 시 에이전트를 working으로 전환
    if (status === 'in-progress' && task.assignedTo) {
      await agentsCol.updateOne(
        { id: task.assignedTo },
        { $set: { status: 'working', currentTask: id } },
      );
      io.emit('state:updated', await getGameState());
    }

    // 태스크 완료 시 에이전트를 idle로 복귀.
    // currentTask 는 비우되 lastActiveTask 에 id 를 적재해 클라이언트가 새로고침
    // 후에도 "마지막으로 이 에이전트가 다룬 태스크" 를 복원할 수 있게 한다.
    if (status === 'completed' && task.assignedTo) {
      await agentsCol.updateOne(
        { id: task.assignedTo, currentTask: id },
        { $set: { status: 'idle', currentTask: '', workingOnFileId: '', lastActiveTask: id } },
      );
      io.emit('state:updated', await getGameState());
      // 리더 자동화: 완료된 태스크가 리더 본인(Leader) 이 아닌 다른 에이전트의
      // 작업일 때만 자동 git 실행을 시도한다. Leader 는 orchestration 전용이라
      // 본인의 "completed" 를 다시 트리거하면 무한 루프 위험이 있다.
      const actor = await agentsCol.findOne({ id: task.assignedTo });
      if (actor && actor.role !== 'Leader') {
        executeGitAutomation(task.projectId, {
          type: 'chore',
          summary: task.description?.slice(0, 64) || 'auto update',
          agent: actor.name,
          // 긴급 수정 #a7b258fb: 태스크 완료 PATCH 경로도 taskRunner 훅과 동일하게
          // 커밋+푸시를 한 번에 원격까지 반영하도록 강제한다.
          forcePush: true,
        }).catch(err => console.error('[git-automation] auto-run failed:', err?.message));
      }
      // 전원 idle 수렴 감시기 — 이번 태스크 완료로 프로젝트 전체가 idle 이 된
      // 경우 집계 커밋을 1회 발사한다. 개별 태스크 트리거와 중복돼도 tracker
      // rising-edge 가드가 1회로 수렴시킨다.
      allAgentsCompletedWatcher(task.projectId).catch(err =>
        console.error('[all-agents-watcher] tick failed:', (err as Error).message),
      );
    }

    io.emit('tasks:updated', await getTasks());
    res.json({ success: true });
  });

  app.post('/api/projects', async (req, res) => {
    const { name, description, workspacePath } = req.body;
    const id = uuidv4();
    const finalPath = workspacePath || `./workspaces/${name.toLowerCase().replace(/\s+/g, '-')}`;
    resolveWorkspace(finalPath);

    const leader = await agentsCol.findOne({ role: 'Leader' });
    const project: Project = {
      id,
      name,
      description,
      workspacePath: finalPath,
      status: 'active',
      agents: leader ? [leader.id] : [],
      // 프로젝트 관리 옵션 기본값 주입. MongoDB 는 스키마리스라 이 필드들이
      // 문서에 없어도 읽기는 가능하지만, 생성 시 한 번에 채워 넣어 후속 PATCH /
      // UI 로직이 undefined 폴백을 반복하지 않도록 한다.
      autoDevEnabled: PROJECT_OPTION_DEFAULTS.autoDevEnabled,
      autoCommitEnabled: PROJECT_OPTION_DEFAULTS.autoCommitEnabled,
      autoPushEnabled: PROJECT_OPTION_DEFAULTS.autoPushEnabled,
      defaultBranch: PROJECT_OPTION_DEFAULTS.defaultBranch,
      settingsJson: { ...PROJECT_OPTION_DEFAULTS.settingsJson },
    };
    await projectsCol.insertOne(project);

    io.emit('state:updated', await getGameState());
    res.json(project);
  });

  // 프로젝트 관리 옵션 부분 업데이트. 스키마리스 저장이라 null 로 명시된 필드는
  // $unset 으로 제거하고, 지정되지 않은 필드는 건드리지 않는다. sharedGoalId 가
  // 제공되면 동일 프로젝트 스코프의 활성/보관 목표를 실제로 가리키는지 검증한다.
  app.patch('/api/projects/:id', async (req, res) => {
    const { id } = req.params;
    const project = await projectsCol.findOne({ id });
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    const body = (req.body || {}) as ProjectOptionsUpdate;

    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};

    const assignBool = (key: keyof ProjectOptionsUpdate) => {
      if (body[key] === undefined) return;
      if (typeof body[key] !== 'boolean') {
        throw new Error(`${key} 는 boolean 이어야 합니다`);
      }
      $set[key] = body[key];
    };
    try {
      assignBool('autoDevEnabled');
      assignBool('autoCommitEnabled');
      assignBool('autoPushEnabled');

      if (body.defaultBranch !== undefined) {
        if (typeof body.defaultBranch !== 'string' || !body.defaultBranch.trim()) {
          throw new Error('defaultBranch 는 비어있지 않은 문자열이어야 합니다');
        }
        $set.defaultBranch = body.defaultBranch.trim();
      }
      if (body.gitRemoteUrl !== undefined) {
        if (body.gitRemoteUrl === null) $unset.gitRemoteUrl = '';
        else if (typeof body.gitRemoteUrl === 'string') $set.gitRemoteUrl = body.gitRemoteUrl.trim();
        else throw new Error('gitRemoteUrl 은 문자열 또는 null 이어야 합니다');
      }
      if (body.sharedGoalId !== undefined) {
        if (body.sharedGoalId === null) $unset.sharedGoalId = '';
        else if (typeof body.sharedGoalId === 'string') {
          const goal = await sharedGoalsCol.findOne({ id: body.sharedGoalId, projectId: id });
          if (!goal) throw new Error('지정한 sharedGoalId 가 이 프로젝트에 존재하지 않습니다');
          $set.sharedGoalId = body.sharedGoalId;
        } else throw new Error('sharedGoalId 는 문자열 또는 null 이어야 합니다');
      }
      if (body.settingsJson !== undefined) {
        if (!body.settingsJson || typeof body.settingsJson !== 'object' || Array.isArray(body.settingsJson)) {
          throw new Error('settingsJson 은 객체여야 합니다');
        }
        $set.settingsJson = body.settingsJson;
      }
    } catch (e: any) {
      res.status(400).json({ error: e?.message || 'invalid payload' });
      return;
    }

    if (Object.keys($set).length === 0 && Object.keys($unset).length === 0) {
      res.status(400).json({ error: '갱신할 필드가 없습니다' });
      return;
    }
    const update: Record<string, unknown> = {};
    if (Object.keys($set).length > 0) update.$set = $set;
    if (Object.keys($unset).length > 0) update.$unset = $unset;
    await projectsCol.updateOne({ id }, update);
    const saved = await projectsCol.findOne({ id }, { projection: { _id: 0 } });
    io.emit('state:updated', await getGameState());
    res.json(saved);
  });

  // 프로젝트 관리 옵션 전용 조회. PATCH /api/projects/:id 와 달리 옵션 필드만
  // 노출해 클라이언트 훅(useProjectOptions)이 GameState 전체를 수신하지 않고도
  // 새로고침/재로그인 직후 권위값을 복원할 수 있다.
  app.get('/api/projects/:id/options', async (req, res) => {
    const { id } = req.params;
    const project = await projectsCol.findOne({ id }, { projection: { _id: 0 } });
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    res.json(projectOptionsView(project));
  });

  // 프로젝트 관리 옵션 부분 업데이트. 검증은 updateProjectOptionsSchema 가 담당하고,
  // 저장은 projectsCol.updateOne 에 위임한다(별도 storage 모듈이 없음). sharedGoalId
  // 는 해당 프로젝트 스코프의 목표를 가리키는지 DB 조회로 교차 검증한다.
  app.patch('/api/projects/:id/options', async (req, res) => {
    const { id } = req.params;
    const project = await projectsCol.findOne({ id });
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }

    let validated;
    try {
      validated = updateProjectOptionsSchema(req.body);
    } catch (e) {
      if (e instanceof ProjectOptionsValidationError) {
        res.status(400).json({ error: e.message, field: e.field });
        return;
      }
      res.status(400).json({ error: (e as Error).message || 'invalid payload' });
      return;
    }

    if (!hasAnyUpdate(validated)) {
      res.status(400).json({ error: '갱신할 필드가 없습니다' });
      return;
    }

    if (typeof validated.$set.sharedGoalId === 'string') {
      const goal = await sharedGoalsCol.findOne({ id: validated.$set.sharedGoalId, projectId: id });
      if (!goal) {
        res.status(400).json({ error: '지정한 sharedGoalId 가 이 프로젝트에 존재하지 않습니다', field: 'sharedGoalId' });
        return;
      }
    }

    const update: Record<string, unknown> = {};
    if (Object.keys(validated.$set).length > 0) update.$set = validated.$set;
    if (Object.keys(validated.$unset).length > 0) update.$unset = validated.$unset;
    await projectsCol.updateOne({ id }, update);
    const saved = await projectsCol.findOne({ id }, { projection: { _id: 0 } });
    if (!saved) { res.status(404).json({ error: 'project not found' }); return; }
    io.emit('state:updated', await getGameState());
    io.emit('project-options:updated', { projectId: id, options: projectOptionsView(saved) });
    res.json(projectOptionsView(saved));
  });

  app.delete('/api/projects/:id', async (req, res) => {
    const { id } = req.params;
    // 프로젝트에 배정돼있던 에이전트 워커를 모두 종료한다. 다른 프로젝트로 재배정되면
    // ensureWorkerForAgent 가 새 컨텍스트로 다시 spawn 한다.
    const project = await projectsCol.findOne({ id });
    if (project?.agents) {
      for (const agentId of project.agents) taskRunner.disposeAgentWorker(agentId);
    }
    // tracker 상태 초기화 — 같은 ID 의 프로젝트가 이후 재생성되더라도 이전 phase 가
    // 유령처럼 남아 첫 관측 결과를 왜곡하지 않도록 한다.
    completionTracker.reset(id);
    const files = await filesCol.find({ projectId: id }).toArray();
    const fileIds = files.map(f => f.id);
    await projectsCol.deleteOne({ id });
    await filesCol.deleteMany({ projectId: id });
    if (fileIds.length > 0) {
      await depsCol.deleteMany({ $or: [{ from: { $in: fileIds } }, { to: { $in: fileIds } }] });
    }
    await tasksCol.deleteMany({ projectId: id });
    io.emit('state:updated', await getGameState());
    io.emit('tasks:updated', await getTasks());
    res.json({ success: true });
  });

  // 현재 프로젝트 워크스페이스 절대 경로를 OS 파일 관리자(Explorer / Finder / xdg-open)로 연다.
  app.post('/api/projects/:id/open-workspace', async (req, res) => {
    const { id } = req.params;
    const project = await projectsCol.findOne({ id });
    if (!project) {
      res.status(404).json({ ok: false, error: 'project_not_found' });
      return;
    }
    const abs = resolveWorkspace(project.workspacePath);
    const out = await openFolderInOsFileManager(abs);
    if (!out.ok) {
      const status = out.error === 'path_not_found' ? 404 : 500;
      res.status(status).json({ ok: false, error: out.error ?? 'open_failed' });
      return;
    }
    res.json({ ok: true });
  });

  // VS Code / Cursor CLI — 본체 설치 후 "PATH에 shell 명령 등록" 이 되어 있어야 한다.
  app.post('/api/projects/:id/open-in-ide', async (req, res) => {
    const { id } = req.params;
    const project = await projectsCol.findOne({ id });
    if (!project) {
      res.status(404).json({ ok: false, error: 'project_not_found' });
      return;
    }
    const raw = req.body && typeof (req.body as { ide?: unknown }).ide === 'string'
      ? String((req.body as { ide: string }).ide).trim().toLowerCase()
      : '';
    const ide: WorkspaceIdeCli | null = raw === 'code' || raw === 'vscode' ? 'code'
      : raw === 'cursor' ? 'cursor'
        : null;
    if (!ide) {
      res.status(400).json({ ok: false, error: 'ide_required' });
      return;
    }
    const abs = resolveWorkspace(project.workspacePath);
    const out = await openWorkspaceInIdeCli(abs, ide);
    if (!out.ok) {
      const status = out.error === 'path_not_found' ? 404 : 500;
      res.status(status).json({ ok: false, error: out.error ?? 'open_failed' });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/agents', async (req, res) => {
    const { id } = req.params;
    const { agentId } = req.body;
    if (!agentId) { res.status(400).json({ error: 'agentId required' }); return; }
    const project = await projectsCol.findOne({ id });
    const agent = await agentsCol.findOne({ id: agentId });
    if (!project || !agent) { res.status(404).json({ error: 'not found' }); return; }
    await projectsCol.updateOne({ id }, { $addToSet: { agents: agentId } });
    io.emit('state:updated', await getGameState());
    res.json({ success: true });
  });

  app.delete('/api/projects/:id/agents/:agentId', async (req, res) => {
    const { id, agentId } = req.params;
    // 프로젝트에서 해제된 에이전트의 워커는 기존 프로젝트 컨텍스트(시스템 프롬프트·cwd·MCP)
    // 를 쥐고 있으므로 dispose 해 두고, 다른 프로젝트에 재배정될 때 새 컨텍스트로 spawn 되게 한다.
    taskRunner.disposeAgentWorker(agentId);
    await projectsCol.updateOne({ id }, { $pull: { agents: agentId } });
    await tasksCol.deleteMany({ projectId: id, assignedTo: agentId });
    io.emit('state:updated', await getGameState());
    io.emit('tasks:updated', await getTasks());
    res.json({ success: true });
  });

  app.post('/api/agents/hire', async (req, res) => {
    const { name, role, spriteTemplate, persona } = req.body;
    const agent: Agent = {
      id: uuidv4(),
      name,
      role,
      spriteTemplate,
      persona: persona?.trim() || undefined,
      x: Math.random() * 500,
      y: Math.random() * 500,
      status: 'idle',
    };
    await agentsCol.insertOne(agent);

    io.emit('state:updated', await getGameState());
    res.json(agent);
  });

  app.post('/api/agent/think', async (req, res) => {
    const { prompt, agentId, projectId } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt required' });
      return;
    }
    // 에이전트/프로젝트가 지정된 경우: 상시 워커로 enqueue. 워커가 비어있으면
    // 즉시 실행되고, 앞선 지시가 처리 중이면 대기했다가 순서대로 처리된다.
    if (agentId && projectId) {
      const [agent, project] = await Promise.all([
        agentsCol.findOne({ id: agentId }, { projection: { _id: 0 } }),
        projectsCol.findOne({ id: projectId }, { projection: { _id: 0 } }),
      ]);
      if (!agent || !project) {
        res.status(404).json({ error: 'agent or project not found' });
        return;
      }
      try {
        const worker = await taskRunner.ensureWorkerForAgent(agent as Agent, project as Project);
        const text = await worker.enqueue(prompt);
        res.json({ text });
      } catch (e: any) {
        console.error('worker enqueue failed:', e?.message);
        res.status(500).json({ error: e?.message || 'claude failed' });
      }
      return;
    }
    // 컨텍스트 없는 일회성 호출(진단·ping 등)은 1-shot 경로. 프로바이더 추상화
    // 덕분에 LLM_PROVIDER 값에 따라 claude-cli/ollama/vllm 어느 쪽으로든 간다.
    try {
      const text = await callLLMOneshot(prompt);
      res.json({ text });
    } catch (e: any) {
      console.error('claude CLI failed:', e?.message);
      res.status(500).json({ error: e?.message || 'claude failed' });
    }
  });

  // 자동개발 상태 조회/갱신. 서버가 source of truth 를 소유하므로 어느 브라우저에서
  // 토글해도 즉시 모든 세션에 전파되고(서버 소켓 이벤트), 재접속 후에도 복원된다.
  app.get('/api/auto-dev', (_req, res) => {
    res.json(taskRunner.getAutoDev());
  });

  app.patch('/api/auto-dev', async (req, res) => {
    const { enabled, projectId } = req.body || {};
    try {
      const next = await taskRunner.setAutoDev({
        enabled: typeof enabled === 'boolean' ? enabled : undefined,
        projectId: projectId === null ? undefined : (typeof projectId === 'string' ? projectId : undefined),
      });
      res.json(next);
    } catch (e: any) {
      // 활성 공동 목표 미설정은 운영자가 UI 에서 즉시 복구 가능한 사용자 오류이므로
      // 400 으로 내려보내 토스트·배지로 안내한다. 다른 오류는 기존 5xx 경로로 승격.
      if (e?.code === 'SHARED_GOAL_REQUIRED') {
        res.status(400).json({ error: e.message, code: 'SHARED_GOAL_REQUIRED' });
        return;
      }
      console.error('[auto-dev] setAutoDev failed:', e?.message);
      res.status(500).json({ error: e?.message || 'auto-dev update failed' });
    }
  });

  // --- MCP-backed endpoints ---
  // 에이전트(또는 MCP 도구)가 스스로 상태를 보고하는 엔드포인트. 워커 아키텍처
  // 도입 이후 태스크 완료/ git 자동화 트리거는 전적으로 TaskRunner.dispatchTask
  // 가 소유한다. 이 엔드포인트는 UI 표시용 상태 필드만 갱신해 "이중 완료 처리" 를 막는다.
  app.patch('/api/agents/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status, workingOnFileId } = req.body || {};
    const update: Record<string, unknown> = {};
    if (status !== undefined) update.status = status;
    if (workingOnFileId !== undefined) update.workingOnFileId = workingOnFileId;
    if (status === 'idle') {
      // 다음 새로고침에도 "직전 작업 컨텍스트" 를 잃지 않도록 lastActiveTask 에 id 를 남긴다.
      const agent = await agentsCol.findOne({ id });
      const taskId = agent?.currentTask;
      update.currentTask = '';
      if (taskId) update.lastActiveTask = taskId;
    }
    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: 'nothing to update' });
      return;
    }
    await agentsCol.updateOne({ id }, { $set: update });
    io.emit('state:updated', await getGameState());
    // 상태 전이에 따라 이 에이전트가 속한 모든 프로젝트의 completion 감시기를 재평가.
    // 같은 에이전트가 동시에 여러 프로젝트에 매핑되는 일은 드물지만, projectId 를
    // body 에 요구하지 않는 이 엔드포인트에서는 agents 배열에 포함된 모든 프로젝트를
    // 후보로 본다.
    const owningProjects = await projectsCol
      .find({ agents: id }, { projection: { _id: 0, id: 1 } })
      .toArray();
    for (const p of owningProjects) {
      allAgentsCompletedWatcher(p.id).catch(err =>
        console.error('[all-agents-watcher] tick failed:', (err as Error).message),
      );
    }
    res.json({ success: true });
  });

  app.get('/api/files', async (req, res) => {
    const { projectId } = req.query;
    const query = projectId ? { projectId: String(projectId) } : {};
    const files = await filesCol.find(query, { projection: { _id: 0 } }).toArray();
    res.json(files);
  });

  app.post('/api/files', async (req, res) => {
    const { name, projectId, type } = req.body || {};
    if (!name || !projectId) {
      res.status(400).json({ error: 'name and projectId required' });
      return;
    }
    const normalizedName = normalizeCodeGraphPath(String(name));
    if (!normalizedName) {
      res.status(400).json({ error: 'name required' });
      return;
    }
    if (isExcludedFromCodeGraph(normalizedName)) {
      res.status(400).json({ error: `path excluded from code graph: ${name}` });
      return;
    }
    const projectIdStr = String(projectId);
    // 중복 체크: 같은 프로젝트에 동일 정규화 경로가 이미 있으면 새 id 를 만들지 않고
    // 기존 노드를 그대로 돌려준다. 그래프가 유령 노드로 분열되지 않도록 보장.
    const existing = await filesCol.findOne(
      { projectId: projectIdStr, name: normalizedName },
      { projection: { _id: 0 } },
    );
    if (existing) {
      res.json(existing);
      return;
    }
    const file: CodeFile = {
      id: uuidv4(),
      name: normalizedName,
      x: 0,
      y: 0,
      projectId: projectIdStr,
      type: (type as CodeFile['type']) || inferFileType(normalizedName),
    };
    try {
      await filesCol.insertOne(file);
    } catch (e: any) {
      // 동시 삽입 경합으로 unique index 에 걸렸을 때의 폴백. 다른 호출이 먼저
      // 만든 노드를 찾아 돌려주면 호출자 입장에서는 add_file 이 "성공" 한 것과
      // 구분되지 않는다.
      if (e && (e.code === 11000 || /duplicate key/i.test(e?.message || ''))) {
        const winner = await filesCol.findOne(
          { projectId: projectIdStr, name: normalizedName },
          { projection: { _id: 0 } },
        );
        if (winner) { res.json(winner); return; }
      }
      console.error('[files] insert failed:', e?.message);
      res.status(500).json({ error: e?.message || 'insert failed' });
      return;
    }
    io.emit('state:updated', await getGameState());
    res.json(file);
  });

  // docs/handoffs · docs/reports 디렉터리의 md 프론트매터를 파싱해 반환.
  // 클라이언트(CollabTimeline)가 직접 파일을 읽지 않도록 서버가 단일 소스를 소유한다.
  // §6.3 리뷰에 따라 TTL 캐시는 프로파일링 전까지 도입하지 않는다(파일 10여 건 규모).
  app.get('/api/collab/timeline', (_req, res) => {
    const entries: LedgerEntry[] = [];
    const collect = (relDir: string, kind: 'handoff' | 'report') => {
      const abs = path.resolve(process.cwd(), relDir);
      let names: string[];
      try {
        names = readdirSync(abs);
      } catch {
        return;
      }
      for (const name of names) {
        if (!name.endsWith('.md') || /readme/i.test(name)) continue;
        const full = path.join(abs, name);
        try {
          const content = readFileSync(full, 'utf8');
          entries.push(parseEntry({
            path: `${relDir}/${name}`,
            kind,
            content,
          }));
        } catch (e) {
          console.warn(`[collab/timeline] failed to read ${full}: ${(e as Error).message}`);
        }
      }
    };
    collect('docs/handoffs', 'handoff');
    collect('docs/reports', 'report');
    res.json(entries);
  });

  app.post('/api/dependencies', async (req, res) => {
    const { from, to } = req.body || {};
    if (!from || !to) {
      res.status(400).json({ error: 'from and to required' });
      return;
    }
    await depsCol.insertOne({ from: String(from), to: String(to) });
    io.emit('state:updated', await getGameState());
    res.json({ success: true });
  });

  // 그래프 초기화: 특정 프로젝트(projectId 쿼리) 또는 전체 코드그래프를 비운다.
  // 에이전트가 만지던 working 파일 참조도 끊어 좀비 링크가 남지 않게 한다.
  app.post('/api/graph/reset', async (req, res) => {
    const raw = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    if (raw) {
      const files = await filesCol.find({ projectId: raw }).toArray();
      const fileIds = files.map(f => f.id);
      const filesDeleted = await filesCol.deleteMany({ projectId: raw });
      let depsDeleted = { deletedCount: 0 } as { deletedCount?: number };
      if (fileIds.length > 0) {
        depsDeleted = await depsCol.deleteMany({ $or: [{ from: { $in: fileIds } }, { to: { $in: fileIds } }] });
      }
      if (fileIds.length > 0) {
        await agentsCol.updateMany(
          { workingOnFileId: { $in: fileIds } },
          { $set: { workingOnFileId: '' } },
        );
      }
      io.emit('state:updated', await getGameState());
      res.json({
        scope: 'project',
        projectId: raw,
        filesDeleted: filesDeleted.deletedCount ?? 0,
        dependenciesDeleted: depsDeleted.deletedCount ?? 0,
      });
      return;
    }
    const filesDeleted = await filesCol.deleteMany({});
    const depsDeleted = await depsCol.deleteMany({});
    await agentsCol.updateMany({}, { $set: { workingOnFileId: '' } });
    io.emit('state:updated', await getGameState());
    res.json({
      scope: 'all',
      filesDeleted: filesDeleted.deletedCount ?? 0,
      dependenciesDeleted: depsDeleted.deletedCount ?? 0,
    });
  });

  // --- Source integrations (GitHub / GitLab) ---
  const redactIntegration = (i: SourceIntegration) => ({ ...i, accessToken: '' });

  // 프로젝트 스코프가 지정되지 않은 호출은 400 으로 거절한다. 클라이언트가
  // "선택된 프로젝트 없음" 상태에서 fetch 를 아예 건너뛰도록 유도하는 쪽이
  // 빈 배열로 조용히 응답하는 것보다 회귀 포착에 더 유리하다.
  app.get('/api/integrations', async (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }
    const items = await integrationsCol.find({ projectId }, { projection: { _id: 0 } }).toArray();
    res.json(items.map(i => redactIntegration(i as SourceIntegration)));
  });

  const normalizeHost = (raw: unknown): string | undefined => {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return undefined;
    const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    return withScheme.replace(/\/+$/, '');
  };

  app.post('/api/integrations', async (req, res) => {
    const { provider, label, accessToken, host, projectId } = req.body || {};
    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ error: 'projectId required' });
      return;
    }
    if (!provider || !accessToken || (provider !== 'github' && provider !== 'gitlab')) {
      res.status(400).json({ error: 'provider (github|gitlab) and accessToken required' });
      return;
    }
    const integration: SourceIntegration = {
      id: uuidv4(),
      projectId,
      provider: provider as SourceProvider,
      label: String(label || provider),
      accessToken: String(accessToken),
      host: normalizeHost(host),
      createdAt: new Date().toISOString(),
    };
    await integrationsCol.insertOne(integration);
    res.json(redactIntegration(integration));
  });

  app.delete('/api/integrations/:id', async (req, res) => {
    await integrationsCol.deleteOne({ id: req.params.id });
    res.json({ success: true });
  });

  // --- 프로젝트 설정 화면용 Git 자격증명 (GitCredentialsSection) ---
  // localStorage 기반 토큰 저장을 걷어내고 전부 여기로 모은다. 저장은 AES-256-GCM
  // 암호문으로만 이루어지고, 응답에는 암호문조차 노출하지 않는다(hasToken 배지로만 표기).
  const redactCredential = (c: GitCredential): GitCredentialRedacted => {
    const { tokenEncrypted, ...rest } = c;
    return { ...rest, hasToken: typeof tokenEncrypted === 'string' && tokenEncrypted.length > 0 };
  };

  // 프로젝트 공동 목표(sharedGoal) 조회·갱신. 활성 1건만 조회해 내려주며, 없으면
  // null 을 반환해 UI 가 "목표 미설정" 배지를 띄울 수 있게 한다.
  app.get('/api/projects/:id/shared-goal', async (req, res) => {
    const { id } = req.params;
    const project = await projectsCol.findOne({ id });
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    const goal = await sharedGoalsCol.findOne(
      { projectId: id, status: 'active' },
      { projection: { _id: 0 }, sort: { createdAt: -1 } },
    );
    res.json(goal || null);
  });

  app.post('/api/projects/:id/shared-goal', async (req, res) => {
    const { id } = req.params;
    const project = await projectsCol.findOne({ id });
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    const { title, description, priority, deadline, status } = req.body || {};
    const trimmedTitle = typeof title === 'string' ? title.trim() : '';
    if (!trimmedTitle) {
      res.status(400).json({ error: 'title required' });
      return;
    }
    const normalizedPriority: SharedGoalPriority =
      priority === 'low' || priority === 'high' ? priority : 'normal';
    const normalizedStatus: SharedGoalStatus =
      status === 'archived' || status === 'completed' ? status : 'active';
    const goal: SharedGoal = {
      id: uuidv4(),
      projectId: id,
      title: trimmedTitle,
      description: typeof description === 'string' ? description.trim() : '',
      priority: normalizedPriority,
      deadline: typeof deadline === 'string' && deadline.trim() ? deadline.trim() : undefined,
      status: normalizedStatus,
      createdAt: new Date().toISOString(),
    };
    // "활성 1건" 불변식: 새 목표가 active 로 들어오면 기존 활성은 archived 로 내린다.
    if (goal.status === 'active') {
      await sharedGoalsCol.updateMany(
        { projectId: id, status: 'active' },
        { $set: { status: 'archived' } },
      );
    }
    await sharedGoalsCol.insertOne(goal);
    res.json(goal);
  });

  app.get('/api/projects/:id/git-credentials', async (req, res) => {
    const projectId = String(req.params.id || '').trim();
    if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }
    const row = await gitCredentialsCol.findOne({ projectId }, { projection: { _id: 0 } });
    if (!row) { res.status(404).json({ error: 'not-found' }); return; }
    res.json(redactCredential(row as GitCredential));
  });

  app.post('/api/projects/:id/git-credentials', async (req, res) => {
    const projectId = String(req.params.id || '').trim();
    if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }
    const { provider, username, token } = req.body || {};
    if (provider !== 'github' && provider !== 'gitlab') {
      res.status(400).json({ error: 'provider (github|gitlab) required' });
      return;
    }
    const user = typeof username === 'string' ? username.trim() : '';
    const pat = typeof token === 'string' ? token.trim() : '';
    if (!user || !pat) {
      res.status(400).json({ error: 'username and token required' });
      return;
    }
    let tokenEncrypted: string;
    try {
      tokenEncrypted = encryptToken(pat);
    } catch (e) {
      // GIT_TOKEN_ENC_KEY 미설정/잘못된 키 길이 등은 서버 운영 단계의 구성 오류다.
      // 평문 토큰을 로그에 남기지 않기 위해 상세 메시지만 한국어로 돌려준다.
      console.error('[git-credentials] encryption failed:', (e as Error).message);
      res.status(500).json({ error: 'token encryption unavailable' });
      return;
    }
    const existing = await gitCredentialsCol.findOne({ projectId }, { projection: { _id: 0 } });
    const nowIso = new Date().toISOString();
    const next: GitCredential = {
      projectId,
      provider: provider as SourceProvider,
      username: user,
      tokenEncrypted,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
    };
    await gitCredentialsCol.updateOne(
      { projectId },
      { $set: next },
      { upsert: true },
    );
    res.json(redactCredential(next));
  });

  app.delete('/api/projects/:id/git-credentials', async (req, res) => {
    const projectId = String(req.params.id || '').trim();
    if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }
    await gitCredentialsCol.deleteOne({ projectId });
    res.json({ success: true });
  });

  // executeGitAutomation 의 push/pr 단계에서 호출되는 내부 조회 헬퍼.
  // 성공 시 {username, token} 평문을 돌려주고, 실패(레코드 부재·복호 실패)는
  // null 로 폴백해 호출자가 기존 경로(시스템 credential helper/대화형 프롬프트)
  // 로 투명하게 내려가도록 한다.
  async function loadDecryptedCredential(
    projectId: string,
  ): Promise<{ username: string; token: string } | null> {
    const row = await gitCredentialsCol.findOne({ projectId }, { projection: { _id: 0 } });
    if (!row || !row.tokenEncrypted) return null;
    try {
      const token = decryptToken(row.tokenEncrypted);
      return { username: row.username, token };
    } catch (e) {
      console.warn(
        `[git-credentials] decrypt failed project=${projectId}: ${(e as Error).message}`,
      );
      return null;
    }
  }

  async function fetchRepos(integration: SourceIntegration): Promise<ManagedProject[]> {
    const now = new Date().toISOString();
    if (integration.provider === 'github') {
      // 공식: https://api.github.com, Enterprise: https://<host>/api/v3
      const base = integration.host
        ? `${integration.host.replace(/\/+$/, '')}/api/v3`
        : 'https://api.github.com';
      const r = await fetch(`${base}/user/repos?per_page=100&sort=updated`, {
        headers: {
          Authorization: `token ${integration.accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'llm-tycoon',
        },
      });
      if (!r.ok) throw new Error(`github ${r.status}: ${await r.text().then(t => t.slice(0, 200))}`);
      const repos = await r.json() as any[];
      return repos.map(repo => ({
        id: uuidv4(),
        projectId: integration.projectId,
        provider: 'github',
        integrationId: integration.id,
        remoteId: String(repo.id),
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description || undefined,
        url: repo.html_url,
        defaultBranch: repo.default_branch,
        private: !!repo.private,
        importedAt: now,
      }));
    }
    // gitlab (공식 또는 Self-hosted)
    const gitlabBase = (integration.host || 'https://gitlab.com').replace(/\/+$/, '');
    const r = await fetch(`${gitlabBase}/api/v4/projects?membership=true&per_page=100&order_by=updated_at`, {
      headers: { 'PRIVATE-TOKEN': integration.accessToken },
    });
    if (!r.ok) throw new Error(`gitlab ${r.status}: ${await r.text().then(t => t.slice(0, 200))}`);
    const repos = await r.json() as any[];
    return repos.map(repo => ({
      id: uuidv4(),
      projectId: integration.projectId,
      provider: 'gitlab',
      integrationId: integration.id,
      remoteId: String(repo.id),
      name: repo.name,
      fullName: repo.path_with_namespace,
      description: repo.description || undefined,
      url: repo.web_url,
      defaultBranch: repo.default_branch,
      private: repo.visibility !== 'public',
      importedAt: now,
    }));
  }

  app.post('/api/integrations/:id/import', async (req, res) => {
    const integration = await integrationsCol.findOne({ id: req.params.id });
    if (!integration) { res.status(404).json({ error: 'integration not found' }); return; }
    try {
      const repos = await fetchRepos(integration as SourceIntegration);
      let imported = 0;
      for (const repo of repos) {
        const { id: newId, ...rest } = repo;
        // projectId 도 동일성 키에 포함시켜, 같은 remote 저장소가 다른 게임 프로젝트에서
        // 동시에 관리될 때 서로 덮어쓰지 않고 각자 슬롯에 독립적으로 저장되게 한다.
        const result = await managedProjectsCol.updateOne(
          {
            projectId: repo.projectId,
            provider: repo.provider,
            remoteId: repo.remoteId,
            integrationId: repo.integrationId,
          },
          { $set: rest, $setOnInsert: { id: newId } },
          { upsert: true },
        );
        if (result.upsertedCount > 0) imported++;
      }
      res.json({ imported, total: repos.length });
    } catch (e: any) {
      console.error('[import] failed:', e?.message);
      res.status(502).json({ error: e?.message || 'import failed' });
    }
  });

  app.get('/api/managed-projects', async (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }
    const items = await managedProjectsCol.find({ projectId }, { projection: { _id: 0 } }).toArray();
    res.json(items);
  });

  app.delete('/api/managed-projects/:id', async (req, res) => {
    await managedProjectsCol.deleteOne({ id: req.params.id });
    res.json({ success: true });
  });

  // PR 대상 브랜치 등 관리 프로젝트의 설정을 부분 업데이트한다.
  // 현재는 prBaseBranch만 수용하지만 추후 설정 필드 확장 여지를 위해 PATCH로 둔다.
  app.patch('/api/managed-projects/:id', async (req, res) => {
    const { prBaseBranch, prTarget } = req.body || {};
    const setOps: Record<string, unknown> = {};
    const unsetOps: Record<string, ''> = {};
    if (prBaseBranch !== undefined) {
      const trimmed = typeof prBaseBranch === 'string' ? prBaseBranch.trim() : '';
      // 빈 문자열이면 설정을 지워 defaultBranch 폴백이 다시 동작하도록 한다.
      if (trimmed) setOps.prBaseBranch = trimmed;
      else unsetOps.prBaseBranch = '';
    }
    if (prTarget !== undefined) {
      // PR 대상 토글. true 일 때만 저장하고, false 면 키를 $unset 으로 제거한다.
      // $set 에 undefined 를 넣으면 드라이버가 값을 버려 "실제로는 아무것도 바뀌지 않는"
      // 상태가 되어 토글 해제가 반영되지 않는다.
      if (prTarget === true) setOps.prTarget = true;
      else unsetOps.prTarget = '';
    }
    if (Object.keys(setOps).length === 0 && Object.keys(unsetOps).length === 0) {
      res.status(400).json({ error: 'nothing to update' });
      return;
    }
    const ops: Record<string, unknown> = {};
    if (Object.keys(setOps).length > 0) ops.$set = setOps;
    if (Object.keys(unsetOps).length > 0) ops.$unset = unsetOps;
    const result = await managedProjectsCol.updateOne({ id: req.params.id }, ops);
    if (result.matchedCount === 0) {
      res.status(404).json({ error: 'managed project not found' });
      return;
    }
    const updated = await managedProjectsCol.findOne({ id: req.params.id }, { projection: { _id: 0 } });
    res.json(updated);
  });

  // --- Git automation settings (per project) ---
  // GET 은 저장본이 없으면 기본값을 enabled=false 로 감싸 반환한다.
  // 이렇게 해야 UI 가 "한 번도 저장하지 않은 상태"와 "저장된 뒤 비활성화한 상태"를
  // 구분해서 보여줄 수 있다.
  function withDefaultSettings(projectId: string, raw: Partial<GitAutomationSettings> | null): GitAutomationSettings {
    const base = { ...DEFAULT_GIT_AUTOMATION_CONFIG, ...(raw || {}) };
    // branchStrategy 는 enum 두 값만 허용. 저장 row 가 이 필드를 모르면 env 기본값으로
    // 보정해, UI/리더가 항상 유효한 값 하나를 받도록 한다.
    const branchStrategy: GitAutomationBranchStrategy =
      raw?.branchStrategy && GIT_AUTOMATION_BRANCH_STRATEGY_VALUES.includes(raw.branchStrategy)
        ? raw.branchStrategy
        : GIT_AUTO_DEFAULT_BRANCH_STRATEGY;
    const branchName = typeof raw?.branchName === 'string' ? raw.branchName : GIT_AUTO_DEFAULT_BRANCH_NAME;
    return {
      projectId,
      enabled: raw?.enabled ?? false,
      flowLevel: base.flowLevel,
      branchTemplate: base.branchTemplate,
      commitConvention: base.commitConvention,
      commitScope: base.commitScope,
      prTitleTemplate: base.prTitleTemplate,
      reviewers: base.reviewers,
      branchStrategy,
      branchName,
      updatedAt: raw?.updatedAt || new Date(0).toISOString(),
    };
  }

  app.get('/api/projects/:id/git-automation', async (req, res) => {
    const { id } = req.params;
    const project = await projectsCol.findOne({ id });
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    const row = await gitAutomationSettingsCol.findOne({ projectId: id }, { projection: { _id: 0 } });
    // DB raw 문서를 그대로 반환하되, 기본값으로 빈 필드를 보완한다.
    // uiBranchStrategy 등 UI 전용 필드도 함께 내려보낸다.
    const defaults = withDefaultSettings(id, row as Partial<GitAutomationSettings> | null);
    res.json({ ...defaults, ...(row || {}) });
  });

  app.post('/api/projects/:id/git-automation', async (req, res) => {
    const { id } = req.params;
    const project = await projectsCol.findOne({ id });
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    const body = req.body || {};
    const validation = validateGitAutomationConfig(body);
    if (validation.ok !== true) { res.status(400).json({ error: validation.error }); return; }
    // validation.config 가 branchStrategy/branchName 을 이미 검증·머지해 둔 상태라
    // withDefaultSettings 와 동일 경로로 env 기본값을 끼워 넣어 저장 row 에 항상
    // 유효한 enum·string 쌍이 박히도록 한다.
    const persistedBranchStrategy: GitAutomationBranchStrategy =
      validation.config.branchStrategy
        && GIT_AUTOMATION_BRANCH_STRATEGY_VALUES.includes(validation.config.branchStrategy)
        ? validation.config.branchStrategy
        : GIT_AUTO_DEFAULT_BRANCH_STRATEGY;
    const persistedBranchName = typeof validation.config.branchName === 'string'
      ? validation.config.branchName
      : GIT_AUTO_DEFAULT_BRANCH_NAME;
    const settings: GitAutomationSettings = {
      projectId: id,
      enabled: body.enabled !== false,
      flowLevel: validation.config.flowLevel,
      branchTemplate: validation.config.branchTemplate,
      commitConvention: validation.config.commitConvention,
      commitScope: validation.config.commitScope,
      prTitleTemplate: validation.config.prTitleTemplate,
      reviewers: validation.config.reviewers,
      branchStrategy: persistedBranchStrategy,
      branchName: persistedBranchName,
      // 태스크 경계 커밋(#f1d5ce51) — UI 가 항상 값을 채워 보내도록 하되, 과거 row 호환을
      // 위해 optional 로 유지. 값이 없으면 프런트 GitAutomationPanel 이 기본값을 보완.
      commitStrategy: validation.config.commitStrategy,
      commitMessagePrefix: validation.config.commitMessagePrefix,
      updatedAt: new Date().toISOString(),
    };
    // UI 브랜치 전략 원본(per-session 등)을 별도 필드로 보존
    const extra: Record<string, unknown> = {};
    if (typeof body.uiBranchStrategy === 'string') {
      extra.uiBranchStrategy = body.uiBranchStrategy;
    }
    if (typeof body.fixedBranchName === 'string') {
      extra.fixedBranchName = body.fixedBranchName;
    }
    // 2모드 시안(A안) UI round-trip 필드. 'new'|'continue' 외 값은 무시해 검증을
    // 최소화한다(스키마 승격 전 시안 블록이라, 잘못된 값이 박혀도 fromServerSettings
    // 가 DEFAULT 로 폴백한다).
    if (body.branchModeSketch === 'new' || body.branchModeSketch === 'continue') {
      extra.branchModeSketch = body.branchModeSketch;
    }
    if (typeof body.branchModeNewName === 'string') {
      extra.branchModeNewName = body.branchModeNewName;
    }
    await gitAutomationSettingsCol.updateOne(
      { projectId: id },
      { $set: { ...settings, ...extra } },
      { upsert: true },
    );
    const saved = { ...settings, ...extra };
    io.emit('git-automation:updated', { projectId: id, settings: saved });
    res.json(saved);
  });

  // Git 자동화 패널 설정을 읽어 실제 git/gh 명령을 돌리는 실행기.
  // autoCommit → autoPush → autoPR 순서로 플래그를 검사하고, 각 플래그가 켜진
  // 경우에만 해당 단계의 명령을 수행한다. 한 단계라도 실패하면 뒷 단계는 건너뛰고
  // 즉시 실패로 종결 — 실패한 push 를 그대로 덮어 PR 을 만들면 잘못된 상태가
  // 공개 저장소에 박힌다.
  async function executeGitAutomation(
    projectId: string,
    // forcePush: flowLevel='commitOnly' 로 저장된 프로젝트라도 태스크 완료 훅 호출에는
    // 커밋 직후 바로 원격 push 까지 수행하도록 강제한다(긴급 수정 #a7b258fb).
    // 마스터 스위치 enabled=false 는 여전히 우선되므로, 사용자가 명시적으로 끈 자동화는
    // 이 플래그로 뚫리지 않는다.
    ctxHint?: {
      type?: string;
      summary?: string;
      agent?: string;
      prBase?: string;
      forcePush?: boolean;
      taskId?: string;
      // MCP/REST 트리거 1회 한정 오버라이드. 저장된 settings.branchStrategy 보다 우선.
      branchStrategy?: GitAutomationBranchStrategy;
      branchName?: string;
    },
  ): Promise<GitAutomationRunResult> {
    try {
      const project = await projectsCol.findOne({ id: projectId });
      if (!project) return { ok: false, skipped: 'no-project', error: 'project not found', results: [] };
      const options = projectOptionsView(project as Project);
      const row = await gitAutomationSettingsCol.findOne({ projectId });
      // 과거에는 두 경로를 같은 skipped='disabled' 로 뭉뚱그려 UI 토글이 ON 인데도
      // 커밋이 침묵하는 경우 원인이 "설정 row 자체가 없음" 인지 "명시적 비활성" 인지
      // 구분할 수 없었다. tests/auto-commit-no-fire-repro.md 의 침묵 경로 추적을 위해
      // 최소 한 줄씩 분리 로그를 남긴다.
      if (!row) {
        console.warn(
          `[git-automation] skip project=${projectId}: settings row 부재 — 한 번도 저장된 적 없음 (POST /api/projects/:id/git-automation 으로 초기화 필요)`,
        );
        return { ok: false, skipped: 'disabled', results: [] };
      }
      if (row.enabled === false) {
        if (process.env.DEBUG_GIT_AUTO === '1') {
          console.log(`[git-automation] skip project=${projectId}: enabled=false (명시적 OFF)`);
        }
        return { ok: false, skipped: 'disabled', results: [] };
      }
      const settings = row as GitAutomationSettings;
      const cwd = resolveWorkspace(project.workspacePath);
      const projectWithBranch = project as Project;

      // 트리거 1회 한정 오버라이드가 있으면 저장된 settings 보다 우선한다. env 기본값은
      // withDefaultSettings 와 동일 규칙으로 끼워 넣어, row 가 이 필드를 모르는 레거시
      // 프로젝트에서도 유효한 enum 쌍을 돌려받는다.
      const effectiveStrategy: GitAutomationBranchStrategy =
        (ctxHint?.branchStrategy && GIT_AUTOMATION_BRANCH_STRATEGY_VALUES.includes(ctxHint.branchStrategy))
          ? ctxHint.branchStrategy
          : (settings.branchStrategy && GIT_AUTOMATION_BRANCH_STRATEGY_VALUES.includes(settings.branchStrategy))
            ? settings.branchStrategy
            : GIT_AUTO_DEFAULT_BRANCH_STRATEGY;
      const effectiveBranchName = (
        typeof ctxHint?.branchName === 'string' ? ctxHint.branchName
          : typeof settings.branchName === 'string' ? settings.branchName
            : GIT_AUTO_DEFAULT_BRANCH_NAME
      ).trim();

      // 'current' 모드는 checkout 단계를 건너뛰어 현재 HEAD 에 그대로 커밋/푸시한다.
      // 브랜치 이름은 rev-parse 로 조회해 UI/구조화 로그 소비자가 "어느 브랜치에
      // 박혔는지" 를 동일 계약(branch 필드)으로 읽도록 한다. detached HEAD 는 이름
      // 대신 'HEAD' 를 돌려주므로 조기 실패시키고, 사용자가 수동 전환하도록 한다.
      let branch: string;
      let skipCheckout = false;
      // 'new' 모드에서 explicit branchName 대신 resolveBranch 폴백을 썼을 때만 기존
      // 재사용 경로(cache/persisted/fixed)를 그대로 유지해 `checkout <branch>` 로 전환.
      // explicit branchName 경로는 항상 `-B` 로 힘 있게 생성/재설정한다.
      let forceFreshCheckout = false;
      if (effectiveStrategy === 'current') {
        const head = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
          encoding: 'utf8',
          windowsHide: true,
        });
        const headName = (head.stdout || '').trim();
        if (head.status !== 0 || !headName || headName === 'HEAD') {
          console.error(
            `[git-automation] branchStrategy=current 실패 project=${projectId}: HEAD rev-parse code=${head.status ?? 'null'} name='${headName}' — detached 이거나 작업 디렉터리에 git 저장소가 없음`,
          );
          return {
            ok: false,
            error: 'branchStrategy=current 에서 HEAD 이름을 확인할 수 없습니다 (detached HEAD 또는 저장소 누락)',
            results: [],
          };
        }
        branch = headName;
        skipCheckout = true;
      } else if (effectiveBranchName) {
        // 'new' + 명시 branchName — Project 측 네이밍 정책(per-session 등)을 우회해
        // 이 이름으로 `checkout -B` 를 발사한다. cache/persisted 갱신은 건너뛴다.
        branch = effectiveBranchName;
        forceFreshCheckout = true;
      } else {
        // 'new' + branchName 미지정 — 기존 resolveBranch 폴백. 리더 루프가 매
        // 태스크마다 새 브랜치를 만들던 회귀(#91aeaf7a) 를 그대로 차단.
        const resolution = resolveBranch({
          strategy: projectWithBranch.branchStrategy,
          fixedBranchName: projectWithBranch.fixedBranchName,
          branchNamePattern: projectWithBranch.branchNamePattern,
          cachedActiveBranch: activeBranchCache.get(projectId),
          persistedActiveBranch: projectWithBranch.currentAutoBranch,
          fallbackTemplate: settings.branchTemplate,
          templateContext: {
            type: ctxHint?.type || 'chore',
            summary: ctxHint?.summary || 'auto',
            agent: ctxHint?.agent,
          },
        });
        branch = resolution.branch;
        forceFreshCheckout = resolution.source === 'fresh';
        if (resolution.persist) {
          activeBranchCache.set(projectId, branch);
          await projectsCol.updateOne(
            { id: projectId },
            { $set: { currentAutoBranch: branch } },
          );
        } else if (resolution.source === 'cache' || resolution.source === 'persisted') {
          // 캐시 경로에서 DB 에 값이 빠진 경우(예: 다른 프로세스가 기록 전), 백필해 둔다.
          if (!projectWithBranch.currentAutoBranch) {
            await projectsCol.updateOne(
              { id: projectId },
              { $set: { currentAutoBranch: branch } },
            );
          }
          activeBranchCache.set(projectId, branch);
        }
      }
      const commitMessage = formatCommitMessage(settings, {
        type: ctxHint?.type || 'chore',
        summary: ctxHint?.summary || 'auto update',
      });
      const prTitle = formatPrTitle(settings.prTitleTemplate, {
        type: ctxHint?.type || 'chore',
        summary: ctxHint?.summary || 'auto update',
        branch,
      });

      const results: GitAutomationStepResult[] = [];
      const runStep = (label: string, cmd: string[]): boolean => {
        const [bin, ...rest] = cmd;
        const r = spawnSync(bin, rest, { cwd, encoding: 'utf8', windowsHide: true });
        // spawn 자체가 실패(바이너리 미설치 등)하면 r.status 는 null, r.error 가 채워진다.
        // stderr 만 보면 원인이 빈 문자열로 남아 디버깅 불가 → r.error.message 를 로그에 합친다.
        const ok = r.status === 0 && !r.error;
        const stderrRaw = (r.stderr || '') + (r.error ? `\nspawn error: ${r.error.message}` : '');
        const stdoutRaw = r.stdout || '';
        // commit/pr 의 stdout 은 SHA·PR URL 파싱 계약이 있어 step 에 보존한다. 그 외 단계도
        // 실패 시 stdout 으로 원인이 흘러가는 케이스(pre-commit 훅이 stdout 에 오류를 찍는 등)
        // 가 있어 진단용 로그에는 항상 포함시킨다.
        const stdout = label === 'commit' || label === 'pr'
          ? stdoutRaw.slice(0, 400)
          : undefined;
        // stderr 가 비어 있으면 stdout 헤드를 합성해 step.stderr 에 채운다 — `git commit` 이
        // "nothing to commit, working tree clean" 을 stdout 으로만 뱉는 케이스, 그리고 한글
        // Windows 콘솔(CP949)에서 utf8 디코딩 누락으로 stderr 가 빈 사례를 동일 경로로 살린다.
        const stderrForStep = (() => {
          if (ok) return undefined;
          const trimmedStderr = stderrRaw.trim();
          if (trimmedStderr) return redactRemoteUrl(stderrRaw).slice(0, 400);
          const trimmedStdout = stdoutRaw.trim();
          if (trimmedStdout) {
            return `(empty stderr; stdout) ${redactRemoteUrl(trimmedStdout)}`.slice(0, 400);
          }
          return `(empty stderr/stdout; exit=${r.status ?? 'null'})`;
        })();
        // 원격 URL 에 토큰이 인라인 주입된 상태라면, 실패 stderr 에 자격증명이 그대로
        // 박힌 채 로그·소켓 페이로드로 흘러갈 위험이 있다. redactRemoteUrl 을 항상
        // 통과시켜 `user:***@host` 로 마스킹한 뒤에만 외부에 노출한다.
        const step: GitAutomationStepResult = {
          label,
          ok,
          code: r.status,
          stderr: stderrForStep,
          stdout: stdout ? redactRemoteUrl(stdout) : undefined,
        };
        results.push(step);
        if (!ok) {
          // stdout 도 함께 남겨, "code=1, stderr 빈" 케이스(특히 commit 단계)에서 원인을
          // 즉시 식별할 수 있도록 한다. 200자 캡으로 페이로드 폭주를 방지.
          const stdoutLog = stdoutRaw.trim()
            ? ` stdout=${redactRemoteUrl(stdoutRaw).slice(0, 200)}`
            : '';
          console.error(
            `[git-automation] step=${label} failed project=${projectId} branch=${branch} code=${r.status ?? 'null'} stderr=${(step.stderr || '').slice(0, 200)}${stdoutLog}`,
          );
        }
        return ok;
      };
      const finalize = (ok: boolean): GitAutomationRunResult => {
        io.emit('git-automation:ran', { projectId, results, branch });
        return { ok, results, branch, commitMessage, prTitle };
      };

      // autoCommit: checkout → add → commit.
      //   - branchStrategy='current' (skipCheckout=true): checkout 생략, 현재 HEAD 에 커밋.
      //   - branchStrategy='new' + 명시 branchName: 항상 `checkout -B` 로 덮어써 생성/전환.
      //   - branchStrategy='new' + 폴백(resolveBranch): 신규(fresh)면 -B, 재사용(cache/persisted/fixed)은
      //     전환만 해 "매 태스크마다 새 브랜치" 회귀(#91aeaf7a)를 계속 차단.
      if (shouldAutoCommit(settings)) {
        if (!skipCheckout) {
          const checkoutCmd = forceFreshCheckout
            ? ['git', '-C', cwd, 'checkout', '-B', branch]
            : ['git', '-C', cwd, 'checkout', branch];
          if (!runStep('checkout', checkoutCmd)) return finalize(false);
        }
        if (!runStep('add', ['git', '-C', cwd, 'add', '-A'])) return finalize(false);
        // commit 단계의 exit 코드만 보면 pre/post-commit 훅이 비정상 종료한 경우에도
        // 실패로 단정해 버린다 — 그러나 커밋 객체는 이미 생성되어 HEAD 는 전진한 상태.
        // commit 실행 전후로 HEAD SHA 를 조회하고, non-zero 종료여도 HEAD 가 전진했으면
        // reconcileCommitOutcome 이 ok=true 로 재판정한다(#77704932). results 배열의
        // 마지막 step 도 동시에 갱신해 UI 로그/소켓 페이로드가 동일 결과를 받게 한다.
        const probeHead = (): string | undefined => {
          const p = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
            encoding: 'utf8', windowsHide: true,
          });
          return p.status === 0 ? (p.stdout || '').trim() : undefined;
        };

        // commit pre-flight: stderr 가 빈 채 code=1 로 떨어지는 모호 실패를 사전 차단한다.
        //   1) user.email/user.name 미설정: 일부 로컬화 git 빌드는 stderr 가 비고 종료.
        //   2) .git/index.lock 잔존: 다른 git 프로세스 충돌·이전 실행 강제종료의 잔여 파일.
        //   3) 스테이징된 변경 없음(--allow-empty 미사용 정책): 메시지가 stdout 으로만 가
        //      현재 로깅에서는 빈 stderr 로 보였다. 사전 감지 후 noop 로 단축해, 자동화
        //      스케줄러가 같은 done 구간에서 "실패 → 재시도" 토큰을 더 태우지 않게 한다.
        const probeConfig = (key: string): string => {
          const c = spawnSync('git', ['-C', cwd, 'config', '--get', key], {
            encoding: 'utf8', windowsHide: true,
          });
          return (c.stdout || '').trim();
        };
        const userEmail = probeConfig('user.email');
        const userName = probeConfig('user.name');
        if (!userEmail || !userName) {
          const missing = !userEmail && !userName ? 'user.email/user.name' : !userEmail ? 'user.email' : 'user.name';
          const reason = `git ${missing} 미설정 — \`git -C <repo> config ${missing} <value>\` 로 지정 필요`;
          results.push({ label: 'commit', ok: false, code: 1, stderr: `preflight: ${reason}` });
          console.error(`[git-automation] commit preflight failed project=${projectId} branch=${branch} reason=${reason}`);
          return finalize(false);
        }
        try {
          const lockPath = path.join(cwd, '.git', 'index.lock');
          if (existsSync(lockPath)) {
            const reason = '.git/index.lock 잔존 — 다른 git 프로세스가 잠금 중이거나 이전 실행의 잔여 파일. 안전 확인 후 수동 삭제 필요';
            results.push({ label: 'commit', ok: false, code: 1, stderr: `preflight: ${reason}` });
            console.error(`[git-automation] commit preflight failed project=${projectId} branch=${branch} reason=${reason}`);
            return finalize(false);
          }
        } catch {
          // fs 접근 자체가 실패하면 commit 단계의 spawn 에서 다시 드러난다 — pre-flight 는
          // 폴백 없이 그대로 통과시켜 정상 경로의 진단 로그가 원인을 잡게 한다.
        }
        // diff --cached --quiet: exit 0 = 변경 없음, exit 1 = 스테이징된 diff 있음.
        // exit 0 이면 commit 을 건너뛰고 noop 결과를 push 해 파이프라인을 정상 마감한다.
        const stagedProbe = spawnSync('git', ['-C', cwd, 'diff', '--cached', '--quiet'], {
          encoding: 'utf8', windowsHide: true,
        });
        if (stagedProbe.status === 0 && !stagedProbe.error) {
          console.warn(
            `[git-automation] commit 단계 noop project=${projectId} branch=${branch} — 스테이징된 변경 없음 (add -A 후에도 추적 변경 0건)`,
          );
          results.push({
            label: 'commit',
            ok: true,
            code: 0,
            stdout: '[noop] nothing to commit, working tree clean',
          });
        } else {
          const headBefore = probeHead();
          const committed = runStep('commit', ['git', '-C', cwd, 'commit', '-m', commitMessage]);
          if (!committed) {
            const headAfter = probeHead();
            const idx = results.length - 1;
            const reconciled = reconcileCommitOutcome({
              step: results[idx],
              headBefore,
              headAfter,
            });
            if (reconciled !== results[idx]) {
              results[idx] = reconciled;
              if (reconciled.ok) {
                console.warn(
                  `[git-automation] commit step reconciled to ok project=${projectId} branch=${branch} HEAD ${(headBefore || '').slice(0, 7)} → ${(headAfter || '').slice(0, 7)} despite exit=${reconciled.code ?? 'null'}`,
                );
              }
            }
            if (!reconciled.ok) return finalize(false);
          }
        }
      }

      // autoPush: 원격 원브랜치로 업스트림 연결 후 push.
      // 태스크 완료 훅은 ctxHint.forcePush=true 를 넘기므로, flowLevel='commitOnly' 로
      // 저장된 프로젝트에서도 커밋 직후 push 가 한 번에 이어져 원격까지 반영된다.
      const shouldPush = shouldAutoPush(settings) || ctxHint?.forcePush === true;
      if (shouldPush) {
        if (ctxHint?.forcePush === true && !shouldAutoPush(settings)) {
          console.log(
            `[git-automation] push forced project=${projectId} branch=${branch} (flowLevel=${settings.flowLevel}, forcePush=true)`,
          );
        }
        // 프로젝트별 저장된 자격증명(AES-256-GCM 복호화)을 원격 HTTPS URL 에 인라인
        // 주입해 매 push 마다 대화형 인증 프롬프트가 뜨는 문제를 차단한다. 복구
        // 가능성을 위해 원래 URL 을 snapshot 으로 보관하고, push 성공/실패 여부와
        // 무관하게 finally 블록에서 원상 복구한다. SSH 원격 또는 자격증명이 없는
        // 프로젝트는 기존 경로(시스템 credential helper)로 그대로 흘러간다.
        let originalRemoteUrl: string | null = null;
        try {
          const cred = await loadDecryptedCredential(projectId);
          if (cred) {
            const cur = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
              encoding: 'utf8',
              windowsHide: true,
            });
            const currentUrl = (cur.stdout || '').trim();
            if (cur.status === 0 && currentUrl) {
              const injected = injectTokenIntoRemoteUrl(currentUrl, cred.username, cred.token);
              if (injected) {
                const setR = spawnSync(
                  'git',
                  ['-C', cwd, 'remote', 'set-url', 'origin', injected],
                  { encoding: 'utf8', windowsHide: true },
                );
                if (setR.status === 0) {
                  originalRemoteUrl = currentUrl;
                } else {
                  console.warn(
                    `[git-automation] remote set-url failed project=${projectId}: ${(setR.stderr || '').trim().slice(0, 200)}`,
                  );
                }
              }
            }
          }
          if (!runStep('push', ['git', '-C', cwd, 'push', '-u', 'origin', branch])) {
            return finalize(false);
          }
        } finally {
          if (originalRemoteUrl) {
            const restore = spawnSync(
              'git',
              ['-C', cwd, 'remote', 'set-url', 'origin', originalRemoteUrl],
              { encoding: 'utf8', windowsHide: true },
            );
            if (restore.status !== 0) {
              // 복구 실패는 설정 파일에 토큰이 박힌 채 남을 위험이 있다 — 운영자가
              // 수동으로 `git remote set-url origin <원래 URL>` 을 돌리도록 한국어로 경고.
              console.error(
                `[git-automation] remote URL 복구 실패 project=${projectId} — .git/config 에서 수동으로 토큰을 제거하세요`,
              );
            }
          }
        }
      }

      // autoMergeToMain: push 성공 이후 옵션이 켜진 경우 defaultBranch 로 ff-only
      // 병합을 시도한다. --ff-only 로 제한해 자동 병합이 히스토리를 망가뜨리지 않도록
      // 보수적으로 유지하고, 실패해도 경고 로그만 남기며 파이프라인은 성공으로 마감한다.
      // 병합 완료 후 세션 브랜치를 기본값으로 리셋해 다음 리더 트리거가 새 세션을 시작.
      if (options.autoMergeToMain && shouldPush) {
        const target = options.defaultBranch || PROJECT_OPTION_DEFAULTS.defaultBranch;
        if (target === branch) {
          console.warn(
            `[git-automation] autoMergeToMain 건너뜀 project=${projectId}: target==branch (${target})`,
          );
        } else {
          const coTarget = spawnSync('git', ['-C', cwd, 'checkout', target], { encoding: 'utf8', windowsHide: true });
          if (coTarget.status === 0) {
            const merge = spawnSync('git', ['-C', cwd, 'merge', '--ff-only', branch], { encoding: 'utf8', windowsHide: true });
            if (merge.status === 0) {
              console.log(`[git-automation] autoMergeToMain 성공 project=${projectId} ${branch} → ${target}`);
              // 세션 브랜치를 모두 비워 다음 호출에서 새 브랜치가 만들어지게 한다.
              activeBranchCache.clear(projectId);
              await projectsCol.updateOne(
                { id: projectId },
                { $unset: { currentAutoBranch: '' } },
              );
            } else {
              console.warn(
                `[git-automation] autoMergeToMain ff-only 실패 project=${projectId} stderr=${(merge.stderr || '').trim().slice(0, 200)}`,
              );
            }
          } else {
            console.warn(
              `[git-automation] autoMergeToMain checkout(${target}) 실패 project=${projectId} stderr=${(coTarget.stderr || '').trim().slice(0, 200)}`,
            );
          }
        }
      }

      // autoPR: gh CLI 가 인증돼 있어야 한다. 실패 로그는 호출자가 agent 워커로 전달.
      if (shouldAutoOpenPR(settings)) {
        const reviewerArgs: string[] = [];
        for (const r of settings.reviewers || []) {
          if (r && typeof r === 'string') reviewerArgs.push('--reviewer', r);
        }
        const base = ctxHint?.prBase?.trim();
        const prCmd = [
          'gh', 'pr', 'create',
          '--title', prTitle,
          '--body', commitMessage,
          ...(base ? ['--base', base] : []),
          '--head', branch,
          ...reviewerArgs,
        ];
        if (!runStep('pr', prCmd)) return finalize(false);
      }

      return finalize(true);
    } catch (e) {
      // DB 조회·spawn 래퍼·템플릿 렌더 중 어디서든 throw 가 나면 호출자 쪽 훅이
      // 이벤트를 못 받고 조용히 죽는다. 여기서 한 번 더 가두고 원인을 로그로 남겨
      // TaskRunner.handleWorkerTaskComplete 와 /api/tasks PATCH 양쪽 호출자가
      // 동일한 {ok:false, error} 계약만 보고도 판정 가능하게 한다.
      const message = (e as Error)?.message || String(e);
      console.error(`[git-automation] unexpected throw project=${projectId}: ${message}`);
      return { ok: false, error: message, results: [] };
    }
  }

  app.post('/api/projects/:id/git-automation/run', async (req, res) => {
    const { id } = req.params;
    const body = (req.body || {}) as Record<string, unknown>;
    // 트리거 1회 한정 오버라이드 — MCP `trigger_git_automation` 이 이 경로로 흘러든다.
    // enum 이외 값은 executeGitAutomation 안에서 무시되지만, 로그/에러 가시성을 위해
    // 서버 경계에서도 가볍게 normalize 한다.
    const rawStrategy = body.branchStrategy;
    const branchStrategy =
      rawStrategy === 'new' || rawStrategy === 'current' ? rawStrategy : undefined;
    const branchName = typeof body.branchName === 'string' ? body.branchName : undefined;
    const out = await executeGitAutomation(id, {
      type: typeof body.type === 'string' ? body.type : undefined,
      summary: typeof body.summary === 'string' ? body.summary : undefined,
      agent: typeof body.agent === 'string' ? body.agent : undefined,
      prBase: typeof body.prBase === 'string' ? body.prBase : undefined,
      forcePush: body.forcePush === true,
      taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
      branchStrategy,
      branchName,
    });
    if (!out.ok && out.skipped === 'no-project') { res.status(404).json(out); return; }
    res.json(out);
  });

  // 모든 에이전트 상태가 idle 로 수렴된 "전이 순간" 감시기.
  //   - 각 태스크 완료 훅이 개별 변경을 커밋하는 것과는 별개로, 한 묶음의 지시가
  //     "전원 idle" 로 가라앉는 시점에 한 번 더 자동화를 돌려 흩어진 변경을 모은
  //     마무리 커밋/PR 을 남긴다.
  //   - ProjectCompletionTracker 가 busy → completed 전이에만 true 를 돌려주므로
  //     같은 completed 구간에서 tick 이 여러 번 와도 한 번만 발사된다.
  //   - 프로젝트 agent 편성이 0명인 경우 tracker 가 이전 phase 를 그대로 유지해
  //     의미 없는 자동화가 돌지 않는다.
  async function allAgentsCompletedWatcher(projectId: string): Promise<void> {
    const project = await projectsCol.findOne({ id: projectId }, { projection: { _id: 0 } });
    if (!project?.agents || project.agents.length === 0) return;
    const members = await agentsCol
      .find({ id: { $in: project.agents } }, { projection: { _id: 0 } })
      .toArray();
    const statuses = members.map(m => m.status as Agent['status']);
    const { fire } = completionTracker.observe(projectId, statuses);
    if (!fire) return;
    // 정상 전이 — 집계 커밋을 트리거. 실패는 기존 executeGitAutomation 의 구조화
    // 로그/소켓 이벤트 경로로 흘러가므로 여기서는 로그만 남긴다.
    executeGitAutomation(projectId, {
      type: 'chore',
      summary: 'all agents completed',
      // 긴급 수정 #a7b258fb: 전원 idle 수렴 집계 커밋도 원격까지 한 번에 반영.
      forcePush: true,
    }).catch(err =>
      console.error('[all-agents-watcher] auto-run failed:', (err as Error).message),
    );
  }

  // 긴급중단: 모든 에이전트를 idle 로 되돌리고, 완료되지 않은 모든 작업을 pending
  // 상태로 재설정한다. 이미 completed 인 작업은 그대로 보존해 이력을 잃지 않는다.
  // 실패 중인 LLM 호출은 서버에서 취소할 수단이 없으므로, "스냅샷" 차원에서
  // 상태·작업 큐만 리셋하는 것이 실제로 의미 있는 최대 범위다.
  app.post('/api/emergency-stop', async (_req, res) => {
    // 자동개발 루프도 함께 꺼야 방금 pending 복구된 태스크가 즉시 다시 dispatch
    // 되는 상황을 막을 수 있다. 사용자는 필요 시 토글로 재개 가능.
    await taskRunner.setAutoDev({ enabled: false });
    // 모든 에이전트 워커(= Claude 자식 프로세스)를 즉시 종료한다. 진행 중이던
    // LLM 호출은 서버에서 확실히 끊을 방법이 이 외에는 없다.
    for (const agentId of workerRegistry.listAgentIds()) {
      workerRegistry.dispose(agentId);
    }
    const agentResult = await agentsCol.updateMany(
      {},
      { $set: { status: 'idle', workingOnFileId: '', currentTask: '' } },
    );
    const taskResult = await tasksCol.updateMany(
      { status: { $ne: 'completed' } },
      { $set: { status: 'pending' } },
    );
    io.emit('state:updated', await getGameState());
    io.emit('tasks:updated', await getTasks());
    io.emit('agents:halted');
    res.json({
      agentsReset: agentResult.modifiedCount,
      tasksPending: taskResult.modifiedCount,
    });
  });

  app.delete('/api/agents/:id', async (req, res) => {
    const { id } = req.params;
    // 에이전트 해고 시 해당 워커의 Claude 프로세스를 즉시 종료한다. 큐에 남은
    // 지시는 모두 실패로 응답되어 dispatch 체인이 조용히 끊긴다.
    taskRunner.disposeAgentWorker(id);
    await agentsCol.deleteOne({ id });
    await tasksCol.deleteMany({ assignedTo: id });
    await projectsCol.updateMany({}, { $pull: { agents: id } });

    io.emit('state:updated', await getGameState());
    io.emit('tasks:updated', await getTasks());
    res.json({ success: true });
  });

  // Claude 토큰 사용량 브로드캐스터 주입: io 가 준비된 뒤에야 푸시 이벤트를
  // 보낼 수 있다. recordClaudeUsage 는 CLI 호출 완료 시 이 함수를 통해 총계를
  // 전 클라이언트에 푸시한다. delta 는 마지막 한 건, totals 는 서버 누적본.
  claudeUsageBroadcaster = (totals, delta) => {
    io.emit('claude-usage:updated', { totals, delta });
  };

  // agentWorker 의 stream-json result 이벤트에서 발사되는 usage 를 전역 옵저버로
  // 받아 기존 `recordClaudeUsage` 에 합친다. 이 한 줄이 에이전트 멀티턴 경로의
  // 실제 토큰 수집을 상단바 위젯까지 배선한다(#176df2b8 의 (2) 배선 보완).
  onClaudeUsage(recordClaudeUsage);

  // 세션 폴백 방송 배선(#cdaaabf3) — emitTokenExhausted 가 발사되면 서버 측 상태를
  // exhausted 로 전이시키고 agentWorker 가드를 닫는다. socket 경로는 아래 broadcaster
  // 주입 후 바로 이어받아 기존 접속자에게도 즉시 푸시된다.
  claudeSessionStatusBroadcaster = (payload) => {
    io.emit('claude-session:status', payload);
  };
  onTokenExhausted((event) => {
    setClaudeSessionStatus('exhausted', event.message);
  });

  // 현재 세션 가용 상태 조회. 클라이언트는 초기 마운트 시점에 이 값으로 위젯 배너와
  // DirectivePrompt/SharedGoalForm 의 readOnly 가드를 세팅하고, 이후에는 socket 푸시를 따른다.
  app.get('/api/claude/session-status', (_req, res) => {
    res.json({
      status: claudeSessionStatus,
      reason: claudeSessionStatusReason,
      at: claudeSessionStatusUpdatedAt,
    });
  });

  // 현재 누적 총계를 한 번에 돌려주는 조회 엔드포인트. 클라이언트는 최초 마운트
  // 시점에 이 값으로 상단바 위젯을 하이드레이트하고, 이후에는 소켓 푸시를 따른다.
  app.get('/api/claude/token-usage', (_req, res) => {
    res.json(claudeUsageTotals);
  });

  // Claude Code IDE 의 `/usage` 슬래시 명령과 동일한 프롬프트를 headless 로 시도한다.
  // 대화형 TTY 가 아니면 Anthropic 쪽에서 거절되는 경우가 많으며, 그때는 클라이언트가
  // 구독 세션 모델(TokenUsageIndicator)만 신뢰하면 된다.
  app.get('/api/claude/slash-usage-preview', (_req, res) => {
    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        LANG: 'en_US.UTF-8',
      };
      delete env.ANTHROPIC_API_KEY;
      delete env.CLAUDE_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      const r = spawnSync(CLAUDE_BIN, ['-p', '/usage', '--dangerously-skip-permissions', '--output-format', 'text'], {
        shell: true,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 30_000,
        env,
      });
      if (r.error) {
        res.json({
          ok: false,
          unavailable: true,
          exitCode: null,
          output: null,
          error: r.error.message,
        });
        return;
      }
      const stdout = (r.stdout ?? '').trim();
      const stderr = (r.stderr ?? '').trim();
      const combined = [stdout, stderr].filter(Boolean).join('\n').slice(0, 8000);
      const unavailable = /isn'?t available|not available in this environment/i.test(combined);
      res.json({
        ok: typeof r.status === 'number' && r.status === 0 && !unavailable && combined.length > 0,
        exitCode: r.status,
        output: combined.length > 0 ? combined : null,
        unavailable: unavailable || combined.length === 0,
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        unavailable: true,
        error: (e as Error).message,
        output: null,
      });
    }
  });

  // Claude Code 로컬 세션 로그(*.jsonl) 합산 — `/usage` CLI 없이도 동일 머신의 사용량을
  // 집계한다. 증분은 data/claude-jsonl-usage-baseline.json 기준으로만 record 된다.
  app.get('/api/claude/jsonl-aggregate', (_req, res) => {
    try {
      const roots = resolveClaudeCodeJsonlRoots();
      const aggregate = aggregateUsageFromJsonlRoots(roots);
      res.json({ roots, aggregate });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post('/api/claude/sync-jsonl-usage', (_req, res) => {
    try {
      const out = runLocalJsonlUsageSync();
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  // claude.ai OAuth 토큰(~/.claude/.credentials.json)으로 `/usage` 와 동일 계열의
  // 구독 할당량 JSON 을 가져온다(비공개 엔드포인트 — 커뮤니티 표준 우회).
  app.get('/api/claude/oauth-usage', async (_req, res) => {
    try {
      const out = await getOAuthUsageCached();
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, reason: (e as Error).message });
    }
  });

  // 누적을 수동으로 0 으로 되돌린다. 관측 편의용 — UI 에서 "이번 세션부터 다시
  // 측정" 시나리오를 만들기 위해 별도 엔드포인트로 분리했다. 전 클라이언트에
  // 리셋 이벤트를 푸시해 동시 접속 탭들도 함께 0 으로 맞춘다.
  app.post('/api/claude/token-usage/reset', (_req, res) => {
    // errors 축도 함께 0 으로 되돌려야 "사용자가 재측정 시 과거 에러 잔상" 이 남지 않는다.
    claudeUsageTotals = { ...EMPTY_CLAUDE_USAGE_TOTALS, byModel: {}, errors: emptyErrorCounters() };
    io.emit('claude-usage:reset', claudeUsageTotals);
    res.json(claudeUsageTotals);
  });

  // Socket logic
  io.on('connection', async (socket) => {
    socket.emit('state:initial', await getGameState());
    // 새 접속자에게 최신 토큰 사용량을 즉시 전달 — 초기 fetch 가 늦어도 위젯이
    // 빈 0 이 아닌 누적값부터 보여주도록 한다. fetch 가 이후 도착하면 동일 값이
    // 덮여 일관성에 문제 없다.
    socket.emit('claude-usage:updated', { totals: claudeUsageTotals, delta: null });
    // 세션 폴백 상태도 동일 원칙으로 즉시 전달 — 재접속한 탭도 read-only 배너/워커
    // 가드를 동기화 지연 없이 복원한다.
    socket.emit('claude-session:status', {
      status: claudeSessionStatus,
      reason: claudeSessionStatusReason,
      at: claudeSessionStatusUpdatedAt,
    });

    socket.on('agent:move', async ({ agentId, x, y }) => {
      await agentsCol.updateOne({ id: agentId }, { $set: { x, y } });
      socket.broadcast.emit('agent:moved', { agentId, x, y });
    });

    socket.on('agent:working', async ({ agentId, fileId }) => {
      await agentsCol.updateOne({ id: agentId }, { $set: { workingOnFileId: fileId } });
      io.emit('agent:working', { agentId, fileId });
    });

    socket.on('agent:message', ({ agentId, message, targetAgentId }) => {
      io.emit('agent:messaged', { agentId, message, targetAgentId });
    });

    socket.on('disconnect', () => {
      console.log('User disconnected');
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    // 로컬 JSONL 합산은 기본 끔. 필요 시 CLAUDE_JSONL_AUTO_SYNC=1 로 주기 동기화.
    if (process.env.CLAUDE_JSONL_AUTO_SYNC === '1') {
      const intervalMs = Math.max(
        30_000,
        parseInt(process.env.CLAUDE_JSONL_SYNC_INTERVAL_MS || '120000', 10) || 120_000,
      );
      setTimeout(() => {
        try {
          const r = runLocalJsonlUsageSync();
          if (DEBUG_CLAUDE && (r.deltaRecorded || r.aggregate.usageLineCount > 0)) {
            console.log('[claude-jsonl] initial sync', r.deltaRecorded ? '+delta' : 'noop', r.aggregate);
          }
        } catch (e) {
          console.warn('[claude-jsonl] initial sync failed:', (e as Error).message);
        }
      }, 4000);
      setInterval(() => {
        try {
          runLocalJsonlUsageSync();
        } catch {
          /* 주기 동기화 실패는 치명적이지 않음 */
        }
      }, intervalMs);
    }
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
