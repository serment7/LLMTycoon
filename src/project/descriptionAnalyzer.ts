// 지시 #1d026b5b · 추천 매칭 정확도 개선 — 프로젝트 설명을 도메인/스킬/산출물 축으로
// 분류하고, 역할별 가중치 매트릭스로 점수를 매겨 상위 N개 역할을 결정하는 분석 모듈.
//
// 설계 원칙
//   (1) 한국어/영어 양쪽 동의어 사전(LEXICON) 으로 표제어(canonical) 를 추출한다.
//       예) "쇼핑몰" "커머스" "commerce" "ecommerce" → 'commerce' 도메인.
//   (2) 매칭은 ASCII 토큰은 word-boundary, 한글/유니코드는 substring 으로 수행한다.
//       'qa' 가 'aqua' 같은 우연 매칭에 잡히지 않도록 영어 표제어는 경계 조건을 강제.
//   (3) 가중치는 (역할 × {도메인|스킬|산출물}) 3 축. 합산 후 Leader 는 base 점수가 매우
//       크기 때문에 항상 1순위로 고정 — selectTopRoles 의 첫 슬롯이 Leader 인 계약을 깨지 않는다.
//   (4) 역할 다양성 제약: ROLE_CATALOG 가 5종이므로 자연 1명/역할. 다만 점수 0 인 역할도
//       count 부족분이면 fallback 순서(`Designer → QA → Researcher → Developer`) 로 채운다.
//   (5) buildReason — 역할이 어떤 매칭 근거로 뽑혔는지 한 줄로 설명한다. UI 카드의 보조
//       문구로 노출되며, 이유가 없으면 "기본 팀 구성에 필수" 같은 폴백 카피를 돌려준다.

import type { AgentRole } from '../types';

// 본 모듈은 recommendAgentTeam 의 하위 의존이므로 순환을 피하기 위해 ROLE_CATALOG 을
// 상수로 자체 보유한다. recommendAgentTeam.ROLE_CATALOG 과 동일한 5 종 — 어느 한쪽이
// 바뀌면 양쪽을 함께 업데이트한다(테스트가 양쪽 일치를 잠근다).
const ROLE_CATALOG: readonly AgentRole[] = [
  'Leader',
  'Developer',
  'QA',
  'Designer',
  'Researcher',
];

// ────────────────────────────────────────────────────────────────────────────
// 어휘 사전 (LEXICON) — 한/영 동의어 ↔ 표제어
// ────────────────────────────────────────────────────────────────────────────

export type LexiconCategory = 'domain' | 'skill' | 'deliverable';

export interface LexiconEntry {
  /** 표제어. 본 모듈이 노출하는 안정적인 식별자. */
  readonly canonical: string;
  /** 매칭에 사용할 한/영 alias 목록. 대소문자 무관. 한글 alias 는 substring 매칭. */
  readonly aliases: readonly string[];
  readonly category: LexiconCategory;
}

