import type { Collection, Db } from 'mongodb';
import type { Server as SocketServer } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { mkdirSync } from 'fs';

import type { Agent, CodeFile, GameState, Project, Task, AutoDevSettings, SharedGoal } from '../types';
import { AgentWorkerRegistry } from './agentWorker';
import { readLLMEnv } from './llm/provider';
import {
  buildSystemPrompt,
  buildTaskPrompt,
  buildLeaderPlanPrompt,
  extractLeaderPlan,
  type CodeRulesForPrompt,
} from './prompts';
import { buildAgentDispatchContext } from '../services/agentDispatcher';
import {
  collectNaturalLanguageSample,
  isMostlyKorean,
} from '../utils/koreanRatio';
import {
  buildLeaderGitAutomationContext,
  classifyLeaderMessage,
  formatImprovementReportForLeader,
  type ImprovementReport,
  type LeaderMessageKind,
} from '../utils/leaderMessage';
import type { GitAutomationRunResult } from '../utils/gitAutomation';

// Git 자동화 트리거 경로 전용 디버그 스위치. 리더 경유 단일 브랜치 경로
// (handleImprovementReport → runGitAutomation) 에서 어느 단계가 누락됐는지
// 재현 로그로 좁혀 볼 때 켠다. 기본 OFF 이며 운영 노이즈를 만들지 않는다.
// agentWorker.ts 의 동일 가드와 키를 공유해 한 번의 환경변수 토글로 전 경로가
// 함께 기록된다.
const DEBUG_GIT_AUTO = process.env.DEBUG_GIT_AUTO === '1';

// 서버가 보유한 태스크 dispatcher. 에이전트별 워커를 통해 지시를 흘려 넣고,
// 결과에 따라 Task/Agent 상태 전환 + 리더 분배 결과의 2차 태스크 생성 + git
// 자동화 트리거까지 한 곳에서 처리한다. 클라이언트는 /api/tasks POST 만으로
// 모든 후속 처리를 위임할 수 있다.

interface RunnerDeps {
  db: Db;
  io: SocketServer;
  registry: AgentWorkerRegistry;
  port: number;
  resolveWorkspace: (p: string) => string;
  runGitAutomation: (
    projectId: string,
    // forcePush: flowLevel 이 commitOnly 로 저장된 프로젝트라도 태스크 완료 훅에서는
    // 커밋+푸시가 한 번에 원격까지 반영되어야 한다는 요구(긴급 수정 #a7b258fb)를
    // 위해 서버 쪽 push 가드를 1회만 우회하는 강제 플래그.
    ctx?: { type?: string; summary?: string; agent?: string; prBase?: string; forcePush?: boolean },
  ) => Promise<GitAutomationRunResult>;
  getGameState: () => Promise<GameState>;
  getTasks: () => Promise<Task[]>;
  // 에이전트 상태 전이가 일어난 직후 호출되는 훅. server.ts 의 completionTracker
  // 와 연동해 "프로젝트 내 전원 idle" rising-edge 를 포착하는 경로다. 선택적으로
  // 주입되며, 생략 시 상태 전이에 대한 추가 사이드이펙트는 발생하지 않는다.
  onAgentStateChanged?: (projectId: string) => void;
}

export class TaskRunner {
  private db: Db;
  private io: SocketServer;
  private registry: AgentWorkerRegistry;
  private port: number;
  private resolveWorkspace: (p: string) => string;
  private runGitAutomation: RunnerDeps['runGitAutomation'];
  private getGameState: RunnerDeps['getGameState'];
  private getTasks: RunnerDeps['getTasks'];
  private onAgentStateChanged?: RunnerDeps['onAgentStateChanged'];

  private projectsCol: Collection<Project>;
  private agentsCol: Collection<Agent>;
  private tasksCol: Collection<Task>;
  private filesCol: Collection<CodeFile>;
  private settingsCol: Collection<{ key: string; value: any }>;
  private sharedGoalsCol: Collection<SharedGoal>;

