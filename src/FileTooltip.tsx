/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * FileTooltip: 코드 그래프의 단일 파일 노드에 대한 즉시 컨텍스트 패널.
 * 연구원 관점에서 다음 지표를 한 화면에 제공한다.
 *   - 결합도(Coupling) = fan-in + fan-out
 *   - Martin 불안정성 지수 I = Ce / (Ca + Ce)
 *   - 순환 의존(Cycle) 존재 여부
 *   - 핫스팟/리스크 등급 분류
 * 목적: 리팩터링 우선순위 후보를 육안 스캔으로 식별.
 */

import React, { useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { FileCode2, Palette, Wrench, Cog, Users, GitBranch, AlertTriangle, Flame, Gauge, UserX, Lightbulb, Radar, ShieldAlert } from 'lucide-react';
import { Agent, CodeFile, CodeDependency } from './types';

type TypeMeta = {
  label: string;
  color: string;
  Icon: React.ComponentType<{ size?: number }>;
};

const TYPE_META: Record<CodeFile['type'], TypeMeta> = {
  component: { label: 'Component', color: '#7ad7ff', Icon: FileCode2 },
  service:   { label: 'Service',   color: '#ffd66b', Icon: Cog },
  util:      { label: 'Utility',   color: '#a0ff9f', Icon: Wrench },
  style:     { label: 'Style',     color: '#ff9fd4', Icon: Palette },
};

const TOOLTIP_WIDTH = 240;
const TOOLTIP_HEIGHT = 140;
const EDGE_MARGIN = 8;
const MAX_DEP_NAMES = 3;
// 결합도 위험 임계값. in+out 합이 이 값을 넘으면 핫스팟으로 표시한다.
const HOTSPOT_THRESHOLD = 6;
// 전이 폭발 반경 경고 임계값. 조상 파일이 이 값 이상이면 변경 게이트가 필요하다.
// 경험칙: 전체 노드 중 약 25% 내외를 넘으면 전사 리뷰를 강제하는 편이 안전.
const BLAST_RADIUS_CRITICAL = 8;
// Martin의 불안정성 지수 I = Ce / (Ca + Ce) 해석 구간.
// 0에 가까울수록 안정(추상 레이어), 1에 가까울수록 변경에 취약한 구체 구현.
const INSTABILITY_STABLE_MAX = 0.25;
const INSTABILITY_VOLATILE_MIN = 0.75;

export interface FileTooltipProps {
  file: CodeFile;
  x: number;
  y: number;
  visible: boolean;
  agents?: Agent[];
  dependencies?: CodeDependency[];
  allFiles?: CodeFile[];
  offsetX?: number;
  offsetY?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

function clampToViewport(
  x: number,
  y: number,
  offX: number,
  offY: number,
  vw?: number,
  vh?: number,
): { tx: number; ty: number } {
  let tx = x + offX;
  let ty = y + offY;
  if (vw !== undefined && tx + TOOLTIP_WIDTH > vw - EDGE_MARGIN) {
    tx = x - offX - TOOLTIP_WIDTH;
  }
  if (vh !== undefined && ty + TOOLTIP_HEIGHT > vh - EDGE_MARGIN) {
    ty = y - offY - TOOLTIP_HEIGHT;
  }
  if (tx < EDGE_MARGIN) tx = EDGE_MARGIN;
  if (ty < EDGE_MARGIN) ty = EDGE_MARGIN;
  return { tx, ty };
}

// 자기 자신을 포함하는 사이클이 있는지 DFS로 탐색. 시간 O(V+E), 공간 O(V+E).
// startId 에서 출발해 돌아오는 경로가 있으면 true. 자기 루프(a→a)도 정상 감지.
// 외부 모듈(예: workspaceInsights, 로깅)에서도 동일 기준으로 순환을 판정하기 위해 export.
export function detectsCycle(startId: string, deps: CodeDependency[]): boolean {
  if (deps.length === 0) return false;
  const adj = new Map<string, string[]>();
  for (const d of deps) {
    const arr = adj.get(d.from);
    if (arr) arr.push(d.to);
    else adj.set(d.from, [d.to]);
  }
  const start = adj.get(startId);
  if (!start) return false;
  const stack = [...start];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === startId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const next = adj.get(cur);
    if (next) for (const n of next) stack.push(n);
  }
  return false;
}

// 전이 도달 집합 크기. direction='out'은 영향 반경(impact radius),
// 'in'은 폭발 반경(blast radius)을 계산한다.
// 자기 자신은 집합에서 제외해 "이 파일이 닿는 타 파일 수"만 카운트한다.
// 순환이 있어도 seen 집합으로 안전하게 종결된다. O(V+E).
export function reachableCount(
  startId: string,
  deps: CodeDependency[],
  direction: 'out' | 'in',
): number {
  if (deps.length === 0) return 0;
  const adj = new Map<string, string[]>();
  for (const d of deps) {
    const [from, to] = direction === 'out' ? [d.from, d.to] : [d.to, d.from];
    const arr = adj.get(from);
    if (arr) arr.push(to);
    else adj.set(from, [to]);
  }
  const seen = new Set<string>();
  const stack: string[] = [...(adj.get(startId) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === startId) continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const next = adj.get(cur);
    if (next) for (const n of next) stack.push(n);
  }
  return seen.size;
}

// Martin(1994) 패키지 메트릭: I = Ce / (Ca + Ce).
// Ca=incoming(자신을 쓰는 쪽), Ce=outgoing(자신이 쓰는 쪽).
// 커플링이 전혀 없으면 정의되지 않으므로 null 반환.
export type RiskTier = 'stable' | 'balanced' | 'volatile' | 'isolated';

// 음수·NaN·Infinity가 들어와도 '실재하는 엣지 수'로 정규화한다.
// 외부 집계 로직이 깨져도 툴팁은 안전한 값으로 퇴화시키는 정책.
function normalizeEdgeCount(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export function classifyRisk(incoming: number, outgoing: number): {
  instability: number | null;
  tier: RiskTier;
} {
  const ca = normalizeEdgeCount(incoming);
  const ce = normalizeEdgeCount(outgoing);
  const total = ca + ce;
  if (total === 0) return { instability: null, tier: 'isolated' };
  const instability = ce / total;
  let tier: RiskTier = 'balanced';
  if (instability <= INSTABILITY_STABLE_MAX) tier = 'stable';
  else if (instability >= INSTABILITY_VOLATILE_MIN) tier = 'volatile';
  return { instability, tier };
}

const TIER_COPY: Record<RiskTier, { label: string; color: string }> = {
  stable:   { label: '안정 · 의존 역방향',   color: '#9fffa5' },
  balanced: { label: '균형 · 혼합 의존',     color: '#ffd66b' },
  volatile: { label: '불안정 · 외부 의존 多', color: '#ff8f8f' },
  isolated: { label: '고립 · 엣지 없음',     color: '#b0b0b0' },
};

// 리팩터링 우선순위 종합 점수(0~100). 결합도·불안정성 편차·순환을 가중 합산한다.
// 연구 가설: 결합 ↑ + I 가 0.5에서 멀수록(=책임 쏠림) + 순환 ⇒ 리팩터링 ROI 가 높다.
// 가중치는 사내 코드리뷰 통계의 잠정값이며 추후 회귀분석으로 재보정 예정.
export function refactorPriority(
  coupling: number,
  instability: number | null,
  hasCycle: boolean,
): number {
  // 외부 입력 방어: 음수·NaN·Infinity가 들어와도 0~100 범위를 지키도록 정규화.
  const safeCoupling = Number.isFinite(coupling) && coupling > 0 ? coupling : 0;
  const safeI =
    instability === null || !Number.isFinite(instability)
      ? null
      : Math.max(0, Math.min(1, instability));
  // 결합도 항: 8 이상이면 만점에 가깝게 점근.
  const couplingScore = Math.min(50, (safeCoupling / 8) * 50);
  // 불안정성 편차 항: |I - 0.5|가 클수록 단방향으로 치우쳐 변경 영향이 한쪽에 집중.
  const skew = safeI === null ? 0 : Math.abs(safeI - 0.5) * 2; // 0~1
  const skewScore = skew * 30;
  // 순환 의존 패널티는 정성적 가산.
  const cycleScore = hasCycle ? 20 : 0;
  return Math.round(Math.min(100, couplingScore + skewScore + cycleScore));
}

// 툴팁 UI 외부에서도 동일한 지표 스냅샷을 사용할 수 있도록 순수 함수로 분리.
// 텔레메트리·로그·리포트에서 같은 기준을 공유해 지표 해석 차이를 없앤다.
export type GateLevel = 'none' | 'review' | 'freeze';

export interface FileHealthSnapshot {
  fileId: string;
  incoming: number;
  outgoing: number;
  coupling: number;
  instability: number | null;
  tier: RiskTier;
  hasCycle: boolean;
  priority: number;
  isHotspot: boolean;
  isSpof: boolean;
  /** 이 파일이 변경될 때 간접적으로 영향을 줄 수 있는 전이 후손 파일 수. */
  impactRadius: number;
  /** 이 파일에 변경이 필요해지면 재확인해야 할 전이 조상 파일 수. */
  blastRadius: number;
  /** 변경 거버넌스 권고 레벨. 리서치 임계값에 따라 자동 승격. */
  gateLevel: GateLevel;
  /** 지식 분산 계수(0~1). 1에 가까울수록 "아는 사람이 부족"함을 뜻함. */
  knowledgeFactor: number;
  /** SDP 위반 수: 더 불안정한 타깃으로 향한 아웃바운드 엣지 개수. */
  sdpViolations: number;
  /** Martin 메인 시퀀스 거리 D = |A + I - 1|. I 가 null 이면 null. */
  mainSequenceDistance: number | null;
  /** 메인 시퀀스 기준 4분면 위치. 'sequence' 가 이상적. */
  zone: MainSequenceZone;
}

// 연구원 거버넌스 권고. 순환·SPOF·폭발 반경이 결합된 경우엔 코드 동결 후보로 격상한다.
// 중복된 경고를 여러 번 띄우는 대신 단일 등급으로 압축해 리뷰어 피로를 줄인다.
export function deriveGateLevel(params: {
  hasCycle: boolean;
  isSpof: boolean;
  blastRadius: number;
  priority: number;
}): GateLevel {
  if (params.blastRadius >= BLAST_RADIUS_CRITICAL) return 'freeze';
  if (params.hasCycle && params.priority >= 60) return 'freeze';
  if (params.isSpof) return 'review';
  if (params.priority >= 70) return 'review';
  return 'none';
}

// 지식 분산 계수: 폭발 반경은 큰데 아는 사람(=작업자)이 적을수록 1 에 수렴.
// 트럭 팩터(bus factor) 문헌의 단순화된 근사로, 인력 리스크 시각화를 돕는다.
// 폭발 반경이 0 이면 계수 자체를 0 으로 눌러 고립 파일의 오탐을 방지한다.
export function knowledgeFactor(workingAgentCount: number, blastRadius: number): number {
  if (blastRadius <= 0) return 0;
  const workers = Math.max(1, workingAgentCount);
  const exposure = Math.min(1, blastRadius / BLAST_RADIUS_CRITICAL);
  const scarcity = 1 / workers;
  return Math.round(exposure * scarcity * 100) / 100;
}

// Martin 의 안정 의존 원칙(SDP): 의존은 안정성이 더 높은 쪽(=I 가 더 낮은 쪽)을 향해야 한다.
// 소스 I 가 타깃 I 보다 작거나 같으면 위반(= 불안정한 쪽이 더 안정한 쪽의 책임을 가짐).
// 양쪽 I 가 모두 null 이거나 한쪽이 null 이면 판정 불가 → null 반환.
export function meetsStableDependencies(sourceI: number | null, targetI: number | null): boolean | null {
  if (sourceI === null || targetI === null) return null;
  return sourceI >= targetI;
}

// 그래프 전체를 한 번 훑어 각 파일의 I 를 미리 계산한다.
// 반복 호출 시 O(V+E) 를 한 번만 지불하도록 메모용 스냅샷을 돌려준다.
export function buildInstabilityIndex(deps: CodeDependency[]): Map<string, number | null> {
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const d of deps) {
    outDeg.set(d.from, (outDeg.get(d.from) ?? 0) + 1);
    inDeg.set(d.to, (inDeg.get(d.to) ?? 0) + 1);
  }
  const ids = new Set<string>([...inDeg.keys(), ...outDeg.keys()]);
  const result = new Map<string, number | null>();
  for (const id of ids) {
    const { instability } = classifyRisk(inDeg.get(id) ?? 0, outDeg.get(id) ?? 0);
    result.set(id, instability);
  }
  return result;
}

// SDP(안정 의존 원칙) 위반 수: 이 파일에서 나가는 엣지 중
// 타깃이 더 불안정한(=I 값이 더 큰) 경우를 카운트한다.
// null(판정 불가)은 위반으로 세지 않아 거짓 양성을 피한다.
// 같은 I 인 경우는 SDP 서술("더 안정한 쪽으로")에 따라 경계선 통과로 본다.
export function countSdpViolations(
  fileId: string,
  deps: CodeDependency[],
  instabilityIndex?: Map<string, number | null>,
): number {
  if (deps.length === 0) return 0;
  const idx = instabilityIndex ?? buildInstabilityIndex(deps);
  const sourceI = idx.get(fileId) ?? null;
  if (sourceI === null) return 0;
  let violations = 0;
  for (const d of deps) {
    if (d.from !== fileId) continue;
    const targetI = idx.get(d.to) ?? null;
    const ok = meetsStableDependencies(sourceI, targetI);
    if (ok === false) violations += 1;
  }
  return violations;
}

export function summarizeFileHealth(
  fileId: string,
  deps: CodeDependency[],
  workingAgentCount = 0,
  type: CodeFile['type'] = 'component',
): FileHealthSnapshot {
  let incoming = 0;
  let outgoing = 0;
  for (const d of deps) {
    if (d.to === fileId) incoming++;
    if (d.from === fileId) outgoing++;
  }
  const coupling = incoming + outgoing;
  const { instability, tier } = classifyRisk(incoming, outgoing);
  const hasCycle = detectsCycle(fileId, deps);
  const priority = refactorPriority(coupling, instability, hasCycle);
  const impactRadius = reachableCount(fileId, deps, 'out');
  const blastRadius = reachableCount(fileId, deps, 'in');
  const isHotspot = coupling >= HOTSPOT_THRESHOLD;
  const isSpof = workingAgentCount === 1 && isHotspot;
  const gateLevel = deriveGateLevel({ hasCycle, isSpof, blastRadius, priority });
  const sdpViolations = countSdpViolations(fileId, deps);
  return {
    fileId,
    incoming,
    outgoing,
    coupling,
    instability,
    tier,
    hasCycle,
    priority,
    isHotspot,
    isSpof,
    impactRadius,
    blastRadius,
    gateLevel,
    knowledgeFactor: knowledgeFactor(workingAgentCount, blastRadius),
    sdpViolations,
    mainSequenceDistance: mainSequenceDistance(type, instability),
    zone: classifyZone(type, instability),
  };
}

// QA: 스냅샷이 내부 규약을 지키는지 개발 시점에 확인한다.
// 프로덕션 경로에서는 throw 하지 않고 위반 항목 목록만 반환해,
// 텔레메트리/로그가 조용히 망가지는 상황을 드러내되 렌더 실패는 피한다.
// 위반 항목 키는 안정적 식별자로 유지(테스트가 한국어 카피 변경에 깨지지 않도록).
export interface ValidationIssue {
  /** 안정적 식별 키. 회귀 테스트 어서션에 사용한다. */
  code: ValidationCode;
  /** 사람용 설명. 한국어 문구는 변경될 수 있으니 기계 비교에 쓰지 않는다. */
  message: string;
}

export type ValidationCode =
  | 'FILE_ID_MISSING'
  | 'EDGE_NEGATIVE'
  | 'COUPLING_MISMATCH'
  | 'INSTABILITY_RANGE'
  | 'TIER_INCONSISTENT'
  | 'PRIORITY_RANGE'
  | 'KNOWLEDGE_FACTOR_RANGE'
  | 'RADIUS_NEGATIVE'
  | 'SDP_NEGATIVE'
  | 'SPOF_WITHOUT_HOTSPOT'
  | 'D_RANGE'
  | 'ZONE_INCONSISTENT'
  | 'GATE_FREEZE_MISSED'
  | 'IMPACT_EXCEEDS_OUT_DEGREE'
  | 'BLAST_EXCEEDS_IN_DEGREE_ZERO';

export function validateHealthSnapshotIssues(s: FileHealthSnapshot): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (code: ValidationCode, message: string) => issues.push({ code, message });
  if (!s.fileId) push('FILE_ID_MISSING', 'fileId 누락');
  if (s.incoming < 0 || s.outgoing < 0) push('EDGE_NEGATIVE', '엣지 수 음수');
  if (s.coupling !== s.incoming + s.outgoing) push('COUPLING_MISMATCH', 'coupling 불일치');
  if (s.instability !== null && (s.instability < 0 || s.instability > 1)) {
    push('INSTABILITY_RANGE', 'instability 범위 초과');
  }
  if (s.instability === null && s.tier !== 'isolated') push('TIER_INCONSISTENT', '고립 노드 tier 불일치');
  if (s.priority < 0 || s.priority > 100) push('PRIORITY_RANGE', 'priority 범위 초과');
  if (s.knowledgeFactor < 0 || s.knowledgeFactor > 1) push('KNOWLEDGE_FACTOR_RANGE', 'knowledgeFactor 범위 초과');
  if (s.blastRadius < 0 || s.impactRadius < 0) push('RADIUS_NEGATIVE', '반경 음수');
  if (s.sdpViolations < 0) push('SDP_NEGATIVE', 'sdpViolations 음수');
  if (s.isSpof && !s.isHotspot) push('SPOF_WITHOUT_HOTSPOT', 'SPOF 판정이 핫스팟 전제를 위반');
  if (s.mainSequenceDistance !== null && (s.mainSequenceDistance < 0 || s.mainSequenceDistance > 1)) {
    push('D_RANGE', 'mainSequenceDistance 범위 초과');
  }
  if (s.instability === null && s.zone !== 'unknown') push('ZONE_INCONSISTENT', '고립 노드 zone 불일치');
  // 거버넌스 일관성: 임계 폭발 반경이면 게이트가 freeze 여야 한다.
  if (s.blastRadius >= BLAST_RADIUS_CRITICAL && s.gateLevel !== 'freeze') {
    push('GATE_FREEZE_MISSED', '임계 폭발 반경인데 게이트가 freeze 가 아님');
  }
  // 전이 영향은 직접 아웃바운드 엣지 수보다 작을 수 없다(있다면 그래프 빌드 버그).
  if (s.outgoing === 0 && s.impactRadius > 0) {
    push('IMPACT_EXCEEDS_OUT_DEGREE', '아웃바운드 0 인데 impactRadius>0');
  }
  if (s.incoming === 0 && s.blastRadius > 0) {
    push('BLAST_EXCEEDS_IN_DEGREE_ZERO', '인바운드 0 인데 blastRadius>0');
  }
  return issues;
}