export const LEXICON: readonly LexiconEntry[] = [
  // ── domain ────────────────────────────────────────────────────────────
  {
    canonical: 'commerce',
    category: 'domain',
    aliases: ['쇼핑몰', '커머스', '이커머스', '마켓플레이스', '결제', '체크아웃', '장바구니',
      'commerce', 'ecommerce', 'e-commerce', 'marketplace', 'payment', 'checkout', 'cart', 'shop'],
  },
  {
    canonical: 'gaming',
    category: 'domain',
    aliases: ['게임', '게이밍', '보드게임', '캐주얼 게임',
      'game', 'gaming', 'rpg', 'fps', 'mmo', 'gamedev', 'game engine'],
  },
  {
    canonical: 'analytics',
    category: 'domain',
    aliases: ['데이터 분석', '데이터분석', '지표', '리포트', '대시보드', 'bi', '비즈니스 인텔리전스',
      'analytics', 'metric', 'metrics', 'kpi', 'reporting', 'business intelligence'],
  },
  {
    canonical: 'social',
    category: 'domain',
    aliases: ['소셜', 'sns', '커뮤니티', '피드', '메신저', '채팅', '댓글',
      'social', 'community', 'feed', 'messenger', 'chat', 'comments'],
  },
  {
    canonical: 'fintech',
    category: 'domain',
    aliases: ['핀테크', '뱅킹', '대출', '보험', '투자', '지갑',
      'fintech', 'banking', 'loan', 'insurance', 'invest', 'wallet'],
  },
  {
    canonical: 'media',
    category: 'domain',
    aliases: ['미디어', '스트리밍', '비디오', '오디오', '콘텐츠', '팟캐스트',
      'media', 'streaming', 'vod', 'video', 'audio', 'content', 'podcast'],
  },
  {
    canonical: 'edtech',
    category: 'domain',
    aliases: ['교육', '강의', '학습', 'lms', '이러닝',
      'edtech', 'course', 'learning', 'elearning', 'tutoring'],
  },
  {
    canonical: 'healthtech',
    category: 'domain',
    aliases: ['헬스케어', '의료', '병원', '환자', '웨어러블',
      'healthcare', 'medical', 'clinic', 'patient', 'wearable'],
  },
  {
    canonical: 'productivity',
    category: 'domain',
    aliases: ['생산성', '협업', '문서', '이슈 트래커', '프로젝트 관리',
      'productivity', 'collaboration', 'document', 'issue tracker', 'project management'],
  },

  // ── skill ─────────────────────────────────────────────────────────────
  {
    canonical: 'frontend',
    category: 'skill',
    aliases: ['프런트', '프론트', '프론트엔드', '프런트엔드', '웹페이지', '웹 페이지', 'spa',
      'frontend', 'react', 'vue', 'svelte', 'next.js', 'nextjs', 'tailwind'],
  },
  {
    canonical: 'backend',
    category: 'skill',
    aliases: ['백엔드', '서버', '엔드포인트',
      'backend', 'server', 'node', 'express', 'fastify', 'rest', 'graphql', 'grpc'],
  },
  {
    canonical: 'mobile',
    category: 'skill',
    aliases: ['모바일', '모바일 앱', '아이폰', '안드로이드', '플러터',
      'mobile', 'ios', 'android', 'react native', 'flutter', 'swift', 'kotlin'],
  },
  {
    canonical: 'ml',
    category: 'skill',
    aliases: ['머신러닝', '딥러닝', '인공지능', '추천 시스템', '추천시스템', '임베딩', '벡터 검색',
      'machine learning', 'deep learning', 'ai', 'llm', 'rag', 'embedding', 'recommendation'],
  },
  {
    canonical: 'devops',
    category: 'skill',
    aliases: ['데브옵스', '인프라', '배포', '쿠버네티스',
      'devops', 'cicd', 'ci/cd', 'docker', 'kubernetes', 'k8s', 'aws', 'gcp', 'azure', 'terraform'],
  },
  {
    canonical: 'security',
    category: 'skill',
    aliases: ['보안', '암호화', '인증', '권한', '오딧', '취약점',
      'security', 'audit', 'pci', 'encryption', 'oauth', 'jwt', 'vulnerability'],
  },
  {
    canonical: 'design',
    category: 'skill',
    aliases: ['디자인', '시안', '와이어프레임', '프로토타입', 'ux', 'ui', '인터랙션',
      'design', 'wireframe', 'prototype', 'figma', 'interaction', 'a11y', 'accessibility'],
  },
  {
    canonical: 'qa',
    category: 'skill',
    aliases: ['테스트', '회귀', '검증', '자동화 테스트', '품질 검증',
      'qa', 'test', 'testing', 'regression', 'playwright', 'cypress', 'unit test'],
  },
  {
    canonical: 'data-engineering',
    category: 'skill',
    aliases: ['데이터 엔지니어링', '데이터엔지니어링', '데이터 파이프라인', '데이터파이프라인', '웨어하우스',
      'data engineering', 'pipeline', 'etl', 'airflow', 'spark', 'warehouse', 'snowflake'],
  },
  {
    canonical: 'research',
    category: 'skill',
    aliases: ['연구', '조사', '시장 조사', '시장조사', '벤치마킹', '레퍼런스 조사', '사례 조사', '경쟁사 분석',
      'research', 'survey', 'benchmark', 'benchmarking', 'competitive analysis', 'user research'],
  },

  // ── deliverable ───────────────────────────────────────────────────────
  {
    canonical: 'web-app',
    category: 'deliverable',
    aliases: ['웹앱', '웹 앱', '웹사이트', '웹 사이트', '홈페이지', '랜딩페이지', '랜딩 페이지',
      'web app', 'website', 'web application', 'landing page'],
  },
  {
    canonical: 'mobile-app',
    category: 'deliverable',
    aliases: ['모바일 앱', '네이티브 앱',
      'mobile app', 'native app'],
  },
  {
    canonical: 'api',
    category: 'deliverable',
    aliases: ['api', '오픈 api', 'rest api', 'graphql api', '마이크로서비스',
      'microservice', 'webhook'],
  },
  {
    canonical: 'dashboard',
    category: 'deliverable',
    aliases: ['대시보드', '관리자 페이지', '관리자페이지', '어드민', '콘솔',
      'dashboard', 'admin', 'console'],
  },
  {
    canonical: 'cms',
    category: 'deliverable',
    aliases: ['cms', '블로그', '포털',
      'blog', 'portal', 'content management'],
  },
  {
    canonical: 'mvp',
    category: 'deliverable',
    aliases: ['mvp', '프로토타입', 'poc', '프루프 오브 컨셉',
      'prototype', 'proof of concept'],
  },
];