  private autoDevTimer: NodeJS.Timeout | null = null;
  // auto-dev 는 서버 메모리 + DB 영속화. 기동 시 DB 에서 복원한다.
  private autoDev: AutoDevSettings = { enabled: false, updatedAt: new Date(0).toISOString() };

  private static readonly AUTO_DEV_TICK_MS = 12000;
  private static readonly SETTINGS_KEY = 'auto-dev';

  constructor(deps: RunnerDeps) {
    this.db = deps.db;
    this.io = deps.io;
    this.registry = deps.registry;
    this.port = deps.port;
    this.resolveWorkspace = deps.resolveWorkspace;
    this.runGitAutomation = deps.runGitAutomation;
    this.getGameState = deps.getGameState;
    this.getTasks = deps.getTasks;
    this.onAgentStateChanged = deps.onAgentStateChanged;

    this.projectsCol = this.db.collection<Project>('projects');
    this.agentsCol = this.db.collection<Agent>('agents');
    this.tasksCol = this.db.collection<Task>('tasks');
    this.filesCol = this.db.collection<CodeFile>('files');
    this.settingsCol = this.db.collection<{ key: string; value: any }>('settings');
    this.sharedGoalsCol = this.db.collection<SharedGoal>('shared_goals');
  }

  // 프로젝트의 활성 공동 목표를 반환. 자동 개발 루프와 리더 프롬프트 조립 양쪽에서
  // 사용하며, 없으면 null 을 돌려 호출자가 "목표 없음" 분기로 처리할 수 있게 한다.
  async getActiveSharedGoal(projectId: string): Promise<SharedGoal | null> {
    const goal = await this.sharedGoalsCol.findOne(
      { projectId, status: 'active' },
      { projection: { _id: 0 }, sort: { createdAt: -1 } },
    );
    return (goal as SharedGoal | null) || null;
  }

  async init() {
    await this.settingsCol.createIndex({ key: 1 }, { unique: true });
    const row = await this.settingsCol.findOne({ key: TaskRunner.SETTINGS_KEY });
    if (row?.value && typeof row.value === 'object') {
      this.autoDev = {
        enabled: !!row.value.enabled,
        projectId: typeof row.value.projectId === 'string' ? row.value.projectId : undefined,
        updatedAt: typeof row.value.updatedAt === 'string' ? row.value.updatedAt : new Date().toISOString(),
      };
    }
    this.startAutoDevTimer();
  }

  // 워커 응답 후처리: 한국어 비율 검증을 통과한 텍스트만 호출자에게 돌려준다.
  // (1) 첫 응답을 받고 collectNaturalLanguageSample 로 message/description 영역만
  //     추출 — JSON 키 자체가 영문이라는 이유로 false-positive 가 나지 않도록 한다.
  // (2) isMostlyKorean 가 false 면 같은 워커 세션에 한국어 강제 지시를 enqueue 해
  //     재요청한다. 동일 세션에 흘려 넣어 직전 컨텍스트가 보존되므로 재작성 품질이
  //     안정적이다.
  // (3) 재요청 후에도 비율이 낮으면 경고만 남기고 원문을 그대로 통과시킨다 — 무한
  //     재시도는 비용 폭주와 작업 정체로 이어지므로 한 번에서 잘라낸다.
  private async enqueueWithKoreanGate(
    worker: ReturnType<AgentWorkerRegistry['ensure']>,
    prompt: string,
    task: Task,
  ): Promise<string> {
    const first = await worker.enqueue(prompt, task.id);
    const sample = collectNaturalLanguageSample(first);
    if (isMostlyKorean(sample)) return first;
    console.warn(
      `[lang] task ${task.id} (assignedTo=${task.assignedTo}) 한국어 비율 낮음 — 재요청`,
    );
    const retryPrompt = [
      '직전 응답이 한국어가 아닙니다.',
      '동일한 형식 규칙(JSON 스키마 / 한 줄 요약 등)을 그대로 유지하되,',
      '모든 자연어 문장(message·description·요약)을 반드시 한국어로 다시 작성해 보내세요.',
      '코드·식별자·파일 경로는 원문을 유지하면 됩니다.',
    ].join(' ');
    const retry = await worker.enqueue(retryPrompt, task.id);
    const retrySample = collectNaturalLanguageSample(retry);
    if (!isMostlyKorean(retrySample)) {
      console.warn(
        `[lang] task ${task.id} 재요청 후에도 한국어 비율 낮음 — 원문 진행 (검토 필요)`,
      );
    }
    return retry;
  }