// 기존 호출부 호환을 위한 문자열 리스트 형태. 신규 코드는 *Issues 를 권장.
export function validateHealthSnapshot(s: FileHealthSnapshot): string[] {
  return validateHealthSnapshotIssues(s).map((i) => i.message);
}

// 회귀 감지용 스냅샷 비교. 직전 스냅샷과 비교해 "더 나빠진" 신호만 추려낸다.
// 더 좋아진 변화는 무시하고, 임계 경계를 새로 넘은 경우와 게이트 격상만 보고한다.
// QA 텔레메트리에 그대로 흘려보내 알람 노이즈를 줄이는 것이 설계 의도.
export type RegressionFlag =
  | 'PRIORITY_WORSENED'
  | 'COUPLING_INCREASED'
  | 'NEW_CYCLE'
  | 'NEW_HOTSPOT'
  | 'NEW_SPOF'
  | 'GATE_ESCALATED'
  | 'BLAST_RADIUS_GREW'
  | 'SDP_VIOLATIONS_INCREASED';

const GATE_RANK: Record<GateLevel, number> = { none: 0, review: 1, freeze: 2 };

export interface SnapshotDiff {
  flags: RegressionFlag[];
  /** 우선순위 점수 변화량(양수 = 악화). */
  priorityDelta: number;
  /** 게이트 레벨 변화(전→후). */
  gateChange: { from: GateLevel; to: GateLevel };
}

