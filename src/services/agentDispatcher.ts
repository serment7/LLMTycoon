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

export interface AgentDispatchContext {
  projectId: string;
  skills: AgentSkillContext[];
  mcpServers: AgentMcpServerContext[];
}

export type SkillsProvider = (projectId: string) => Promise<SkillRecord[]>;
export type McpServersProvider = (projectId: string) => Promise<McpServerRecord[]>;

let skillsProvider: SkillsProvider | null = null;
let mcpServersProvider: McpServersProvider | null = null;

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
 * 에이전트 런타임이 디스패치 직전에 호출해 현재 프로젝트의 스킬·MCP 서버를
 * 한 묶음으로 가져온다. 각 프로바이더가 실패하더라도 한쪽이 비어 있는 결과를
 * 돌려주며 전체 디스패치가 멈추지 않는다(에이전트 컨텍스트는 "있으면 좋고
 * 없어도 되는" 보조 정보).
 */
export async function buildAgentDispatchContext(
  projectId: string,
): Promise<AgentDispatchContext> {
  if (!projectId) {
    return { projectId: '', skills: [], mcpServers: [] };
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

  const [skillRecords, mcpRecords] = await Promise.all([skillsPromise, mcpPromise]);

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
  };
}

/**
 * 컨텍스트를 에이전트 프롬프트 접미어로 직렬화한다. 디스패치 시
 * 시스템 프롬프트 꼬리에 붙여 넣을 용도의 단순 텍스트 포맷. MCP 서버는 민감
 * 환경변수(env) 가 있을 수 있으므로 값은 요약만 하고, command/args 는 실행
 * 구성을 재현 가능하도록 원문을 싣는다.
 */
export function formatDispatchContextForPrompt(ctx: AgentDispatchContext): string {
  if (ctx.skills.length === 0 && ctx.mcpServers.length === 0) return '';
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
  return lines.join('\n');
}

/** 테스트 전용 초기화. */
export function resetAgentDispatcherForTests(): void {
  skillsProvider = null;
  mcpServersProvider = null;
}
