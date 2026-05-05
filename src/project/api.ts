// 지시 #fa0621b3 · 프로젝트 신규 생성 플로우의 얇은 클라이언트 래퍼.
//
// 디자이너의 3단계 화면 중 3단계("바로 추가") 에서 UI 가 단일 호출로 팀 전원을
// 생성·프로젝트에 편성하도록 묶는다. 내부 구현은 두 기존 엔드포인트를 순차 호출:
//   (1) POST /api/agents/hire       — 이름·역할·아바타·persona 로 에이전트 문서 생성.
//   (2) POST /api/projects/:id/agents — 생성된 agentId 를 프로젝트에 첨부.
//
// 설계
//   · `fetch` 주입 가능(기본 globalThis.fetch). 노드 단위 테스트가 stub 을 주입할 수 있다.
//   · 부분 실패 정책: 한 역할이 실패해도 나머지는 시도한다. 결과는
//     `AppliedTeamResult.items[]` 에 성공/실패를 모두 담아 UI 가 부분 반영 안내 가능.
//   · Leader 는 서버가 신규 프로젝트 생성 시 자동으로 합류시키므로, 추천에 Leader 가
//     포함돼 있어도 이미 프로젝트에 같은 역할의 에이전트가 배정된 경우 충돌할 수 있다.
//     그 판정은 서버 측 책임이며 본 클라이언트 래퍼는 들어온 추천 그대로 위임한다.

import type { AgentRole } from '../types';
import type { AgentRecommendation } from './recommendAgentTeam';
import { dedupeRecommendationNames } from '../utils/agentNameDedup';
import { translate, type Locale } from '../i18n';

export interface ApplyRecommendedTeamOptions {
  /** 테스트 주입 용. 기본 globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** 서버 base URL. 기본 '' (동일 오리진). */
  readonly baseUrl?: string;
  /**
   * 역할별 기본 스프라이트 템플릿. UI 레벨 커스터마이즈가 필요 없으면 생략 가능.
   * 서버는 spriteTemplate 문자열을 그대로 저장만 하므로 빈 문자열이어도 허용.
   */
  readonly spriteTemplateFor?: (role: AgentRole) => string;
  /**
   * 사용자 가시 에러 문구의 locale. UI 컴포넌트가 useLocale().locale 을 그대로 넘긴다.
   * 미주입 시 i18n 모듈의 currentLocale(기본 'en') 을 쓴다.
   */
  readonly locale?: Locale;
}

function fillTemplate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    k in params ? String(params[k]) : `{${k}}`,
  );
}

/** 단일 추천 항목의 적용 결과. */
export interface AppliedAgentResult {
  readonly recommendation: AgentRecommendation;
  readonly agentId?: string;
  readonly ok: boolean;
  /** 실패 시 사람이 읽을 수 있는 메시지(한국어 권장). */
  readonly error?: string;
}

export interface AppliedTeamResult {
  readonly projectId: string;
  readonly items: readonly AppliedAgentResult[];
  /** 성공한 에이전트 수. UI 토스트 "N명 추가됨" 표시에 사용. */
  readonly appliedCount: number;
}

const DEFAULT_SPRITE_TEMPLATE: Record<AgentRole, string> = {
  Leader: 'leader',
  Developer: 'developer',
  QA: 'qa',
  Designer: 'designer',
  Researcher: 'researcher',
};

function resolveFetch(opts: ApplyRecommendedTeamOptions): typeof globalThis.fetch {
  const f = opts.fetch ?? globalThis.fetch;
  if (!f) {
    throw new Error(translate('project.applyTeam.errors.fetchMissing', opts.locale));
  }
  return f;
}

async function hireAgent(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  rec: AgentRecommendation,
  spriteTemplate: string,
  locale: Locale | undefined,
): Promise<string> {
  const res = await fetchImpl(`${baseUrl}/api/agents/hire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: rec.name,
      role: rec.role,
      spriteTemplate,
      persona: rec.rationale,
    }),
  });
  if (!res.ok) {
    throw new Error(
      fillTemplate(translate('project.applyTeam.errors.hireFailed', locale), {
        status: res.status,
      }),
    );
  }
  const body = (await res.json()) as { id?: string };
  if (!body || typeof body.id !== 'string' || body.id.length === 0) {
    throw new Error(translate('project.applyTeam.errors.hireMissingId', locale));
  }
  return body.id;
}

async function attachAgent(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  projectId: string,
  agentId: string,
  locale: Locale | undefined,
): Promise<void> {
  const res = await fetchImpl(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId }),
  });
  if (!res.ok) {
    throw new Error(
      fillTemplate(translate('project.applyTeam.errors.attachFailed', locale), {
        status: res.status,
      }),
    );
  }
}

/**
 * 추천 팀 전체를 프로젝트에 적용. 각 항목을 순차 처리해 부분 실패를 허용한다.
 * 순차 처리 이유: 서버의 `$addToSet` 동시 업데이트 충돌을 회피 + UI 카드의 로딩
 * 인디케이터가 카드별 순서대로 점등되도록 한다(시안 §3.2 "한 명씩 추가 애니메이션").
 */
export async function applyRecommendedTeam(
  projectId: string,
  recommendations: readonly AgentRecommendation[],
  options: ApplyRecommendedTeamOptions = {},
): Promise<AppliedTeamResult> {
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new Error(translate('project.applyTeam.errors.invalidProjectId', options.locale));
  }
  if (!Array.isArray(recommendations) || recommendations.length === 0) {
    return { projectId, items: [], appliedCount: 0 };
  }
  const fetchImpl = resolveFetch(options);
  const baseUrl = options.baseUrl ?? '';
  const spriteFor =
    options.spriteTemplateFor ?? ((role: AgentRole) => DEFAULT_SPRITE_TEMPLATE[role]);

  // 클라이언트 측 1차 방어선 — 호출자가 dedup 안 된 추천을 그대로 넘긴 경우에도
  // hire 직전에 배치 내 이름 충돌을 접미사로 해소한다. 서버는 글로벌 충돌도 다시
  // 검사하지만, 클라이언트에서 미리 끊어 사용자가 hire 응답에서 예상 이름과 다른
  // 결과를 받는 빈도를 줄인다.
  const deduped = dedupeRecommendationNames(recommendations);

  const items: AppliedAgentResult[] = [];
  let appliedCount = 0;
  for (const rec of deduped) {
    try {
      const agentId = await hireAgent(fetchImpl, baseUrl, rec, spriteFor(rec.role), options.locale);
      await attachAgent(fetchImpl, baseUrl, projectId, agentId, options.locale);
      items.push({ recommendation: rec, agentId, ok: true });
      appliedCount += 1;
    } catch (err) {
      items.push({
        recommendation: rec,
        ok: false,
        error: err instanceof Error
          ? err.message
          : translate('project.applyTeam.errors.unknown', options.locale),
      });
    }
  }
  return { projectId, items, appliedCount };
}