  async ensureWorkerForAgent(agent: Agent, project: Project): Promise<ReturnType<AgentWorkerRegistry['ensure']>> {
    const workspacePath = this.resolveWorkspace(project.workspacePath);
    try { mkdirSync(workspacePath, { recursive: true }); } catch { /* noop */ }
    // 로컬 LLM(ollama/vllm) 과 claude-cli 는 노출되는 도구 이름·호출 규약이 다르므로,
    // 현재 프로바이더를 프롬프트 빌더에 넘겨 알맞은 도구 목록과 규칙 블록을 선택한다.
    const systemPrompt = buildSystemPrompt(agent, { provider: readLLMEnv().provider });
    return this.registry.ensure({
      agentId: agent.id,
      projectId: project.id,
      workspacePath,
      port: this.port,
      systemPrompt,
      // 리더 단일 브랜치 경로로 통합된 뒤, 에이전트 단위 완료 훅은 제거됐다.
      // 팀원 턴이 성공 종료되면 워커는 오직 개선 보고만 리더 큐로 흘려 보내고,
      // Git 자동화(브랜치/커밋/푸시/PR)는 전적으로 리더 태스크 흐름이 책임진다.
      onImprovementReport: (report) => {
        this.handleImprovementReport(agent, project, report).catch(err =>
          console.error(
            '[improvement] leader dispatch failed:',
            (err as Error)?.message,
          ),
        );
      },
    });
  }

  // 외부 진입점 — 테스트/서버 핸들러가 에이전트를 대신해 리포트를 리더 큐로
  // 밀어 넣을 때 사용한다. agentWorker 의 동명 메서드가 내부 탐지 루프를 책임지고,
  // 이 쪽은 "이미 준비된 리포트를 리더에게 전달" 하는 얇은 래퍼다.
  async reportImprovementToLeader(
    agent: Agent,
    project: Project,
    report: ImprovementReport,
  ): Promise<void> {
    return this.handleImprovementReport(agent, project, report);
  }

  // 리더 큐 전달 파이프라인. 리포트를 사람이 읽을 수 있는 한국어 지시문으로 변환해
  // 새 태스크로 insert 하고, 해당 프로젝트의 리더를 찾아 dispatchTask 로 흘려 넣는다.
  // 리더 본인이 보낸 보고는 무한 루프 위험이 있어 차단하고, 리더가 없는 프로젝트는
  // 조용히 스킵한다(팀 구성에 따라 리더 없는 1인 프로젝트도 허용되므로 에러가 아님).
  private async handleImprovementReport(
    agent: Agent,
    project: Project,
    report: ImprovementReport,
  ): Promise<void> {
    if (agent.role === 'Leader') return;
    if (!report?.summary) return;
    const leader = await this.agentsCol.findOne(
      { id: { $in: project.agents || [] }, role: 'Leader' },
      { projection: { _id: 0 } },
    );
    if (!leader) return;
    // 리더가 팀원의 완료 이벤트를 수신하는 순간 Git 자동화 파이프라인을 직접 실행한다.
    // 리더 단일 브랜치 경로로 통합된 이후, 이 호출이 전체 프로젝트의 브랜치 생성·
    // 커밋·푸시·PR 을 책임지는 유일한 지점이다. 에이전트 단위 트리거(구
    // handleWorkerTaskComplete 와 AgentWorker.onTaskComplete) 는 제거됐으며,
    // 팀원의 모든 기여는 리더 태스크 흐름을 통해 하나의 브랜치로 통합 커밋된다.
    const gitContext = buildLeaderGitAutomationContext(report, agent.name);
    if (DEBUG_GIT_AUTO) {
      console.log(
        `[git-auto] leader-dispatch trigger project=${project.id} reporter=${agent.id} type=${gitContext.type} summary="${gitContext.summary.slice(0, 48)}"`,
      );
    }
    this.runGitAutomation(project.id, gitContext).catch(err =>
      console.error(
        '[improvement] leader-mediated git automation failed:',
        (err as Error)?.message,
      ),
    );
    const description = formatImprovementReportForLeader(report);
    const task: Task = {
      id: uuidv4(),
      projectId: project.id,
      assignedTo: leader.id,
      description,
      status: 'pending',
      // 'user' 로 기록해 리더의 buildLeaderPlanPrompt 가 user-command trigger 로
      // 받도록 한다. 'leader' 는 "리더가 분배한 자식 태스크" 의미로 이미 쓰이고
      // 있어 재사용하면 맥락이 충돌한다.
      source: 'user',
    };
    await this.tasksCol.insertOne(task);
    this.io.emit('tasks:updated', await this.getTasks());
    this.dispatchTask(task).catch(err =>
      console.error(
        '[improvement] leader dispatchTask failed:',
        (err as Error)?.message,
      ),
    );
  }