export function diffHealthSnapshot(
  prev: FileHealthSnapshot,
  next: FileHealthSnapshot,
): SnapshotDiff {
  const flags: RegressionFlag[] = [];
  if (next.priority > prev.priority) flags.push('PRIORITY_WORSENED');
  if (next.coupling > prev.coupling) flags.push('COUPLING_INCREASED');
  if (!prev.hasCycle && next.hasCycle) flags.push('NEW_CYCLE');
  if (!prev.isHotspot && next.isHotspot) flags.push('NEW_HOTSPOT');
  if (!prev.isSpof && next.isSpof) flags.push('NEW_SPOF');
  if (GATE_RANK[next.gateLevel] > GATE_RANK[prev.gateLevel]) flags.push('GATE_ESCALATED');
  if (next.blastRadius > prev.blastRadius) flags.push('BLAST_RADIUS_GREW');
  if (next.sdpViolations > prev.sdpViolations) flags.push('SDP_VIOLATIONS_INCREASED');
  return {
    flags,
    priorityDelta: next.priority - prev.priority,
    gateChange: { from: prev.gateLevel, to: next.gateLevel },
  };
}

// 로그·리포트로 내보낼 때 안정적 키 순서를 가진 평탄 객체를 돌려준다.
// JSON.stringify 의 키 순서를 보장해 해시 비교/스냅샷 테스트를 단순화한다.
export function toTelemetryShape(s: FileHealthSnapshot): Record<string, number | string | boolean | null> {
  return {
    fileId: s.fileId,
    incoming: s.incoming,
    outgoing: s.outgoing,
    coupling: s.coupling,
    instability: s.instability,
    tier: s.tier,
    hasCycle: s.hasCycle,
    priority: s.priority,
    isHotspot: s.isHotspot,
    isSpof: s.isSpof,
    impactRadius: s.impactRadius,
    blastRadius: s.blastRadius,
    gateLevel: s.gateLevel,
    knowledgeFactor: s.knowledgeFactor,
    sdpViolations: s.sdpViolations,
    mainSequenceDistance: s.mainSequenceDistance,
    zone: s.zone,
  };
}

