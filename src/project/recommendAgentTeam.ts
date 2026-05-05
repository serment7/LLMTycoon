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
import { translate } from '../i18n';
import { dedupeRecommendationNames } from '../utils/agentNameDedup';
import {
  analyzeDescription,
  buildReason,
  describeAnalysisForPrompt,
  scoreRoles,
  selectTopRoles,
  type RoleScore,
} from './descriptionAnalyzer';

/** i18n 모듈과 동일 Locale 유니언. 순환 의존을 피하려고 로컬로 선언. */
export type RecommendationLocale = 'en' | 'ko';

/** 기본 locale — 사용자가 명시적으로 선택하지 않은 상태. i18n DEFAULT_LOCALE 과 일치. */
export const DEFAULT_RECOMMENDATION_LOCALE: RecommendationLocale = 'en';

/**
 * 지시 #797538d6 — 추천 인원 기본값. recommendCountStore 의 DEFAULT_RECOMMEND_COUNT
 * 와 동일하지만, 본 모듈은 React 의존을 끊기 위해 상수만 자체 보유한다. 두 값을 동시에
 * 변경할 때는 `src/stores/recommendCountStore.ts` 도 함께 수정해야 한다.
 */
export const DEFAULT_RECOMMENDATION_COUNT = 5;
export const MIN_RECOMMENDATION_COUNT = 2;
export const MAX_RECOMMENDATION_COUNT = 5;

