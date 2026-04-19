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

// 저장 row 에 이미 들어있는 branchStrategy 가 "열거값인지" 런타임에서 방어한다.
// DB 수동 편집/구 스키마 잔존/다른 서비스 이식 등으로 유효하지 않은 문자열·비문자
// 값이 들어와 있으면, 그 값을 UI 까지 그대로 흘려보낼 경우 라디오가 "선택 없음"
// 으로 깨져 사용자가 재저장도 할 수 없게 된다. 로드 경계에서 한 번 더 깎아 항상
// 합법적인 BranchStrategy 값만 내보낸다. (쓰기 경로는 updateProjectOptionsSchema
// 가 이미 검증하므로 본 가드는 "과거에 들어온 잘못된 값" 전용 폴백이다.)
function coerceBranchStrategy(value: unknown): BranchStrategy {
  if (typeof value === 'string'
    && (BRANCH_STRATEGY_VALUES as readonly string[]).includes(value.trim())) {
    return value.trim() as BranchStrategy;
  }
  return PROJECT_OPTION_DEFAULTS.branchStrategy;
}

// 같은 이유로 "비어있지 않은 문자열" 을 강제하는 필드도 로드 경계에서 한 번 더
// 깎는다. 쓰기 경로(updateProjectOptionsSchema) 가 이미 trim·비어있음 거부를
// 수행하지만, 과거에 다른 경로(직접 DB 수정·임포트)로 들어와 빈 문자열·비문자가
// 남아 있으면 UI 의 입력란이 "값은 있는데 비어 보이는" 상태로 빠져 사용자가
// 의도치 않은 기본값을 다시 저장하게 된다. trim 후 비어있으면 fallback 으로 폴백.
function coerceNonEmptyString(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return fallback;
}

// boolean 도 동일한 이유로 방어한다. 1/0 같은 숫자 또는 "true"/"false" 같은 문자열
// 이 들어오면 ?? 연산자는 통과시켜 UI 체크박스의 controlled state 가 깨진다.
// 엄격하게 boolean 만 받고 그 외엔 기본값으로 폴백.
function coerceBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
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
  const settingsJsonValue = source.settingsJson;
  const settingsJson = settingsJsonValue
    && typeof settingsJsonValue === 'object'
    && !Array.isArray(settingsJsonValue)
      ? settingsJsonValue
      : { ...PROJECT_OPTION_DEFAULTS.settingsJson };
  return {
    autoDevEnabled: coerceBoolean(source.autoDevEnabled, PROJECT_OPTION_DEFAULTS.autoDevEnabled),
    autoCommitEnabled: coerceBoolean(source.autoCommitEnabled, PROJECT_OPTION_DEFAULTS.autoCommitEnabled),
    autoPushEnabled: coerceBoolean(source.autoPushEnabled, PROJECT_OPTION_DEFAULTS.autoPushEnabled),
    defaultBranch: coerceNonEmptyString(source.defaultBranch, PROJECT_OPTION_DEFAULTS.defaultBranch),
    gitRemoteUrl: typeof source.gitRemoteUrl === 'string' && source.gitRemoteUrl.trim()
      ? source.gitRemoteUrl.trim()
      : undefined,
    sharedGoalId: typeof source.sharedGoalId === 'string' && source.sharedGoalId.trim()
      ? source.sharedGoalId.trim()
      : undefined,
    settingsJson,
    branchStrategy: coerceBranchStrategy(source.branchStrategy),
    fixedBranchName: coerceNonEmptyString(source.fixedBranchName, PROJECT_OPTION_DEFAULTS.fixedBranchName),
    branchNamePattern: coerceNonEmptyString(source.branchNamePattern, PROJECT_OPTION_DEFAULTS.branchNamePattern),
    autoMergeToMain: coerceBoolean(source.autoMergeToMain, PROJECT_OPTION_DEFAULTS.autoMergeToMain),
    currentAutoBranch: typeof source.currentAutoBranch === 'string' && source.currentAutoBranch.trim()
      ? source.currentAutoBranch.trim()
      : undefined,
  };
}

export function hasAnyUpdate(result: ValidatedProjectOptionsUpdate): boolean {
  return Object.keys(result.$set).length > 0 || Object.keys(result.$unset).length > 0;
}