// ────────────────────────────────────────────────────────────────────────────
// 매칭 — ASCII 표제어는 word boundary, 그 외(한글 등) 는 substring
// ────────────────────────────────────────────────────────────────────────────

const ASCII_ALIAS = /^[\x21-\x7E ]+$/;

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 한 alias 가 정규화된 텍스트에 매칭되는지. ASCII 는 경계 보호, 그 외는 substring. */
export function aliasMatches(text: string, alias: string): boolean {
  const trimmed = alias.trim().toLowerCase();
  if (trimmed.length === 0) return false;
  if (ASCII_ALIAS.test(trimmed)) {
    // 영어/숫자/기호 alias — 좌우가 영문/숫자가 아닌 경계만 허용. 'qa' 가 'aqua' 에 잡히지 않게.
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(trimmed)}(?:[^a-z0-9]|$)`, 'i');
    return re.test(text);
  }
  // 한글/유니코드 alias — 단순 substring(어절 경계가 명확해 충분).
  return text.includes(trimmed);
}

// ────────────────────────────────────────────────────────────────────────────
// 분석 결과 — 표제어 집합 + 매칭에 쓰인 raw keyword
// ────────────────────────────────────────────────────────────────────────────

export interface DescriptionAnalysis {
  readonly raw: string;
  readonly normalized: string;
  /** 매칭에 사용된 alias 의 raw form(소문자 정규화 전). 디버깅·추천 이유 작성용. */
  readonly keywords: readonly string[];
  readonly domains: readonly string[];
  readonly skills: readonly string[];
  readonly deliverables: readonly string[];
}

function normalize(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 설명을 한 번 훑으면서 LEXICON 의 entry 별로 alias 1 개라도 매칭되면 표제어를 추가한다.
 * 같은 entry 의 다른 alias 는 이후 무시(중복 가산 방지).
 */
export function analyzeDescription(input: string): DescriptionAnalysis {
  const raw = typeof input === 'string' ? input : '';
  const normalized = normalize(raw);
  const domains = new Set<string>();
  const skills = new Set<string>();
  const deliverables = new Set<string>();
  const keywords: string[] = [];
  if (normalized.length === 0) {
    return { raw, normalized, keywords: [], domains: [], skills: [], deliverables: [] };
  }
  for (const entry of LEXICON) {
    let matched = false;
    for (const alias of entry.aliases) {
      if (aliasMatches(normalized, alias)) {
        keywords.push(alias);
        matched = true;
        break;
      }
    }
    if (!matched) continue;
    if (entry.category === 'domain') domains.add(entry.canonical);
    else if (entry.category === 'skill') skills.add(entry.canonical);
    else deliverables.add(entry.canonical);
  }
  return {
    raw,
    normalized,
    keywords,
    domains: [...domains].sort(),
    skills: [...skills].sort(),
    deliverables: [...deliverables].sort(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 가중치 매트릭스 (역할 × {도메인|스킬|산출물}) + base
// ────────────────────────────────────────────────────────────────────────────

export interface RoleWeightProfile {
  readonly base: number;
  readonly domains: Readonly<Record<string, number>>;
  readonly skills: Readonly<Record<string, number>>;
  readonly deliverables: Readonly<Record<string, number>>;
}

/**
 * 점수는 정수. base 는 "분석 결과가 아무것도 없을 때" 도 받는 기본 점수.
 * Leader 는 1000 으로 고정해 selectTopRoles 의 첫 슬롯 계약을 깨지 않는다.
 */
export const ROLE_WEIGHTS: Readonly<Record<AgentRole, RoleWeightProfile>> = {
  Leader: {
    base: 1000,
    domains: {},
    skills: {},
    deliverables: {},
  },
  Developer: {
    // base 30 — 신호가 전혀 없을 때도 Leader 다음 2순위를 유지할 만큼 크지만,
    // Designer/QA/Researcher 가 강한 신호를 받으면 양보할 수 있는 여유를 둔다.
    base: 30,
    domains: {
      commerce: 5, gaming: 6, fintech: 5, healthtech: 4, edtech: 4, social: 5, media: 4,
      analytics: 4, productivity: 5,
    },
    skills: {
      frontend: 12, backend: 14, mobile: 12, ml: 8, devops: 6, 'data-engineering': 8,
    },
    deliverables: {
      'web-app': 10, 'mobile-app': 10, api: 12, mvp: 8, dashboard: 4, cms: 6,
    },
  },
  Designer: {
    base: 6,
    domains: {
      commerce: 6, social: 7, edtech: 5, media: 6, healthtech: 4, productivity: 5,
    },
    skills: {
      design: 30, frontend: 5, mobile: 4,
    },
    deliverables: {
      'web-app': 9, 'mobile-app': 9, dashboard: 6, cms: 4, mvp: 4,
    },
  },
  QA: {
    base: 6,
    domains: {
      fintech: 9, healthtech: 9, commerce: 6, gaming: 5,
    },
    skills: {
      qa: 30, security: 14, devops: 5,
    },
    deliverables: {
      api: 5, 'web-app': 5, 'mobile-app': 5, dashboard: 3,
    },
  },
  Researcher: {
    base: 4,
    domains: {
      analytics: 14, healthtech: 8, edtech: 7, fintech: 5, media: 5, social: 4,
    },
    skills: {
      ml: 12, 'data-engineering': 8, research: 16,
    },
    deliverables: {
      dashboard: 7, mvp: 4,
    },
  },
};

// ────────────────────────────────────────────────────────────────────────────
// 점수 계산 + 상위 N 역할 선정
// ────────────────────────────────────────────────────────────────────────────

export interface RoleScore {
  readonly role: AgentRole;
  readonly score: number;
  /** 점수에 기여한 표제어 — buildReason 이 한 줄 카피에 쓴다. */
  readonly matchedDomains: readonly string[];
  readonly matchedSkills: readonly string[];
  readonly matchedDeliverables: readonly string[];
}

export function scoreRoles(analysis: DescriptionAnalysis): RoleScore[] {
  return ROLE_CATALOG.map((role) => {
    const w = ROLE_WEIGHTS[role];
    let score = w.base;
    const matchedDomains: string[] = [];
    const matchedSkills: string[] = [];
    const matchedDeliverables: string[] = [];
    for (const d of analysis.domains) {
      const v = w.domains[d] ?? 0;
      if (v > 0) {
        score += v;
        matchedDomains.push(d);
      }
    }
    for (const s of analysis.skills) {
      const v = w.skills[s] ?? 0;
      if (v > 0) {
        score += v;
        matchedSkills.push(s);
      }
    }
    for (const dl of analysis.deliverables) {
      const v = w.deliverables[dl] ?? 0;
      if (v > 0) {
        score += v;
        matchedDeliverables.push(dl);
      }
    }
    return { role, score, matchedDomains, matchedSkills, matchedDeliverables };
  });
}

/** count 미만으로 잘리지 않도록 폴백 우선순위로 빈 슬롯을 채울 때 쓰는 순서. */
const FALLBACK_ORDER: readonly AgentRole[] = ['Developer', 'Designer', 'QA', 'Researcher'];

/**
 * 상위 N 역할 선정. Leader 는 base=1000 으로 항상 1순위가 되며, 그 외 4 역할은
 * 점수 내림차순(동점이면 ROLE_CATALOG 순서) 으로 정렬 후 부족분을 FALLBACK_ORDER 로
 * 메운다. 동일 역할은 절대 중복되지 않으므로 다양성 제약은 자동 충족.
 */
export function selectTopRoles(scores: readonly RoleScore[], count: number): AgentRole[] {
  const target = Math.max(1, Math.min(ROLE_CATALOG.length, Math.trunc(count)));
  const sorted = [...scores].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return ROLE_CATALOG.indexOf(a.role) - ROLE_CATALOG.indexOf(b.role);
  });
  const picked: AgentRole[] = [];
  const seen = new Set<AgentRole>();
  for (const s of sorted) {
    if (picked.length >= target) break;
    if (seen.has(s.role)) continue;
    picked.push(s.role);
    seen.add(s.role);
  }
  // base 점수 기반이라 일반적으로 채워지지만, 가중치를 0 으로 비워둔 미래 확장에 대비.
  for (const role of FALLBACK_ORDER) {
    if (picked.length >= target) break;
    if (seen.has(role)) continue;
    picked.push(role);
    seen.add(role);
  }
  return picked;
}

// ────────────────────────────────────────────────────────────────────────────
// 추천 이유 — 한 줄 카피
// ────────────────────────────────────────────────────────────────────────────

const ROLE_LABEL_KO: Record<AgentRole, string> = {
  Leader: '리더',
  Developer: '개발자',
  Designer: '디자이너',
  QA: 'QA',
  Researcher: '리서처',
};

const DOMAIN_LABEL_KO: Record<string, string> = {
  commerce: '커머스',
  gaming: '게임',
  analytics: '데이터 분석',
  social: '소셜',
  fintech: '핀테크',
  media: '미디어',
  edtech: '교육',
  healthtech: '헬스케어',
  productivity: '생산성',
};

const SKILL_LABEL_KO: Record<string, string> = {
  frontend: '프런트엔드',
  backend: '백엔드',
  mobile: '모바일',
  ml: 'ML/AI',
  devops: '데브옵스',
  security: '보안',
  design: '디자인',
  qa: '테스트 자동화',
  'data-engineering': '데이터 엔지니어링',
  research: '리서치',
};

const DELIVERABLE_LABEL_KO: Record<string, string> = {
  'web-app': '웹앱',
  'mobile-app': '모바일 앱',
  api: 'API',
  dashboard: '대시보드',
  cms: 'CMS',
  mvp: 'MVP',
};

function localized(map: Record<string, string>, key: string, locale: 'en' | 'ko'): string {
  if (locale === 'ko') return map[key] ?? key;
  return key;
}

/**
 * 한 줄 추천 이유를 만든다. 매칭 근거가 있으면 도메인·스킬·산출물 1개씩 골라 합성하고,
 * 아무것도 매칭되지 않았으면 역할 책임을 가리키는 폴백 카피를 돌려준다.
 */
export function buildReason(
  role: AgentRole,
  score: RoleScore,
  locale: 'en' | 'ko',
): string {
  const parts: string[] = [];
  if (score.matchedDomains.length > 0) {
    parts.push(localized(DOMAIN_LABEL_KO, score.matchedDomains[0], locale));
  }
  if (score.matchedSkills.length > 0) {
    parts.push(localized(SKILL_LABEL_KO, score.matchedSkills[0], locale));
  }
  if (score.matchedDeliverables.length > 0) {
    parts.push(localized(DELIVERABLE_LABEL_KO, score.matchedDeliverables[0], locale));
  }
  if (parts.length === 0) {
    if (role === 'Leader') {
      return locale === 'ko' ? '범위 분해와 분배를 책임지는 리더 슬롯' : 'Anchors scope decomposition and distribution';
    }
    return locale === 'ko'
      ? `${ROLE_LABEL_KO[role]} 기본 팀 구성 슬롯`
      : `Default ${role.toLowerCase()} slot for the core team`;
  }
  if (locale === 'ko') {
    return `${parts.join(' · ')} 매칭 → ${ROLE_LABEL_KO[role]} 적합`;
  }
  return `Matches ${parts.join(', ')} → fits ${role}`;
}

// ────────────────────────────────────────────────────────────────────────────
// 시스템 프롬프트 보조 — 분석 결과 한 줄 메타
// ────────────────────────────────────────────────────────────────────────────

/**
 * LLM USER 블록에 이어 붙일 한 줄 메타. 시스템 프리픽스(캐시 프리픽스) 는 그대로 두고
 * description 와 함께 USER 블록에만 들어가므로 캐시 히트율을 떨어뜨리지 않는다.
 */
export function describeAnalysisForPrompt(
  analysis: DescriptionAnalysis,
  locale: 'en' | 'ko',
): string {
  const fmt = (label: string, list: readonly string[]): string =>
    list.length > 0 ? `${label}: ${list.join(', ')}` : '';
  if (locale === 'ko') {
    const lines = [
      fmt('도메인', analysis.domains),
      fmt('스킬', analysis.skills),
      fmt('산출물', analysis.deliverables),
    ].filter((s) => s.length > 0);
    if (lines.length === 0) return '추출 신호 없음 — 기본 팀 구성 권장.';
    return `추출 신호 — ${lines.join(' / ')}.`;
  }
  const lines = [
    fmt('domains', analysis.domains),
    fmt('skills', analysis.skills),
    fmt('deliverables', analysis.deliverables),
  ].filter((s) => s.length > 0);
  if (lines.length === 0) return 'Extracted signals: none — recommend the default core team.';
  return `Extracted signals — ${lines.join(' / ')}.`;
}
