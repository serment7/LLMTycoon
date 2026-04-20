// 지시 #fa0621b3 · 프로젝트 신규 생성 플로우의 "에이전트 팀 추천" 백엔드 로직.
//
// 디자이너 시안(3단계: 설명 입력 → 추천 카드 → 바로 추가) 과 UI 팀이 공유할 **응답
// 스키마를 먼저 고정** 한다. 스키마가 확정되어야 카드 레이아웃·선택 체크박스·"바로
// 추가" 버튼 핸들러가 UI 쪽에서 병렬로 전진할 수 있기 때문이다.
//
// 설계 원칙
//   (1) 순수 함수 — 본 모듈은 DOM/브라우저 의존이 없으며, 테스트는 `invoker` 훅만
//       주입하면 네트워크 없이 돌아간다.
//   (2) 프롬프트 캐싱 — 시스템 프롬프트(스키마 선언·역할 정책) 는 입력과 무관하게
//       재사용되므로 `buildCacheableMessages` 로 `cache_control: ephemeral` 마커가
//       마지막 시스템 블록에 붙도록 구성한다. 사용자 description 은 휘발성 USER 블록.
//   (3) 기본 휴리스틱 폴백 — invoker 미주입 또는 실패 시에도 UI 가 비어 있지 않도록
//       설명 키워드에 기반한 heuristic 팀 구성을 반환한다. 온라인 성공 경로와 별개로
//       오프라인/테스트 흐름의 결정론성을 보장한다.
//   (4) 스키마 검증 — invoker 응답이 깨졌을 때 조용히 원문을 돌려주지 않고,
//       `validateRecommendations` 를 통과한 항목만 반환한다. 스키마 위반은 폴백으로 대체.

import { buildCacheableMessages, type CacheableClaudeMessages } from '../server/claudeClient';
import type { AgentRole } from '../types';

// ────────────────────────────────────────────────────────────────────────────
// 공개 스키마 — UI 와 공유. 이후 변경은 디자이너·QA 합의 필요.
// ────────────────────────────────────────────────────────────────────────────

/**
 * 단일 추천 카드에 그려질 최소 단위.
 *   · role: 고용 시 `POST /api/agents/hire` 로 그대로 전달할 AgentRole.
 *   · name: 디폴트 카드 제목. 사용자가 수정 가능(시안 §2 카드 편집 영역).
 *   · rationale: "이 역할이 왜 필요한가" 한국어 설명 1문장(시안 §2.2 힌트 박스).
 */
export interface AgentRecommendation {
  readonly role: AgentRole;
  readonly name: string;
  readonly rationale: string;
}

/** 추천 결과 봉투. UI 는 `items` 만 쓰고, `source` 는 디버깅/텔레메트리용. */
export interface AgentTeamRecommendation {
  readonly items: readonly AgentRecommendation[];
  /** 'heuristic' — 폴백 경로, 'claude' — invoker 성공, 'cache' — 캐시 히트. */
  readonly source: 'heuristic' | 'claude' | 'cache';
  /** invoker 호출 시 전달된 프롬프트 캐싱 메시지 봉투(디버그 전용). */
  readonly messages?: CacheableClaudeMessages;
}