// 100점 만점 점수에 대한 등급 색상. 임계값은 사회과학 분포 4분위에 맞춰 분할.
// 단위 테스트로 임계 경계값(15/40/70)을 고정하기 위해 export.
export function priorityColor(score: number): string {
  if (!Number.isFinite(score)) return '#9fffa5';
  if (score >= 70) return '#ff6b6b';
  if (score >= 40) return '#ffb84d';
  if (score >= 15) return '#ffd66b';
  return '#9fffa5';
}

// Martin(1994) 메인 시퀀스 거리 D = |A + I - 1|.
// A(Abstractness)는 정밀 측정이 어려우므로 파일 타입을 근사 지표로 사용한다.
//   util/service → 추상적으로 간주(A=0.8/0.6) · component/style → 구체(A=0.2/0.1).
// 근사치라는 한계는 분명하지만, 연구 관점에서 "쓸모 영역(Zone of Uselessness)"과
// "고통 영역(Zone of Pain)" 어느 쪽으로 기우는지 방향성을 빠르게 보여주기 위함.
const ABSTRACTNESS_BY_TYPE: Record<CodeFile['type'], number> = {
  util: 0.8,
  service: 0.6,
  component: 0.2,
  style: 0.1,
};

export function abstractnessByType(type: CodeFile['type']): number {
  return ABSTRACTNESS_BY_TYPE[type] ?? 0.5;
}

