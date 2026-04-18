import type { Collection, Db } from 'mongodb';
import type { Server as SocketServer } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { mkdirSync } from 'fs';

import type { Agent, CodeFile, GameState, Project, Task, AutoDevSettings } from '../types';
import { AgentWorkerRegistry } from './agentWorker';
import {
  buildSystemPrompt,
  buildTaskPrompt,
  buildLeaderPlanPrompt,
  extractLeaderPlan,
} from './prompts';

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
    ctx?: { type?: string; summary?: string; agent?: string; prBase?: string },
  ) => Promise<unknown>;
  getGameState: () => Promise<GameState>;
  getTasks: () => Promise<Task[]>;
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

  private projectsCol: Collection<Project>;
  private agentsCol: Collection<Agent>;
  private tasksCol: Collection<Task>;
  private filesCol: Collection<CodeFile>;
  private settingsCol: Collection<{ key: string; value: any }>;

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

    this.projectsCol = this.db.collection<Project>('projects');
    this.agentsCol = this.db.collection<Agent>('agents');
    this.tasksCol = this.db.collection<Task>('tasks');
    this.filesCol = this.db.collection<CodeFile>('files');
    this.settingsCol = this.db.collection<{ key: string; value: any }>('settings');
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

  async ensureWorkerForAgent(agent: Agent, project: Project): Promise<ReturnType<AgentWorkerRegistry['ensure']>> {
    const workspacePath = this.resolveWorkspace(project.workspacePath);
    try { mkdirSync(workspacePath, { recursive: true }); } catch { /* noop */ }
    const systemPrompt = buildSystemPrompt(agent);
    return this.registry.ensure({
      agentId: agent.id,
      projectId: project.id,
      workspacePath,
      port: this.port,
      systemPrompt,
    });
  }

  getAutoDev(): AutoDevSettings { return { ...this.autoDev }; }

  async setAutoDev(next: Partial<AutoDevSettings>): Promise<AutoDevSettings> {
    const merged: AutoDevSettings = {
      enabled: next.enabled !== undefined ? !!next.enabled : this.autoDev.enabled,
      projectId: 'projectId' in next ? next.projectId : this.autoDev.projectId,
      updatedAt: new Date().toISOString(),
    };
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
    if (agent.role === 'Leader') {
      // 리더에게 할당된 태스크는 "업무 분배" 로 해석한다. description 을 사용자
      // 커맨드로 전달하고, 팀원 목록은 프로젝트 멤버에서 리더 본인을 제외해 구성.
      const teamPeers = (await this.agentsCol
        .find({ id: { $in: project.agents || [] } }, { projection: { _id: 0 } })
        .toArray()).filter(p => p.id !== agent.id);
      prompt = buildLeaderPlanPrompt({
        agent,
        project,
        peers: teamPeers,
        trigger: task.source === 'auto-dev' ? 'auto-dev' : 'user-command',
        userCommand: task.description,
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
      prompt = buildTaskPrompt({ agent, task, project, candidateFile, peer });
    }

    try {
      const text = await worker.enqueue(prompt, task.id);
      // 리더 분배 계획 후처리: JSON 파싱 → 하위 태스크 생성
      if (isLeaderPlanning) {
        const parsed = extractLeaderPlan(text);
        if (parsed?.tasks && parsed.tasks.length > 0) {
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
        if (parsed?.message) {
          this.io.emit('agent:messaged', { agentId: agent.id, message: parsed.message });
        }
      }

      const final = (text || '').trim();
      if (final) {
        // 에이전트 말풍선/타임라인 업데이트
        this.io.emit('agent:messaged', { agentId: agent.id, message: final.slice(0, 400) });
        await this.agentsCol.updateOne(
          { id: agent.id },
          { $set: { lastMessage: final.slice(0, 400) } },
        );
      }

      // 완료 전환
      await this.tasksCol.updateOne({ id: task.id }, { $set: { status: 'completed' } });
      await this.agentsCol.updateOne(
        { id: agent.id, currentTask: task.id },
        { $set: { status: 'idle', currentTask: '', workingOnFileId: '', lastActiveTask: task.id } },
      );
      this.io.emit('tasks:updated', await this.getTasks());
      this.io.emit('state:updated', await this.getGameState());

      if (agent.role !== 'Leader') {
        this.runGitAutomation(project.id, {
          type: 'chore',
          summary: task.description?.slice(0, 64) || 'auto update',
          agent: agent.name,
        }).catch(err => console.error('[git-automation] auto-run failed:', (err as Error)?.message));
      }
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
