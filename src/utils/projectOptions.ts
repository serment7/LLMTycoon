// 프로젝트 옵션(자동 개발·자동 커밋·자동 푸시 토글 및 부가 설정) 부분 업데이트
// 요청을 검증하는 순수 함수 모듈. Zod 가 도입되어 있지 않은 저장소라
// 의존성 없이 동기 검증을 수행한다.
//
// 설계 요약:
// - 서버(/api/projects/:id/options)와 클라이언트(useProjectOptions 훅)가
//   동일한 스키마를 통해 입력을 걸러내도록 한 곳에서 정의한다.
// - MongoDB 문서 패치용 $set / $unset 빌더를 함께 반환해 server.ts 호출부가
//   validator 결과를 그대로 updateOne 에 위임할 수 있다.
// - sharedGoalId 의 "해당 프로젝트에 실제로 속하는지" 검증은 DB 조회가 필요해
//   여기서는 수행하지 않는다. 호출부가 필요 시 추가로 검증한다.

import type { ProjectOptionsUpdate, BranchStrategy } from '../types';
import { PROJECT_OPTION_DEFAULTS, BRANCH_STRATEGY_VALUES } from '../types';

export interface ValidatedProjectOptionsUpdate {
  $set: Record<string, unknown>;
  $unset: Record<string, ''>;
}

export class ProjectOptionsValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
    this.name = 'ProjectOptionsValidationError';
  }
}

const BOOL_FIELDS = ['autoDevEnabled', 'autoCommitEnabled', 'autoPushEnabled', 'autoMergeToMain'] as const;

// 입력 검증 + Mongo 업데이트 구문 빌더. 호환성을 위해 "업데이트 할 필드가
// 하나도 없는" 케이스도 정상 반환한다(호출부가 직접 400 처리). `null` 명시는
// "해제" 로 해석해 `$unset` 에 담는다.
export function updateProjectOptionsSchema(input: unknown): ValidatedProjectOptionsUpdate {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProjectOptionsValidationError('body', '요청 본문은 객체여야 합니다');
  }
  const body = input as Record<string, unknown>;
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, ''> = {};

  for (const key of BOOL_FIELDS) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      throw new ProjectOptionsValidationError(key, `${key} 는 boolean 이어야 합니다`);
    }
    $set[key] = value;
  }

  if ('defaultBranch' in body && body.defaultBranch !== undefined) {
    const value = body.defaultBranch;
    if (typeof value !== 'string' || !value.trim()) {
      throw new ProjectOptionsValidationError('defaultBranch', 'defaultBranch 는 비어있지 않은 문자열이어야 합니다');
    }
    $set.defaultBranch = value.trim();
  }

  if ('gitRemoteUrl' in body && body.gitRemoteUrl !== undefined) {
    const value = body.gitRemoteUrl;
    if (value === null) $unset.gitRemoteUrl = '';
    else if (typeof value === 'string') $set.gitRemoteUrl = value.trim();
    else throw new ProjectOptionsValidationError('gitRemoteUrl', 'gitRemoteUrl 은 문자열 또는 null 이어야 합니다');
  }

  if ('sharedGoalId' in body && body.sharedGoalId !== undefined) {
    const value = body.sharedGoalId;
    if (value === null) $unset.sharedGoalId = '';
    else if (typeof value === 'string' && value.trim()) $set.sharedGoalId = value.trim();
    else throw new ProjectOptionsValidationError('sharedGoalId', 'sharedGoalId 는 비어있지 않은 문자열 또는 null 이어야 합니다');
  }

  if ('settingsJson' in body && body.settingsJson !== undefined) {
    const value = body.settingsJson;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ProjectOptionsValidationError('settingsJson', 'settingsJson 은 객체여야 합니다');
    }
    $set.settingsJson = value;
  }

  if ('branchStrategy' in body && body.branchStrategy !== undefined) {
    const value = body.branchStrategy;
    if (typeof value !== 'string' || !BRANCH_STRATEGY_VALUES.includes(value as BranchStrategy)) {
      throw new ProjectOptionsValidationError(
        'branchStrategy',
        `branchStrategy 는 ${BRANCH_STRATEGY_VALUES.join('|')} 중 하나여야 합니다`,
      );
    }
    $set.branchStrategy = value;
  }

  if ('fixedBranchName' in body && body.fixedBranchName !== undefined) {
    const value = body.fixedBranchName;
    if (typeof value !== 'string' || !value.trim()) {
      throw new ProjectOptionsValidationError('fixedBranchName', 'fixedBranchName 은 비어있지 않은 문자열이어야 합니다');
    }
    $set.fixedBranchName = value.trim();
  }

  if ('branchNamePattern' in body && body.branchNamePattern !== undefined) {
    const value = body.branchNamePattern;
    if (typeof value !== 'string' || !value.trim()) {
      throw new ProjectOptionsValidationError('branchNamePattern', 'branchNamePattern 은 비어있지 않은 문자열이어야 합니다');
    }
    $set.branchNamePattern = value.trim();
  }

  return { $set, $unset };
}

