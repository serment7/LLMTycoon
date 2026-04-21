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

import { messagesWithCache } from '../server/llm/messagesWithCache';
import type { CacheableClaudeMessages } from '../server/claudeClient';
import type { AgentRole } from '../types';

/** i18n 모듈과 동일 Locale 유니언. 순환 의존을 피하려고 로컬로 선언. */
export type RecommendationLocale = 'en' | 'ko';

/** 기본 locale — 사용자가 명시적으로 선택하지 않은 상태. i18n DEFAULT_LOCALE 과 일치. */
export const DEFAULT_RECOMMENDATION_LOCALE: RecommendationLocale = 'en';

// ────────────────────────────────────────────────────────────────────────────
// 공개 스키마 — UI 와 공유. 이후 변경은 디자이너·QA 합의 필요.
// ────────────────────────────────────────────────────────────────────────────

/**
 * 단일 추천 카드에 그려질 최소 단위.
 *   · role: 고용 시 `POST /api/agents/hire` 로 그대로 전달할 AgentRole.
 *   · name: 디폴트 카드 제목. 사용자가 수정 가능(시안 §2 카드 편집 영역).
 *   · rationale: "이 역할이 왜 필요한가" 현재 locale 로 된 한 문장(시안 §2.2 힌트 박스).
 */
export interface AgentRecommendation {
  readonly role: AgentRole;
  readonly name: string;
  readonly rationale: string;
  /** 역할별 핵심 스킬 태그(≤5개). UI 카드에 칩으로 노출 + 서버 persona 에 합쳐 저장. */
  readonly skills?: readonly string[];
}