export interface RecommendAgentTeamOptions {
  /**
   * 실제 LLM 호출을 수행하는 함수. 주입 안 하면 휴리스틱으로 폴백. 반환 형식은
   * JSON 문자열 `{items: [...]}` 또는 이미 파싱된 객체 둘 다 허용.
   * SDK 전환 후에는 `anthropic.messages.create(messages).content[0].text` 를 그대로
   * 넘기면 된다(시스템/유저 블록은 messages 인자로 이미 캐시 마커 붙어 있음).
   */
  readonly invoker?: (messages: CacheableClaudeMessages) => Promise<string | object>;
  /** invoker 실패 시에도 예외를 전파하지 않고 휴리스틱으로 폴백할지. 기본 true. */
  readonly fallbackOnError?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// 시스템 프롬프트 — 캐시 프리픽스 목표. 본 문자열은 입력과 무관해 매 호출 동일.
// ────────────────────────────────────────────────────────────────────────────

/** 역할 카탈로그. AgentRole 유니언과 1:1. */
export const ROLE_CATALOG: readonly AgentRole[] = [
  'Leader',
  'Developer',
  'QA',
  'Designer',
  'Researcher',
];

/**
 * 시스템 프롬프트의 "역할 정책" 프리픽스 — 추천 갯수·역할 우선순위를 고정한다.
 * 본 문자열은 description 변화와 독립적이므로 캐시 프리픽스에 올린다.
 */
export const SYSTEM_ROLE_POLICY = [
  '당신은 소규모 소프트웨어 스튜디오의 HR/편성 담당입니다.',
  '사용자가 입력한 프로젝트 설명을 읽고, 최소 2명·최대 5명의 핵심 팀원을 추천하세요.',
  '반드시 JSON 오브젝트 하나를 응답하고 그 외 텍스트·마크다운·설명을 붙이지 마세요.',
  '허용된 role 값은 다음 5 가지뿐입니다: Leader, Developer, QA, Designer, Researcher.',
  '첫 번째 추천은 항상 role="Leader" 여야 하며, Leader 는 단 1명입니다.',
  '응답 스키마:',
  '{"items":[{"role":"<AgentRole>","name":"<짧은 한국어 이름>","rationale":"<한 문장 한국어 설명>"}]}',
  'rationale 은 1문장(80자 이하) 한국어, name 은 8자 이하 별칭을 권장합니다.',
].join('\n');

/**
 * 예시 프리픽스 — 모델이 JSON-only 출력 포맷을 지키도록 한 번 보여 준다. description 과
 * 독립이므로 동일하게 캐시 프리픽스로 같이 묶인다.
 */
export const SYSTEM_FEW_SHOT = [
  '예시 입력: "결제 모듈 보안 강화 — PCI 감사·토큰 암호화"',
  '예시 출력:',
  '{"items":[',
  '  {"role":"Leader","name":"Kai","rationale":"범위를 쪼개고 병렬로 분배합니다."},',
  '  {"role":"Developer","name":"Dev","rationale":"PCI 토큰·암호화 구현을 맡습니다."},',
  '  {"role":"QA","name":"QA","rationale":"결제 경로 회귀·보안 테스트를 잠급니다."}',
  ']}',
].join('\n');

// ────────────────────────────────────────────────────────────────────────────
// 메시지 빌더
// ────────────────────────────────────────────────────────────────────────────

export function buildRecommendationMessages(description: string): CacheableClaudeMessages {
  // 시스템 프리픽스는 정책 + 예시 두 블록. buildCacheableMessages 가 마지막 블록에만
  // cache_control: ephemeral 을 붙여 앞 블록까지 모두 하나의 캐시 프리픽스로 묶는다.
  return buildCacheableMessages(
    [SYSTEM_ROLE_POLICY, SYSTEM_FEW_SHOT],
    `프로젝트 설명:\n${description.trim()}`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 스키마 검증 · 폴백
// ────────────────────────────────────────────────────────────────────────────

function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && (ROLE_CATALOG as readonly string[]).includes(value);
}

/** invoker 응답을 스키마에 맞춰 정제. 망가진 항목은 버리고 유효한 것만 반환. */
export function validateRecommendations(raw: unknown): AgentRecommendation[] {
  const root = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  if (!root || typeof root !== 'object') return [];
  const list = (root as { items?: unknown }).items;
  if (!Array.isArray(list)) return [];
  const out: AgentRecommendation[] = [];
  const seenLeader = { flag: false };
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (!isAgentRole(row.role)) continue;
    if (typeof row.name !== 'string' || row.name.trim().length === 0) continue;
    if (typeof row.rationale !== 'string' || row.rationale.trim().length === 0) continue;
    if (row.role === 'Leader') {
      if (seenLeader.flag) continue;
      seenLeader.flag = true;
    }
    out.push({ role: row.role, name: row.name.trim(), rationale: row.rationale.trim() });
    if (out.length >= 5) break;
  }
  return out;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // 모델이 앞뒤로 텍스트를 붙인 경우 첫 `{` ~ 마지막 `}` 만 잘라 재시도.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * 휴리스틱 폴백 — description 에 등장하는 키워드로 Developer/QA/Designer/Researcher
 * 를 조건부로 추가한다. Leader 는 고정 1인. 최소 Leader + Developer 2인 구성을 보장.
 */
export function heuristicTeam(description: string): AgentRecommendation[] {
  const lower = description.toLowerCase();
  const items: AgentRecommendation[] = [
    { role: 'Leader', name: 'Kai', rationale: '범위를 쪼개고 분배합니다.' },
    { role: 'Developer', name: 'Dev', rationale: '핵심 기능 구현을 맡습니다.' },
  ];
  const has = (...kws: string[]) => kws.some((k) => lower.includes(k));
  if (has('ui', 'ux', '디자인', '화면', 'screen', 'design')) {
    items.push({ role: 'Designer', name: 'Dex', rationale: '화면 시안과 상호작용을 설계합니다.' });
  }
  if (has('보안', '테스트', 'qa', '회귀', '검증', 'security', 'test')) {
    items.push({ role: 'QA', name: 'QA', rationale: '회귀 테스트와 품질 게이트를 담당합니다.' });
  }
  if (has('연구', '조사', 'research', '분석', 'analysis', '시장')) {
    items.push({ role: 'Researcher', name: 'Riz', rationale: '레퍼런스·사례 조사를 맡습니다.' });
  }
  return items.slice(0, 5);
}

// ────────────────────────────────────────────────────────────────────────────
// 메인 엔트리
// ────────────────────────────────────────────────────────────────────────────

/**
 * 프로젝트 설명을 받아 추천 팀을 돌려준다.
 * - invoker 미주입 → `heuristic` 폴백.
 * - invoker 성공 + 스키마 통과 → `claude`.
 * - invoker 실패 또는 빈 결과 → `heuristic` 폴백(옵션으로 예외 전파 가능).
 */
export async function recommendAgentTeam(
  description: string,
  options: RecommendAgentTeamOptions = {},
): Promise<AgentTeamRecommendation> {
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('description 은 비어 있지 않은 문자열이어야 합니다.');
  }
  const messages = buildRecommendationMessages(description);
  if (!options.invoker) {
    return { items: heuristicTeam(description), source: 'heuristic', messages };
  }
  try {
    const raw = await options.invoker(messages);
    const items = validateRecommendations(raw);
    if (items.length === 0) {
      return { items: heuristicTeam(description), source: 'heuristic', messages };
    }
    return { items, source: 'claude', messages };
  } catch (err) {
    if (options.fallbackOnError === false) throw err;
    return { items: heuristicTeam(description), source: 'heuristic', messages };
  }
}
