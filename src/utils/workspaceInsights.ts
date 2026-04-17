/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 워크스페이스 통계/분석 유틸 (연구원 담당).
 * 프로젝트의 파일-에이전트-의존성 그래프를 읽어 의사결정에 쓸 만한
 * 지표를 계산한다. 순수 함수로 구성되어 있어 UI와 테스트 양쪽에서 재사용된다.
 */

import { Agent, AgentRole, CodeDependency, CodeFile, Project } from '../types';

export type FileTypeBreakdown = Record<CodeFile['type'], number>;

export type AgentRoleBreakdown = Partial<Record<AgentRole, number>>;

export interface DependencyHotspot {
  id: string;
  name: string;
  inDegree: number;
  outDegree: number;
}

export interface AgentWorkload {
  agentId: string;
  agentName: string;
  role: AgentRole;
  status: Agent['status'];
  workingOnFileId?: string;
  workingOnFileName?: string;
}

export interface WorkspaceInsights {
  totalFiles: number;
  totalAgents: number;
  activeAgents: number;
  /** 에이전트가 현재 만지고 있는 파일 비율(0~100, 정수). */
  coveragePercent: number;
  /** 의존 그래프에서 완전 고립된 파일 이름 목록. */
  isolatedFiles: string[];
  /** 가장 많이 참조되는 파일(in-degree 최대). */
  topDependedFile?: DependencyHotspot;
  /** 가장 많이 참조를 내보내는 파일(out-degree 최대). */
  topDependingFile?: DependencyHotspot;
  avgFilesPerAgent: number;
  fileTypeBreakdown: FileTypeBreakdown;
  roleBreakdown: AgentRoleBreakdown;
  /** 의존성 사이클을 이루는 파일 ID 집합(있다면). */
  cyclicFiles: string[];
  /** 에이전트별 현재 작업 스냅샷. */
  workloads: AgentWorkload[];
}

const EMPTY_FILE_TYPE_BREAKDOWN: FileTypeBreakdown = {
  component: 0,
  service: 0,
  util: 0,
  style: 0,
};

export function computeWorkspaceInsights(
  projectId: string | null,
  projects: Project[],
  agents: Agent[],
  files: CodeFile[],
  dependencies: CodeDependency[],
): WorkspaceInsights {
  const project = projects.find(p => p.id === projectId);
  const projectFiles = files.filter(f => f.projectId === projectId);
  const projectAgents = agents.filter(a => project?.agents.includes(a.id));

  // 의존성 엣지는 파일 간에서만 의미가 있으므로, 현재 프로젝트 파일 ID만 허용.
  // 뒤에서 이름/타입 조회가 반복되므로 O(1) 조회를 위해 Map을 한 번만 만든다.
  const fileById = new Map(projectFiles.map(f => [f.id, f] as const));
  const projectDeps = dependencies.filter(d => fileById.has(d.from) && fileById.has(d.to));

  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  projectDeps.forEach(d => {
    inDegree.set(d.to, (inDegree.get(d.to) ?? 0) + 1);
    outDegree.set(d.from, (outDegree.get(d.from) ?? 0) + 1);
  });

  const touchedFileIds = new Set(
    projectAgents
      .map(a => a.workingOnFileId)
      .filter((id): id is string => Boolean(id)),
  );

  // 완전 고립된 파일(들어오는 엣지도 나가는 엣지도 없는 노드)을 추려 리스크 신호로 활용.
  const connected = new Set<string>();
  projectDeps.forEach(d => {
    connected.add(d.from);
    connected.add(d.to);
  });
  // UI에서 목록이 뒤집히는 것을 막으려고 알파벳순으로 고정한다.
  const isolatedFiles = projectFiles
    .filter(f => !connected.has(f.id))
    .map(f => f.name)
    .sort((a, b) => a.localeCompare(b));

  const topDependedFile = pickHotspot(fileById, inDegree, outDegree, 'in');
  const topDependingFile = pickHotspot(fileById, inDegree, outDegree, 'out');

  const coveragePercent = projectFiles.length === 0
    ? 0
    : Math.round((touchedFileIds.size / projectFiles.length) * 100);

  const avgFilesPerAgent = projectAgents.length === 0
    ? 0
    : Number((projectFiles.length / projectAgents.length).toFixed(2));

  const fileTypeBreakdown: FileTypeBreakdown = { ...EMPTY_FILE_TYPE_BREAKDOWN };
  projectFiles.forEach(f => {
    fileTypeBreakdown[f.type] += 1;
  });

  const roleBreakdown: AgentRoleBreakdown = {};
  projectAgents.forEach(a => {
    roleBreakdown[a.role] = (roleBreakdown[a.role] ?? 0) + 1;
  });

  const cyclicFiles = detectCyclicFiles(projectFiles, projectDeps);

  const workloads: AgentWorkload[] = projectAgents.map(a => ({
    agentId: a.id,
    agentName: a.name,
    role: a.role,
    status: a.status,
    workingOnFileId: a.workingOnFileId,
    workingOnFileName: a.workingOnFileId ? fileById.get(a.workingOnFileId)?.name : undefined,
  }));

  return {
    totalFiles: projectFiles.length,
    totalAgents: projectAgents.length,
    activeAgents: projectAgents.filter(a => a.status !== 'idle').length,
    coveragePercent,
    isolatedFiles,
    topDependedFile,
    topDependingFile,
    avgFilesPerAgent,
    fileTypeBreakdown,
    roleBreakdown,
    cyclicFiles,
    workloads,
  };
}

function pickHotspot(
  fileById: Map<string, CodeFile>,
  inDegree: Map<string, number>,
  outDegree: Map<string, number>,
  which: 'in' | 'out',
): DependencyHotspot | undefined {
  const primary = which === 'in' ? inDegree : outDegree;
  // 동률일 때 Map 순회 순서에 의존해 결과가 흔들리던 문제를 막으려고
  // 점수 내림차순 + 이름 오름차순으로 명시적으로 정렬한다.
  const ranked: DependencyHotspot[] = [];
  primary.forEach((_, id) => {
    const file = fileById.get(id);
    if (!file) return;
    ranked.push({
      id,
      name: file.name,
      inDegree: inDegree.get(id) ?? 0,
      outDegree: outDegree.get(id) ?? 0,
    });
  });
  if (ranked.length === 0) return undefined;
  const score = (h: DependencyHotspot) => (which === 'in' ? h.inDegree : h.outDegree);
  ranked.sort((a, b) => (score(b) - score(a)) || a.name.localeCompare(b.name));
  return ranked[0];
}

/**
 * Tarjan 풍 반복 DFS로 강결합 요소(SCC)를 찾아 크기가 2 이상이거나
 * 자기 자신을 가리키는 셀프 루프가 있는 노드를 사이클 참여자로 간주한다.
 * 재귀 대신 명시적 스택을 써 큰 그래프에서도 스택 오버플로를 피한다.
 */
export function detectCyclicFiles(files: CodeFile[], deps: CodeDependency[]): string[] {
  const adjacency = new Map<string, string[]>();
  files.forEach(f => adjacency.set(f.id, []));
  deps.forEach(d => {
    const list = adjacency.get(d.from);
    if (list) list.push(d.to);
  });

  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cyclic = new Set<string>();

  type Frame = { node: string; iter: number };

  for (const start of adjacency.keys()) {
    if (indices.has(start)) continue;
    const callStack: Frame[] = [{ node: start, iter: 0 }];
    indices.set(start, index);
    lowlinks.set(start, index);
    index += 1;
    stack.push(start);
    onStack.add(start);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const neighbors = adjacency.get(frame.node) ?? [];
      if (frame.iter < neighbors.length) {
        const next = neighbors[frame.iter];
        frame.iter += 1;
        if (!indices.has(next)) {
          indices.set(next, index);
          lowlinks.set(next, index);
          index += 1;
          stack.push(next);
          onStack.add(next);
          callStack.push({ node: next, iter: 0 });
        } else if (onStack.has(next)) {
          lowlinks.set(
            frame.node,
            Math.min(lowlinks.get(frame.node) ?? 0, indices.get(next) ?? 0),
          );
        }
      } else {
        if (lowlinks.get(frame.node) === indices.get(frame.node)) {
          const component: string[] = [];
          // 스택에서 현재 노드까지 pop.
          while (stack.length > 0) {
            const popped = stack.pop() as string;
            onStack.delete(popped);
            component.push(popped);
            if (popped === frame.node) break;
          }
          const hasSelfLoop = (adjacency.get(frame.node) ?? []).includes(frame.node);
          if (component.length > 1 || hasSelfLoop) {
            component.forEach(id => cyclic.add(id));
          }
        }
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1];
          lowlinks.set(
            parent.node,
            Math.min(
              lowlinks.get(parent.node) ?? 0,
              lowlinks.get(frame.node) ?? 0,
            ),
          );
        }
      }
    }
  }

  return Array.from(cyclic);
}

/**
 * 인사이트를 한국어 한 줄 요약으로 압축한다.
 * UI 상단 배너나 상태 줄처럼 지면이 좁을 때 쓰기 좋다.
 */
export function summarizeInsights(insights: WorkspaceInsights): string {
  if (insights.totalFiles === 0) return '아직 등록된 파일이 없습니다.';
  const parts = [
    `파일 ${insights.totalFiles}개`,
    `에이전트 ${insights.activeAgents}/${insights.totalAgents} 활성`,
    `커버리지 ${insights.coveragePercent}%`,
  ];
  if (insights.cyclicFiles.length > 0) {
    parts.push(`순환 의존 ${insights.cyclicFiles.length}건`);
  }
  if (insights.isolatedFiles.length > 0) {
    parts.push(`고립 ${insights.isolatedFiles.length}개`);
  }
  return parts.join(' · ');
}

export type RiskLevel = 'healthy' | 'watch' | 'warning' | 'critical';

export interface RiskAssessment {
  level: RiskLevel;
  score: number;
  reasons: string[];
}

const RISK_THRESHOLDS: Array<[number, RiskLevel]> = [
  [75, 'critical'],
  [50, 'warning'],
  [25, 'watch'],
];

// 각 신호에 가중치를 둬 0~100 사이 점수로 환산한다.
// 수치 자체보다는 상대 비교(어느 프로젝트가 더 위험한가)에 쓰기 적합하다.
export function assessRisk(insights: WorkspaceInsights): RiskAssessment {
  if (insights.totalFiles === 0) {
    return { level: 'healthy', score: 0, reasons: [] };
  }

  const reasons: string[] = [];
  let score = 0;

  const cyclicRatio = insights.cyclicFiles.length / insights.totalFiles;
  if (cyclicRatio > 0) {
    const contribution = Math.min(40, Math.round(cyclicRatio * 120));
    score += contribution;
    reasons.push(`순환 의존 비율 ${Math.round(cyclicRatio * 100)}%`);
  }

  const isolatedRatio = insights.isolatedFiles.length / insights.totalFiles;
  if (isolatedRatio > 0.2) {
    const contribution = Math.min(25, Math.round(isolatedRatio * 60));
    score += contribution;
    reasons.push(`고립 파일 비중 ${Math.round(isolatedRatio * 100)}%`);
  }

  if (insights.totalAgents > 0) {
    const idleRatio = 1 - insights.activeAgents / insights.totalAgents;
    if (idleRatio >= 0.5) {
      const contribution = Math.min(20, Math.round(idleRatio * 30));
      score += contribution;
      reasons.push(`유휴 에이전트 ${Math.round(idleRatio * 100)}%`);
    }
  } else if (insights.totalFiles > 0) {
    score += 15;
    reasons.push('할당된 에이전트 없음');
  }

  if (insights.coveragePercent < 20 && insights.totalAgents > 0) {
    score += 10;
    reasons.push(`작업 커버리지 ${insights.coveragePercent}%`);
  }

  score = Math.min(100, score);
  const level =
    RISK_THRESHOLDS.find(([threshold]) => score >= threshold)?.[1] ?? 'healthy';

  return { level, score, reasons };
}