/** 추천 결과 봉투. UI 는 `items` 만 쓰고, `source`/`locale` 은 디버깅/재번역 판정용. */
export interface AgentTeamRecommendation {
  readonly items: readonly AgentRecommendation[];
  /** 'heuristic' — 폴백 경로, 'claude' — invoker 성공, 'cache' — 캐시 히트, 'translated' — translateOnly 경로. */
  readonly source: 'heuristic' | 'claude' | 'cache' | 'translated';
  /** 본 items 가 어떤 locale 로 생성되었는지. UI 가 현재 locale 과 비교해 재번역을 판단한다. */
  readonly locale: RecommendationLocale;
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
  /** 추천 근거/이름 생성 언어. 기본 DEFAULT_RECOMMENDATION_LOCALE. */
  readonly locale?: RecommendationLocale;
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
 * locale 별 시스템 프롬프트. policy + fewShot 두 블록 구성은 유지하면서, 언어만
 * 교체한다. description 자체는 그대로(어느 언어로 들어오든 모델이 locale 을 따른다).
 * 본 객체 내용은 description 변화와 독립이므로 캐시 프리픽스에 올린다.
 */
export const SYSTEM_PROMPTS: Record<
  RecommendationLocale,
  { readonly policy: string; readonly fewShot: string; readonly userPrefix: string }
> = {
  en: {
    policy: [
      'You are the HR/staffing lead of a small software studio.',
      'Read the user project description and recommend a core team of 2 to 5 members.',
      'Respond with a single JSON object and nothing else (no prose, no markdown).',
      'Allowed role values are exactly: Leader, Developer, QA, Designer, Researcher.',
      'The first item must be role="Leader"; there is exactly one Leader.',
      'Response schema:',
      '{"items":[{"role":"<AgentRole>","name":"<short English alias>","rationale":"<one sentence in English>"}]}',
      'rationale: one sentence (<=80 chars) in English. name: <=8 chars alias.',
    ].join('\n'),
    fewShot: [
      'Example input: "Payment module hardening — PCI audit + token encryption"',
      'Example output:',
      '{"items":[',
      '  {"role":"Leader","name":"Kai","rationale":"Breaks the scope down and distributes in parallel."},',
      '  {"role":"Developer","name":"Dev","rationale":"Handles PCI token and encryption work."},',
      '  {"role":"QA","name":"QA","rationale":"Locks regression and security tests on the payment path."}',
      ']}',
    ].join('\n'),
    userPrefix: 'Project description:',
  },
  ko: {
    policy: [
      '당신은 소규모 소프트웨어 스튜디오의 HR/편성 담당입니다.',
      '사용자가 입력한 프로젝트 설명을 읽고, 최소 2명·최대 5명의 핵심 팀원을 추천하세요.',
      '반드시 JSON 오브젝트 하나를 응답하고 그 외 텍스트·마크다운·설명을 붙이지 마세요.',
      '허용된 role 값은 다음 5 가지뿐입니다: Leader, Developer, QA, Designer, Researcher.',
      '첫 번째 추천은 항상 role="Leader" 여야 하며, Leader 는 단 1명입니다.',
      '응답 스키마:',
      '{"items":[{"role":"<AgentRole>","name":"<짧은 한국어 이름>","rationale":"<한 문장 한국어 설명>"}]}',
      'rationale 은 1문장(80자 이하) 한국어, name 은 8자 이하 별칭을 권장합니다.',
    ].join('\n'),
    fewShot: [
      '예시 입력: "결제 모듈 보안 강화 — PCI 감사·토큰 암호화"',
      '예시 출력:',
      '{"items":[',
      '  {"role":"Leader","name":"Kai","rationale":"범위를 쪼개고 병렬로 분배합니다."},',
      '  {"role":"Developer","name":"Dev","rationale":"PCI 토큰·암호화 구현을 맡습니다."},',
      '  {"role":"QA","name":"QA","rationale":"결제 경로 회귀·보안 테스트를 잠급니다."}',
      ']}',
    ].join('\n'),
    userPrefix: '프로젝트 설명:',
  },
};

/**
 * 하위 호환 재노출 — 기존 테스트·소비자가 가리키던 상수. 'ko' 프롬프트를 유지.
 * @deprecated — 신규 코드는 SYSTEM_PROMPTS[locale] 을 사용한다.
 */
export const SYSTEM_ROLE_POLICY = SYSTEM_PROMPTS.ko.policy;
/** @deprecated — SYSTEM_PROMPTS 사용. */
export const SYSTEM_FEW_SHOT = SYSTEM_PROMPTS.ko.fewShot;

// ────────────────────────────────────────────────────────────────────────────
// 메시지 빌더
// ────────────────────────────────────────────────────────────────────────────

export function buildRecommendationMessages(
  description: string,
  locale: RecommendationLocale = DEFAULT_RECOMMENDATION_LOCALE,
): CacheableClaudeMessages {
  // 시스템 프리픽스는 정책 + 예시 두 블록. messagesWithCache 가 마지막 블록에만
  // cache_control: ephemeral 을 붙여 앞 블록까지 모두 하나의 캐시 프리픽스로 묶는다.
  const p = SYSTEM_PROMPTS[locale];
  const { messages } = messagesWithCache({
    system: [p.policy, p.fewShot],
    user: `${p.userPrefix}\n${description.trim()}`,
  });
  return messages;
}

// ────────────────────────────────────────────────────────────────────────────
// translateOnly — 기존 추천 items 의 name/rationale 만 대상 locale 로 바꾼다.
// role 은 AgentRole 유니언이므로 언어 독립. 본 경로는 description 을 넘기지 않아
// 프리픽스만 재사용 + 훨씬 짧은 user 블록으로 돌아온다.
// ────────────────────────────────────────────────────────────────────────────

export const TRANSLATE_SYSTEM_PROMPT = [
  'You translate short role/name/rationale cards between English and Korean.',
  'Respond with a single JSON object: {"items":[{"role":"<unchanged>","name":"<translated>","rationale":"<translated one sentence>"}]}.',
  'Do not invent new items; preserve the same length and order as the input.',
  'Keep role values untouched. Do not add prose outside of JSON.',
].join('\n');

export function buildTranslationMessages(
  existing: AgentTeamRecommendation,
  targetLocale: RecommendationLocale,
): CacheableClaudeMessages {
  // 캐시 프리픽스(시스템) 가 locale 과 무관하므로 재번역 구간은 대부분 히트.
  const { messages } = messagesWithCache({
    system: [TRANSLATE_SYSTEM_PROMPT],
    user: [
      `Target locale: ${targetLocale}`,
      `Source locale: ${existing.locale}`,
      'Items to translate (preserve order, role unchanged):',
      JSON.stringify({ items: existing.items }),
    ].join('\n'),
  });
  return messages;
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
    const skills = Array.isArray(row.skills)
      ? row.skills
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim())
          .slice(0, 5)
      : undefined;
    out.push({
      role: row.role,
      name: row.name.trim(),
      rationale: row.rationale.trim(),
      ...(skills && skills.length > 0 ? { skills } : {}),
    });
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

/** locale 별 휴리스틱 카피 — 추가 언어가 들어오면 본 테이블만 확장한다. */
const HEURISTIC_COPY: Record<
  RecommendationLocale,
  Record<AgentRole, string>
> = {
  en: {
    Leader: 'Breaks the scope down and distributes tasks.',
    Developer: 'Owns the core feature implementation.',
    Designer: 'Designs screens and interactions.',
    QA: 'Owns regression tests and quality gates.',
    Researcher: 'Gathers references and case studies.',
  },
  ko: {
    Leader: '범위를 쪼개고 분배합니다.',
    Developer: '핵심 기능 구현을 맡습니다.',
    Designer: '화면 시안과 상호작용을 설계합니다.',
    QA: '회귀 테스트와 품질 게이트를 담당합니다.',
    Researcher: '레퍼런스·사례 조사를 맡습니다.',
  },
};

/** 역할별 기본 skill 세트 — 휴리스틱 폴백과 서버 응답의 default 를 제공한다. */
export const DEFAULT_ROLE_SKILLS: Record<AgentRole, readonly string[]> = {
  Leader: ['planning', 'coordination', 'prioritization'],
  Developer: ['typescript', 'node', 'react'],
  Designer: ['ux', 'wireframes', 'design-system'],
  QA: ['regression', 'accessibility', 'security-testing'],
  Researcher: ['desk-research', 'benchmarking', 'synthesis'],
};

/**
 * 휴리스틱 폴백 — description 에 등장하는 키워드로 Developer/QA/Designer/Researcher
 * 를 조건부로 추가한다. Leader 는 고정 1인. 최소 Leader + Developer 2인 구성을 보장.
 * rationale 은 locale 에 따라 다른 카피를 고른다(role·name 은 언어 독립).
 */
export function heuristicTeam(
  description: string,
  locale: RecommendationLocale = DEFAULT_RECOMMENDATION_LOCALE,
): AgentRecommendation[] {
  const lower = description.toLowerCase();
  const copy = HEURISTIC_COPY[locale];
  const items: AgentRecommendation[] = [
    { role: 'Leader', name: 'Kai', rationale: copy.Leader, skills: DEFAULT_ROLE_SKILLS.Leader },
    { role: 'Developer', name: 'Dev', rationale: copy.Developer, skills: DEFAULT_ROLE_SKILLS.Developer },
  ];
  const has = (...kws: string[]) => kws.some((k) => lower.includes(k));
  if (has('ui', 'ux', '디자인', '화면', 'screen', 'design')) {
    items.push({ role: 'Designer', name: 'Dex', rationale: copy.Designer, skills: DEFAULT_ROLE_SKILLS.Designer });
  }
  if (has('보안', '테스트', 'qa', '회귀', '검증', 'security', 'test')) {
    items.push({ role: 'QA', name: 'QA', rationale: copy.QA, skills: DEFAULT_ROLE_SKILLS.QA });
  }
  if (has('연구', '조사', 'research', '분석', 'analysis', '시장')) {
    items.push({ role: 'Researcher', name: 'Riz', rationale: copy.Researcher, skills: DEFAULT_ROLE_SKILLS.Researcher });
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
  const locale = options.locale ?? DEFAULT_RECOMMENDATION_LOCALE;
  const messages = buildRecommendationMessages(description, locale);
  if (!options.invoker) {
    return { items: heuristicTeam(description, locale), source: 'heuristic', locale, messages };
  }
  try {
    const raw = await options.invoker(messages);
    const items = validateRecommendations(raw);
    if (items.length === 0) {
      return { items: heuristicTeam(description, locale), source: 'heuristic', locale, messages };
    }
    return { items, source: 'claude', locale, messages };
  } catch (err) {
    if (options.fallbackOnError === false) throw err;
    return { items: heuristicTeam(description, locale), source: 'heuristic', locale, messages };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// translateOnly — 언어 전환 시 기존 추천을 폐기하지 않고 번역만 요청하는 경량 경로.
// ────────────────────────────────────────────────────────────────────────────

export interface TranslateRecommendationsOptions {
  readonly invoker?: (messages: CacheableClaudeMessages) => Promise<string | object>;
  readonly fallbackOnError?: boolean;
}

/**
 * 기존 추천을 targetLocale 로 번역. invoker 가 스키마를 유지하지 못하면 heuristic
 * 번역표로 폴백. 이미 targetLocale 인 경우 그대로 반환(네트워크 호출 없음).
 */
export async function translateRecommendations(
  existing: AgentTeamRecommendation,
  targetLocale: RecommendationLocale,
  options: TranslateRecommendationsOptions = {},
): Promise<AgentTeamRecommendation> {
  if (existing.locale === targetLocale) return existing;

  const heuristic = (): AgentTeamRecommendation => {
    const copy = HEURISTIC_COPY[targetLocale];
    const items: AgentRecommendation[] = existing.items.map((it) => ({
      role: it.role,
      name: it.name,
      rationale: copy[it.role] ?? it.rationale,
    }));
    return { items, source: 'heuristic', locale: targetLocale };
  };

  if (!options.invoker) {
    return heuristic();
  }

  const messages = buildTranslationMessages(existing, targetLocale);
  try {
    const raw = await options.invoker(messages);
    const translated = validateRecommendations(raw);
    // 번역은 "같은 items 의 동수·동순" 계약이므로 개수가 변했으면 휴리스틱으로 폴백.
    if (translated.length !== existing.items.length) {
      return heuristic();
    }
    // role 보존 체크 — 바뀐 항목은 원본 role 로 되돌려 유저가 혼동하지 않도록 한다.
    const items: AgentRecommendation[] = translated.map((t, i) => ({
      role: existing.items[i].role,
      name: t.name,
      rationale: t.rationale,
    }));
    return { items, source: 'translated', locale: targetLocale, messages };
  } catch (err) {
    if (options.fallbackOnError === false) throw err;
    return heuristic();
  }
}
