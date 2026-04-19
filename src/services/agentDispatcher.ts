// 지시 #6fd99c90 — 에이전트 디스패치 연결점.
//
// 목적
//   스킬(projectSkillsStore) · MCP 서버(projectMcpServersStore) 에서 보관하는
//   프로젝트 설정을 에이전트 런타임이 디스패치 시점에 컨텍스트로 주입할 수 있도록
//   단일 진입점을 제공한다.
//
// 왜 서비스 계층인가
//   서버 워커(src/server/agentWorker.ts) 는 Node 환경에서 돌고 브라우저 stores 에
//   직접 접근할 수 없다. 본 모듈은 "제공자(Provider) 를 등록받아 호출자에게 동일한
//   shape 의 payload 를 돌려주는" 얇은 레이어만 맡는다. 실제 데이터 출처는
//   브라우저는 projectSkillsStore/projectMcpServersStore 를, 서버는 DB/파일에서
//   로드한 프로바이더를 주입하면 된다.
//
// 결합 최소화
//   · 기본(provider 미등록) 상태에서는 빈 컨텍스트를 반환한다 — 기존 에이전트 경로가
//     본 연결점의 유무와 무관하게 동작한다.
//   · 테스트는 `setSkillsProvider(null)` · `setMcpServersProvider(null)` 로 초기화.

import {
  listSkillsForAgent as defaultListSkillsForAgent,
  type SkillRecord,
} from '../stores/projectSkillsStore';
import {
  listProjectMcpServers as defaultListProjectMcpServers,
  type McpServerRecord,
} from '../stores/projectMcpServersStore';
import {
  loadCodeRulesForAgent as defaultLoadCodeRulesForAgent,
  type CodeRulesRecord,
} from '../stores/codeRulesStore';
import {
  getPendingUserInstructionsStore,
  type EnqueueInput,
  type PendingInstruction,
  type PendingUserInstructionsStore,
} from '../stores/pendingUserInstructionsStore';

export interface AgentSkillContext {
  id: string;
  scope: 'local' | 'global';
  name: string;
  description: string;
  prompt: string;
}