  getAutoDev(): AutoDevSettings { return { ...this.autoDev }; }

  async setAutoDev(next: Partial<AutoDevSettings>): Promise<AutoDevSettings> {
    const merged: AutoDevSettings = {
      enabled: next.enabled !== undefined ? !!next.enabled : this.autoDev.enabled,
      projectId: 'projectId' in next ? next.projectId : this.autoDev.projectId,
      updatedAt: new Date().toISOString(),
    };
    // "목표 없으면 자동 개발을 시작하지 않는다" 규약: projectId 를 지정해 활성화하는
    // 경우, 해당 프로젝트에 활성 공동 목표가 없으면 거부한다. projectId 를 생략한
    // 전역 활성화는 tick 단계에서 프로젝트별로 개별 스킵하므로 여기서는 통과시킨다.
    if (merged.enabled && merged.projectId) {
      const goal = await this.getActiveSharedGoal(merged.projectId);
      if (!goal) {
        const err = new Error('이 프로젝트에는 활성 공동 목표가 없어 자동 개발을 시작할 수 없습니다.');
        (err as Error & { code?: string }).code = 'SHARED_GOAL_REQUIRED';
        throw err;
      }
    }
    this.autoDev = merged;
    await this.settingsCol.updateOne(
      { key: TaskRunner.SETTINGS_KEY },
      { $set: { value: merged } },
      { upsert: true },
    );
    this.io.emit('auto-dev:updated', merged);
    return merged;
  }

  private startAutoDevTimer() {
    if (this.autoDevTimer) clearInterval(this.autoDevTimer);
    this.autoDevTimer = setInterval(() => {
      this.autoDevTick().catch(err => console.error('[auto-dev] tick failed:', err?.message));
    }, TaskRunner.AUTO_DEV_TICK_MS);
  }

  private async autoDevTick() {
    if (!this.autoDev.enabled) return;
    const projectsFilter = this.autoDev.projectId ? { id: this.autoDev.projectId } : {};
    const projects = await this.projectsCol.find(projectsFilter, { projection: { _id: 0 } }).toArray();
    if (projects.length === 0) return;
    // 각 프로젝트마다 최대 1명의 idle 에이전트에게 합성 태스크를 생성한다.
    // "idle" 기준: DB 상 status=idle 이고 현재 워커 큐가 비어있음(중복 enqueue 방지).
    for (const project of projects) {
      if (!project.agents || project.agents.length === 0) continue;
      // 활성 공동 목표가 없는 프로젝트는 tick 을 건너뛴다. 목표 없이 합성 태스크를
      // 생성하면 리더가 맥락 없는 분배를 하게 되어 불필요한 모델 호출만 쌓인다.
      const goal = await this.getActiveSharedGoal(project.id);
      if (!goal) {
        console.warn(`[auto-dev] project ${project.id} 활성 공동 목표 없음 — 스킵`);
        continue;
      }
      const members = await this.agentsCol
        .find({ id: { $in: project.agents } }, { projection: { _id: 0 } })
        .toArray();
      const idleMembers = members.filter(a => a.status === 'idle' && this.isWorkerIdle(a.id));
      if (idleMembers.length === 0) continue;
      const pick = idleMembers[Math.floor(Math.random() * idleMembers.length)];
      await this.spawnAutoDevTask(pick, project);
    }
  }