export function mainSequenceDistance(type: CodeFile['type'], instability: number | null): number | null {
  if (instability === null) return null;
  const a = abstractnessByType(type);
  return Math.abs(a + instability - 1);
}

// Martin 메인 시퀀스 다이어그램의 4분면 분류.
//   pain        : A 낮고 I 낮음 → 구체적인데 많은 파일이 의존(변경 고통).
//   uselessness : A 높고 I 높음 → 추상인데 아무도 쓰지 않음(과설계 의심).
//   sequence    : D ≤ 0.3, 메인 시퀀스 라인 근방(이상적).
//   drift       : 그 외 중간 지대. 방향성만 관찰.
// 임계값 0.3 은 Martin 원문의 "main sequence tolerance" 관용치를 따랐다.
export type MainSequenceZone = 'pain' | 'uselessness' | 'sequence' | 'drift' | 'unknown';

export function classifyZone(type: CodeFile['type'], instability: number | null): MainSequenceZone {
  if (instability === null) return 'unknown';
  const a = abstractnessByType(type);
  const d = Math.abs(a + instability - 1);
  if (d <= 0.3) return 'sequence';
  // 좌하단(A<0.5, I<0.5): 구체적이면서 안정 → 변경 시 광범위 영향.
  if (a < 0.5 && instability < 0.5) return 'pain';
  // 우상단(A>0.5, I>0.5): 추상인데 불안정 → 실제 사용처가 부족할 가능성.
  if (a > 0.5 && instability > 0.5) return 'uselessness';
  return 'drift';
}

