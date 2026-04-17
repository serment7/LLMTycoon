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
import { Agent, Project, GameState, CodeFile, CodeDependency, Task, SourceIntegration, ManagedProject, SourceProvider, GitAutomationSettings } from './src/types';
import { parseEntry, type LedgerEntry } from './src/utils/handoffLedger';
import { inferFileType, isExcludedFromCodeGraph } from './src/utils/codeGraphFilter';
import {
  DEFAULT_GIT_AUTOMATION_CONFIG,
  buildRunPlan,
  formatCommitMessage,
  formatPrTitle,
  renderBranchName,
  validateGitAutomationConfig,
} from './src/utils/gitAutomation';
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
      let mcpFlag = '';
      if (ctx && ctx.agentId && ctx.projectId) {
        mcpConfigPath = writeMcpConfig(ctx);
        mcpFlag = `--mcp-config ${shellQuote(mcpConfigPath)}`;
      }
      const shellCmd = `${CLAUDE_BIN} --dangerously-skip-permissions ${mcpFlag} -p ${shellQuote(prompt)}`.replace(/\s+/g, ' ');
      if (DEBUG_CLAUDE) console.log('[claude] $', shellCmd);
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
      const child = spawn(shellCmd, {
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        cwd,
      });
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
  // 프로젝트별 Git 자동화 설정. projectId 를 논리적 주키로 쓰고, upsert 로만 갱신한다.
  // 리더 에이전트가 태스크 완료 이벤트마다 이 컬렉션을 조회해 auto-commit/push/PR 여부를 판정.
  const gitAutomationSettingsCol = db.collection<GitAutomationSettings>('git_automation_settings');
  await gitAutomationSettingsCol.createIndex({ projectId: 1 }, { unique: true });

  console.log(`Connected to MongoDB at ${MONGODB_URI}/${MONGODB_DB}`);
  diagnoseClaudeCli();

  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);

  app.use(express.json());

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

  // Seed initial data if empty
  const projectCount = await projectsCol.countDocuments();
  if (projectCount === 0) {
    const defaultProjectId = uuidv4();

    const initialAgents: Agent[] = [
      { id: uuidv4(), name: '알파', role: 'Leader', spriteTemplate: 'char1', x: 100, y: 100, status: 'idle' },
      { id: uuidv4(), name: '베타', role: 'Developer', spriteTemplate: 'char2', x: 200, y: 150, status: 'idle' },
      { id: uuidv4(), name: '감마', role: 'QA', spriteTemplate: 'char3', x: 300, y: 200, status: 'idle' },
    ];
    await agentsCol.insertMany(initialAgents);

    const defaultProject: Project = {
      id: defaultProjectId,
      name: 'Core System',
      description: 'The main engine of LLM Tycoon',
      workspacePath: './workspaces/core',
      status: 'active',
      agents: initialAgents.map(a => a.id),
    };
    resolveWorkspace(defaultProject.workspacePath);
    await projectsCol.insertOne(defaultProject);

    const initialFiles: CodeFile[] = [
      { id: 'f1', name: 'App.tsx', x: 150, y: 150, projectId: defaultProjectId, type: 'component' },
      { id: 'f2', name: 'Header.tsx', x: 300, y: 100, projectId: defaultProjectId, type: 'component' },
      { id: 'f3', name: 'Sidebar.tsx', x: 300, y: 200, projectId: defaultProjectId, type: 'component' },
      { id: 'f4', name: 'api.ts', x: 500, y: 150, projectId: defaultProjectId, type: 'service' },
      { id: 'f5', name: 'utils.ts', x: 650, y: 150, projectId: defaultProjectId, type: 'util' },
    ];
    await filesCol.insertMany(initialFiles);

    const initialDeps: CodeDependency[] = [
      { from: 'f1', to: 'f2' },
      { from: 'f1', to: 'f3' },
      { from: 'f2', to: 'f4' },
      { from: 'f3', to: 'f4' },
      { from: 'f4', to: 'f5' },
    ];
    await depsCol.insertMany(initialDeps);
  }

  // API Routes
  app.get('/api/state', async (req, res) => {
    res.json(await getGameState());
  });

  app.get('/api/tasks', async (req, res) => {
    res.json(await getTasks());
  });

  app.post('/api/tasks', async (req, res) => {
    const { projectId, assignedTo, description } = req.body;
    const task: Task = { id: uuidv4(), projectId, assignedTo, description, status: 'pending' };
    await tasksCol.insertOne(task);

    // 에이전트 상태는 여기서 바꾸지 않는다.
    // 실제 Claude 호출 시점(processAgentTask)에서 in-progress 전환과 함께 working으로 변경된다.
    // 여기서 미리 working으로 바꾸면 타이머가 idle 에이전트를 못 찾아 데드락이 발생한다.

    io.emit('tasks:updated', await getTasks());
    res.json(task);
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

    // 태스크 완료 시 에이전트를 idle로 복귀
    if (status === 'completed' && task.assignedTo) {
      await agentsCol.updateOne(
        { id: task.assignedTo, currentTask: id },
        { $set: { status: 'idle', currentTask: '', workingOnFileId: '' } },
      );
      io.emit('state:updated', await getGameState());
      // 리더 자동화: 완료된 태스크가 리더 본인(Leader) 이 아닌 다른 에이전트의
      // 작업일 때만 자동 git 실행을 시도한다. Leader 는 orchestration 전용이라
      // 본인의 "completed" 를 다시 트리거하면 무한 루프 위험이 있다.
      const actor = await agentsCol.findOne({ id: task.assignedTo });
      if (actor && actor.role !== 'Leader') {
        runGitAutomation(task.projectId, {
          type: 'chore',
          summary: task.description?.slice(0, 64) || 'auto update',
          agent: actor.name,
        }).catch(err => console.error('[git-automation] auto-run failed:', err?.message));
      }
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
    };
    await projectsCol.insertOne(project);

    io.emit('state:updated', await getGameState());
    res.json(project);
  });

  app.delete('/api/projects/:id', async (req, res) => {
    const { id } = req.params;
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
    let ctx: AgentContext | undefined;
    if (agentId && projectId) {
      const project = await projectsCol.findOne({ id: projectId });
      ctx = { agentId, projectId, workspacePath: project?.workspacePath };
    }
    try {
      const text = await callClaude(prompt, ctx);
      res.json({ text });
    } catch (e: any) {
      console.error('claude CLI failed:', e?.message);
      res.status(500).json({ error: e?.message || 'claude failed' });
    }
  });

  // --- MCP-backed endpoints ---
  app.patch('/api/agents/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status, workingOnFileId } = req.body || {};
    const update: Record<string, unknown> = {};
    if (status !== undefined) update.status = status;
    if (workingOnFileId !== undefined) update.workingOnFileId = workingOnFileId;
    // idle 전환 시 currentTask도 함께 정리하고, 할당된 태스크를 completed로 전환
    if (status === 'idle') {
      const agent = await agentsCol.findOne({ id });
      const taskId = agent?.currentTask;
      update.currentTask = '';

      if (taskId) {
        // 해당 태스크를 completed로 전환 → git-automation 트리거
        const task = await tasksCol.findOne({ id: taskId });
        if (task && task.status !== 'completed') {
          await tasksCol.updateOne({ id: taskId }, { $set: { status: 'completed' } });
          io.emit('tasks:updated', await getTasks());

          // git-automation 실행
          if (task.assignedTo) {
            const actor = await agentsCol.findOne({ id: task.assignedTo });
            if (actor && actor.role !== 'Leader') {
              runGitAutomation(task.projectId, {
                type: 'chore',
                summary: task.description?.slice(0, 64) || 'auto update',
                agent: actor.name,
              }).catch(err => console.error('[git-automation] auto-run failed:', err?.message));
            }
          }
        }
      }
    }
    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: 'nothing to update' });
      return;
    }
    await agentsCol.updateOne({ id }, { $set: update });
    io.emit('state:updated', await getGameState());
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
    if (isExcludedFromCodeGraph(String(name))) {
      res.status(400).json({ error: `path excluded from code graph: ${name}` });
      return;
    }
    const file: CodeFile = {
      id: uuidv4(),
      name: String(name),
      x: 0,
      y: 0,
      projectId: String(projectId),
      type: (type as CodeFile['type']) || inferFileType(String(name)),
    };
    await filesCol.insertOne(file);
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

  app.get('/api/integrations', async (_req, res) => {
    const items = await integrationsCol.find({}, { projection: { _id: 0 } }).toArray();
    res.json(items.map(i => redactIntegration(i as SourceIntegration)));
  });

  const normalizeHost = (raw: unknown): string | undefined => {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return undefined;
    const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    return withScheme.replace(/\/+$/, '');
  };

  app.post('/api/integrations', async (req, res) => {
    const { provider, label, accessToken, host } = req.body || {};
    if (!provider || !accessToken || (provider !== 'github' && provider !== 'gitlab')) {
      res.status(400).json({ error: 'provider (github|gitlab) and accessToken required' });
      return;
    }
    const integration: SourceIntegration = {
      id: uuidv4(),
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
        const result = await managedProjectsCol.updateOne(
          { provider: repo.provider, remoteId: repo.remoteId, integrationId: repo.integrationId },
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

  app.get('/api/managed-projects', async (_req, res) => {
    const items = await managedProjectsCol.find({}, { projection: { _id: 0 } }).toArray();
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

  // 리더가 완료 이벤트에 맞춰 호출하는 자동 실행 엔드포인트. 설정을 읽어
  // buildRunPlan 이 계산한 단계들을 프로젝트 workspacePath 에서 순차 실행한다.
  // 실패한 단계에서 중단하고 이후 단계는 skip 으로 기록한다.
  async function runGitAutomation(projectId: string, ctxHint?: { type?: string; summary?: string; agent?: string; prBase?: string }) {
    const project = await projectsCol.findOne({ id: projectId });
    if (!project) return { ok: false, error: 'project not found' };
    const row = await gitAutomationSettingsCol.findOne({ projectId });
    if (!row || row.enabled === false) return { ok: false, skipped: 'disabled' };
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
    const steps = buildRunPlan(settings, {
      workspacePath: cwd,
      branch,
      commitMessage,
      prTitle,
      prBase: ctxHint?.prBase,
      reviewers: settings.reviewers,
    });
    const results: Array<{ label: string; ok: boolean; code: number | null; stderr?: string }> = [];
    for (const step of steps) {
      const [bin, ...rest] = step.cmd;
      const r = spawnSync(bin, rest, { cwd, encoding: 'utf8', windowsHide: true });
      const ok = r.status === 0;
      results.push({ label: step.label, ok, code: r.status, stderr: ok ? undefined : (r.stderr || '').slice(0, 400) });
      if (!ok) break;
    }
    io.emit('git-automation:ran', { projectId, results, branch });
    return { ok: results.every(r => r.ok), results, branch, commitMessage, prTitle };
  }

  app.post('/api/projects/:id/git-automation/run', async (req, res) => {
    const { id } = req.params;
    const out = await runGitAutomation(id, req.body || {});
    if (!out.ok && 'error' in out) { res.status(404).json(out); return; }
    res.json(out);
  });

  // 긴급중단: 모든 에이전트를 idle 로 되돌리고, 완료되지 않은 모든 작업을 pending
  // 상태로 재설정한다. 이미 completed 인 작업은 그대로 보존해 이력을 잃지 않는다.
  // 실패 중인 LLM 호출은 서버에서 취소할 수단이 없으므로, "스냅샷" 차원에서
  // 상태·작업 큐만 리셋하는 것이 실제로 의미 있는 최대 범위다.
  app.post('/api/emergency-stop', async (_req, res) => {
    const agentResult = await agentsCol.updateMany(
      {},
      { $set: { status: 'idle', workingOnFileId: '' } },
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
