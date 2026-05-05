// 에이전트 이름 유일성 보장 헬퍼.
//
// 배경: 추천 LLM 이 한 배치에 같은 별칭(예: "Dev") 을 두 번 내놓거나, 사용자가
// 새 프로젝트의 추천 팀을 적용하면서 이미 글로벌 풀에 같은 이름의 에이전트가
// 있는 경우, UI 에서 "동일 이름의 에이전트가 섞여서 합류" 한 것처럼 보였다.
// 본 모듈은 추천 파이프라인·서버 hire 엔드포인트·기동 시점 마이그레이션이
// 공통으로 쓰는 작은 순수 함수 두 개를 제공한다.
//
// 정책: 충돌은 **숫자 접미사 부여** 로 해결한다(스킵 X — 추천 카드 수가 줄어드는
// 회귀를 방지). "Dev" 가 이미 쓰였으면 "Dev2", 그것도 쓰였으면 "Dev3" ... 식.
// 이미 끝자리 숫자가 있는 이름("Dev2") 의 경우는 단순히 뒤에 더 붙여 "Dev22" 가
// 되는데, 추천 흐름에서는 거의 발생하지 않으며 발생해도 가독성에는 문제가 없다.

/**
 * 이미 점유된 이름 집합과 원하는 이름을 받아 충돌 없는 이름을 돌려준다.
 * 입력 desired 가 비어 있으면 그대로 반환(빈 문자열은 호출 측 책임).
 *
 *   uniqueAgentName(["Dev"], "Dev")           → "Dev2"
 *   uniqueAgentName(["Dev","Dev2"], "Dev")    → "Dev3"
 *   uniqueAgentName([], "Dev")                → "Dev"
 */
export function uniqueAgentName(taken: Iterable<string>, desired: string): string {
  const set = new Set<string>();
  for (const t of taken) set.add(t);
  if (!set.has(desired)) return desired;
  let n = 2;
  while (set.has(`${desired}${n}`)) n += 1;
  return `${desired}${n}`;
}

/** 단일 추천 카드 모양에서 이름 필드만 본다. AgentRecommendation 임포트는 의도적으로 피해 순환 의존을 끊는다. */
interface NamedItem {
  readonly name: string;
}

/**
 * 추천(혹은 임의의 NamedItem) 배열을 이름 기준으로 dedupe.
 * 외부 점유 이름이 추가로 있다면 `alreadyTaken` 에 넘겨 함께 회피한다.
 * 순서는 보존하고, 충돌난 항목만 새 이름이 부여된 새 객체로 교체한다.
 */
export function dedupeRecommendationNames<T extends NamedItem>(
  items: readonly T[],
  alreadyTaken: Iterable<string> = [],
): T[] {
  const taken = new Set<string>();
  for (const t of alreadyTaken) taken.add(t);
  const out: T[] = [];
  for (const item of items) {
    const resolved = uniqueAgentName(taken, item.name);
    taken.add(resolved);
    out.push(resolved === item.name ? item : { ...item, name: resolved });
  }
  return out;
}

/**
 * 마이그레이션·진단용: 이름이 같은 항목들의 중복 그룹을 돌려준다. 그룹 길이가 1
 * 이하인 항목은 결과에 포함시키지 않는다. id 필드(없으면 식별 불가) 가 있는
 * 객체 배열을 받는다 — 호출 측에서 적절한 키를 보장.
 */
export function findDuplicateNameGroups<T extends NamedItem & { readonly id: string }>(
  items: readonly T[],
): Array<{ name: string; ids: string[] }> {
  const groups = new Map<string, string[]>();
  for (const it of items) {
    const arr = groups.get(it.name) ?? [];
    arr.push(it.id);
    groups.set(it.name, arr);
  }
  const out: Array<{ name: string; ids: string[] }> = [];
  for (const [name, ids] of groups) {
    if (ids.length > 1) out.push({ name, ids });
  }
  return out;
}