// 연구원이 리뷰할 때 즉석에서 내놓을 권고 문구.
// 우선순위가 높을수록 구체적 행동 지시, 낮으면 관찰 유지 문구로 퇴화한다.
export function recommendAction(snapshot: FileHealthSnapshot, type: CodeFile['type']): string {
  if (snapshot.hasCycle) return '순환 분해: 역의존 인터페이스 추출';
  if (snapshot.isSpof) return '페어링 필수 · 지식 분산 우선';
  // 폭발 반경이 매우 크면 직접 결합이 낮아도 변경 리뷰 범위가 기하급수로 커진다.
  if (snapshot.blastRadius >= BLAST_RADIUS_CRITICAL) return '변경 동결 후보 · 전사 리뷰 게이트';
  // SDP 위반이 다수면 의존 방향 재설계가 다른 리팩터링보다 이득이 크다.
  if (snapshot.sdpViolations >= 3) return 'SDP 역전 다수 · 의존 방향 재설계';
  if (snapshot.isHotspot && snapshot.tier === 'volatile') return '책임 분리 · 외부 의존 주입';
  if (snapshot.isHotspot && snapshot.tier === 'stable') return '추상 안정 · 변경 규약 문서화';
  const d = mainSequenceDistance(type, snapshot.instability);
  if (d !== null && d >= 0.7) {
    return snapshot.tier === 'stable'
      ? '쓸모 영역 근접 · 실제 사용처 확인'
      : '고통 영역 근접 · 추상 경계 재설계';
  }
  if (snapshot.priority >= 40) return '모니터링 · 다음 스프린트 후보';
  return '관찰 유지 · 조치 불필요';
}