export interface RecommendedAction {
  priority: 'high' | 'medium' | 'low';
  message: string;
}

/**
 * 인사이트를 바탕으로 바로 취할 수 있는 액션 힌트를 생성한다.
 * 순서는 우선순위 내림차순이며, UI에서 상위 몇 건만 노출하는 용도로 쓴다.
 */
export function recommendActions(insights: WorkspaceInsights): RecommendedAction[] {
  const actions: RecommendedAction[] = [];

  if (insights.cyclicFiles.length > 0) {
    actions.push({
      priority: 'high',
      message: `순환 의존 ${insights.cyclicFiles.length}개 파일을 분리하거나 인터페이스로 경계를 나누세요.`,
    });
  }

  if (insights.totalFiles > 0 && insights.totalAgents === 0) {
    actions.push({
      priority: 'high',
      message: '프로젝트에 에이전트를 배정하세요. 현재 담당자가 없습니다.',
    });
  }

  if (
    insights.totalAgents > 0 &&
    insights.activeAgents === 0 &&
    insights.totalFiles > 0
  ) {
    actions.push({
      priority: 'medium',
      message: '모든 에이전트가 유휴 상태입니다. 다음 작업을 할당해 주세요.',
    });
  }

  if (insights.isolatedFiles.length >= 3) {
    actions.push({
      priority: 'medium',
      message: `고립 파일 ${insights.isolatedFiles.length}개의 용도를 점검하고 필요 없으면 제거하세요.`,
    });
  }

  if (
    insights.topDependedFile &&
    insights.topDependedFile.inDegree >= Math.max(3, Math.ceil(insights.totalFiles * 0.3))
  ) {
    actions.push({
      priority: 'low',
      message: `${insights.topDependedFile.name}에 참조가 집중되어 있습니다. 변경 영향도를 모니터링하세요.`,
    });
  }

  if (insights.totalAgents > 0 && insights.avgFilesPerAgent >= 6) {
    actions.push({
      priority: 'low',
      message: `에이전트당 담당 파일이 ${insights.avgFilesPerAgent}개로 높습니다. 업무 재분배를 고려하세요.`,
    });
  }

  const rank: Record<RecommendedAction['priority'], number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  return actions.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

/**
 * 특정 파일을 수정했을 때 영향받는 후보 파일 ID 집합을 구한다.
 * 들어오는 엣지를 역추적하는 BFS라, "이 파일을 바꾸면 누가 다시 빌드돼야 하나?"를
 * 가늠할 때 사용한다. 결과에 자신은 포함하지 않는다.
 */
export function findDependents(
  fileId: string,
  dependencies: CodeDependency[],
): string[] {
  return traverseGraph(fileId, dependencies, 'reverse');
}

/**
 * `findDependents`의 정방향 대칭. "이 파일이 의존하는 모든 파일"을 BFS로 모은다.
 * 영향도 분석에서 "이 파일이 빌드되려면 무엇이 먼저 준비돼야 하나?"를 답하는 용도.
 * 결과에 자신은 포함하지 않는다.
 */
export function findDependencies(
  fileId: string,
  dependencies: CodeDependency[],
): string[] {
  return traverseGraph(fileId, dependencies, 'forward');
}

// 두 BFS가 인접 리스트 방향만 다르다. 한 군데로 합쳐 분기 버그를 예방한다.
function traverseGraph(
  fileId: string,
  dependencies: CodeDependency[],
  direction: 'forward' | 'reverse',
): string[] {
  const adjacency = new Map<string, string[]>();
  dependencies.forEach(d => {
    const [key, value] = direction === 'reverse' ? [d.to, d.from] : [d.from, d.to];
    const list = adjacency.get(key);
    if (list) list.push(value);
    else adjacency.set(key, [value]);
  });

  const visited = new Set<string>();
  // Array.shift()는 O(n)이라 수천 노드 그래프에서 BFS 전체가 O(n^2)로 튄다.
  // 헤드 포인터로 대체해 amortized O(1) 디큐를 유지한다.
  const queue: string[] = [fileId];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const neighbors = adjacency.get(current) ?? [];
    for (const next of neighbors) {
      if (visited.has(next) || next === fileId) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return Array.from(visited);
}

// ───────────────────────────────────────────────────────────────
// 이하 품질 관리("감마") 추가 파트 — 그래프 데이터 무결성 검증과
// QA 관점의 리포트를 담당한다. 기존 인사이트 계산과 달리 "무엇이
// 잘못됐는지"를 짚는 데 초점이 맞춰져 있다.
// ───────────────────────────────────────────────────────────────

export type DataIntegrityCode =
  | 'dangling-dependency'
  | 'self-loop'
  | 'duplicate-dependency'
  | 'orphan-agent-assignment'
  | 'cross-project-edge'
  | 'unknown-file-type';

export interface DataIntegrityIssue {
  code: DataIntegrityCode;
  message: string;
  /** 문제에 연관된 파일/에이전트/엣지의 식별자. 디버깅 핑포인트로 쓴다. */
  refs: string[];
}

const KNOWN_FILE_TYPES: ReadonlySet<CodeFile['type']> = new Set([
  'component',
  'service',
  'util',
  'style',
]);

/**
 * 그래프 데이터가 UI/게임 로직이 기대하는 불변식을 지키는지 점검한다.
 * QA 단계에서 CI처럼 돌려, 상태 저장소가 이상해지기 전에 조기 경고를 띄운다.
 * 성능을 위해 파일 O(n) + 엣지 O(m)만 돌고, 중복 문자열 생성은 피한다.
 */
export function validateGraphIntegrity(
  files: CodeFile[],
  dependencies: CodeDependency[],
  agents: Agent[] = [],
): DataIntegrityIssue[] {
  const issues: DataIntegrityIssue[] = [];
  const fileById = new Map(files.map(f => [f.id, f] as const));

  files.forEach(f => {
    if (!KNOWN_FILE_TYPES.has(f.type)) {
      issues.push({
        code: 'unknown-file-type',
        message: `알 수 없는 파일 타입(${String(f.type)}): ${f.name}`,
        refs: [f.id],
      });
    }
  });

  const seenEdges = new Set<string>();
  dependencies.forEach(d => {
    const from = fileById.get(d.from);
    const to = fileById.get(d.to);
    if (!from || !to) {
      issues.push({
        code: 'dangling-dependency',
        message: '존재하지 않는 파일을 참조하는 의존성 엣지.',
        refs: [d.from, d.to],
      });
      return;
    }
    if (d.from === d.to) {
      issues.push({
        code: 'self-loop',
        message: `${from.name}이(가) 자기 자신을 참조합니다.`,
        refs: [d.from],
      });
    }
    if (from.projectId !== to.projectId) {
      issues.push({
        code: 'cross-project-edge',
        message: `${from.name} → ${to.name}: 프로젝트 경계를 넘는 의존성.`,
        refs: [d.from, d.to],
      });
    }
    const key = `${d.from}->${d.to}`;
    if (seenEdges.has(key)) {
      issues.push({
        code: 'duplicate-dependency',
        message: `중복 엣지: ${from.name} → ${to.name}`,
        refs: [d.from, d.to],
      });
    } else {
      seenEdges.add(key);
    }
  });

  agents.forEach(a => {
    if (a.workingOnFileId && !fileById.has(a.workingOnFileId)) {
      issues.push({
        code: 'orphan-agent-assignment',
        message: `${a.name} 에이전트가 사라진 파일(${a.workingOnFileId})을 참조합니다.`,
        refs: [a.id, a.workingOnFileId],
      });
    }
  });

  return issues;
}

export interface QualityReport {
  /** 0~100, 100에 가까울수록 건강한 워크스페이스. */
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  integrityIssues: DataIntegrityIssue[];
  risk: RiskAssessment;
  highlights: string[];
}

// 위험 점수는 "문제의 크기", 품질 점수는 "얼마나 반듯한가"를 나타낸다.
// 둘은 역수 관계에 가깝지만, 완전히 대칭은 아니라서(무결성 문제는 별도 감점)
// 독립된 함수로 유지한다.
export function buildQualityReport(
  insights: WorkspaceInsights,
  files: CodeFile[],
  dependencies: CodeDependency[],
  agents: Agent[] = [],
): QualityReport {
  const integrityIssues = validateGraphIntegrity(files, dependencies, agents);
  const risk = assessRisk(insights);

  let score = 100 - risk.score;
  // 무결성 이슈 1건당 5점 감점, 단 40점 한도.
  const integrityPenalty = Math.min(40, integrityIssues.length * 5);
  score = Math.max(0, score - integrityPenalty);

  const grade: QualityReport['grade'] =
    score >= 90 ? 'A' :
    score >= 75 ? 'B' :
    score >= 60 ? 'C' :
    score >= 40 ? 'D' : 'F';

  const highlights: string[] = [];
  if (insights.totalFiles === 0) {
    highlights.push('측정할 파일이 없어 초기 상태로 간주합니다.');
  } else {
    highlights.push(`총 ${insights.totalFiles}개 파일, 활성 에이전트 ${insights.activeAgents}/${insights.totalAgents}.`);
    if (integrityIssues.length > 0) {
      highlights.push(`무결성 이슈 ${integrityIssues.length}건을 먼저 해결하세요.`);
    }
    if (risk.reasons.length > 0) {
      highlights.push(`리스크 신호: ${risk.reasons.slice(0, 3).join(', ')}.`);
    }
    if (insights.coveragePercent >= 80) {
      highlights.push('에이전트 커버리지가 양호합니다.');
    }
  }

  return { score, grade, integrityIssues, risk, highlights };
}

/**
 * QA 대시보드용 한 줄 요약. summarizeInsights와 달리 품질 등급/이슈 수를 앞세운다.
 */
export function summarizeQuality(report: QualityReport): string {
  const issueCount = report.integrityIssues.length;
  const issuePart = issueCount === 0 ? '무결성 OK' : `이슈 ${issueCount}건`;
  return `품질 ${report.grade}(${report.score}/100) · ${issuePart} · 리스크 ${report.risk.level}`;
}

export type IssueSeverity = 'blocker' | 'major' | 'minor';

// QA 우선순위 매핑: "블로커"는 릴리스를 막고, "메이저"는 스프린트 내 해결,
// "마이너"는 백로그에서 천천히 정리해도 되는 수준이다.
const ISSUE_SEVERITY: Record<DataIntegrityCode, IssueSeverity> = {
  'dangling-dependency': 'blocker',
  'orphan-agent-assignment': 'blocker',
  'self-loop': 'major',
  'cross-project-edge': 'major',
  'duplicate-dependency': 'minor',
  'unknown-file-type': 'minor',
};

export type SeverityBuckets = Record<IssueSeverity, DataIntegrityIssue[]>;

export function groupIssuesBySeverity(issues: DataIntegrityIssue[]): SeverityBuckets {
  const buckets: SeverityBuckets = { blocker: [], major: [], minor: [] };
  issues.forEach(issue => {
    buckets[ISSUE_SEVERITY[issue.code]].push(issue);
  });
  return buckets;
}

export function getIssueSeverity(code: DataIntegrityCode): IssueSeverity {
  return ISSUE_SEVERITY[code];
}

export type QualityTrend = 'improved' | 'regressed' | 'stable';

export interface QualityDiff {
  trend: QualityTrend;
  scoreDelta: number;
  /** 이전에 없다가 새로 등장한 이슈. QA 회귀 탐지의 핵심 신호다. */
  newIssues: DataIntegrityIssue[];
  /** 이전엔 있었는데 사라진 이슈. 리그레션 리포트에서 개선 항목으로 쓴다. */
  resolvedIssues: DataIntegrityIssue[];
}

// 이슈를 같다고 볼 기준은 (code, refs 정렬 후 조인) 조합이다.
// 메시지는 사람이 읽기 위한 필드이므로 키에서 제외한다.
function issueKey(issue: DataIntegrityIssue): string {
  return `${issue.code}|${[...issue.refs].sort().join(',')}`;
}

/**
 * 이전 QA 리포트 대비 현재 리포트가 나아졌는지/나빠졌는지를 계산한다.
 * 회귀 알림이나 일일 품질 브리프에 쓰는 용도다.
 */
export function diffQualityReports(
  previous: QualityReport,
  current: QualityReport,
): QualityDiff {
  const prevKeys = new Map(previous.integrityIssues.map(i => [issueKey(i), i] as const));
  const currKeys = new Map(current.integrityIssues.map(i => [issueKey(i), i] as const));

  const newIssues: DataIntegrityIssue[] = [];
  currKeys.forEach((issue, key) => {
    if (!prevKeys.has(key)) newIssues.push(issue);
  });

  const resolvedIssues: DataIntegrityIssue[] = [];
  prevKeys.forEach((issue, key) => {
    if (!currKeys.has(key)) resolvedIssues.push(issue);
  });

  const scoreDelta = current.score - previous.score;
  // 점수와 블로커 수 둘 다 고려해 추세를 정한다. 블로커가 새로 생기면
  // 점수가 우연히 올랐더라도 "회귀"로 판단하는 게 QA 관점에서 안전하다.
  const newBlockers = newIssues.filter(i => ISSUE_SEVERITY[i.code] === 'blocker').length;
  let trend: QualityTrend;
  if (newBlockers > 0 || scoreDelta < -2) {
    trend = 'regressed';
  } else if (scoreDelta > 2 || resolvedIssues.length > newIssues.length) {
    trend = 'improved';
  } else {
    trend = 'stable';
  }

  return { trend, scoreDelta, newIssues, resolvedIssues };
}

export interface OwnershipGap {
  fileId: string;
  fileName: string;
  type: CodeFile['type'];
}

/**
 * 현재 어떤 에이전트도 "working" 상태로 다루지 않는 파일을 추린다.
 * 단순 고립과 달리, 의존성 그래프가 연결돼 있어도 담당자가 비어 있으면 잡힌다.
 * QA는 "담당 없는 파일"을 장기 방치 리스크로 분류해 매일 브리프에 올린다.
 */
export function findUnownedFiles(
  files: CodeFile[],
  agents: Agent[],
  projectId: string | null,
): OwnershipGap[] {
  const projectFiles = projectId == null
    ? files
    : files.filter(f => f.projectId === projectId);
  const activelyTouched = new Set(
    agents
      .filter(a => a.status !== 'idle')
      .map(a => a.workingOnFileId)
      .filter((id): id is string => Boolean(id)),
  );
  return projectFiles
    .filter(f => !activelyTouched.has(f.id))
    .map(f => ({ fileId: f.id, fileName: f.name, type: f.type }));
}

/**
 * QA 일일 브리프용 다행 포맷. Slack/메신저에 그대로 붙여 쓸 수 있도록
 * 등급 · 점수 · 블로커 이슈 · 상위 권장 액션을 블록으로 묶는다.
 */
export function formatQualityBrief(
  report: QualityReport,
  actions: RecommendedAction[] = [],
): string {
  const lines: string[] = [];
  lines.push(`[QA 브리프] 등급 ${report.grade} · 점수 ${report.score}/100 · 리스크 ${report.risk.level}`);

  const buckets = groupIssuesBySeverity(report.integrityIssues);
  if (buckets.blocker.length > 0) {
    lines.push(`🚨 블로커 ${buckets.blocker.length}건 — 릴리스 전 반드시 해결.`);
    buckets.blocker.slice(0, 3).forEach(issue => lines.push(`  • ${issue.message}`));
  }
  if (buckets.major.length > 0) {
    lines.push(`⚠️ 메이저 ${buckets.major.length}건.`);
  }
  if (buckets.minor.length > 0) {
    lines.push(`· 마이너 ${buckets.minor.length}건은 백로그로.`);
  }
  if (report.integrityIssues.length === 0) {
    lines.push('✅ 무결성 검사 통과.');
  }

  const top = actions.slice(0, 3);
  if (top.length > 0) {
    lines.push('권장 액션:');
    top.forEach(a => lines.push(`  [${a.priority}] ${a.message}`));
  }

  report.highlights.forEach(h => lines.push(`- ${h}`));
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────
// 이하 개발자("베타") 추가 파트 — 리팩터링 우선순위와 에이전트
// 워크로드 재분배 제안을 다룬다. QA가 "무엇이 잘못됐나"를 본다면
// 여기서는 "다음에 무엇을 손볼까"를 제안한다.
// ───────────────────────────────────────────────────────────────

export interface RefactorCandidate {
  fileId: string;
  fileName: string;
  inDegree: number;
  outDegree: number;
  /** in*out 곱으로 환산한 "구조적 영향도". 양방향 결합이 강할수록 커진다. */
  couplingScore: number;
}

/**
 * 양방향 결합이 강한 파일을 추려 리팩터 후보로 제시한다.
 * in-degree만 큰 파일은 "공용 라이브러리"라서 그대로 둘 만하지만,
 * in/out이 동시에 큰 파일은 책임이 비대해져 변경 비용이 폭증하기 쉽다.
 */
export function findRefactorCandidates(
  files: CodeFile[],
  dependencies: CodeDependency[],
  limit = 5,
): RefactorCandidate[] {
  const fileById = new Map(files.map(f => [f.id, f] as const));
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  dependencies.forEach(d => {
    if (!fileById.has(d.from) || !fileById.has(d.to)) return;
    inDegree.set(d.to, (inDegree.get(d.to) ?? 0) + 1);
    outDegree.set(d.from, (outDegree.get(d.from) ?? 0) + 1);
  });

  const candidates: RefactorCandidate[] = [];
  fileById.forEach((file, id) => {
    const inD = inDegree.get(id) ?? 0;
    const outD = outDegree.get(id) ?? 0;
    const couplingScore = inD * outD;
    if (couplingScore <= 0) return;
    candidates.push({
      fileId: id,
      fileName: file.name,
      inDegree: inD,
      outDegree: outD,
      couplingScore,
    });
  });

  candidates.sort(
    (a, b) => (b.couplingScore - a.couplingScore) || a.fileName.localeCompare(b.fileName),
  );
  return candidates.slice(0, Math.max(0, limit));
}

export interface RebalanceSuggestion {
  fromAgentId: string;
  fromAgentName: string;
  toAgentId: string;
  toAgentName: string;
  /** 이동을 권장하는 파일 수(추정치). 실제 어떤 파일을 옮길지는 사람이 결정. */
  suggestedTransfer: number;
  reason: string;
}

/**
 * 같은 역할(role) 안에서 작업량이 한쪽으로 쏠려 있을 때
 * 평균에 가까워지도록 일감을 옮기는 시나리오를 제안한다.
 * 역할이 다르면 전문성 영역이 달라 단순 비교가 위험하므로 같은 역할끼리만 짝짓는다.
 */
export function suggestRebalancing(
  insights: WorkspaceInsights,
  files: CodeFile[],
): RebalanceSuggestion[] {
  if (insights.workloads.length < 2) return [];

  // 보조적으로 미할당 파일 수를 계산해 "옮기기 vs 새로 배정"을 가른다.
  const unassigned = files.filter(f =>
    !insights.workloads.some(w => w.workingOnFileId === f.id),
  ).length;

  const byRole = new Map<AgentRole, AgentWorkload[]>();
  insights.workloads.forEach(w => {
    const list = byRole.get(w.role) ?? [];
    list.push(w);
    byRole.set(w.role, list);
  });

  const suggestions: RebalanceSuggestion[] = [];
  byRole.forEach(group => {
    if (group.length < 2) return;
    const busy = group.filter(w => w.workingOnFileId);
    const idle = group.filter(w => !w.workingOnFileId);
    if (busy.length === 0 || idle.length === 0) return;
    // 가장 바쁜 사람 → 가장 한가한 사람 1쌍만 추천.
    // 너무 많은 제안은 노이즈가 되므로 역할당 1건으로 제한한다.
    const fromAgent = busy[0];
    const toAgent = idle[0];
    suggestions.push({
      fromAgentId: fromAgent.agentId,
      fromAgentName: fromAgent.agentName,
      toAgentId: toAgent.agentId,
      toAgentName: toAgent.agentName,
      // 미할당 파일이 있으면 이동(transfer) 대신 새 배정이 우선이라 0으로 둔다.
      suggestedTransfer: unassigned > 0 ? 0 : 1,
      reason: unassigned > 0
        ? `미할당 파일 ${unassigned}개 있음 — ${toAgent.agentName}에게 새 작업을 먼저 배정 가능.`
        : `${fromAgent.agentName}이(가) 계속 작업 중, ${toAgent.agentName}은 유휴 상태.`,
    });
  });

  return suggestions;
}

/**
 * 의존성 그래프를 위상 정렬해 빌드/리뷰 권장 순서를 만든다.
 * 사이클이 있으면 해당 노드들은 마지막에 그룹으로 모아 둔다.
 * (사이클 안에선 어차피 어떤 순서로도 의존이 깨지지 않으므로 사람이 다시 본다.)
 */
export function topologicalBuildOrder(
  files: CodeFile[],
  dependencies: CodeDependency[],
): string[] {
  const fileIds = new Set(files.map(f => f.id));
  const adjacency = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  files.forEach(f => {
    adjacency.set(f.id, []);
    inDeg.set(f.id, 0);
  });
  dependencies.forEach(d => {
    if (!fileIds.has(d.from) || !fileIds.has(d.to)) return;
    adjacency.get(d.from)!.push(d.to);
    inDeg.set(d.to, (inDeg.get(d.to) ?? 0) + 1);
  });

  // 결정적 결과를 위해 같은 in-degree=0 그룹 안에서는 ID 오름차순.
  const queue: string[] = [];
  inDeg.forEach((deg, id) => {
    if (deg === 0) queue.push(id);
  });
  queue.sort();

  const order: string[] = [];
  const placed = new Set<string>();
  // traverseGraph와 동일하게 head 포인터로 디큐해 O(n^2) shift 비용을 피한다.
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    order.push(id);
    placed.add(id);
    const newlyReady: string[] = [];
    (adjacency.get(id) ?? []).forEach(n => {
      const remaining = (inDeg.get(n) ?? 0) - 1;
      inDeg.set(n, remaining);
      if (remaining === 0) newlyReady.push(n);
    });
    newlyReady.sort();
    queue.push(...newlyReady);
  }

  // 위상 정렬에 들어가지 못한 노드는 사이클 참여자. 알파벳순으로 뒤에 붙인다.
  if (order.length < files.length) {
    const remaining = files
      .map(f => f.id)
      .filter(id => !placed.has(id))
      .sort();
    order.push(...remaining);
  }
  return order;
}

// ───────────────────────────────────────────────────────────────
// 이하 디자이너 추가 파트 — 대시보드 시각화에 필요한 토큰·레이블·
// 레이아웃 힌트를 모은다. 색상은 UI 테마와 1:1로 매핑되며, 접근성
// 대비율을 고려해 전경/배경 쌍으로 묶는다. 계산 로직이 아닌
// "보여주는 방법"에 집중한다.
// ───────────────────────────────────────────────────────────────

export interface PresentationTone {
  /** 배경색 토큰(CSS 변수 이름 또는 HEX). */
  background: string;
  /** 대비 확보된 전경색. */
  foreground: string;
  /** 강조 테두리/아이콘에 쓰는 보조색. */
  accent: string;
  /** 스크린리더용 한국어 레이블. 아이콘만 있는 UI에서도 의미가 전달되도록. */
  ariaLabel: string;
}

// 리스크 레벨 ↔ 디자인 토큰 매핑. 테마가 바뀌어도 이 한 곳만 손보면 된다.
// 색상은 WCAG AA 대비(4.5:1 이상)를 목표로 골랐다.
const RISK_TONE: Record<RiskLevel, PresentationTone> = {
  healthy: {
    background: '#0f2a1f',
    foreground: '#7ee4b0',
    accent: '#34d399',
    ariaLabel: '상태 양호',
  },
  watch: {
    background: '#21250b',
    foreground: '#f4e27a',
    accent: '#facc15',
    ariaLabel: '주의 관찰 필요',
  },
  warning: {
    background: '#2a1a0a',
    foreground: '#fcb673',
    accent: '#fb923c',
    ariaLabel: '경고 수준',
  },
  critical: {
    background: '#2a0f14',
    foreground: '#ff8b96',
    accent: '#f43f5e',
    ariaLabel: '위험 — 즉시 대응',
  },
};

// 품질 등급은 리스크와 다른 팔레트를 쓴다. "성적표" 은유가 통하도록
// A~F 순으로 채도가 떨어지고 붉은 기운이 강해진다.
const GRADE_TONE: Record<QualityReport['grade'], PresentationTone> = {
  A: { background: '#0b2e23', foreground: '#8ee9bf', accent: '#22d3a5', ariaLabel: '최상급 품질' },
  B: { background: '#122a2f', foreground: '#84d9e8', accent: '#2dd4bf', ariaLabel: '양호한 품질' },
  C: { background: '#24250d', foreground: '#eadf76', accent: '#eab308', ariaLabel: '보통 품질' },
  D: { background: '#2a1a0a', foreground: '#fcb673', accent: '#fb923c', ariaLabel: '개선 필요' },
  F: { background: '#2a0f14', foreground: '#ff8b96', accent: '#f43f5e', ariaLabel: '심각 — 재설계 권장' },
};

export function getRiskTone(level: RiskLevel): PresentationTone {
  return RISK_TONE[level];
}

export function getGradeTone(grade: QualityReport['grade']): PresentationTone {
  return GRADE_TONE[grade];
}

// 파일 타입별 아이콘/색 토큰. 그래프 노드와 파일 리스트에서 동일 토큰을 써
// 사용자가 화면을 옮겨 다녀도 같은 개념을 같은 색으로 인식하게 한다.
const FILE_TYPE_TONE: Record<CodeFile['type'], PresentationTone & { icon: string }> = {
  component: {
    background: '#10223a',
    foreground: '#a7c4ff',
    accent: '#60a5fa',
    ariaLabel: '컴포넌트 파일',
    icon: '◧',
  },
  service: {
    background: '#1a1133',
    foreground: '#c4b5fd',
    accent: '#8b5cf6',
    ariaLabel: '서비스 파일',
    icon: '◈',
  },
  util: {
    background: '#0f2321',
    foreground: '#99e9d3',
    accent: '#2dd4bf',
    ariaLabel: '유틸 파일',
    icon: '◇',
  },
  style: {
    background: '#2a1529',
    foreground: '#f5a3d1',
    accent: '#ec4899',
    ariaLabel: '스타일 파일',
    icon: '◉',
  },
};

export function getFileTypeTone(type: CodeFile['type']): PresentationTone & { icon: string } {
  return FILE_TYPE_TONE[type];
}

export interface DashboardCard {
  id: string;
  title: string;
  value: string;
  caption: string;
  tone: PresentationTone;
  /** 카드 비중을 결정하는 크기. 그리드 레이아웃에서 span을 정하는 데 쓴다. */
  emphasis: 'hero' | 'primary' | 'secondary';
}

/**
 * 인사이트를 대시보드에 올릴 카드 목록으로 변환한다.
 * 숫자 포매팅·색상·레이블을 한 번에 정리해, 뷰 컴포넌트는 map만 하면 되게 한다.
 * 순서는 화면에 놓일 우선순위와 일치한다.
 */
export function buildDashboardCards(
  insights: WorkspaceInsights,
  report?: QualityReport,
): DashboardCard[] {
  const cards: DashboardCard[] = [];

  if (report) {
    cards.push({
      id: 'quality',
      title: '품질 등급',
      value: `${report.grade} · ${report.score}`,
      caption: report.highlights[0] ?? '품질 리포트 준비됨',
      tone: getGradeTone(report.grade),
      emphasis: 'hero',
    });
  }

  cards.push({
    id: 'coverage',
    title: '작업 커버리지',
    value: `${insights.coveragePercent}%`,
    caption: `${insights.activeAgents}/${insights.totalAgents} 에이전트 활성`,
    tone: coverageTone(insights.coveragePercent),
    emphasis: 'primary',
  });

  cards.push({
    id: 'files',
    title: '파일 수',
    value: formatCompactNumber(insights.totalFiles),
    caption: describeFileBreakdown(insights.fileTypeBreakdown),
    tone: getFileTypeTone('component'),
    emphasis: 'primary',
  });

  if (insights.cyclicFiles.length > 0) {
    cards.push({
      id: 'cyclic',
      title: '순환 의존',
      value: `${insights.cyclicFiles.length}건`,
      caption: '인터페이스로 분리 검토',
      tone: getRiskTone('warning'),
      emphasis: 'secondary',
    });
  }

  if (insights.isolatedFiles.length > 0) {
    cards.push({
      id: 'isolated',
      title: '고립 파일',
      value: `${insights.isolatedFiles.length}개`,
      caption: insights.isolatedFiles.slice(0, 2).join(', '),
      tone: getRiskTone('watch'),
      emphasis: 'secondary',
    });
  }

  return cards;
}

// 커버리지는 "높을수록 좋다"는 방향성이 있어 리스크 팔레트를 뒤집어 쓴다.
function coverageTone(percent: number): PresentationTone {
  if (percent >= 75) return getRiskTone('healthy');
  if (percent >= 50) return getRiskTone('watch');
  if (percent >= 25) return getRiskTone('warning');
  return getRiskTone('critical');
}

// 1,000 단위를 k로 축약. 대시보드 카드 폭이 좁아 긴 숫자가 레이아웃을 깨뜨리는 걸 막는다.
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '-';
  if (Math.abs(value) < 1_000) return String(Math.round(value));
  if (Math.abs(value) < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function describeFileBreakdown(breakdown: FileTypeBreakdown): string {
  const parts: string[] = [];
  (Object.keys(breakdown) as Array<CodeFile['type']>).forEach(type => {
    const count = breakdown[type];
    if (count > 0) parts.push(`${getFileTypeTone(type).icon} ${count}`);
  });
  return parts.length > 0 ? parts.join(' · ') : '파일 없음';
}

export interface GraphLayoutHint {
  fileId: string;
  /** 0~1. 중심부(허브)에 가까울수록 작다. */
  radius: number;
  /** 0~2π. 같은 타입끼리 섹터를 형성하도록 타입별 기준각에서 퍼진다. */
  angle: number;
  tone: PresentationTone;
}

const TYPE_SECTOR: Record<CodeFile['type'], number> = {
  component: 0,
  service: Math.PI / 2,
  util: Math.PI,
  style: (3 * Math.PI) / 2,
};

/**
 * 강제 지향 시뮬레이션이 무거울 때 쓰는 가벼운 초기 좌표 힌트.
 * in-degree가 큰 파일은 중앙(반지름 작게), 파생 파일은 바깥 궤도로 배치한다.
 * 실제 렌더러가 이 값을 시작점으로 잡으면 수렴이 훨씬 빨라진다.
 */
export function buildGraphLayoutHints(
  files: CodeFile[],
  dependencies: CodeDependency[],
): GraphLayoutHint[] {
  const fileIds = new Set(files.map(f => f.id));
  const inDegree = new Map<string, number>();
  dependencies.forEach(d => {
    if (!fileIds.has(d.from) || !fileIds.has(d.to)) return;
    inDegree.set(d.to, (inDegree.get(d.to) ?? 0) + 1);
  });
  const maxIn = Math.max(1, ...Array.from(inDegree.values()));

  // 타입별 섹터 안에서 N등분해 겹치지 않게 배치.
  const perTypeCount: Record<CodeFile['type'], number> = { component: 0, service: 0, util: 0, style: 0 };
  const perTypeIndex: Record<CodeFile['type'], number> = { component: 0, service: 0, util: 0, style: 0 };
  files.forEach(f => { perTypeCount[f.type] += 1; });

  return files.map(f => {
    const degree = inDegree.get(f.id) ?? 0;
    // 허브일수록 중심에 가깝도록 반지름을 0.25~1.0 사이로 역매핑.
    const radius = 1 - 0.75 * (degree / maxIn);
    const sector = TYPE_SECTOR[f.type];
    const span = Math.PI / 2; // 섹터 폭(90도)
    const slot = perTypeCount[f.type] || 1;
    const idxWithin = perTypeIndex[f.type];
    perTypeIndex[f.type] += 1;
    const angle = sector + span * ((idxWithin + 0.5) / slot - 0.5);
    return {
      fileId: f.id,
      radius: clamp01(radius),
      angle,
      tone: getFileTypeTone(f.type),
    };
  });
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 파일 이름을 UI에 맞게 자르는 헬퍼. 확장자는 살리고 중간을 줄여
 * "Project…Details.tsx"처럼 식별성을 유지한다.
 */
export function truncateFileName(name: string, maxLength = 20): string {
  if (name.length <= maxLength) return name;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return `${name.slice(0, maxLength - 1)}…`;
  }
  const ext = name.slice(dot);
  const head = name.slice(0, Math.max(1, maxLength - ext.length - 1));
  return `${head}…${ext}`;
}

export interface Sparkline {
  /** SVG viewBox 기준 0~100 좌표로 매핑된 포인트 목록. */
  points: Array<{ x: number; y: number }>;
  /** 첫/마지막 값을 비교한 트렌드. Sparkline 옆에 화살표로 표시하기 좋다. */
  trend: QualityTrend;
  /** 접근성 요약(스크린리더 alt 용). */
  summary: string;
}

/**
 * 최근 품질 점수 히스토리를 SVG-친화적인 100x100 좌표로 정규화한다.
 * 디자이너가 대시보드 카드에 꽂아 쓸 수 있도록 viewBox 고정 규격으로 반환한다.
 * 값이 하나뿐이면 수평선으로 렌더되어 "데이터 부족" 상태를 암시한다.
 */
export function buildScoreSparkline(history: number[]): Sparkline {
  if (history.length === 0) {
    return { points: [], trend: 'stable', summary: '기록 없음' };
  }
  const clamped = history.map(v => Math.max(0, Math.min(100, v)));
  const count = clamped.length;
  // 분모 0을 피하려고 count=1이면 x=50에 점 하나만 찍는다.
  const points = clamped.map((value, idx) => ({
    x: count === 1 ? 50 : Math.round((idx / (count - 1)) * 100),
    // SVG는 y축이 아래로 자라므로 점수가 높을수록 y가 작아지도록 뒤집는다.
    y: Math.round(100 - value),
  }));
  const first = clamped[0];
  const last = clamped[count - 1];
  const delta = last - first;
  const trend: QualityTrend =
    delta > 2 ? 'improved' : delta < -2 ? 'regressed' : 'stable';
  const summary =
    count === 1
      ? `현재 점수 ${last}`
      : `${first} → ${last} (${delta >= 0 ? '+' : ''}${delta})`;
  return { points, trend, summary };
}

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

/**
 * 화면 폭에 따라 대시보드 카드 강조도를 조정한다.
 * 좁은 화면에서는 hero 1장만 남기고 나머지는 모두 secondary로 끌어내려
 * 스크롤이 끝없이 길어지는 것을 막는다.
 */
export function adaptCardsToBreakpoint(
  cards: DashboardCard[],
  breakpoint: Breakpoint,
): DashboardCard[] {
  if (breakpoint === 'desktop') return cards;
  let heroAssigned = false;
  return cards.map(card => {
    if (breakpoint === 'mobile') {
      if (card.emphasis === 'hero' && !heroAssigned) {
        heroAssigned = true;
        return card;
      }
      return { ...card, emphasis: 'secondary' };
    }
    // tablet: hero는 유지하되 primary/secondary 구분만 살린다.
    if (card.emphasis === 'hero') {
      heroAssigned = true;
      return card;
    }
    return card;
  });
}

export interface LegendEntry {
  label: string;
  tone: PresentationTone;
  /** 범례 옆에 표시할 예시 아이콘(파일 타입 범례일 때 사용). */
  icon?: string;
}

/**
 * 그래프/대시보드에서 공통으로 쓰는 범례 데이터를 생성한다.
 * 색상-의미 매핑이 여러 컴포넌트에 중복 선언되던 문제를 한 곳으로 모았다.
 */
export function buildLegend(kind: 'risk' | 'grade' | 'fileType'): LegendEntry[] {
  if (kind === 'risk') {
    return (['healthy', 'watch', 'warning', 'critical'] as RiskLevel[]).map(level => ({
      label: RISK_TONE[level].ariaLabel,
      tone: RISK_TONE[level],
    }));
  }
  if (kind === 'grade') {
    return (['A', 'B', 'C', 'D', 'F'] as QualityReport['grade'][]).map(grade => ({
      label: `${grade} · ${GRADE_TONE[grade].ariaLabel}`,
      tone: GRADE_TONE[grade],
    }));
  }
  return (['component', 'service', 'util', 'style'] as CodeFile['type'][]).map(type => ({
    label: FILE_TYPE_TONE[type].ariaLabel,
    tone: FILE_TYPE_TONE[type],
    icon: FILE_TYPE_TONE[type].icon,
  }));
}

// 에이전트 상태 ↔ 톤 매핑. 상태 배지(칩)와 아바타 링에 동시에 쓰인다.
// "working"은 시선을 끌 필요가 있어 보색에 가까운 accent를 잡았고,
// "idle"은 배경과 가깝게 눌러 둔다. meeting/thinking은 일시적 상태라
// 보색과 무채색 사이 중간톤으로 타협한다.
const AGENT_STATUS_TONE: Record<Agent['status'], PresentationTone> = {
  idle: {
    background: '#1b1d24',
    foreground: '#9ca3af',
    accent: '#4b5563',
    ariaLabel: '유휴 상태',
  },
  working: {
    background: '#0f2a1f',
    foreground: '#7ee4b0',
    accent: '#34d399',
    ariaLabel: '작업 중',
  },
  meeting: {
    background: '#121a33',
    foreground: '#a7c4ff',
    accent: '#60a5fa',
    ariaLabel: '회의 중',
  },
  thinking: {
    background: '#1a1133',
    foreground: '#c4b5fd',
    accent: '#8b5cf6',
    ariaLabel: '사고 중',
  },
};

export function getAgentStatusTone(status: Agent['status']): PresentationTone {
  return AGENT_STATUS_TONE[status];
}

// 역할별 아바타 이니셜/톤. 팀 프로필 이미지가 없을 때 기본 아바타로 쓰인다.
// 이니셜은 한국어 역할명의 첫 글자를 잡아 식별성을 높였다.
const ROLE_AVATAR: Record<AgentRole, { initial: string; tone: PresentationTone }> = {
  Leader: {
    initial: '리',
    tone: { background: '#2a1a0a', foreground: '#fcd34d', accent: '#f59e0b', ariaLabel: '리더' },
  },
  Developer: {
    initial: '개',
    tone: { background: '#10223a', foreground: '#a7c4ff', accent: '#60a5fa', ariaLabel: '개발자' },
  },
  Designer: {
    initial: '디',
    tone: { background: '#2a1529', foreground: '#f5a3d1', accent: '#ec4899', ariaLabel: '디자이너' },
  },
  Researcher: {
    initial: '연',
    tone: { background: '#0f2321', foreground: '#99e9d3', accent: '#2dd4bf', ariaLabel: '연구원' },
  },
  QA: {
    initial: 'Q',
    tone: { background: '#24250d', foreground: '#eadf76', accent: '#eab308', ariaLabel: '품질 관리' },
  },
};

const FALLBACK_AVATAR = {
  initial: '?',
  tone: {
    background: '#1b1d24',
    foreground: '#cbd5f5',
    accent: '#64748b',
    ariaLabel: '역할 미지정',
  } satisfies PresentationTone,
};

export function getRoleAvatar(role: AgentRole): { initial: string; tone: PresentationTone } {
  return ROLE_AVATAR[role] ?? FALLBACK_AVATAR;
}

export interface ProgressSegment {
  /** 0~100, 세그먼트가 차지하는 퍼센트. 합이 100을 넘지 않도록 정규화된다. */
  percent: number;
  tone: PresentationTone;
  label: string;
}

/**
 * 파일 타입 구성비를 누적 막대(stacked bar) 세그먼트로 변환한다.
 * 백분율은 반올림 오차가 누적되지 않도록 마지막 세그먼트가 잔여분을 흡수한다.
 * 합계가 0이면 빈 배열을 반환해, 호출부가 "데이터 없음" 상태를 그리게 한다.
 */
export function buildFileTypeProgress(breakdown: FileTypeBreakdown): ProgressSegment[] {
  const types = (Object.keys(breakdown) as Array<CodeFile['type']>).filter(
    t => breakdown[t] > 0,
  );
  const total = types.reduce((sum, t) => sum + breakdown[t], 0);
  if (total === 0) return [];

  const segments: ProgressSegment[] = [];
  let consumed = 0;
  types.forEach((type, idx) => {
    const raw = (breakdown[type] / total) * 100;
    const percent = idx === types.length - 1
      ? Math.max(0, 100 - consumed)
      : Math.round(raw);
    consumed += percent;
    const tone = getFileTypeTone(type);
    segments.push({
      percent,
      tone,
      label: `${tone.ariaLabel} ${breakdown[type]}개 (${percent}%)`,
    });
  });
  return segments;
}

/**
 * 카드/툴팁 등에 쓰는 "foreground on background" 인라인 스타일 객체를 만든다.
 * CSSProperties 타입을 임포트하지 않고도 동일한 키를 갖도록 Record로 반환한다.
 * 호출부에서 곧바로 style={...}에 펼쳐 쓸 수 있다.
 */
export function toneToStyle(tone: PresentationTone): Record<string, string> {
  return {
    backgroundColor: tone.background,
    color: tone.foreground,
    borderColor: tone.accent,
  };
}

/**
 * 에이전트 워크로드를 "누가 지금 무엇을"을 한 줄로 표현하는 문자열로 압축.
 * 상태 배지와 함께 리스트 아이템의 subtitle로 쓰기 좋다.
 */
export function describeWorkload(workload: AgentWorkload): string {
  const statusLabel = AGENT_STATUS_TONE[workload.status].ariaLabel;
  if (workload.status === 'idle' || !workload.workingOnFileName) {
    return `${statusLabel} · 대기 중`;
  }
  return `${statusLabel} · ${truncateFileName(workload.workingOnFileName, 24)}`;
}

// ───────────────────────────────────────────────────────────────
// 이하 개발자("베타") 추가 파트 v2 — 리팩터 실행 계획과 병렬 작업
// 단위 분석, 에이전트 할당 힌트. 기존 파트가 "무엇이 잘못됐나 / 어디가
// 위험한가"를 짚었다면, 여기서는 "어떤 순서로 어떻게 끊어서 처리할까"를
// 스프린트 실행 계획으로 펼쳐 낸다.
// ───────────────────────────────────────────────────────────────

export interface RefactorPhase {
  /** 1부터 시작. 숫자가 작을수록 먼저 처리. */
  phase: number;
  label: string;
  candidates: RefactorCandidate[];
  /** 이 단계에서 먼저 정리해야 하는 근거. 툴팁/커밋 메시지 드래프트에 그대로 쓴다. */
  rationale: string;
}

/**
 * 리팩터 후보를 결합도 분위(quantile)별로 잘라 단계적 실행 계획을 만든다.
 * 한 번에 전부 손대면 PR이 비대해져 리뷰가 불가능해지므로,
 * 핵심 허브(상위 25%)부터 3단계로 나눠 스프린트에 분배하기 쉽게 한다.
 * 상대 분위는 절대 임계치보다 프로젝트 크기 변화에 덜 민감하다.
 */
export function planRefactorPhases(candidates: RefactorCandidate[]): RefactorPhase[] {
  if (candidates.length === 0) return [];
  const sorted = [...candidates].sort((a, b) => b.couplingScore - a.couplingScore);
  const total = sorted.length;
  const topCut = Math.max(1, Math.ceil(total * 0.25));
  const midCut = Math.max(topCut + 1, Math.ceil(total * 0.6));

  const phases: RefactorPhase[] = [];
  const top = sorted.slice(0, topCut);
  const mid = sorted.slice(topCut, midCut);
  const tail = sorted.slice(midCut);

  if (top.length > 0) {
    phases.push({
      phase: 1,
      label: '핵심 허브 해체',
      candidates: top,
      rationale: '결합도 상위 — 인터페이스 분리·의존 역전으로 영향 반경부터 좁힌다.',
    });
  }
  if (mid.length > 0) {
    phases.push({
      phase: phases.length + 1,
      label: '주변부 정돈',
      candidates: mid,
      rationale: '허브가 정리된 뒤 같은 인터페이스를 따라 주변 파일을 맞춰 바꾼다.',
    });
  }
  if (tail.length > 0) {
    phases.push({
      phase: phases.length + 1,
      label: '잔여 정리',
      candidates: tail,
      rationale: '남은 경미한 결합은 기능 브랜치 작업 중 곁다리로 처리한다.',
    });
  }
  return phases;
}

export interface WorkCluster {
  /** 클러스터 식별자. 정렬한 파일 ID의 첫 값을 그대로 쓴다. */
  id: string;
  fileIds: string[];
  /** 클러스터 내부 엣지 수. 0이면 서로 독립적인 단일 파일 그룹이다. */
  internalEdges: number;
}

/**
 * 방향을 무시한 약 연결 요소(Weakly Connected Component)를 Union-Find로 구한다.
 * 서로 다른 클러스터는 의존이 얽히지 않아 병렬 브랜치에 나눠 작업해도 충돌이 없다.
 * 개발자가 릴리스 슬라이스를 나눌 때 이 클러스터 단위를 최소 분할 단위로 삼는다.
 */
export function findParallelWorkClusters(
  files: CodeFile[],
  dependencies: CodeDependency[],
): WorkCluster[] {
  const parent = new Map<string, string>();
  files.forEach(f => parent.set(f.id, f.id));

  // 경로 압축 포함 find. 대형 그래프에서도 amortized 거의 O(1).
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let node = x;
    while (parent.get(node) !== root) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const fileSet = new Set(files.map(f => f.id));
  dependencies.forEach(d => {
    if (!fileSet.has(d.from) || !fileSet.has(d.to)) return;
    union(d.from, d.to);
  });

  const groups = new Map<string, string[]>();
  files.forEach(f => {
    const root = find(f.id);
    const list = groups.get(root) ?? [];
    list.push(f.id);
    groups.set(root, list);
  });

  // 내부 엣지 수는 루트 기준으로 누적. 외부 엣지는 정의상 존재하지 않는다.
  const edgesPerRoot = new Map<string, number>();
  dependencies.forEach(d => {
    if (!fileSet.has(d.from) || !fileSet.has(d.to)) return;
    const root = find(d.from);
    edgesPerRoot.set(root, (edgesPerRoot.get(root) ?? 0) + 1);
  });

  const clusters: WorkCluster[] = [];
  groups.forEach((ids, root) => {
    const sortedIds = [...ids].sort();
    clusters.push({
      id: sortedIds[0],
      fileIds: sortedIds,
      internalEdges: edgesPerRoot.get(root) ?? 0,
    });
  });
  // 크기 내림차순 + 대표 ID 오름차순으로 결정적 순서 고정.
  clusters.sort((a, b) =>
    (b.fileIds.length - a.fileIds.length) || a.id.localeCompare(b.id),
  );
  return clusters;
}

export interface AgentAssignmentHint {
  agentId: string;
  agentName: string;
  recommendedFileId?: string;
  recommendedFileName?: string;
  reason: string;
}

/**
 * 유휴 에이전트에게 "다음에 열어볼 만한 파일"을 한 건씩 추천한다.
 * 우선순위: 리팩터 후보 → 고립 파일 → 나머지 미배정 파일.
 * 역할 기반의 정교한 매칭은 하지 않는다 — 사람이 최종 결정을 하도록 가벼운 힌트만 낸다.
 */
export function suggestAgentAssignments(
  insights: WorkspaceInsights,
  files: CodeFile[],
  refactorCandidates: RefactorCandidate[] = [],
): AgentAssignmentHint[] {
  const busyFileIds = new Set(
    insights.workloads
      .map(w => w.workingOnFileId)
      .filter((id): id is string => Boolean(id)),
  );
  const fileById = new Map(files.map(f => [f.id, f] as const));
  const seen = new Set<string>();
  const prioritized: CodeFile[] = [];
  const pushIfNew = (f: CodeFile | undefined) => {
    if (!f || seen.has(f.id) || busyFileIds.has(f.id)) return;
    seen.add(f.id);
    prioritized.push(f);
  };
  refactorCandidates.forEach(c => pushIfNew(fileById.get(c.fileId)));
  insights.isolatedFiles.forEach(name => pushIfNew(files.find(f => f.name === name)));
  files.forEach(f => pushIfNew(f));

  const hints: AgentAssignmentHint[] = [];
  const idleAgents = insights.workloads.filter(w => !w.workingOnFileId);
  idleAgents.forEach((agent, idx) => {
    const target = prioritized[idx];
    if (!target) {
      hints.push({
        agentId: agent.agentId,
        agentName: agent.agentName,
        reason: '추천할 미배정 파일이 부족합니다. 새 태스크를 수동 등록해 주세요.',
      });
      return;
    }
    const viaRefactor = refactorCandidates.some(c => c.fileId === target.id);
    hints.push({
      agentId: agent.agentId,
      agentName: agent.agentName,
      recommendedFileId: target.id,
      recommendedFileName: target.name,
      reason: viaRefactor
        ? `리팩터 후보 ${target.name} — 결합도가 높아 조기 개입 이득이 큽니다.`
        : `미할당 파일 ${target.name}부터 착수해 작업 커버리지를 확보하세요.`,
    });
  });
  return hints;
}

// ───────────────────────────────────────────────────────────────
// 이하 개발자("카이") 릴리스 게이트 — QA/베타가 만든 리포트를 받아
// "지금 내보내도 되는가?"를 한 줄로 답한다. CI 파이프라인에서
// early-return 용도로 쓸 수 있도록 부작용 없는 순수 함수로 둔다.
// ───────────────────────────────────────────────────────────────

export interface ReleaseGateResult {
  ready: boolean;
  /** 통과하지 못한 이유. 비어 있으면 통과. 순서는 심각도 내림차순. */
  blockers: string[];
}

/**
 * 릴리스 가능 여부를 한 번에 판단한다.
 * 1) critical 리스크, 2) F 등급, 3) blocker 심각도의 무결성 이슈, 4) 사이클 참여 파일
 * 중 하나라도 있으면 게이트가 닫힌다. 개별 규칙은 이미 각 함수가 계산해 둔 값을
 * 재사용할 뿐 — 이곳에서 중복 계산을 만들지 않는 것이 이 헬퍼의 의도다.
 */
export function evaluateReleaseGate(
  report: QualityReport,
  insights: WorkspaceInsights,
): ReleaseGateResult {
  const blockers: string[] = [];

  if (report.risk.level === 'critical') {
    blockers.push(`리스크 수준 critical (점수 ${report.risk.score}).`);
  }
  if (report.grade === 'F') {
    blockers.push('품질 등급 F — 재설계 없이 릴리스 불가.');
  }

  const blockerIssues = report.integrityIssues.filter(
    i => getIssueSeverity(i.code) === 'blocker',
  );
  if (blockerIssues.length > 0) {
    blockers.push(`무결성 블로커 ${blockerIssues.length}건 — 먼저 해결 필요.`);
  }

  if (insights.cyclicFiles.length > 0) {
    blockers.push(`순환 의존 ${insights.cyclicFiles.length}건 — 배포 전 분리 권장.`);
  }

  return { ready: blockers.length === 0, blockers };
}

/**
 * `evaluateReleaseGate`의 얇은 부울 래퍼. 스크립트/CLI에서 exit code로
 * 변환하기 좋게 true/false만 반환한다.
 */
export function isReleaseReady(
  report: QualityReport,
  insights: WorkspaceInsights,
): boolean {
  return evaluateReleaseGate(report, insights).ready;
}

// ───────────────────────────────────────────────────────────────
// 이하 연구원 추가 파트 — 정성적 관찰을 수치로 바꾸는 리서치 레이어.
// 프로젝트 간 벤치마킹, 시계열 추세 외삽, 역할 다양성(엔트로피),
// 그리고 이 신호들을 한 장의 "리서치 브리프"로 묶는 포매터를 담는다.
// 게임 로직에 직접 영향을 주진 않고, 대시보드/리포트의 해석을 돕는다.
// ───────────────────────────────────────────────────────────────

export interface ProjectBenchmark {
  projectId: string;
  projectName: string;
  score: number;
  grade: QualityReport['grade'];
  /** 표본 평균 대비 표준편차 단위의 상대 위치. 0이면 평균, 양수면 평균 이상. */
  zScore: number;
  /** 0~100. 낮을수록 하위권, 100이면 최상위. 동점은 평균 순위로 처리. */
  percentile: number;
}

/**
 * 여러 프로젝트의 품질 리포트를 한 줄에 놓고 상대 순위를 계산한다.
 * 단순 정렬만으론 "A팀은 B팀보다 얼마나 잘하고 있나"가 안 보여서,
 * 표준점수(z)와 백분위를 함께 낸다. 표본이 1개면 비교가 무의미하므로
 * z=0, percentile=50으로 중립값을 내려 호출부가 분기 처리를 덜 하도록 한다.
 */
export function benchmarkProjects(
  entries: Array<{ projectId: string; projectName: string; report: QualityReport }>,
): ProjectBenchmark[] {
  if (entries.length === 0) return [];
  const scores = entries.map(e => e.report.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
  const stddev = Math.sqrt(variance);

  // 점수 오름차순 순위에 동점 평균 순위(tie-averaging)를 적용해 백분위에 반영한다.
  const sortedAsc = [...entries].sort((a, b) => a.report.score - b.report.score);
  const rankByProject = new Map<string, number>();
  let i = 0;
  while (i < sortedAsc.length) {
    let j = i;
    while (
      j + 1 < sortedAsc.length &&
      sortedAsc[j + 1].report.score === sortedAsc[i].report.score
    ) {
      j += 1;
    }
    const avgRank = (i + j) / 2;
    for (let k = i; k <= j; k += 1) {
      rankByProject.set(sortedAsc[k].projectId, avgRank);
    }
    i = j + 1;
  }

  return entries.map(e => {
    const zScore = stddev === 0 ? 0 : (e.report.score - mean) / stddev;
    const rank = rankByProject.get(e.projectId) ?? 0;
    const percentile = entries.length === 1
      ? 50
      : Math.round((rank / (entries.length - 1)) * 100);
    return {
      projectId: e.projectId,
      projectName: e.projectName,
      score: e.report.score,
      grade: e.report.grade,
      zScore: Number(zScore.toFixed(2)),
      percentile,
    };
  });
}

export interface TrendForecast {
  /** 다음 관측 시점의 기대 점수(0~100으로 클리핑됨). */
  nextScore: number;
  /** 단위 시간당 변화량. 양수면 개선, 음수면 하락 추세. */
  slope: number;
  /** 결정계수(R²). 1에 가까울수록 선형 회귀가 히스토리를 잘 설명한다. */
  fitQuality: number;
  /** 예측 신뢰 수준을 자연어로 요약. UI 툴팁에 그대로 쓴다. */
  confidence: 'low' | 'medium' | 'high';
}

/**
 * 단순 최소제곱 선형 회귀로 다음 품질 점수를 외삽한다.
 * 과적합을 피하려고 고차 회귀는 쓰지 않는다 — 단순함이 안정성을 낳는다.
 * 표본 3개 미만이면 추세라 부르기 어려워 low로 고정하고,
 * 결정계수에 따라 medium/high로만 승급시킨다.
 */
export function forecastQualityTrend(history: number[]): TrendForecast {
  if (history.length === 0) {
    return { nextScore: 0, slope: 0, fitQuality: 0, confidence: 'low' };
  }
  if (history.length === 1) {
    return { nextScore: history[0], slope: 0, fitQuality: 0, confidence: 'low' };
  }
  const n = history.length;
  const xs = history.map((_, idx) => idx);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = history.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let k = 0; k < n; k += 1) {
    num += (xs[k] - meanX) * (history[k] - meanY);
    den += (xs[k] - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanY - slope * meanX;

  // 결정계수 = 1 - SSres/SStot. 분모가 0(평탄한 히스토리)이면 완전 적합으로 본다.
  let ssRes = 0;
  let ssTot = 0;
  for (let k = 0; k < n; k += 1) {
    const predicted = slope * xs[k] + intercept;
    ssRes += (history[k] - predicted) ** 2;
    ssTot += (history[k] - meanY) ** 2;
  }
  const fitQuality = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);

  const rawNext = slope * n + intercept;
  const nextScore = Math.round(Math.max(0, Math.min(100, rawNext)));

  let confidence: TrendForecast['confidence'] = 'low';
  if (n >= 3 && fitQuality >= 0.75) confidence = 'high';
  else if (n >= 3 && fitQuality >= 0.4) confidence = 'medium';

  return {
    nextScore,
    slope: Number(slope.toFixed(2)),
    fitQuality: Number(fitQuality.toFixed(2)),
    confidence,
  };
}

export interface RoleDiversity {
  /** 0~1, Shannon 엔트로피를 최대치로 정규화한 균형도. 1에 가까울수록 균형. */
  balance: number;
  /** 존재하지 않는 역할 목록. 팀 구성 리밸런싱 힌트로 쓴다. */
  missingRoles: AgentRole[];
  /** 한 역할이 절반을 넘으면 과대대표 역할로 표시한다. */
  dominantRole?: AgentRole;
}

const ALL_ROLES: AgentRole[] = ['Leader', 'Developer', 'Designer', 'Researcher', 'QA'];

/**
 * 역할 분포의 다양성을 엔트로피로 측정한다.
 * 단일 역할만 있으면 0, 모든 역할이 동률이면 1이 나오도록 정규화한다.
 * "에이전트 n명"이라는 양적 지표만으론 드러나지 않는 팀 구성 불균형을 잡아낸다.
 */
export function analyzeRoleDiversity(roleBreakdown: AgentRoleBreakdown): RoleDiversity {
  const counts = ALL_ROLES.map(r => roleBreakdown[r] ?? 0);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) {
    return { balance: 0, missingRoles: [...ALL_ROLES] };
  }

  const present = counts.filter(c => c > 0).length;
  // log(1) = 0이라 단일 역할일 때 분모가 0이 되어 NaN이 뜨는 걸 막는다.
  const maxEntropy = present <= 1 ? 1 : Math.log(present);
  let entropy = 0;
  counts.forEach(c => {
    if (c === 0) return;
    const p = c / total;
    entropy -= p * Math.log(p);
  });
  const balance = present <= 1 ? 0 : Number((entropy / maxEntropy).toFixed(2));

  const missingRoles = ALL_ROLES.filter(r => (roleBreakdown[r] ?? 0) === 0);
  let dominantRole: AgentRole | undefined;
  ALL_ROLES.forEach(r => {
    const count = roleBreakdown[r] ?? 0;
    if (count / total > 0.5) dominantRole = r;
  });

  return { balance, missingRoles, dominantRole };
}

export interface ResearchBrief {
  headline: string;
  /** 세 줄 이내의 관찰 문장. 리포트 상단이나 접힌 카드 면에 쓴다. */
  observations: string[];
  /** 관찰을 뒷받침하는 수치 근거. 라벨-값 쌍으로 표 형태로 렌더한다. */
  evidence: Array<{ label: string; value: string }>;
}

/**
 * 인사이트/품질/추세/다양성 지표를 한 장의 리서치 브리프로 압축한다.
 * 연구원은 수치를 나열하기보다 "무엇이 눈에 띄는가"를 한 줄로 요약해 주는 역할이라,
 * 가장 강한 신호 2~3개만 추려 담는다.
 */
export function buildResearchBrief(
  insights: WorkspaceInsights,
  report: QualityReport,
  history: number[] = [],
): ResearchBrief {
  const forecast = forecastQualityTrend(history.length > 0 ? history : [report.score]);
  const diversity = analyzeRoleDiversity(insights.roleBreakdown);

  const observations: string[] = [];
  if (forecast.confidence !== 'low') {
    const direction = forecast.slope > 0 ? '상승' : forecast.slope < 0 ? '하락' : '정체';
    observations.push(
      `최근 품질 추세는 ${direction}(기울기 ${forecast.slope}), 다음 예상 점수 ${forecast.nextScore}.`,
    );
  } else if (history.length > 0) {
    observations.push('표본이 부족해 추세 해석은 보류합니다. 측정 주기를 늘리세요.');
  }

  if (diversity.dominantRole) {
    observations.push(
      `${diversity.dominantRole} 역할이 팀의 과반을 차지해 관점 편중 위험이 있습니다.`,
    );
  } else if (diversity.missingRoles.length > 0) {
    observations.push(
      `누락 역할: ${diversity.missingRoles.join(', ')} — 보강하면 브리지 품질이 오를 가능성이 큽니다.`,
    );
  }

  if (insights.cyclicFiles.length > 0 && report.risk.level !== 'healthy') {
    observations.push('순환 의존과 리스크 신호가 동시에 관측됩니다. 원인-결과 분리 조사 권장.');
  }

  const headline = observations.length === 0
    ? `연구 브리프: 품질 ${report.grade}, 특이 신호 없음.`
    : `연구 브리프: ${observations[0]}`;

  const evidence: ResearchBrief['evidence'] = [
    { label: '품질 점수', value: `${report.score}/100 (${report.grade})` },
    { label: '리스크 레벨', value: report.risk.level },
    { label: '역할 균형', value: diversity.balance.toString() },
    { label: '추세 신뢰도', value: forecast.confidence },
  ];

  return { headline, observations, evidence };
}

// ---------------------------------------------------------------------------
// 분업 우선 워크플로우 v2 — 라우팅 준수도 지표
// ---------------------------------------------------------------------------
// 근거: docs/reports/2026-04-17-delegation-workflow.md §3, §4.
// 알파(router) 단독 처리율과 파이프라인 역할 분포를 순수 함수로 계산한다.

export type RoutingVerdict = 'forbidden' | 'allowed';

export interface SoloHandlingRecord {
  /** 인박스 블록 제목 또는 지시 요약. */
  directiveDigest: string;
  /** 'tick=now', 'tick=now+1' 등의 틱 라벨. */
  tick: string;
  /** 라우팅 매트릭스상 ❌/✅ 판정. */
  verdict: RoutingVerdict;
  /** 해당 지시에 대해 생성된 HANDOFF 수. 0이면 알파 단독 처리. */
  delegatedCount: number;
  /** 알파의 단독 처리 사유 원문. "없음"이면 비위임. */
  alphaSoloNote: string;
}

export interface ForbiddenSoloRateResult {
  /** 0~1 범위의 비율. 표본 없음은 0. */
  rate: number;
  denominator: number;
  numerator: number;
  /** 프로토콜 v2의 20% 임계 초과 여부. */
  thresholdExceeded: boolean;
  /** 위반 기록들의 digest 리스트. */
  offendingDirectives: string[];
}

const FORBIDDEN_SOLO_THRESHOLD = 0.2;
const DEFAULT_WINDOW_SIZE = 30;

/**
 * 최근 N개 레코드 중 ❌ 항목을 알파가 단독 처리한 비율을 계산한다.
 * windowSize는 배열 꼬리부터 자르는 단순 슬라이스이며, 시간 가중치는 없다.
 * 정렬은 호출 측 책임 — 이 함수는 "가장 최근 N개"라는 의미 해석을 하지 않는다.
 */
export function computeForbiddenSoloRate(
  records: SoloHandlingRecord[],
  windowSize: number = DEFAULT_WINDOW_SIZE,
): ForbiddenSoloRateResult {
  const size = Number.isFinite(windowSize) && windowSize > 0 ? Math.floor(windowSize) : DEFAULT_WINDOW_SIZE;
  const windowed = records.length > size ? records.slice(records.length - size) : records.slice();

  const forbidden = windowed.filter((r) => r.verdict === 'forbidden');
  const solo = forbidden.filter((r) => r.delegatedCount === 0);
  const denominator = forbidden.length;
  const numerator = solo.length;
  const rate = denominator === 0 ? 0 : numerator / denominator;

  return {
    rate,
    denominator,
    numerator,
    thresholdExceeded: rate > FORBIDDEN_SOLO_THRESHOLD,
    offendingDirectives: solo.map((r) => r.directiveDigest),
  };
}

/** UI 상단 바용 한 줄 한국어 요약. 소수점은 1자리까지. */
export function describeForbiddenSoloRate(result: ForbiddenSoloRateResult): string {
  if (result.denominator === 0) {
    return '❌ 단독 처리율: 표본 없음';
  }
  const pct = (result.rate * 100).toFixed(1);
  const flag = result.thresholdExceeded ? ' · 임계 초과' : '';
  return `❌ 단독 처리율 ${pct}% (${result.numerator}/${result.denominator})${flag}`;
}

export type PipelineRole = 'router' | 'executor' | 'verifier' | 'vacant' | 'standby';

export type PipelineRoleBreakdown = Record<PipelineRole, number>;

/**
 * Agent의 도메인 역할(role)과 현재 status를 조합해 파이프라인 역할을 도출한다.
 * - Leader → router (분업 우선 원칙상 리더는 항상 라우터)
 * - Designer + idle → vacant (결원 정책; Designer가 working이면 정상 executor)
 * - working → executor, 그 외 → standby
 * verifier는 아직 명시 규칙이 없어 배정하지 않는다(외부에서 QA 리뷰 시 덮어쓰기 용도).
 */
export function derivePipelineRole(agent: Pick<Agent, 'role' | 'status'>): PipelineRole {
  if (agent.role === 'Leader') return 'router';
  if (agent.role === 'Designer' && agent.status !== 'working') return 'vacant';
  return agent.status === 'working' ? 'executor' : 'standby';
}

const EMPTY_PIPELINE_BREAKDOWN: PipelineRoleBreakdown = {
  router: 0,
  executor: 0,
  verifier: 0,
  vacant: 0,
  standby: 0,
};

/** AgentStatusSnapshot 요약 바용 카운트. */
export function summarizePipelineRoles(agents: Array<Pick<Agent, 'role' | 'status'>>): PipelineRoleBreakdown {
  const out: PipelineRoleBreakdown = { ...EMPTY_PIPELINE_BREAKDOWN };
  for (const agent of agents) {
    out[derivePipelineRole(agent)] += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 인박스 지시 파싱 + 위임률 집계
// ---------------------------------------------------------------------------
// 근거: docs/reports/2026-04-17-directive-logging.md §3, 2026-04-17-collab-audit.md §5-③.
// docs/inbox/YYYY-MM-DD-user-directives.md의 블록을 순수 함수로 파싱해
// 라우팅 준수도 지표의 입력으로 쓴다.

export type DirectiveStatus = 'open' | 'wip' | 'done' | 'blocked';

export type MatrixVerdict = 'allowed' | 'forbidden';

export interface DirectiveEntry {
  /** "tick=now", "10:22 tick=3" 등 블록 헤더의 원문 태그. */
  tick: string;
  /** 블록 제목(지시 요지). */
  digest: string;
  /** 원문 프롬프트 전문. */
  originalPrompt: string;
  /** 위임 HANDOFF 경로 목록 (docs/handoffs/*.md). */
  handoffs: string[];
  /** "알파 자체 처리분" 본문. "없음"이면 예외 없이 위임만 수행했다는 뜻. */
  alphaSolo: string;
  status: DirectiveStatus;
  /** 블록이 속한 파일 경로(파서 호출 측이 주입). */
  sourcePath: string;
  /** `- **매트릭스 근거**:` 원문 값. 필드가 없거나 파싱 실패 시 undefined. */
  matrixBasis?: string;
  /**
   * matrixBasis에서 추출한 ✅/❌ 판정. 감사기가 키워드 추정 대신
   * 블록이 명시한 판정을 바로 사용하도록 한다. 미기재는 undefined.
   */
  verdict?: MatrixVerdict;
}

const KNOWN_DIRECTIVE_STATUSES: ReadonlyArray<DirectiveStatus> = ['open', 'wip', 'done', 'blocked'];

function normalizeDirectiveStatus(raw: string): DirectiveStatus {
  // 인박스 블록은 "done (베타 검수 대기)" 처럼 첫 토큰 뒤에 주석이 붙는 경우가 잦다.
  // 첫 영문 단어만 추출해 매칭한다.
  const head = raw.toLowerCase().trim().match(/^[a-z]+/)?.[0] ?? '';
  return (KNOWN_DIRECTIVE_STATUSES as ReadonlyArray<string>).includes(head)
    ? (head as DirectiveStatus)
    : 'open';
}

// docs/inbox/README.md §블록 포맷 과 1:1로 대응.
// 의존성 0 원칙: 정규식 기반 파서, 중첩 블록·리스트는 단순 라인 스캔으로 처리.
export function parseDirectiveBlocks(markdown: string, sourcePath: string): DirectiveEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: DirectiveEntry[] = [];

  let current: DirectiveEntry | null = null;
  let field: 'originalPrompt' | 'alphaSolo' | 'handoffs' | null = null;

  const flush = () => {
    if (current) entries.push(current);
    current = null;
    field = null;
  };

  for (const raw of lines) {
    const header = raw.match(/^###\s+\[([^\]]+)\]\s+(.+?)\s*$/);
    if (header) {
      flush();
      current = {
        tick: header[1].trim(),
        digest: header[2].trim(),
        originalPrompt: '',
        handoffs: [],
        alphaSolo: '',
        status: 'open',
        sourcePath,
      };
      continue;
    }

    if (!current) continue;

    const line = raw.trimEnd();
    const fieldMatch = line.match(/^\s*-\s*\*\*(.+?)\*\*\s*:\s*(.*)$/);
    if (fieldMatch) {
      const key = fieldMatch[1].trim();
      const value = fieldMatch[2];
      if (key === '원문 프롬프트') {
        current.originalPrompt = value.replace(/^["']|["']$/g, '').trim();
        field = 'originalPrompt';
      } else if (key === '분해') {
        field = null;
      } else if (key === '위임') {
        for (const p of extractHandoffPaths(value)) current.handoffs.push(p);
        field = 'handoffs';
      } else if (key === '알파 자체 처리분') {
        current.alphaSolo = value.trim();
        field = 'alphaSolo';
      } else if (key === '매트릭스 근거') {
        const basis = value.trim();
        current.matrixBasis = basis;
        const verdict = extractMatrixVerdict(basis);
        if (verdict) current.verdict = verdict;
        field = null;
      } else if (key === '상태') {
        current.status = normalizeDirectiveStatus(value.trim());
        field = null;
      } else {
        field = null;
      }
      continue;
    }

    if (field === 'handoffs') {
      for (const p of extractHandoffPaths(line)) current.handoffs.push(p);
    } else if (field === 'alphaSolo' && line.trim()) {
      current.alphaSolo = current.alphaSolo
        ? `${current.alphaSolo} ${line.trim()}`
        : line.trim();
    }
  }

  flush();
  return entries;
}

function extractHandoffPaths(segment: string): string[] {
  const out = new Set<string>();
  const re = /docs\/handoffs\/[\w.\-/]+\.md/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) out.add(m[0]);
  return Array.from(out);
}

/**
 * `매트릭스 근거` 필드 값에서 ✅/❌ 마커를 탐지해 verdict 로 환원한다.
 * 마커가 두 종류 모두 포함된 경우는 모호하므로 undefined.
 */
function extractMatrixVerdict(raw: string): MatrixVerdict | undefined {
  const hasAllowed = raw.includes('✅');
  const hasForbidden = raw.includes('❌');
  if (hasAllowed && !hasForbidden) return 'allowed';
  if (hasForbidden && !hasAllowed) return 'forbidden';
  return undefined;
}

export interface DirectiveRoutingSummary {
  total: number;
  /** handoffs.length >= 1 인 지시 수. */
  delegated: number;
  /** handoffs.length === 0 인 지시 수. */
  soloOnly: number;
  /** handoffs 없음 + alphaSolo가 "없음"이 아닌 경우. */
  soloWithException: number;
  /** delegated / total, total=0 이면 0. 소수점 그대로. */
  delegationRate: number;
}

/**
 * 지시 라우팅 요약. total=0 이면 delegationRate=0 으로 반환.
 * 호출 측에서 날짜별 필터링/정렬을 먼저 수행한다는 가정.
 */
export function summarizeDirectiveRouting(entries: ReadonlyArray<DirectiveEntry>): DirectiveRoutingSummary {
  const total = entries.length;
  let delegated = 0;
  let soloOnly = 0;
  let soloWithException = 0;

  for (const e of entries) {
    if (e.handoffs.length > 0) {
      delegated += 1;
    } else {
      soloOnly += 1;
      if (e.alphaSolo && e.alphaSolo !== '없음') soloWithException += 1;
    }
  }

  return {
    total,
    delegated,
    soloOnly,
    soloWithException,
    delegationRate: total === 0 ? 0 : delegated / total,
  };
}

/** UI 상단 바용 한 줄 한국어 요약. */
export function describeDirectiveRouting(summary: DirectiveRoutingSummary): string {
  if (summary.total === 0) return '오늘 지시: 없음';
  const pct = (summary.delegationRate * 100).toFixed(1);
  return `오늘 지시 ${summary.total}건 · 위임 ${summary.delegated}건 · 단독(예외) ${summary.soloWithException}건 · 위임률 ${pct}%`;
}

// ---------------------------------------------------------------------------
// 디자이너 슬롯 결원 지표
// ---------------------------------------------------------------------------
// 근거: docs/handoffs/2026-04-17-alpha-to-designer-slot-vacancy.md REPORT
// "workspaceInsights에서 '디자이너 결원 기간' 지표 추가 제안".
// 슬롯 충원 상태와 결원 기간(일수)을 하나의 순수 함수로 계산한다.

export interface DesignerVacancyStatus {
  /** Designer 역할 할당 에이전트 수. */
  totalDesigners: number;
  /** 현재 working 상태인 Designer 수(대행자 제외). */
  activeDesigners: number;
  /** Designer 슬롯이 하나도 없으면 true. */
  isVacant: boolean;
  /** vacancyStartedOn + asOf 가 주어지면 계산된 결원 일수. 슬롯이 채워져 있으면 0. 입력 불충분 시 null. */
  vacancyDays: number | null;
  /** UI/리포트용 한 줄 한국어 요약. */
  summary: string;
}

export interface DesignerVacancyOptions {
  /** 결원 시작일 (ISO `YYYY-MM-DD`). */
  vacancyStartedOn?: string;
  /** 기준일 (ISO `YYYY-MM-DD`). 생략 시 vacancyStartedOn과 동일 처리(=0일). */
  asOf?: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseIsoDate(value: string | undefined): number | null {
  if (!value) return null;
  // ISO `YYYY-MM-DD` 만 허용. 시간대 해석 차이를 피하려고 UTC 고정.
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const ts = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ts) ? ts : null;
}

export function computeDesignerVacancy(
  agents: ReadonlyArray<Pick<Agent, 'role' | 'status'>>,
  options: DesignerVacancyOptions = {},
): DesignerVacancyStatus {
  const designers = agents.filter((a) => a.role === 'Designer');
  const totalDesigners = designers.length;
  const activeDesigners = designers.filter((a) => a.status === 'working').length;
  const isVacant = totalDesigners === 0;

  let vacancyDays: number | null = null;
  if (isVacant) {
    const startTs = parseIsoDate(options.vacancyStartedOn);
    if (startTs !== null) {
      const asOfTs = parseIsoDate(options.asOf) ?? startTs;
      vacancyDays = Math.max(0, Math.floor((asOfTs - startTs) / MS_PER_DAY));
    }
  } else {
    vacancyDays = 0;
  }

  const summary = isVacant
    ? vacancyDays === null
      ? '디자이너 슬롯: 결원 (기간 미상)'
      : `디자이너 슬롯: 결원 ${vacancyDays}일째`
    : `디자이너 슬롯: ${totalDesigners}명 (활동 ${activeDesigners}명)`;

  return { totalDesigners, activeDesigners, isVacant, vacancyDays, summary };
}