  private isWorkerIdle(agentId: string): boolean {
    const w = this.registry.get(agentId);
    return !w || w.isIdle();
  }

  private async spawnAutoDevTask(agent: Agent, project: Project) {
    const description = agent.role === 'Leader'
      ? `프로젝트 "${project.name}" 의 현재 상태를 검토하고 팀원에게 다음 업무를 분배하세요.`
      : `프로젝트 "${project.name}" 에서 자신의 역할(${agent.role})에 맞춰 자율적으로 개선 작업을 수행하세요.`;
    const task: Task = {
      id: uuidv4(),
      projectId: project.id,
      assignedTo: agent.id,
      description,
      status: 'pending',
      source: 'auto-dev',
    };
    await this.tasksCol.insertOne(task);
    this.io.emit('tasks:updated', await this.getTasks());
    this.dispatchTask(task).catch(err => console.error('[auto-dev] dispatch failed:', err?.message));
  }

  // /api/tasks POST 또는 auto-dev 가 호출. 실제 워커 큐에 enqueue 하고 완료될
  // 때까지 상태 전환을 관리한다. 이 함수는 호출자 입장에서 "fire-and-forget" 으로
  // 쓰여도 안전하도록 내부에서 모든 오류를 catch 한다.
  async dispatchTask(task: Task): Promise<void> {
    const agent = await this.agentsCol.findOne({ id: task.assignedTo }, { projection: { _id: 0 } });
    const project = await this.projectsCol.findOne({ id: task.projectId }, { projection: { _id: 0 } });
    if (!agent || !project) {
      console.warn(`[dispatch] missing agent or project for task ${task.id}`);
      return;
    }
    const worker = await this.ensureWorkerForAgent(agent, project);

    // in-progress 전환
    await this.tasksCol.updateOne({ id: task.id }, { $set: { status: 'in-progress' } });
    await this.agentsCol.updateOne(
      { id: agent.id },
      { $set: { status: 'working', currentTask: task.id } },
    );
    this.io.emit('tasks:updated', await this.getTasks());
    this.io.emit('state:updated', await this.getGameState());

    let prompt: string;
    let isLeaderPlanning = false;
    let teamPeers: Agent[] = [];
    if (agent.role === 'Leader') {
      // 리더에게 할당된 태스크는 "업무 분배" 로 해석한다. description 을 사용자
      // 커맨드로 전달하고, 팀원 목록은 프로젝트 멤버에서 리더 본인을 제외해 구성.
      teamPeers = (await this.agentsCol
        .find({ id: { $in: project.agents || [] } }, { projection: { _id: 0 } })
        .toArray()).filter(p => p.id !== agent.id);
      // 리더 분배 프롬프트에 활성 공동 목표를 주입해 팀 전체가 동일한 방향을
      // 지향하도록 한다. auto-dev 가 tick 에서 이미 목표 존재를 검증했지만,
      // 사용자 커맨드로 리더가 호출되는 경우에도 목표 컨텍스트가 유용하므로
      // 조회는 trigger 에 무관하게 수행한다.
      const sharedGoal = await this.getActiveSharedGoal(project.id);
      prompt = buildLeaderPlanPrompt({
        agent,
        project,
        peers: teamPeers,
        trigger: task.source === 'auto-dev' ? 'auto-dev' : 'user-command',
        userCommand: task.description,
        sharedGoal,
      });
      isLeaderPlanning = true;
    } else {
      // 워커 태스크: 우선 검토할 파일과 소통할 피어 1명을 골라준다.
      const files = await this.filesCol
        .find({ projectId: project.id }, { projection: { _id: 0 } })
        .toArray();
      const candidateFile = files.length > 0 ? files[Math.floor(Math.random() * files.length)] : null;
      const peerPool = (await this.agentsCol
        .find({ id: { $in: project.agents || [] } }, { projection: { _id: 0 } })
        .toArray()).filter(p => p.id !== agent.id);
      const peer = peerPool.length > 0 ? peerPool[Math.floor(Math.random() * peerPool.length)] : null;
      // 지시 #87cbd107 — 코드 컨벤션/룰을 디스패처에서 조달해 프롬프트 상단에 주입.
      // provider 가 미등록이거나 조회 실패시 dispatcher 는 codeRules=null 을 돌려주며,
      // renderCodeRulesBlock 가 빈 배열을 반환해 프롬프트에는 블록이 추가되지 않는다.
      let codeRules: CodeRulesForPrompt | null = null;
      try {
        const ctx = await buildAgentDispatchContext(project.id);
        codeRules = ctx.codeRules;
      } catch {
        codeRules = null;
      }
      // 로컬 LLM(ollama/vllm) 경로에서만 "도구 응답 풀어쓰기 금지" 블록을 추가
      // 주입하기 위해 현재 프로바이더를 함께 넘긴다. claude-cli 는 영향 없음.
      prompt = buildTaskPrompt({
        agent, task, project, candidateFile, peer, codeRules,
        provider: readLLMEnv().provider,
      });
    }

    try {
      const text = await this.enqueueWithKoreanGate(worker, prompt, task);
      // 리더 응답은 엄격한 JSON 스키마({tasks,message})라 원문을 그대로 UI 로 흘려보내면
      // 사용자에게 날것의 JSON 이 노출된다. 여기서 파싱해 자연어 메시지 + "@이름: 업무"
      // 브리핑만 방출하고, 파싱 실패 시에는 고정 fallback 으로 차단한다.
      if (isLeaderPlanning) {
        const parsed = extractLeaderPlan(text);
        let displayText: string;
        if (parsed) {
          // reply 모드 또는 tasks 가 비어있는 응답은 "답변 전용" 경로로 합친다.
          // dispatch 선언이라도 실제 분배 대상이 없으면 자식 태스크 생성을 건너뛰어
          // 불필요한 워커 가동을 막는다. UI 배지용 leaderKind 는 classifyLeaderMessage
          // 로 별도 계산하므로, 이 플래그는 순수하게 dispatch 분기 판정에만 쓴다.
          const isReplyOnly = parsed.mode === 'reply' || parsed.tasks.length === 0;
          if (!isReplyOnly) {
            for (const t of parsed.tasks) {
              if (!project.agents?.includes(t.assignedTo)) continue;
              const child: Task = {
                id: uuidv4(),
                projectId: project.id,
                assignedTo: t.assignedTo,
                description: t.description,
                status: 'pending',
                source: 'leader',
              };
              await this.tasksCol.insertOne(child);
              // 백그라운드 dispatch — 상위 리더 태스크 완료 처리와 병렬로 진행.
              this.dispatchTask(child).catch(err => console.error('[leader child] dispatch failed:', err?.message));
            }
            this.io.emit('tasks:updated', await this.getTasks());
          }
          if (isReplyOnly) {
            const reply = parsed.message?.trim();
            // reply 인데 message 조차 없으면 UX 가 침묵으로 끝나므로 명시적 폴백.
            displayText = reply || '리더가 이번 지시에는 별도의 분배 없이 상황만 확인했습니다.';
          } else {
            const nameById = new Map(teamPeers.map(p => [p.id, p.name]));
            const briefings = parsed.tasks.map(t => {
              const name = nameById.get(t.assignedTo) ?? t.assignedTo;
              return `@${name}: ${t.description}`;
            });
            const parts: string[] = [];
            const headline = parsed.message?.trim();
            if (headline) parts.push(headline);
            if (briefings.length > 0) parts.push(...briefings);
            displayText = parts.length > 0
              ? parts.join('\n')
              : '리더가 지금은 분배할 업무를 찾지 못했습니다.';
          }
        } else {
          displayText = '리더 응답을 해석하지 못해 이번 지시는 분배를 건너뜁니다.';
        }
        const clipped = displayText.slice(0, 400);
        // 리더 발화 종류 판정은 UI 배지(AgentStatusPanel·AgentContextBubble)가
        // 쓰는 classifyLeaderMessage 와 단일 출처를 공유한다. 원문(text)을 그대로
        // 넘겨 UI 가 직접 파싱했을 때와 동일한 결과를 서버도 보장한다.
        const leaderKind: LeaderMessageKind = classifyLeaderMessage(text);
        this.io.emit('agent:messaged', {
          agentId: agent.id,
          message: clipped,
          leaderKind,
        });
        await this.agentsCol.updateOne(
          { id: agent.id },
          { $set: { lastMessage: clipped, lastLeaderMessageKind: leaderKind } },
        );
      } else {
        const final = (text || '').trim();
        if (final) {
          // 에이전트 말풍선/타임라인 업데이트. 리더가 아닌 에이전트의 발화는 분배/답변
          // 분기와 무관하므로 kind 를 'plain' 으로 고정해 UI 배지가 잘못 뜨지 않도록 한다.
          this.io.emit('agent:messaged', {
            agentId: agent.id,
            message: final.slice(0, 400),
            leaderKind: 'plain',
          });
          await this.agentsCol.updateOne(
            { id: agent.id },
            { $set: { lastMessage: final.slice(0, 400), lastLeaderMessageKind: 'plain' } },
          );
        }
      }

      // 완료 전환
      await this.tasksCol.updateOne({ id: task.id }, { $set: { status: 'completed' } });
      await this.agentsCol.updateOne(
        { id: agent.id, currentTask: task.id },
        { $set: { status: 'idle', currentTask: '', workingOnFileId: '', lastActiveTask: task.id } },
      );
      this.io.emit('tasks:updated', await this.getTasks());
      this.io.emit('state:updated', await this.getGameState());
      // 에이전트가 idle 로 돌아간 순간이다. server.ts 의 completionTracker 가
      // 이 시점의 프로젝트 전체 상태를 다시 관측해 "전원 idle 전이" 여부를 판정한다.
      try { this.onAgentStateChanged?.(project.id); } catch (e) {
        console.error('[runner] onAgentStateChanged failed:', (e as Error).message);
      }
      // Git 자동화 트리거는 리더 태스크 흐름(handleImprovementReport →
      // runGitAutomation)이 단일 경로로 담당한다. 에이전트 단위 안전망은 제거 —
      // 리더 단일 브랜치로 변경 집합을 통합 커밋하는 계약을 유지한다.
    } catch (e) {
      console.error(`[dispatch] task ${task.id} failed:`, (e as Error).message);
      // 실패 시 pending 복구로 다음 틱에 재시도 가능하게 둔다. 단 task.source 가
      // auto-dev 인 경우 무한 재시도 방지를 위해 completed(실패)로 종결한다.
      const nextStatus: Task['status'] = task.source === 'auto-dev' ? 'completed' : 'pending';
      await this.tasksCol.updateOne({ id: task.id }, { $set: { status: nextStatus } });
      await this.agentsCol.updateOne(
        { id: agent.id, currentTask: task.id },
        { $set: { status: 'idle', currentTask: '', lastActiveTask: task.id } },
      );
      this.io.emit('tasks:updated', await this.getTasks());
      this.io.emit('state:updated', await this.getGameState());
      // 실패 경로에서도 에이전트는 idle 로 돌아간다. completionTracker 입장에서는
      // 성공/실패 구분 없이 "전원 idle" 전이가 의미 있으므로 동일하게 통지한다.
      try { this.onAgentStateChanged?.(project.id); } catch (e) {
        console.error('[runner] onAgentStateChanged failed:', (e as Error).message);
      }
    }
  }

  async disposeAgentWorker(agentId: string) {
    this.registry.dispose(agentId);
  }

  shutdown() {
    if (this.autoDevTimer) clearInterval(this.autoDevTimer);
    this.autoDevTimer = null;
    this.registry.disposeAll();
  }
}