export interface AgentMcpServerContext {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentCodeRulesContext {
  scope: 'local' | 'global';
  indentation: { style: 'space' | 'tab'; size: number };
  quotes: 'single' | 'double' | 'backtick';
  semicolons: 'required' | 'omit';
  filenameConvention: string;
  linterPreset: string;
  forbiddenPatterns: { name: string; pattern: string; message?: string }[];
  extraInstructions?: string;
}

export interface AgentDispatchContext {
  projectId: string;
  skills: AgentSkillContext[];
  mcpServers: AgentMcpServerContext[];
  /** 지시 #87cbd107 — 로컬(프로젝트) 규칙 우선, 없으면 전역으로 폴백. */
  codeRules: AgentCodeRulesContext | null;
}

export type SkillsProvider = (projectId: string) => Promise<SkillRecord[]>;
export type McpServersProvider = (projectId: string) => Promise<McpServerRecord[]>;
export type CodeRulesProvider = (projectId: string) => Promise<CodeRulesRecord | null>;

let skillsProvider: SkillsProvider | null = null;
let mcpServersProvider: McpServersProvider | null = null;
let codeRulesProvider: CodeRulesProvider | null = null;

/**
 * 스킬 제공자 등록. null 을 넘기면 초기화 — 기본 브라우저 스토어 폴백이 적용된다.
 * 서버 환경에서 호출하면 DB 로드 결과를 반환하는 프로바이더를 끼워 넣으면 된다.
 */
export function setSkillsProvider(provider: SkillsProvider | null): void {
  skillsProvider = provider;
}

export function setMcpServersProvider(provider: McpServersProvider | null): void {
  mcpServersProvider = provider;
}

/**
 * 코드 규칙 제공자 등록. null 을 넘기면 초기화 — 기본 브라우저 스토어 폴백이 적용된다.
 * 서버 환경에서는 `.llmtycoon/rules.json` 을 디스크에서 읽는 프로바이더를 끼워 넣을 수 있다.
 */
export function setCodeRulesProvider(provider: CodeRulesProvider | null): void {
  codeRulesProvider = provider;
}

/**
 * 에이전트 런타임이 디스패치 직전에 호출해 현재 프로젝트의 스킬·MCP 서버를
 * 한 묶음으로 가져온다. 각 프로바이더가 실패하더라도 한쪽이 비어 있는 결과를
 * 돌려주며 전체 디스패치가 멈추지 않는다(에이전트 컨텍스트는 "있으면 좋고
 * 없어도 되는" 보조 정보).
 */
export async function buildAgentDispatchContext(
  projectId: string,
): Promise<AgentDispatchContext> {
  if (!projectId) {
    return { projectId: '', skills: [], mcpServers: [], codeRules: null };
  }

  const skillsPromise: Promise<SkillRecord[]> = (async () => {
    try {
      const p = skillsProvider ?? defaultListSkillsForAgent;
      return await p(projectId);
    } catch {
      return [];
    }
  })();

  const mcpPromise: Promise<McpServerRecord[]> = (async () => {
    try {
      const p = mcpServersProvider ?? defaultListProjectMcpServers;
      return await p(projectId);
    } catch {
      return [];
    }
  })();

  const rulesPromise: Promise<CodeRulesRecord | null> = (async () => {
    try {
      const p = codeRulesProvider ?? defaultLoadCodeRulesForAgent;
      return await p(projectId);
    } catch {
      return null;
    }
  })();

  const [skillRecords, mcpRecords, rulesRecord] = await Promise.all([skillsPromise, mcpPromise, rulesPromise]);

  return {
    projectId,
    skills: skillRecords.map((s) => ({
      id: s.id,
      scope: s.scope,
      name: s.name,
      description: s.description,
      prompt: s.prompt,
    })),
    mcpServers: mcpRecords.map((m) => ({
      id: m.id,
      name: m.name,
      command: m.command,
      args: [...m.args],
      env: { ...m.env },
    })),
    codeRules: rulesRecord ? {
      scope: rulesRecord.scope,
      indentation: { ...rulesRecord.indentation },
      quotes: rulesRecord.quotes,
      semicolons: rulesRecord.semicolons,
      filenameConvention: rulesRecord.filenameConvention,
      linterPreset: rulesRecord.linterPreset,
      forbiddenPatterns: rulesRecord.forbiddenPatterns.map((p) => ({ ...p })),
      extraInstructions: rulesRecord.extraInstructions,
    } : null,
  };
}

/**
 * 컨텍스트를 에이전트 프롬프트 접미어로 직렬화한다. 디스패치 시
 * 시스템 프롬프트 꼬리에 붙여 넣을 용도의 단순 텍스트 포맷. MCP 서버는 민감
 * 환경변수(env) 가 있을 수 있으므로 값은 요약만 하고, command/args 는 실행
 * 구성을 재현 가능하도록 원문을 싣는다.
 */
export function formatDispatchContextForPrompt(ctx: AgentDispatchContext): string {
  if (ctx.skills.length === 0 && ctx.mcpServers.length === 0 && !ctx.codeRules) return '';
  const lines: string[] = [];
  lines.push('## 에이전트 컨텍스트 주입');
  if (ctx.skills.length > 0) {
    lines.push('', '### 스킬');
    for (const s of ctx.skills) {
      lines.push(`- [${s.scope}] ${s.name} — ${s.description || '(설명 없음)'}`);
      if (s.prompt) {
        // 프롬프트 본문은 들여쓰기해 모델이 지침과 본문을 분리 인식하도록.
        const body = s.prompt.split('\n').map((l) => `    ${l}`).join('\n');
        lines.push(body);
      }
    }
  }
  if (ctx.mcpServers.length > 0) {
    lines.push('', '### MCP 서버');
    for (const m of ctx.mcpServers) {
      const args = m.args.length > 0 ? ` ${m.args.join(' ')}` : '';
      const envKeys = Object.keys(m.env);
      const envSummary = envKeys.length > 0 ? ` (env: ${envKeys.join(', ')})` : '';
      lines.push(`- ${m.name}: \`${m.command}${args}\`${envSummary}`);
    }
  }
  if (ctx.codeRules) {
    const r = ctx.codeRules;
    lines.push('', '### 코드 컨벤션 / 룰', `[${r.scope === 'local' ? '프로젝트 전용' : '전역 공통'}]`);
    lines.push(`- 들여쓰기: ${r.indentation.style} × ${r.indentation.size}`);
    lines.push(`- 따옴표: ${r.quotes}`);
    lines.push(`- 세미콜론: ${r.semicolons}`);
    lines.push(`- 파일명 규칙: ${r.filenameConvention}`);
    lines.push(`- 린터 프리셋: ${r.linterPreset}`);
    if (r.forbiddenPatterns.length > 0) {
      lines.push('- 금지 패턴(regex):');
      for (const p of r.forbiddenPatterns) {
        const msg = p.message ? ` — ${p.message}` : '';
        lines.push(`    · ${p.name}: \`${p.pattern}\`${msg}`);
      }
    }
    if (r.extraInstructions && r.extraInstructions.trim()) {
      lines.push('- 추가 지시:');
      for (const l of r.extraInstructions.split('\n')) lines.push(`    ${l}`);
    }
  }
  return lines.join('\n');
}

/** 테스트 전용 초기화. */
export function resetAgentDispatcherForTests(): void {
  skillsProvider = null;
  mcpServersProvider = null;
  codeRulesProvider = null;
  autoModeProvider = null;
  workingAgentsProvider = null;
  instructionDispatcher = null;
  overrideQueueStore = null;
}

// ────────────────────────────────────────────────────────────────────────────
// 지시 #367441f0 — 사용자 지시 큐 게이팅 + flush
//
// 자동 개발 ON 이고 working 에이전트가 하나라도 있으면, 즉시 디스패치 대신 큐에
// 적재한다. flushPendingInstructions 는 "팀 전원 idle" 순간에 호출되어 맨 앞
// pending 한 건을 꺼내 실제 디스패치로 연결한다. 큐 상태 전이는 store 한 곳에
// 모여 있어 동시 요청이 들어와도 직렬화된다.
// ────────────────────────────────────────────────────────────────────────────

export type AutoModeProvider = () => boolean;
export type WorkingAgentsProvider = () => number;

export interface InstructionDispatchInput {
  text: string;
  projectId?: string;
  attachments?: Array<{ fileId: string; name: string; type?: string }>;
}

/**
 * 실제 리더 태스크 생성을 담당하는 함수. 큐에서 꺼낸 지시를 디스패치할 때 본 함수가
 * 호출된다. 테스트는 spy 로 주입하고, App 은 POST /api/tasks 를 실행하는 함수를 등록한다.
 */
export type InstructionDispatcher = (input: InstructionDispatchInput) => Promise<void>;

let autoModeProvider: AutoModeProvider | null = null;
let workingAgentsProvider: WorkingAgentsProvider | null = null;
let instructionDispatcher: InstructionDispatcher | null = null;
let overrideQueueStore: PendingUserInstructionsStore | null = null;

export function setAutoModeProvider(provider: AutoModeProvider | null): void {
  autoModeProvider = provider;
}

export function setWorkingAgentsProvider(provider: WorkingAgentsProvider | null): void {
  workingAgentsProvider = provider;
}

export function setInstructionDispatcher(dispatcher: InstructionDispatcher | null): void {
  instructionDispatcher = dispatcher;
}

/** 테스트 전용 — 큐 스토어 주입. */
export function setPendingInstructionsStoreForTests(store: PendingUserInstructionsStore | null): void {
  overrideQueueStore = store;
}

function resolveStore(): PendingUserInstructionsStore {
  return overrideQueueStore ?? getPendingUserInstructionsStore();
}

export type InstructionDispatchOutcome =
  | { kind: 'dispatched' }
  | { kind: 'queued'; item: PendingInstruction }
  | { kind: 'rejected'; reason: 'no-dispatcher' };

/**
 * 사용자 지시 제출 진입점. 자동 개발 ON + working 에이전트 있음 → 큐에 적재,
 * 아니면 즉시 디스패치. 호출자(App.sendLeaderCommand) 는 반환값으로 UI 피드백을
 * 선택한다(큐 적재 토스트 / 즉시 디스패치 로그).
 */
export async function submitUserInstruction(
  input: InstructionDispatchInput,
): Promise<InstructionDispatchOutcome> {
  const store = resolveStore();
  const autoOn = autoModeProvider ? autoModeProvider() : false;
  const workingCount = workingAgentsProvider ? workingAgentsProvider() : 0;

  if (autoOn && workingCount > 0) {
    const enqueue: EnqueueInput = {
      text: input.text,
      projectId: input.projectId,
      attachments: input.attachments,
    };
    const item = store.enqueue(enqueue);
    return { kind: 'queued', item };
  }

  if (!instructionDispatcher) {
    // 디스패처가 붙기 전이면 안전하게 큐에 적재해 둔다 — 나중에 flush 가 처리.
    const item = store.enqueue({
      text: input.text,
      projectId: input.projectId,
      attachments: input.attachments,
    });
    return { kind: 'queued', item };
  }

  try {
    await instructionDispatcher(input);
    return { kind: 'dispatched' };
  } catch (err) {
    // 네트워크 실패는 큐에 적재해 다음 flush 기회에 재시도할 수 있게 한다.
    // markFailed 는 processing 상태 전용이므로, 여기서는 enqueue 시점에 바로
    // lastError 를 박아 두고 상태는 pending 으로 남겨 재시도 대상에 포함되게 한다.
    const item = store.enqueue({
      text: input.text,
      projectId: input.projectId,
      attachments: input.attachments,
      lastError: (err as Error).message,
    });
    return { kind: 'queued', item };
  }
}

export type FlushResult =
  | { kind: 'idle' }
  | { kind: 'skipped'; reason: 'busy' | 'no-dispatcher' }
  | { kind: 'flushed'; item: PendingInstruction };

/**
 * 팀 전원 idle 순간에 호출. 큐의 맨 앞 pending 을 processing 으로 승격하고
 * 디스패처에 넘긴다. 성공하면 markDone, 실패하면 markFailed 로 되돌린다.
 * 경쟁 상태 방지: 여러 곳에서 동시에 호출해도 store.beginNextPending 이 원자적
 * 으로 단일 승자만 뽑아 주기 때문에 중복 디스패치가 일어나지 않는다.
 */
export async function flushPendingInstructions(): Promise<FlushResult> {
  const store = resolveStore();
  // 이미 processing 중인 건이 있으면 flush 가 이중으로 진행되지 않도록 차단.
  if (store.snapshot().processingCount > 0) {
    return { kind: 'skipped', reason: 'busy' };
  }
  if (!instructionDispatcher) {
    return { kind: 'skipped', reason: 'no-dispatcher' };
  }
  const item = store.beginNextPending();
  if (!item) return { kind: 'idle' };
  try {
    await instructionDispatcher({
      text: item.text,
      projectId: item.projectId,
      attachments: item.attachments?.map((a) => ({ fileId: a.fileId, name: a.name, type: a.type })),
    });
    store.markDone(item.id);
    return { kind: 'flushed', item };
  } catch (err) {
    store.markFailed(item.id, (err as Error).message);
    return { kind: 'skipped', reason: 'busy' };
  }
}

export type AutoDevOffPolicy = 'keep' | 'flush-now' | 'discard';

/**
 * 자동 개발 OFF 전환 시 정책 적용.
 *   · keep       : 큐를 그대로 둔다(다음 ON 전환 때 이어서 처리).
 *   · flush-now  : working 상태와 무관하게 즉시 전부 디스패치(한 건씩 순차).
 *   · discard    : pending 전부 cancelled 로 전이.
 */
export async function applyAutoDevOffPolicy(policy: AutoDevOffPolicy): Promise<void> {
  const store = resolveStore();
  if (policy === 'keep') return;
  if (policy === 'discard') { store.cancelAllPending(); return; }
  // flush-now — processing 이 하나씩만 있도록 순차 flush.
  while (true) {
    const snap = store.snapshot();
    if (snap.pendingCount === 0) break;
    const res = await flushPendingInstructions();
    if (res.kind === 'skipped' || res.kind === 'idle') break;
  }
}