// 저장된 프로젝트 문서에서 "옵션 필드" 만 골라 클라이언트 응답을 만든다.
// 문서에 누락된 필드는 PROJECT_OPTION_DEFAULTS 로 채워, 클라이언트는 항상
// 일관된 모양을 받는다.
export interface ProjectOptionsView {
  autoDevEnabled: boolean;
  autoCommitEnabled: boolean;
  autoPushEnabled: boolean;
  defaultBranch: string;
  gitRemoteUrl?: string;
  sharedGoalId?: string;
  settingsJson: Record<string, unknown>;
  branchStrategy: BranchStrategy;
  fixedBranchName: string;
  branchNamePattern: string;
  autoMergeToMain: boolean;
  // 'per-session' 전략 하에서 서버가 재사용 중인 활성 브랜치. 미결정이면 undefined —
  // 클라이언트 패널은 "아직 파이프라인이 한 번도 돌지 않음" 으로 표시한다.
  currentAutoBranch?: string;
}

export function projectOptionsView(
  source: Partial<ProjectOptionsUpdate> & {
    autoDevEnabled?: boolean;
    autoCommitEnabled?: boolean;
    autoPushEnabled?: boolean;
    defaultBranch?: string;
    gitRemoteUrl?: string;
    sharedGoalId?: string;
    settingsJson?: Record<string, unknown>;
    branchStrategy?: BranchStrategy;
    fixedBranchName?: string;
    branchNamePattern?: string;
    autoMergeToMain?: boolean;
    currentAutoBranch?: string;
  },
): ProjectOptionsView {
  return {
    autoDevEnabled: source.autoDevEnabled ?? PROJECT_OPTION_DEFAULTS.autoDevEnabled,
    autoCommitEnabled: source.autoCommitEnabled ?? PROJECT_OPTION_DEFAULTS.autoCommitEnabled,
    autoPushEnabled: source.autoPushEnabled ?? PROJECT_OPTION_DEFAULTS.autoPushEnabled,
    defaultBranch: source.defaultBranch ?? PROJECT_OPTION_DEFAULTS.defaultBranch,
    gitRemoteUrl: source.gitRemoteUrl || undefined,
    sharedGoalId: source.sharedGoalId || undefined,
    settingsJson: source.settingsJson ?? { ...PROJECT_OPTION_DEFAULTS.settingsJson },
    branchStrategy: source.branchStrategy ?? PROJECT_OPTION_DEFAULTS.branchStrategy,
    fixedBranchName: source.fixedBranchName ?? PROJECT_OPTION_DEFAULTS.fixedBranchName,
    branchNamePattern: source.branchNamePattern ?? PROJECT_OPTION_DEFAULTS.branchNamePattern,
    autoMergeToMain: source.autoMergeToMain ?? PROJECT_OPTION_DEFAULTS.autoMergeToMain,
    currentAutoBranch: source.currentAutoBranch || undefined,
  };
}

export function hasAnyUpdate(result: ValidatedProjectOptionsUpdate): boolean {
  return Object.keys(result.$set).length > 0 || Object.keys(result.$unset).length > 0;
}