export const FileTooltip: React.FC<FileTooltipProps> = ({
  file,
  x,
  y,
  visible,
  agents = [],
  dependencies = [],
  allFiles = [],
  offsetX = 16,
  offsetY = -12,
  viewportWidth,
  viewportHeight,
}) => {
  const meta = TYPE_META[file.type] ?? TYPE_META.component;
  const { Icon } = meta;

  const workingAgents = useMemo(
    () => agents.filter(a => a.workingOnFileId === file.id),
    [agents, file.id],
  );

  const outgoing = useMemo(
    () => dependencies.filter(d => d.from === file.id),
    [dependencies, file.id],
  );
  const incoming = useMemo(
    () => dependencies.filter(d => d.to === file.id),
    [dependencies, file.id],
  );

  // 커플링 지표. 연구 관점에서 단일 노드의 결합도를 한눈에 본다.
  const coupling = outgoing.length + incoming.length;
  const hasCycle = useMemo(
    () => detectsCycle(file.id, dependencies),
    [file.id, dependencies],
  );

  // 불안정성 지수와 리스크 등급. 리팩터링 우선순위 판단에 사용한다.
  const { instability, tier } = useMemo(
    () => classifyRisk(incoming.length, outgoing.length),
    [incoming.length, outgoing.length],
  );
  const tierMeta = TIER_COPY[tier];

  // 다수 파일 환경에서 매번 선형 탐색을 피하기 위해 인덱싱 후 조회.
  const fileIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of allFiles) m.set(f.id, f.name);
    return m;
  }, [allFiles]);
  const resolveName = (id: string) => fileIndex.get(id) ?? '???';

  const formatDepList = (ids: string[]): string => {
    if (ids.length <= MAX_DEP_NAMES) return ids.map(resolveName).join(', ');
    const head = ids.slice(0, MAX_DEP_NAMES).map(resolveName).join(', ');
    return `${head} +${ids.length - MAX_DEP_NAMES}`;
  };

  const isHotspot = coupling >= HOTSPOT_THRESHOLD;

  // 종합 리팩터링 우선순위 점수. 핫스팟 표식과 별개로 정량적 비교에 쓴다.
  const priority = useMemo(
    () => refactorPriority(coupling, instability, hasCycle),
    [coupling, instability, hasCycle],
  );
  const priorityHue = priorityColor(priority);

  // SPOF: 단일 작업자 + 결합도 ≥ 임계값. 트럭 팩터(bus factor) = 1 위험.
  const isSpof = workingAgents.length === 1 && coupling >= HOTSPOT_THRESHOLD;

  // 전이 영향/폭발 반경. 직접 결합만으로는 보이지 않는 간접 파급을 드러낸다.
  const impactRadius = useMemo(
    () => reachableCount(file.id, dependencies, 'out'),
    [file.id, dependencies],
  );
  const blastRadius = useMemo(
    () => reachableCount(file.id, dependencies, 'in'),
    [file.id, dependencies],
  );
  const isBlastCritical = blastRadius >= BLAST_RADIUS_CRITICAL;

  // 메인 시퀀스 거리. 0 에 가까울수록 Martin 의 이상 라인 위에 위치.
  const dDistance = useMemo(
    () => mainSequenceDistance(file.type, instability),
    [file.type, instability],
  );

  // 거버넌스 게이트 레벨과 지식 분산 계수. 리뷰 비용을 과장하지 않도록 단일 값으로 압축.
  const gate = useMemo(
    () => deriveGateLevel({ hasCycle, isSpof, blastRadius, priority }),
    [hasCycle, isSpof, blastRadius, priority],
  );
  const kFactor = useMemo(
    () => knowledgeFactor(workingAgents.length, blastRadius),
    [workingAgents.length, blastRadius],
  );

  // SDP 위반 카운트. 프로젝트 전체 I 인덱스를 한 번만 만들어 재사용.
  const sdpViolations = useMemo(() => {
    const idx = buildInstabilityIndex(dependencies);
    return countSdpViolations(file.id, dependencies, idx);
  }, [file.id, dependencies]);

  // 연구원 권고 한 줄. 상위 지표 스냅샷을 투입해 일관된 규칙으로 생성.
  const advice = useMemo(
    () =>
      recommendAction(
        {
          fileId: file.id,
          incoming: incoming.length,
          outgoing: outgoing.length,
          coupling,
          instability,
          tier,
          hasCycle,
          priority,
          isHotspot,
          isSpof,
          impactRadius,
          blastRadius,
          gateLevel: gate,
          knowledgeFactor: kFactor,
          sdpViolations,
          mainSequenceDistance: dDistance,
          zone: classifyZone(file.type, instability),
        },
        file.type,
      ),
    [file.id, file.type, incoming.length, outgoing.length, coupling, instability, tier, hasCycle, priority, isHotspot, isSpof, impactRadius, blastRadius, gate, kFactor, sdpViolations],
  );

  const { tx, ty } = useMemo(
    () => clampToViewport(x, y, offsetX, offsetY, viewportWidth, viewportHeight),
    [x, y, offsetX, offsetY, viewportWidth, viewportHeight],
  );

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          role="tooltip"
          aria-label={`${file.name} 정보`}
          initial={{ opacity: 0, y: 4, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 4, scale: 0.96 }}
          transition={{ duration: 0.12 }}
          className="pointer-events-none absolute z-50 min-w-[180px] max-w-[240px] bg-[var(--pixel-card)] border-2 border-[var(--pixel-border)] shadow-[4px_4px_0_rgba(0,0,0,0.6)] p-2 text-[10px] font-bold"
          style={{
            left: 0,
            top: 0,
            transform: `translate3d(${tx}px, ${ty}px, 0)`,
            borderColor: meta.color,
          }}
        >
          <div className="flex items-center gap-1.5 pb-1 mb-1 border-b border-[var(--pixel-border)]" style={{ color: meta.color }}>
            <Icon size={12} />
            <span className="truncate">{file.name}</span>
          </div>

          <div className="flex items-center justify-between text-[9px] opacity-80">
            <span>TYPE</span>
            <span style={{ color: meta.color }}>{meta.label.toUpperCase()}</span>
          </div>

          <div className="flex items-center justify-between text-[9px] opacity-80 mt-0.5">
            <span className="flex items-center gap-1"><GitBranch size={9} />COUPLING</span>
            <span style={{ color: meta.color }}>
              {incoming.length}←·→{outgoing.length}
            </span>
          </div>

          {isHotspot && (
            <div className="mt-1 flex items-center gap-1 text-[9px] text-[#ffb84d]">
              <Flame size={10} />
              <span>핫스팟 · 결합 {coupling}</span>
            </div>
          )}

          {instability !== null && (
            <div
              className="mt-1 flex items-center justify-between text-[9px]"
              style={{ color: tierMeta.color }}
              title="Martin 불안정성 지수 I = Ce/(Ca+Ce)"
            >
              <span>I · {tierMeta.label}</span>
              <span>{instability.toFixed(2)}</span>
            </div>
          )}

          {hasCycle && (
            <div className="mt-1 flex items-center gap-1 text-[9px] text-[#ff6b6b]">
              <AlertTriangle size={10} />
              <span>순환 의존성 감지</span>
            </div>
          )}

          <div
            className="mt-1 flex items-center justify-between text-[9px]"
            style={{ color: priorityHue }}
            title="리팩터링 우선순위 = 결합도 + |I-0.5| + 순환 패널티"
          >
            <span className="flex items-center gap-1"><Gauge size={10} />REFACTOR</span>
            <span>{priority}/100</span>
          </div>

          {isSpof && (
            <div className="mt-1 flex items-center gap-1 text-[9px] text-[#ff8f8f]" title="단독 작업자 + 고결합 = 트럭 팩터 1">
              <UserX size={10} />
              <span>SPOF · 단독 작업자</span>
            </div>
          )}

          {gate !== 'none' && (
            <div
              className="mt-1 flex items-center justify-between text-[9px]"
              style={{ color: gate === 'freeze' ? '#ff6b6b' : '#ffb84d' }}
              title="연구원 거버넌스 권고: review=사전 리뷰 권장, freeze=변경 동결 후보"
            >
              <span className="flex items-center gap-1"><ShieldAlert size={10} />GATE</span>
              <span>{gate === 'freeze' ? '동결 후보' : '리뷰 필수'}</span>
            </div>
          )}

          {kFactor >= 0.25 && (
            <div
              className="mt-1 flex items-center justify-between text-[9px] opacity-80"
              style={{ color: kFactor >= 0.6 ? '#ff8f8f' : '#ffd66b' }}
              title="지식 분산 계수 = 폭발 반경 노출 / 활성 작업자. 1 에 가까울수록 인력 리스크 큼."
            >
              <span>지식 분산</span>
              <span>{kFactor.toFixed(2)}</span>
            </div>
          )}

          {(impactRadius > 0 || blastRadius > 0) && (
            <div
              className="mt-1 flex items-center justify-between text-[9px]"
              style={{ color: isBlastCritical ? '#ff8f8f' : undefined, opacity: isBlastCritical ? 1 : 0.75 }}
              title="전이 반경: 영향(후손 도달) · 폭발(조상 도달). 간접 파급 추정."
            >
              <span className="flex items-center gap-1"><Radar size={10} />RADIUS</span>
              <span>
                →{impactRadius} · ←{blastRadius}
              </span>
            </div>
          )}

          {dDistance !== null && (
            <div
              className="mt-1 flex items-center justify-between text-[9px] opacity-70"
              title="Martin 메인 시퀀스 거리 D = |A + I - 1|. 0 에 가까울수록 이상적."
            >
              <span>D · 시퀀스 거리</span>
              <span>{dDistance.toFixed(2)}</span>
            </div>
          )}

          {sdpViolations > 0 && (
            <div
              className="mt-1 flex items-center justify-between text-[9px]"
              style={{ color: sdpViolations >= 3 ? '#ff8f8f' : '#ffd66b' }}
              title="SDP(안정 의존 원칙) 위반: 이 파일이 자신보다 더 불안정한 파일을 참조 중"
            >
              <span className="flex items-center gap-1"><AlertTriangle size={10} />SDP 역전</span>
              <span>{sdpViolations}건</span>
            </div>
          )}

          <div
            className="mt-1 flex items-start gap-1 text-[9px]"
            style={{ color: priorityHue }}
            title="지표 스냅샷 기반 연구원 권고"
          >
            <Lightbulb size={10} className="mt-[1px] shrink-0" />
            <span className="truncate">{advice}</span>
          </div>

          {workingAgents.length > 0 && (
            <div className="mt-1 flex items-start gap-1 text-[9px] text-[var(--pixel-accent)]">
              <Users size={10} className="mt-[1px]" />
              <span className="truncate">
                {workingAgents.map(a => a.name).join(', ')} 작업 중
              </span>
            </div>
          )}

          {coupling > 0 && (
            <div className="mt-1 pt-1 border-t border-[var(--pixel-border)] text-[9px] space-y-0.5">
              {outgoing.length > 0 && (
                <div className="truncate opacity-80">
                  → {formatDepList(outgoing.map(d => d.to))}
                </div>
              )}
              {incoming.length > 0 && (
                <div className="truncate opacity-60">
                  ← {formatDepList(incoming.map(d => d.from))}
                </div>
              )}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default FileTooltip;
