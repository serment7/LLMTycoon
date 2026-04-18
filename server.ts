import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { MongoClient, Db } from 'mongodb';
import multer from 'multer';
import { Agent, Project, GameState, CodeFile, CodeDependency, Task, SourceIntegration, ManagedProject, SourceProvider, GitAutomationSettings, GitCredential, GitCredentialRedacted, SharedGoal, SharedGoalPriority, SharedGoalStatus, ProjectOptionsUpdate, PROJECT_OPTION_DEFAULTS } from './src/types';
import { AgentWorkerRegistry } from './src/server/agentWorker';
import { TaskRunner } from './src/server/taskRunner';
import { processDirectiveFile } from './src/server/fileProcessor';
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
  renderBranchName,
  shouldAutoCommit,
  shouldAutoOpenPR,
  shouldAutoPush,
  validateGitAutomationConfig,
  type GitAutomationRunResult,
  type GitAutomationStepResult,
} from './src/utils/gitAutomation';
import {
  decryptToken,
  encryptToken,
  injectTokenIntoRemoteUrl,
  redactRemoteUrl,
} from './src/utils/projectGitCredentials';
import { spawnSync } from 'child_process';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DEBUG_CLAUDE = process.env.DEBUG_CLAUDE === '1';
const PORT = parseInt(process.env.PORT || '3000', 10);

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
      child.on('error', err => { cleanup(); reject(err); });
      child.on('close', code => {
        cleanup();
        if (code === 0) {
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
        reject(new Error(msg));
      });
    };

    claudeQueue.push(run);
    drainClaudeQueue();
  });
}

async function diagnoseClaudeCli() {
  try {
    const out = await callClaude('한 단어만 답하세요: ping');
    console.log(`[claude] CLI OK — response: "${out.slice(0, 80)}"`);
  } catch (e) {
    console.error(`[claude] CLI UNAVAILABLE: ${(e as Error).message}`);
    console.error('[claude] 점검 항목:');
    console.error('  1) "claude --version" 이 터미널에서 동작하는지');
    console.error('  2) "claude login" 으로 구독 세션 인증 완료했는지');
    console.error('  3) 환경변수 CLAUDE_BIN 으로 절대경로 지정 필요 여부');
    console.error('  4) DEBUG_CLAUDE=1 로 재실행하면 실제 명령어 로그 확인');
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
  diagnoseClaudeCli();

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
    // 컨텍스트 없는 일회성 호출(진단·ping 등)은 기존 1-shot 경로를 유지한다.
    try {
      const text = await callClaude(prompt);
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
    return {
      projectId,
      enabled: raw?.enabled ?? false,
      flowLevel: base.flowLevel,
      branchTemplate: base.branchTemplate,
      commitConvention: base.commitConvention,
      commitScope: base.commitScope,
      prTitleTemplate: base.prTitleTemplate,
      reviewers: base.reviewers,
      updatedAt: raw?.updatedAt || new Date(0).toISOString(),
    };
  }

  app.get('/api/projects/:id/git-automation', async (req, res) => {
    const { id } = req.params;
    const project = await projectsCol.findOne({ id });
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    const row = await gitAutomationSettingsCol.findOne({ projectId: id }, { projection: { _id: 0 } });
    res.json(withDefaultSettings(id, row as Partial<GitAutomationSettings> | null));
  });

  app.post('/api/projects/:id/git-automation', async (req, res) => {
    const { id } = req.params;
    const project = await projectsCol.findOne({ id });
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    const body = req.body || {};
    const validation = validateGitAutomationConfig(body);
    if (validation.ok !== true) { res.status(400).json({ error: validation.error }); return; }
    const settings: GitAutomationSettings = {
      projectId: id,
      enabled: body.enabled !== false,
      ...validation.config,
      updatedAt: new Date().toISOString(),
    };
    await gitAutomationSettingsCol.updateOne(
      { projectId: id },
      { $set: settings },
      { upsert: true },
    );
    io.emit('git-automation:updated', { projectId: id, settings });
    res.json(settings);
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
    ctxHint?: { type?: string; summary?: string; agent?: string; prBase?: string; forcePush?: boolean },
  ): Promise<GitAutomationRunResult> {
    try {
      const project = await projectsCol.findOne({ id: projectId });
      if (!project) return { ok: false, skipped: 'no-project', error: 'project not found', results: [] };
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
      const branch = renderBranchName(settings.branchTemplate, {
        type: ctxHint?.type || 'chore',
        summary: ctxHint?.summary || 'auto',
        agent: ctxHint?.agent,
      });
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
        const stdout = label === 'commit' || label === 'pr'
          ? (r.stdout || '').slice(0, 400)
          : undefined;
        // 원격 URL 에 토큰이 인라인 주입된 상태라면, 실패 stderr 에 자격증명이 그대로
        // 박힌 채 로그·소켓 페이로드로 흘러갈 위험이 있다. redactRemoteUrl 을 항상
        // 통과시켜 `user:***@host` 로 마스킹한 뒤에만 외부에 노출한다.
        const step: GitAutomationStepResult = {
          label,
          ok,
          code: r.status,
          stderr: ok ? undefined : redactRemoteUrl(stderrRaw).slice(0, 400),
          stdout: stdout ? redactRemoteUrl(stdout) : undefined,
        };
        results.push(step);
        if (!ok) {
          console.error(
            `[git-automation] step=${label} failed project=${projectId} branch=${branch} code=${r.status ?? 'null'} stderr=${(step.stderr || '').slice(0, 200)}`,
          );
        }
        return ok;
      };
      const finalize = (ok: boolean): GitAutomationRunResult => {
        io.emit('git-automation:ran', { projectId, results, branch });
        return { ok, results, branch, commitMessage, prTitle };
      };

      // autoCommit: checkout → add → commit 을 한 묶음으로 수행.
      if (shouldAutoCommit(settings)) {
        if (!runStep('checkout', ['git', '-C', cwd, 'checkout', '-B', branch])) return finalize(false);
        if (!runStep('add', ['git', '-C', cwd, 'add', '-A'])) return finalize(false);
        if (!runStep('commit', ['git', '-C', cwd, 'commit', '-m', commitMessage])) return finalize(false);
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
    const out = await executeGitAutomation(id, req.body || {});
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

  // Socket logic
  io.on('connection', async (socket) => {
    socket.emit('state:initial', await getGameState());

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
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