export function clampRecommendationCount(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_RECOMMENDATION_COUNT;
  const rounded = Math.round(n);
  if (rounded < MIN_RECOMMENDATION_COUNT) return MIN_RECOMMENDATION_COUNT;
  if (rounded > MAX_RECOMMENDATION_COUNT) return MAX_RECOMMENDATION_COUNT;
  return rounded;
}

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
  /**
   * 지시 #462fa5ec — Joker 가 추가한 "추천 이유" 보강 필드.
   * `rationale` 은 1문장 한 줄 카피(≤80자), `reason` 은 그 뒤에 노출되는 1~2문장 부연
   * 설명. 모델·휴리스틱·서버 어느 쪽도 강제하지 않으며, 비어 있으면 UI 가 영역 자체를
   * 숨긴다(레이아웃 점프 없음).
   */
  readonly reason?: string;
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
  /**
   * 지시 #797538d6 — 사용자가 선택한 팀 크기. 기본 DEFAULT_RECOMMENDATION_COUNT(5).
   * 시스템 프롬프트에 "정확히 N명" 으로 박히고, 휴리스틱·검증기도 동일 N 으로 슬라이스.
   */
  readonly count?: number;
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
      'Use the "Extracted signals" line(s) in the user message — domains, skills, deliverables — as the primary basis for choosing roles; do not invent personas unrelated to those signals.',
      'Respond with a single JSON object and nothing else (no prose, no markdown).',
      'Allowed role values are exactly: Leader, Developer, QA, Designer, Researcher.',
      'The first item must be role="Leader"; there is exactly one Leader.',
      'Each item.name must be unique within items[] — never reuse the same alias across two cards.',
      'Response schema:',
      '{"items":[{"role":"<AgentRole>","name":"<short English alias>","rationale":"<one sentence in English>","reason":"<one short clause citing matched domain/skill/deliverable>"}]}',
      'rationale: one sentence (<=80 chars) in English. name: <=8 chars alias.',
      'reason: one short clause (<=60 chars) that names the matched signal (e.g., "Matches commerce + security").',
    ].join('\n'),
    fewShot: [
      'Example input signals: "Extracted signals — domains: commerce / skills: security / deliverables: api."',
      'Example output:',
      '{"items":[',
      '  {"role":"Leader","name":"Kai","rationale":"Breaks the scope down and distributes in parallel.","reason":"Anchors commerce + security delivery"},',
      '  {"role":"Developer","name":"Dev","rationale":"Handles PCI token and encryption work.","reason":"Matches commerce + backend"},',
      '  {"role":"QA","name":"QA","rationale":"Locks regression and security tests on the payment path.","reason":"Matches security + api"}',
      ']}',
    ].join('\n'),
    userPrefix: 'Project description:',
  },
  ko: {
    policy: [
      '당신은 소규모 소프트웨어 스튜디오의 HR/편성 담당입니다.',
      '사용자가 입력한 프로젝트 설명과 함께 제공되는 "추출 신호" 라인(도메인·스킬·산출물) 을 1차 근거로 삼아 팀원을 추천하세요.',
      '반드시 JSON 오브젝트 하나를 응답하고 그 외 텍스트·마크다운·설명을 붙이지 마세요.',
      '허용된 role 값은 다음 5 가지뿐입니다: Leader, Developer, QA, Designer, Researcher.',
      '첫 번째 추천은 항상 role="Leader" 여야 하며, Leader 는 단 1명입니다.',
      'items 안의 name 은 서로 달라야 합니다 — 같은 별칭을 두 카드에 재사용하지 마세요.',
      '응답 스키마:',
      '{"items":[{"role":"<AgentRole>","name":"<짧은 한국어 이름>","rationale":"<한 문장 한국어 설명>","reason":"<매칭된 도메인/스킬/산출물을 짧게 인용한 한 줄>"}]}',
      'rationale 은 1문장(80자 이하) 한국어, name 은 8자 이하 별칭, reason 은 60자 이하 짧은 절(예: "커머스·보안 매칭") 로 작성하세요.',
    ].join('\n'),
    fewShot: [
      '예시 입력 신호: "추출 신호 — 도메인: commerce / 스킬: security / 산출물: api."',
      '예시 출력:',
      '{"items":[',
      '  {"role":"Leader","name":"Kai","rationale":"범위를 쪼개고 병렬로 분배합니다.","reason":"커머스·보안 분배 적합"},',
      '  {"role":"Developer","name":"Dev","rationale":"PCI 토큰·암호화 구현을 맡습니다.","reason":"커머스 + 백엔드 매칭"},',
      '  {"role":"QA","name":"QA","rationale":"결제 경로 회귀·보안 테스트를 잠급니다.","reason":"보안 + API 매칭"}',
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
  count: number = DEFAULT_RECOMMENDATION_COUNT,
): CacheableClaudeMessages {
  // 시스템 프리픽스는 정책 + 예시 두 블록. messagesWithCache 가 마지막 블록에만
  // cache_control: ephemeral 을 붙여 앞 블록까지 모두 하나의 캐시 프리픽스로 묶는다.
  // 사용자 선택 인원수(N) 와 분석기 추출 신호는 휘발성 USER 블록에 한 줄 메타로 추가한다 —
  // 시스템 프리픽스를 그대로 두어 캐시 프리픽스 히트율을 보존한다.
  const p = SYSTEM_PROMPTS[locale];
  const n = clampRecommendationCount(count);
  const analysis = analyzeDescription(description);
  const analysisLine = describeAnalysisForPrompt(analysis, locale);
  const countDirective =
    locale === 'ko'
      ? `요청 인원수: 정확히 ${n}명. (Leader 1명 + 나머지 ${n - 1}명 구성)`
      : `Required size: exactly ${n} members. (1 Leader + ${n - 1} others)`;
  const { messages } = messagesWithCache({
    system: [p.policy, p.fewShot],
    user: `${p.userPrefix}\n${description.trim()}\n${analysisLine}\n${countDirective}`,
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
export function validateRecommendations(
  raw: unknown,
  count: number = MAX_RECOMMENDATION_COUNT,
): AgentRecommendation[] {
  const root = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  if (!root || typeof root !== 'object') return [];
  const list = (root as { items?: unknown }).items;
  if (!Array.isArray(list)) return [];
  const limit = clampRecommendationCount(count);
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
    // 지시 #462fa5ec — reason 은 선택 필드. 빈 문자열·공백·비문자열은 무시.
    const reasonRaw = row.reason;
    const reason =
      typeof reasonRaw === 'string' && reasonRaw.trim().length > 0
        ? reasonRaw.trim().slice(0, 240)
        : undefined;
    out.push({
      role: row.role,
      name: row.name.trim(),
      rationale: row.rationale.trim(),
      ...(skills && skills.length > 0 ? { skills } : {}),
      ...(reason ? { reason } : {}),
    });
    if (out.length >= limit) break;
  }
  // 배치 내 이름 충돌 해소 — LLM 이 같은 별칭을 두 카드에 부여한 경우 두 번째부터
  // 숫자 접미사를 붙여 유일하게 만든다(스킵하지 않으므로 추천 인원수 보존).
  return dedupeRecommendationNames(out);
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

/** 휴리스틱 카드의 역할별 기본 별칭. UI 캐러셀에서 동일 별칭이 반복되면 가독성이 떨어지므로 5종으로 분리. */
export const HEURISTIC_ROLE_NAMES: Record<AgentRole, string> = {
  Leader: 'Kai',
  Developer: 'Dev',
  Designer: 'Dex',
  QA: 'QA',
  Researcher: 'Riz',
};

/**
 * 휴리스틱 폴백 — 분석기·점수 기반 역할 선정.
 *   1) `analyzeDescription` 으로 도메인/스킬/산출물 추출.
 *   2) `scoreRoles` 가 역할별 점수(가중치 매트릭스 + base) 를 계산.
 *   3) `selectTopRoles` 가 점수 내림차순으로 상위 `count` 역할 선정. Leader 는 base=1000
 *      이라 항상 1순위. 동일 역할은 정의상 중복되지 않으므로 다양성 자동 보장.
 *   4) 각 카드는 `reason` 한 줄(매칭된 도메인·스킬·산출물 인용) 을 동봉한다.
 *
 * rationale·name·skills 는 역할별 디폴트 카피/스킬셋을 그대로 쓴다 — 언어는 locale 따라.
 */
export function heuristicTeam(
  description: string,
  locale: RecommendationLocale = DEFAULT_RECOMMENDATION_LOCALE,
  count: number = DEFAULT_RECOMMENDATION_COUNT,
): AgentRecommendation[] {
  const target = clampRecommendationCount(count);
  const analysis = analyzeDescription(description);
  const allScores = scoreRoles(analysis);
  const scoreByRole = new Map<AgentRole, RoleScore>(allScores.map((s) => [s.role, s]));
  const picked = selectTopRoles(allScores, target);
  const copy = HEURISTIC_COPY[locale];
  return picked.map((role) => {
    const score = scoreByRole.get(role)!;
    return {
      role,
      name: HEURISTIC_ROLE_NAMES[role],
      rationale: copy[role],
      skills: DEFAULT_ROLE_SKILLS[role],
      reason: buildReason(role, score, locale),
    };
  });
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
    throw new Error(translate('project.applyTeam.errors.invalidDescription', options.locale));
  }
  const locale = options.locale ?? DEFAULT_RECOMMENDATION_LOCALE;
  const count = clampRecommendationCount(options.count ?? DEFAULT_RECOMMENDATION_COUNT);
  const messages = buildRecommendationMessages(description, locale, count);
  // 분석은 캐시 효율을 위해 한 번만. heuristicTeam·reason 보강 양쪽에서 재사용.
  const analysis = analyzeDescription(description);
  const scoreByRole = new Map<AgentRole, RoleScore>(
    scoreRoles(analysis).map((s) => [s.role, s]),
  );
  if (!options.invoker) {
    return { items: heuristicTeam(description, locale, count), source: 'heuristic', locale, messages };
  }
  try {
    const raw = await options.invoker(messages);
    const items = validateRecommendations(raw, count);
    if (items.length === 0) {
      return { items: heuristicTeam(description, locale, count), source: 'heuristic', locale, messages };
    }
    // LLM 이 reason 을 빠뜨렸거나 빈 문자열로 돌려준 경우, 점수 기반 분석 결과로 보강한다.
    // 사용자가 빈 카드를 보지 않도록 항상 한 줄 근거를 보장.
    const enriched: AgentRecommendation[] = items.map((item) => {
      if (item.reason && item.reason.trim().length > 0) return item;
      const score = scoreByRole.get(item.role);
      if (!score) return item;
      return { ...item, reason: buildReason(item.role, score, locale) };
    });
    return { items: enriched, source: 'claude', locale, messages };
  } catch (err) {
    if (options.fallbackOnError === false) throw err;
    return { items: heuristicTeam(description, locale, count), source: 'heuristic', locale, messages };
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
