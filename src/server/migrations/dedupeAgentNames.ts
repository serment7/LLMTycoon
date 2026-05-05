// 인앱 마이그레이션 — agentsCol 의 이름 중복을 기동 시점에 1회 정리한다.
//
// 배경: `/api/agents/hire` 가 이름 유일성 검사를 시작하기 전(2026-05-05 이전) 에 생성된
// 에이전트들 중에는 동일 이름이 둘 이상 존재하는 케이스가 있다(특히 추천 카드의
// 휴리스틱 별칭 "Kai/Dev/QA/Dex/Riz" 가 여러 프로젝트에 hire 되며 누적). 새로 들어오는
// hire 는 서버 측 `uniqueAgentName` 가드가 막지만, 이미 DB 에 누적된 충돌은 사용자가
// 게임 화면에서 식별 불가능하게 섞여 보이므로 서버 기동 시 한 번 일괄 리네이밍한다.
//
// 정책:
//   · 같은 이름 그룹에서 첫 번째(컬렉션 스캔 순서) 에이전트는 보존.
//   · 두 번째부터 `${name}2`, `${name}3` ... 식으로 비충돌 접미사 부여(uniqueAgentName 재사용).
//   · 멱등 — 두 번 돌려도 추가 변경 없음(첫 실행 후에는 중복 그룹이 사라지기 때문).
//
// 구조: 순수 플래너(`planAgentNameDedup`) + 얇은 어댑터(`applyAgentNameDedup`).
// 플래너는 Mongo 의존이 없어 단위 테스트가 깔끔하고, 어댑터는 실제 Collection 의
// find/updateOne 만 호출한다. 두 단계가 분리되어 있어 어떤 cursor 타입을 쓰든 어댑터
// 내부에서만 결정된다.

import { uniqueAgentName, findDuplicateNameGroups } from '../../utils/agentNameDedup';

export interface AgentDocLike {
  readonly id: string;
  readonly name: string;
}

export interface AgentNameRename {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

export interface DedupeMigrationPlan {
  /** 스캔한 에이전트 총 수. */
  readonly scanned: number;
  /** 중복 그룹 수(그룹 내 인원수가 2 이상인 이름 종류 수). */
  readonly duplicateGroups: number;
  /** 실제로 리네이밍이 필요한 항목들. */
  readonly renames: readonly AgentNameRename[];
}

/**
 * 이름 중복 정리 계획을 산출. I/O 없음 — 입력 배열만 본다.
 *
 * 알고리즘:
 *   1) 빠른 조기 종료: 중복 그룹이 0 이면 빈 plan 반환.
 *   2) `taken` 셋에 모든 기존 이름을 미리 적재해 신규 접미사가 그것과도 충돌하지 않게 한다.
 *      예: ["Dev","Dev","Dev2"] 가 들어오면 두 번째 "Dev" 를 "Dev3" 로(이미 "Dev2" 가 있으므로) 부여.
 *   3) 같은 이름의 첫 출현은 보존, 두 번째부터 `uniqueAgentName(taken, name)` 적용.
 *      taken 셋은 본 실행에서 부여한 신규 이름까지 누적해 같은 호출 안에서 두 명에게
 *      같은 새 이름을 주는 사고를 차단한다.
 */
export function planAgentNameDedup(
  all: readonly AgentDocLike[],
): DedupeMigrationPlan {
  const groups = findDuplicateNameGroups(all);
  if (groups.length === 0) {
    return { scanned: all.length, duplicateGroups: 0, renames: [] };
  }
  const taken = new Set<string>(all.map(a => a.name));
  const seen = new Set<string>();
  const renames: AgentNameRename[] = [];
  for (const a of all) {
    if (!seen.has(a.name)) {
      seen.add(a.name);
      continue;
    }
    const to = uniqueAgentName(taken, a.name);
    taken.add(to);
    seen.add(to);
    renames.push({ id: a.id, from: a.name, to });
  }
  return {
    scanned: all.length,
    duplicateGroups: groups.length,
    renames,
  };
}

/** 어댑터가 의존하는 컬렉션의 최소 표면. 실제 mongodb Collection 도 호환. */
export interface AgentsColForDedupe {
  find(filter: Record<string, never>): { toArray(): Promise<AgentDocLike[]> };
  updateOne(
    filter: { id: string },
    update: { $set: { name: string } },
  ): Promise<unknown>;
}

export interface DedupeMigrationResult extends DedupeMigrationPlan {}

/**
 * Mongo 어댑터 — 실제 컬렉션을 받아 plan 을 산출하고 updateOne 으로 적용한다.
 * 플래너와 같은 결과 구조를 그대로 돌려준다(서버가 로그 요약에 사용).
 */
export async function applyAgentNameDedup(
  agentsCol: AgentsColForDedupe,
): Promise<DedupeMigrationResult> {
  const all = await agentsCol.find({}).toArray();
  const plan = planAgentNameDedup(all);
  for (const r of plan.renames) {
    await agentsCol.updateOne({ id: r.id }, { $set: { name: r.to } });
  }
  return plan;
}
