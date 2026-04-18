// 리더 루프가 매 태스크마다 새 브랜치를 만드는 회귀(#91aeaf7a) 를 막기 위한
// 브랜치 결정 모듈. Project 옵션의 branchStrategy / fixedBranchName /
// branchNamePattern / currentAutoBranch 를 조합해, 다음 실행에서 어떤 브랜치를
// 사용할지 단일 함수로 결정한다.
//
// 계층:
//   1) 'fixed-branch' → 옵션의 fixedBranchName 을 무조건 사용.
//   2) 'per-session' → 서버 메모리 캐시(activeBranchByProjectId) 가 있으면 그 값.
//      없으면 DB projects.currentAutoBranch 를 사용. 둘 다 없으면 renderBranchName
//      으로 1회 생성하고 호출자에게 "처음 생성된 브랜치" 임을 알려 DB+캐시 저장.
//   3) 'per-task' / 'per-commit' (레거시) → 요청마다 renderBranchName 재호출.
//
// 호출자는 resolveBranch() 를 통해 { branch, persist } 를 받아 persist 가 true 이면
// DB 와 메모리 캐시를 모두 갱신한다. 이 모듈은 DB 접근을 직접 하지 않아 단위 테스트
// 가능하다.

import type { BranchStrategy } from '../types';
import { PROJECT_OPTION_DEFAULTS } from '../types';
import { renderBranchName, type TemplateContext } from './gitAutomation';

export interface BranchResolverOptions {
  strategy?: BranchStrategy;
  fixedBranchName?: string;
  branchNamePattern?: string;
  // 세션 캐시 + DB 에서 읽은 값. 둘 중 하나라도 있으면 per-session 전략이 재사용한다.
  cachedActiveBranch?: string;
  persistedActiveBranch?: string;
  // 글로벌 fallback 템플릿(예: git_automation_settings.branchTemplate).
  // 옵션에 branchNamePattern 이 없을 때 사용한다.
  fallbackTemplate?: string;
  templateContext: TemplateContext;
}

export interface BranchResolution {
  branch: string;
  strategy: BranchStrategy;
  // 호출자가 DB/캐시를 갱신해야 하는지 여부. per-session 의 첫 해석에서만 true 가 된다.
  persist: boolean;
  // 재사용된 경우 true. UI/로그에서 "새로 생성된 브랜치가 아님" 을 구분하는 데 쓴다.
  reused: boolean;
  // 디버그/로그 용 — 어느 경로를 탔는지(fixed/cache/persisted/fresh).
  source: 'fixed' | 'cache' | 'persisted' | 'fresh';
}

export function resolveBranch(opts: BranchResolverOptions): BranchResolution {
  const strategy = opts.strategy ?? PROJECT_OPTION_DEFAULTS.branchStrategy;

  if (strategy === 'fixed-branch') {
    const name = opts.fixedBranchName?.trim() || PROJECT_OPTION_DEFAULTS.fixedBranchName;
    return { branch: name, strategy, persist: false, reused: true, source: 'fixed' };
  }

  if (strategy === 'per-session') {
    const cached = opts.cachedActiveBranch?.trim();
    if (cached) return { branch: cached, strategy, persist: false, reused: true, source: 'cache' };
    const persisted = opts.persistedActiveBranch?.trim();
    if (persisted) return { branch: persisted, strategy, persist: true, reused: true, source: 'persisted' };
    const template = (opts.branchNamePattern?.trim() || opts.fallbackTemplate?.trim() || PROJECT_OPTION_DEFAULTS.branchNamePattern);
    const rendered = renderBranchName(template, opts.templateContext);
    return { branch: rendered, strategy, persist: true, reused: false, source: 'fresh' };
  }

  // per-task / per-commit — 매 호출마다 새 브랜치(기존 동작 유지).
  const template = (opts.branchNamePattern?.trim() || opts.fallbackTemplate?.trim() || PROJECT_OPTION_DEFAULTS.branchNamePattern);
  const rendered = renderBranchName(template, opts.templateContext);
  return { branch: rendered, strategy, persist: false, reused: false, source: 'fresh' };
}

// 서버 프로세스가 보유하는 세션 캐시. projects 테이블은 재기동 시 동일 값을
// 복원해 주지만, 같은 프로세스 내에서의 빠른 재사용을 위해 메모리 맵도 병행한다.
// 클래스 대신 단일 Map 을 export 해 테스트에서 clear() 로 상태 리셋이 쉽다.
export class ActiveBranchCache {
  private readonly map = new Map<string, string>();
  get(projectId: string): string | undefined { return this.map.get(projectId); }
  set(projectId: string, branch: string): void { this.map.set(projectId, branch); }
  clear(projectId?: string): void {
    if (projectId) this.map.delete(projectId);
    else this.map.clear();
  }
}
