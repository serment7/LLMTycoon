/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Git 자동화 패널. 이 패널은 **리더 에이전트가 트리거하는 단일 브랜치 파이프라인**
 * 상태만 노출한다 — 에이전트별 브랜치 목록/선택 UI는 제공하지 않는다.
 * 리더 단일 브랜치 정책: 2026-04-18 리팩터. 실제 브랜치 이름은 서버가
 * `branchPattern` 템플릿으로 단일 문자열을 생성하고, 패널은 그 결과 하나만 읽는다.
 * 배경: 동료 에이전트별로 나뉜 브랜치 축은 UI 폭을 과도하게 점유하고,
 * 리더-중심 트리거 모델(server.ts `executeGitAutomation`)과도 어긋났다.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GitCommit, GitBranch, GitPullRequest, RotateCcw, Save, AlertTriangle, Info, Power, CheckCircle2, Clock3, Check, Square, Loader2, XCircle, Upload, Hash, X } from 'lucide-react';
import { useReducedMotion } from '../utils/useReducedMotion';
import type { BranchStrategy, CommitStrategy } from '../types';
import {
  BRANCH_STRATEGY_VALUES,
  COMMIT_STRATEGY_VALUES,
  COMMIT_STRATEGY_LABEL,
  DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG,
} from '../types';

// 태스크 경계 커밋 옵션별 "UI 전용 힌트". types.ts 의 COMMIT_STRATEGY_LABEL 은 요약
// 라벨만 담당하고, 상세 설명은 컴포넌트 수준에서 관리한다(시안 문구 변경 시 types.ts
// 가 건드려지지 않도록 분리).
const COMMIT_STRATEGY_HINT: Record<CommitStrategy, string> = {
  'per-task': '리더 태스크 1건이 완료될 때마다 자동 커밋을 잘라 냅니다.',
  'per-goal': '공동 목표가 완료 전환될 때 한 번 집계 커밋을 만듭니다.',
  'manual':   '자동 커밋을 하지 않고, 사용자가 직접 트리거할 때만 커밋합니다.',
};

// GitAutomationPanel 전용 기본 접두어. types.ts 의 `TaskBoundaryCommitConfig` 는
// commitMessagePrefix 를 포함하지 않으므로(본 축은 UI 축) 여기서 관리한다.
const DEFAULT_COMMIT_MESSAGE_PREFIX = 'auto: ';

// 디자이너: Git 자동화 흐름은 "되돌릴 수 있는 일 → 원격에 남는 일 → 동료에게 알림이
// 가는 일" 순으로 위험이 누적된다. 3단계 라디오를 가로로 배치하고, 각 단계를
// 초록(안전)/노랑(원격 반영)/빨강(PR 생성) 색으로 코딩해 사용자가 "어디까지 가는
// 버튼인지"를 누르기 전에 시각적으로 인지하도록 설계했다.
export type GitFlowLevel = 'commit' | 'commit-push' | 'full-pr';

export interface GitAutomationSettings {
  flow: GitFlowLevel;
  branchPattern: string;
  commitTemplate: string;
  prTitleTemplate: string;
  // 디자이너: 자동화는 "설정은 남아 있지만 지금은 돌지 않는" 상태와 "지금 실시간으로
  // 돌고 있다"는 상태를 분리해야 사용자가 설정을 잃을까 걱정하지 않고 잠시 꺼둘 수 있다.
  enabled: boolean;
  // 브랜치 운영 전략. 'fixed-branch' 는 사용자가 직접 입력한 newBranchName 을 그대로
  // 사용하고, 나머지는 branchPattern/템플릿 기반으로 매 세션·태스크·커밋에 새 브랜치를
  // 만든다. 디자이너 시안(tests/branch-strategy-mockup.md)과 동일한 4 전략.
  branchStrategy: BranchStrategy;
  // 'fixed-branch' 선택 시 사용되는 고정 브랜치 이름. 다른 전략에서는 서버 측 템플릿
  // 렌더링이 담당하므로 빈 값으로 유지된다. UI 는 값이 비어 있어도 전략 전환에 대비해
  // 마지막 입력을 기억한다.
  newBranchName: string;
  // 태스크 경계 커밋(#f1d5ce51) — 자동 개발 ON 에서 "언제 커밋을 잘라 낼 것인가". 위
  // branchStrategy 와는 별개의 직교 축이다(브랜치 이름 전략 != 커밋 경계 전략).
  commitStrategy: CommitStrategy;
  // 자동 생성 커밋 제목 앞에 항상 붙는 접두어(예: 'auto: '). 빈 문자열이면 원문.
  commitMessagePrefix: string;
}

export const DEFAULT_AUTOMATION: GitAutomationSettings = {
  flow: 'commit',
  branchPattern: '{type}/{ticket}-{branch}',
  commitTemplate: '{type}: {branch}',
  prTitleTemplate: '[{ticket}] {type} — {branch}',
  enabled: true,
  branchStrategy: 'per-session',
  newBranchName: '',
  commitStrategy: DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG.commitStrategy,
  commitMessagePrefix: DEFAULT_COMMIT_MESSAGE_PREFIX,
};

// QA: 'fixed-branch' 전략에서 사용자가 입력한 브랜치명을 git ref 규칙과 팀 관례에
// 비추어 검증한다. 입력·저장·스케줄러 트리거가 모두 같은 판정을 공유하도록 export 한다.
//   - 미입력/공백 전용: 절대 허용하지 않는다 (원격 push 전에 실패).
// - 연속 중복 특수문자(`//`, `..`, `--` 등): git 이 ref 에서 거부하거나 UX 상 혼동을 준다.
//   - 선·후행 슬래시/점, 공백·제어문자: 모두 거부.
//   - 허용 문자는 영문·숫자·`/`·`-`·`_`·`.` 로 한정. 한글 브랜치명은 서버 셸 파서가
//     환경에 따라 깨지는 회귀가 있어 본 입력에서는 사전에 막는다.
export type NewBranchNameValidation =
  | { ok: true }
  | { ok: false; code: 'empty' | 'whitespace' | 'duplicate' | 'invalid'; message: string };

const NEW_BRANCH_NAME_ALLOWED = /^[A-Za-z0-9._\-/]+$/;

export function validateNewBranchName(raw: string): NewBranchNameValidation {
  if (!raw || raw.length === 0) {
    return { ok: false, code: 'empty', message: '브랜치명을 입력하세요' };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, code: 'whitespace', message: '공백만으로는 브랜치를 만들 수 없습니다' };
  }
  if (/\s/.test(raw)) {
    return { ok: false, code: 'whitespace', message: '브랜치명에는 공백을 쓸 수 없습니다' };
  }
  if (/\/\/|\.\.|--/.test(raw)) {
    return { ok: false, code: 'duplicate', message: '연속된 `/`, `.`, `-` 는 허용되지 않습니다' };
  }
  if (/^[./-]|[./-]$/.test(raw)) {
    return { ok: false, code: 'duplicate', message: '브랜치명은 `/`, `.`, `-` 로 시작하거나 끝날 수 없습니다' };
  }
  if (!NEW_BRANCH_NAME_ALLOWED.test(raw)) {
    return { ok: false, code: 'invalid', message: '영문·숫자·`-`·`_`·`.`·`/` 만 사용할 수 있습니다' };
  }
  return { ok: true };
}

// 디자이너: 마지막 실행 시각은 "방금/몇 분 전/오늘"처럼 상대적으로 보여줘야 "이 자동화가
// 살아 있긴 한가?"라는 질문에 한눈에 답이 된다. 1분 미만은 "방금", 60분 미만은 분 단위,
// 24시간 미만은 시 단위, 그 이상은 일 단위로 축약한다. 절대 시각은 title 툴팁에 남긴다.
export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '아직 실행되지 않음';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '아직 실행되지 않음';
  const diffSec = Math.max(0, Math.round((now - t) / 1000));
  if (diffSec < 60) return '방금 전';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}일 전`;
}

// 디자이너: 3단계 옵션 메타데이터. 각 옵션의 위험도와 설명 툴팁은 한 곳에서만
// 관리해 호버/aria-label/미리보기 라벨이 엇나가지 않게 한다.
interface FlowOption {
  key: GitFlowLevel;
  label: string;
  subLabel: string;
  description: string;
  risk: 'safe' | 'remote' | 'pr';
  icon: React.ReactNode;
}

const FLOW_OPTIONS: FlowOption[] = [
  {
    key: 'commit',
    label: 'Commit Only',
    subLabel: '로컬만 기록',
    description: '로컬 저장소에만 커밋합니다. 원격과 동료에게는 아무 변화가 없으며, amend·rebase로 쉽게 되돌릴 수 있습니다.',
    risk: 'safe',
    icon: <GitCommit size={14} />,
  },
  {
    key: 'commit-push',
    label: 'Commit + Push',
    subLabel: '원격 브랜치 반영',
    description: '커밋 후 원격 브랜치로 푸시합니다. 다른 단말/동료가 pull하면 보이며, 되돌리려면 force-push가 필요합니다.',
    risk: 'remote',
    icon: <GitBranch size={14} />,
  },
  {
    key: 'full-pr',
    label: 'Full PR Flow',
    subLabel: 'PR 생성 + 리뷰 요청',
    description: '커밋·푸시에 이어 Pull Request를 생성하고 기본 리뷰어에게 알림을 보냅니다. 팀 전체에 공개되는 고-위험 동선입니다.',
    risk: 'pr',
    icon: <GitPullRequest size={14} />,
  },
];

// 디자이너: 템플릿 변수는 "알고 있으면 편하지만 매번 검색하게 되는" 종류의 지식.
// 각 필드 아래에 인라인 칩으로 노출해, 입력 중에도 바로 눈에 들어오게 한다.
// 리더 단일 브랜치 정책: `{agent}` 토큰은 UI 에서 의도적으로 노출하지 않는다.
// 브랜치가 리더 트리거마다 1개로 고정되므로, 템플릿에 에이전트 이름이 들어갈 이유가 없다.
const TEMPLATE_VARS = [
  { name: '{branch}', hint: '자동 생성된 브랜치 식별자(제목 기반)' },
  { name: '{type}',   hint: '변경 유형 (feat/fix/docs/chore 등)' },
  { name: '{ticket}', hint: '이슈·티켓 번호 (예: LLM-123)' },
] as const;

// 디자이너: 위험도 → 색/테두리 매핑. 한 곳에서만 선언해 라디오 카드·미리보기 배지·
// 제출 버튼이 같은 톤으로 움직이도록 한다. 기존 프로젝트의 pixel accent를 따르되,
// 위험 구분은 범용 green/yellow/red 톤을 사용해 직관성을 우선했다.
const RISK_STYLE: Record<FlowOption['risk'], { ring: string; chip: string; dot: string; label: string; cta: string }> = {
  safe: {
    ring: 'border-emerald-400 ring-emerald-400/40 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.3)]',
    chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/50',
    dot:  'bg-emerald-400',
    label: '안전',
    cta:  'bg-emerald-500 border-b-emerald-700 text-black',
  },
  remote: {
    ring: 'border-yellow-400 ring-yellow-400/40 shadow-[inset_0_0_0_1px_rgba(250,204,21,0.3)]',
    chip: 'bg-yellow-500/15 text-yellow-200 border-yellow-500/50',
    dot:  'bg-yellow-300',
    label: '원격 반영',
    cta:  'bg-yellow-400 border-b-yellow-600 text-black',
  },
  pr: {
    ring: 'border-red-400 ring-red-400/40 shadow-[inset_0_0_0_1px_rgba(248,113,113,0.3)]',
    chip: 'bg-red-500/15 text-red-200 border-red-500/50',
    dot:  'bg-red-400',
    label: 'PR 생성',
    cta:  'bg-red-500 border-b-red-700 text-white',
  },
};

const focusRing = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pixel-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black';

// 디자이너: 상단 요약 바에 체크박스 형태로 노출할 자동화 단계들. flow 레벨이
// 단조증가(commit ⊂ commit+push ⊂ full-pr)하므로, 각 체크박스는 현재 flow에서
// "해당 단계까지 돌아가는가"를 의미한다. mcp__llm-tycoon__get_git_automation_settings
// 호출 결과(설정 객체)를 `initial` prop에 주입하면 동일하게 바인딩된다.
export interface AutomationOptionSummary {
  key: 'commit' | 'push' | 'pr';
  label: string;
  active: boolean;
}

export function deriveAutomationOptions(settings: Pick<GitAutomationSettings, 'flow' | 'enabled'>): AutomationOptionSummary[] {
  const { flow, enabled } = settings;
  return [
    { key: 'commit', label: '자동 커밋',  active: enabled },
    { key: 'push',   label: '자동 푸시',  active: enabled && (flow === 'commit-push' || flow === 'full-pr') },
    { key: 'pr',     label: '자동 PR',    active: enabled && flow === 'full-pr' },
  ];
}

// QA: 템플릿 변수 치환은 순수 함수로 분리해 미리보기·저장·단위 테스트에서 동일하게
// 쓴다. 모르는 변수는 원문 그대로 남겨, 사용자가 오타({brach} 등)를 즉시 발견하도록 한다.
export function renderTemplate(template: string, vars: Record<string, string>): string {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (m, key) => {
    const v = vars[key];
    return typeof v === 'string' && v.length > 0 ? v : m;
  });
}

// QA: 사용자가 아무 변수도 쓰지 않은 템플릿은 "실수로 정적 문자열이 박혔다"는
// 신호일 수 있다. 경고는 차단이 아니라 힌트로만 표시한다(저장은 허용).
export function hasTemplateVariable(template: string): boolean {
  return /\{\w+\}/.test(template);
}

// 디자이너: 커밋/푸시 단계별 라이브 상태. "pending"은 지금 돌고 있다는 신호,
// "success"/"failure"는 가장 최근 실행의 최종 결과. idle 은 한 번도 돌지 않았거나
// 이전 결과가 흐려져도 되는 상태. 단계별로 분리해 "커밋은 성공했는데 푸시에서
// 실패" 같은 부분 실패를 한눈에 전달한다.
export type GitStepStatus = 'idle' | 'pending' | 'success' | 'failure';

export interface GitAutomationPanelProps {
  initial?: Partial<GitAutomationSettings>;
  onSave?: (settings: GitAutomationSettings) => void | Promise<void>;
  onLog?: (text: string) => void;
  // 미리보기용 샘플 값. 호출 측에서 현재 선택된 프로젝트의 기본 브랜치·티켓 등을 주입할 수 있다.
  sample?: Partial<Record<'branch' | 'type' | 'ticket', string>>;
  // 디자이너: 마지막 자동 커밋+푸시 실행 시각(ISO 8601). 미지정이면 "아직 실행되지 않음"으로 표시.
  lastRunAt?: string | null;
  // 디자이너: 마지막 실행이 어떤 흐름(commit / commit+push / full-pr)이었는지 보여줘
  // 설정과 실제 동작의 어긋남을 즉시 포착하도록 한다.
  lastRunFlow?: GitFlowLevel | null;
  // 디자이너: 단계별 라이브 상태. 스케줄러가 커밋을 돌릴 때 'pending' → 'success'/'failure'
  // 로 전이시켜주면, 패널이 색과 아이콘으로 즉시 반영한다.
  commitStatus?: GitStepStatus;
  pushStatus?: GitStepStatus;
  // 디자이너: 마지막 커밋 SHA(7자 축약도 OK, 전체여도 UI에서 앞 7자만 노출). 사용자가
  // "그래서 지금 어떤 커밋이 원격에 올라갔지?"를 터미널 없이 확인할 수 있게 한다.
  lastCommitHash?: string | null;
  // 디자이너: 마지막 성공한 push 시각(ISO 8601). lastRunAt 과 별개로, push 가 실패했을
  // 때에는 갱신되지 않아야 한다 — "원격에 실제로 반영된 마지막 시점"의 신뢰값.
  lastPushAt?: string | null;
  // 디자이너: 가장 최근 실행에서 발생한 에러 메시지. 비어 있으면 토스트는 숨김.
  // 닫기 버튼으로 해제 가능해야 하므로 onDismissError 핸들러를 함께 받는다.
  lastError?: string | null;
  onDismissError?: () => void;
  // 디자이너: 저장 후 "실제로 스케줄러/서버에 반영됐다"는 신호. onSave 가 단순 setState
  // 라면 호출 측에서 save 완료 후 true 로 끌어올리고, "적용됨" 배지를 영구 표시해
  // 사용자가 "저장 버튼이 진짜 먹혔나" 의심하지 않게 한다. 설정이 다시 dirty 가 되면
  // 자동으로 가려진다.
  appliedAt?: string | null;
  // 브랜치 중복 생성 회귀(#91aeaf7a) 대응: 지금 서버가 재사용 중인 활성 브랜치명과
  // 해당 프로젝트의 브랜치 운영 전략을 패널 상단에 노출해, 사용자가 "이번 커밋이
  // 어느 브랜치에 쌓이고 있는가" 를 설정 화면에서 바로 확인하게 한다.
  activeBranch?: string | null;
  branchStrategy?: BranchStrategy | null;
}

// 브랜치 전략 → UI 라벨/설명 매핑. 전략이 추가되더라도 UI 문구를 여기 한 곳에서만
// 관리하면 패널/툴팁/aria-label 이 함께 움직인다.
const BRANCH_STRATEGY_LABEL: Record<BranchStrategy, { label: string; hint: string }> = {
  'per-session': {
    label: '세션 브랜치',
    hint: '한 자동 개발 세션 동안 동일 브랜치를 재사용합니다 (권장).',
  },
  'fixed-branch': {
    label: '고정 브랜치',
    hint: '프로젝트에 고정된 브랜치명을 매번 사용합니다.',
  },
  'per-task': {
    label: '태스크별 브랜치',
    hint: '리더 태스크 1건당 새 브랜치를 만듭니다.',
  },
  'per-commit': {
    label: '커밋별 브랜치',
    hint: '커밋마다 새 브랜치가 생성됩니다 — 브랜치가 쏟아져 나올 수 있어 비권장.',
  },
};

const SAMPLE_DEFAULT: Record<'branch' | 'type' | 'ticket', string> = {
  branch: 'git-automation-panel',
  type: 'feat',
  ticket: 'LLM-0417',
};

// 디자이너: 브랜치 전략 2모드 시안(A안). 4전략 카드(BranchStrategySection) 와 병존 —
// 본 컴포넌트 안에서는 "새로 팔지 / 지금 브랜치 이어서 팔지" 라는 세션 수준 질문에만
// 답하게 한다. 커밋 메시지·자동 푸시와 같은 레이어의 "세션당 한 번만 정하는 세팅" 으로
// 위계가 맞춰져야 하므로 시각 두께도 Template 필드와 동급으로 유지한다.
// 시안 문서: tests/branch-mode-mockup.md
export type BranchMode = 'new' | 'continue';

interface BranchModeOption {
  key: BranchMode;
  label: string;
  subLabel: string;
  description: string;
}

const BRANCH_MODE_OPTIONS: BranchModeOption[] = [
  {
    key: 'new',
    label: '새 브랜치 생성',
    subLabel: '세션 시작 시 한 번',
    description: '리더 단일 브랜치 정책에 따라 세션 시작 시점에 새 브랜치를 하나 만들고, 세션 동안의 모든 커밋을 그 브랜치에 쌓습니다.',
  },
  {
    key: 'continue',
    label: '현재 브랜치에서 계속 작업',
    subLabel: '활성 브랜치 재사용',
    description: '이미 활성화된 브랜치(예: 직전 세션 또는 수동 체크아웃) 에 이어서 커밋합니다. 실험적 수정·긴 PR 을 한 브랜치에 누적하고 싶을 때 선택합니다.',
  },
];

// 접두사(prefix) 규칙 — Git Flow·Conventional Branch 관례를 합쳐 4종을 기본 제공.
// 칩 클릭 시 newBranchName 입력 필드의 prefix 를 교체(이미 동일 prefix 면 유지).
const BRANCH_PREFIXES: Array<{ prefix: string; hint: string }> = [
  { prefix: 'feature/', hint: '새 기능 · 사용자에게 보이는 가치 추가' },
  { prefix: 'fix/',     hint: '버그 수정 · 회귀 또는 결함 복구' },
  { prefix: 'chore/',   hint: '잡무 · 의존성·설정·리팩터 등 사용자 체감 없음' },
  { prefix: 'docs/',    hint: '문서 · 주석·README·시안 문서 갱신' },
];

const BRANCH_PREFIX_REGEX = /^(feature|fix|chore|docs|hotfix|refactor)\//i;

// 접두사 칩 클릭 시 현재 newBranchName 의 prefix 부분만 교체한다. 이름 뒷부분(슬러그)
// 은 보존해 사용자가 입력하던 이름을 잃지 않게 한다. 값이 비어 있으면 prefix 만 삽입.
export function replaceBranchPrefix(current: string, nextPrefix: string): string {
  const trimmed = (current ?? '').trim();
  if (!trimmed) return nextPrefix;
  if (BRANCH_PREFIX_REGEX.test(trimmed)) {
    return trimmed.replace(BRANCH_PREFIX_REGEX, nextPrefix);
  }
  return `${nextPrefix}${trimmed}`;
}

// 디자이너: 단계별 상태 메타데이터. 색·아이콘·라벨을 한 곳에서만 관리해
// 커밋/푸시 두 배지가 같은 톤으로 움직이고, 새 상태가 추가될 때도 한 군데만 확장한다.
const STEP_STATUS_STYLE: Record<GitStepStatus, { ring: string; chip: string; dot: string; label: string; srLabel: string }> = {
  idle: {
    ring: 'border-white/20',
    chip: 'bg-black/40 text-white/50 border-white/20',
    dot: 'bg-white/30',
    label: '대기',
    srLabel: '대기 중 — 아직 실행되지 않음',
  },
  pending: {
    ring: 'border-sky-400',
    chip: 'bg-sky-500/15 text-sky-200 border-sky-400/60',
    dot: 'bg-sky-300',
    label: '진행 중',
    srLabel: '진행 중',
  },
  success: {
    ring: 'border-emerald-400',
    chip: 'bg-emerald-500/15 text-emerald-200 border-emerald-400/60',
    dot: 'bg-emerald-400',
    label: '성공',
    srLabel: '성공',
  },
  failure: {
    ring: 'border-red-400',
    chip: 'bg-red-500/15 text-red-200 border-red-400/60',
    dot: 'bg-red-400',
    label: '실패',
    srLabel: '실패',
  },
};

// 디자이너: 전체 해시가 오든 축약본이 오든 UI는 앞 7자만 노출. 대문자·공백은 다듬는다.
export function shortCommitHash(hash: string | null | undefined): string {
  if (!hash) return '';
  const clean = hash.trim();
  if (!clean) return '';
  return clean.slice(0, 7).toLowerCase();
}

export function GitAutomationPanel({
  initial, onSave, onLog, sample, lastRunAt, lastRunFlow,
  commitStatus = 'idle', pushStatus = 'idle',
  lastCommitHash, lastPushAt, lastError, onDismissError, appliedAt,
  activeBranch, branchStrategy,
}: GitAutomationPanelProps) {
  // 활성 토글의 글로우 펄스를 prefers-reduced-motion 사용자에게 끈다 — 색은 유지.
  const reducedMotion = useReducedMotion();
  const baseline = useMemo<GitAutomationSettings>(() => ({ ...DEFAULT_AUTOMATION, ...(initial ?? {}) }), [initial]);
  const [flow, setFlow] = useState<GitFlowLevel>(baseline.flow);
  const [branchPattern, setBranchPattern] = useState(baseline.branchPattern);
  const [commitTemplate, setCommitTemplate] = useState(baseline.commitTemplate);
  const [prTitleTemplate, setPrTitleTemplate] = useState(baseline.prTitleTemplate);
  const [enabled, setEnabled] = useState<boolean>(baseline.enabled);
  const [branchStrategyChoice, setBranchStrategyChoice] = useState<BranchStrategy>(baseline.branchStrategy);
  const [newBranchName, setNewBranchName] = useState<string>(baseline.newBranchName);
  // 태스크 경계 커밋 상태(#f1d5ce51). baseline 이 initial 변경으로 재계산되면 useEffect
  // 의 복원 훅이 baseline 값으로 다시 세팅해 기존 하이드레이션 레이스 회피 패턴(1587ea9)
  // 과 동일 리듬을 유지한다. 초기 렌더에서 이미 baseline 값으로 세팅되므로 "저장
  // 전에 로드가 한 번 덮는" 케이스도 깨지지 않는다.
  const [commitStrategy, setCommitStrategy] = useState<CommitStrategy>(baseline.commitStrategy);
  const [commitMessagePrefix, setCommitMessagePrefix] = useState<string>(baseline.commitMessagePrefix);
  // 디자이너: 2모드 라디오 시안(A안) 전용 local 상태. onSave 페이로드와 분리해 사용 —
  // 본 블록은 아직 "시안" 단계이므로 서버 스키마를 건드리지 않고 UI 만 먼저 검증한다.
  // 후속 단계에서 Joker 가 4전략 라디오와 통합 결정을 내리면 해당 블록 중 하나를 철거.
  const [branchModeSketch, setBranchModeSketch] = useState<BranchMode>('new');
  const [branchNameSketch, setBranchNameSketch] = useState<string>('feature/');
  // 디자이너: "어디에 값이 들어가 있는지" 모를 때 변수 칩을 클릭하면 해당 필드 끝에
  // 삽입되도록, 현재 포커스된 필드 키를 추적한다. 포커스 잃어도 마지막 값을 유지해
  // 칩 클릭 시 의도한 곳에 확실히 삽입되게 한다.
  const [activeField, setActiveField] = useState<'branch' | 'commit' | 'pr'>('commit');

  // 디자이너: 저장 직후에만 잠깐 나타나는 "저장됨" 배지. 사용자가 버튼을 눌렀는지
  // 아닌지 확신하지 못하는 상황을 없애기 위해, 저장 직후 2.8초간 초록 배지를 띄운다.
  // aria-live=polite로 스크린리더에도 알림이 간다.
  const [justSaved, setJustSaved] = useState<number | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
  }, []);

  // 하이드레이션 레이스 방지(1587ea9 패턴 확장). `initial` 프롭이 비동기 로드로 늦게
  // 도착해 baseline 이 재계산되면, useState 초기값으로만 잡혀 있던
  // branchStrategyChoice/newBranchName 이 DEFAULT_AUTOMATION 으로 남아 셀렉트 UI 가
  // 저장값을 반영하지 못하는 회귀를 막는다. 저장 경로는 onSave 가 같은 값을 부모에
  // 전파하므로 본 훅은 no-op 이다. 프로젝트 전환은 부모 쪽 Fragment key 로 재마운트돼
  // 여기로 들어오지 않는다.
  useEffect(() => {
    setBranchStrategyChoice(baseline.branchStrategy);
    setNewBranchName(baseline.newBranchName);
  }, [baseline.branchStrategy, baseline.newBranchName]);

  const sampleVars = { ...SAMPLE_DEFAULT, ...(sample ?? {}) };
  const selected = FLOW_OPTIONS.find(o => o.key === flow) ?? FLOW_OPTIONS[0];
  const risk = RISK_STYLE[selected.risk];

  const preview = useMemo(() => ({
    branch: renderTemplate(branchPattern, sampleVars),
    commit: renderTemplate(commitTemplate, sampleVars),
    prTitle: renderTemplate(prTitleTemplate, sampleVars),
  }), [branchPattern, commitTemplate, prTitleTemplate, sampleVars.branch, sampleVars.type, sampleVars.ticket]);

  const dirty = flow !== baseline.flow
    || branchPattern !== baseline.branchPattern
    || commitTemplate !== baseline.commitTemplate
    || prTitleTemplate !== baseline.prTitleTemplate
    || enabled !== baseline.enabled
    || branchStrategyChoice !== baseline.branchStrategy
    || newBranchName !== baseline.newBranchName
    || commitStrategy !== baseline.commitStrategy
    || commitMessagePrefix !== baseline.commitMessagePrefix;

  // 'fixed-branch' 전략일 때만 사용자가 입력한 브랜치명이 저장·실행 페이로드에 실린다.
  // 다른 전략에서는 검증을 돌리지 않고 입력값도 저장 시 빈 문자열로 비운다.
  const needsNewBranchInput = branchStrategyChoice === 'fixed-branch';
  const newBranchValidation = useMemo(() =>
    needsNewBranchInput ? validateNewBranchName(newBranchName) : ({ ok: true } as NewBranchNameValidation),
  [needsNewBranchInput, newBranchName]);
  const newBranchError = newBranchValidation.ok ? null : newBranchValidation.message;

  const reset = () => {
    setFlow(baseline.flow);
    setBranchPattern(baseline.branchPattern);
    setCommitTemplate(baseline.commitTemplate);
    setPrTitleTemplate(baseline.prTitleTemplate);
    setEnabled(baseline.enabled);
    setBranchStrategyChoice(baseline.branchStrategy);
    setNewBranchName(baseline.newBranchName);
    setCommitStrategy(baseline.commitStrategy);
    setCommitMessagePrefix(baseline.commitMessagePrefix);
    onLog?.('Git 자동화 설정 초기화');
  };

  const save = () => {
    if (needsNewBranchInput && !newBranchValidation.ok) {
      // 저장 버튼이 disabled 여도 Enter 키나 폼 submit 경로로 들어오는 경우를 방어한다.
      onLog?.(`Git 자동화 저장 실패: ${newBranchValidation.message}`);
      return;
    }
    const next: GitAutomationSettings = {
      flow,
      branchPattern,
      commitTemplate,
      prTitleTemplate,
      enabled,
      branchStrategy: branchStrategyChoice,
      newBranchName: needsNewBranchInput ? newBranchName.trim() : '',
      commitStrategy,
      // 접두어 앞뒤 공백이 "실수로 입력된 한 칸" 이면 커밋 메시지에 불필요한 공백이
      // 반복 누적되므로 양끝만 trim. 사이 공백(예: 'auto: ') 은 사용자가 의도한
      // 표식이므로 보존한다.
      commitMessagePrefix: commitMessagePrefix.replace(/^\s+|\s+$/g, ''),
    };
    onSave?.(next);
    const strategyLabel = BRANCH_STRATEGY_LABEL[branchStrategyChoice]?.label ?? branchStrategyChoice;
    const branchSuffix = needsNewBranchInput ? ` · ${next.newBranchName}` : '';
    onLog?.(`Git 자동화 저장: ${FLOW_OPTIONS.find(o => o.key === flow)?.label} (${risk.label}) · ${strategyLabel}${branchSuffix}${enabled ? '' : ' · 비활성'}`);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    setJustSaved(Date.now());
    savedTimerRef.current = setTimeout(() => setJustSaved(null), 2800);
  };

  const toggleEnabled = () => {
    const nv = !enabled;
    setEnabled(nv);
    onLog?.(`Git 자동화 ${nv ? '활성화' : '비활성화'} (미저장)`);
  };

  const optionSummary = useMemo(() => deriveAutomationOptions({ flow, enabled }), [flow, enabled]);

  const lastRunLabel = formatRelativeTime(lastRunAt ?? null);
  const lastRunAbs = lastRunAt ? new Date(lastRunAt).toLocaleString('ko-KR') : '';
  const lastRunFlowOpt = lastRunFlow ? FLOW_OPTIONS.find(o => o.key === lastRunFlow) : null;
  const lastRunStyle = lastRunFlowOpt ? RISK_STYLE[lastRunFlowOpt.risk] : null;

  const insertVariable = (variable: string) => {
    if (activeField === 'branch') setBranchPattern(prev => prev + variable);
    else if (activeField === 'commit') setCommitTemplate(prev => prev + variable);
    else setPrTitleTemplate(prev => prev + variable);
  };

  return (
    <section
      role="region"
      aria-label="Git 자동화 설정"
      className="mb-4 bg-[#0f3460] border-2 border-[var(--pixel-border)] p-4 space-y-4"
    >
      <header className="flex items-center gap-2 flex-wrap">
        <GitBranch size={16} className="text-[var(--pixel-accent)]" />
        <h3 className="text-sm font-bold text-[var(--pixel-accent)] uppercase tracking-wider">Git 자동화 패널</h3>
        <span className={`px-2 py-0.5 text-[10px] font-bold uppercase border-2 tabular-nums ${risk.chip}`} aria-label={`현재 위험도 ${risk.label}`}>
          <span className={`inline-block w-1.5 h-1.5 mr-1 align-middle ${risk.dot}`} />
          {risk.label}
        </span>

        {/* 디자이너: 저장됨 배지 — 저장 직후 2.8초간만 표시. 이미 저장된 상태(깨끗한 폼)
            일 때는 더 옅은 톤의 "저장됨" 뱃지를 영구 표시해 "내 변경이 남아 있나"라는
            의문을 없앤다. 수정 중(dirty)에는 두 배지 모두 숨기고 "수정됨" 힌트를 띄운다. */}
        <div aria-live="polite" className="inline-flex items-center">
          {justSaved && (
            <span
              role="status"
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border-2 border-emerald-400 bg-emerald-500/25 text-emerald-100 animate-[pulse_1.2s_ease-in-out_1]"
              aria-label="설정이 저장되었습니다"
              title={`저장됨 · ${new Date(justSaved).toLocaleTimeString('ko-KR')}`}
            >
              <CheckCircle2 size={10} /> 저장됨
            </span>
          )}
          {!justSaved && !dirty && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border-2 border-emerald-500/40 bg-emerald-500/10 text-emerald-300/90"
              title="현재 설정이 저장된 상태와 일치합니다"
            >
              <CheckCircle2 size={10} /> 저장된 상태
            </span>
          )}
          {/* 디자이너: "적용됨" 배지 — onSave 이후 호출 측이 appliedAt 을 채워주면
              저장된 설정이 실제 스케줄러/서버에 반영됐다는 신호로 상시 표시된다.
              dirty 상태에서는 숨겨 사용자가 "방금 적용됐다"는 착각을 하지 않게 한다. */}
          {!dirty && appliedAt && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border-2 border-cyan-400/70 bg-cyan-500/15 text-cyan-100"
              title={`${new Date(appliedAt).toLocaleString('ko-KR')}에 실제 적용됨`}
            >
              <CheckCircle2 size={10} /> 적용됨 · {formatRelativeTime(appliedAt)}
            </span>
          )}
          {!justSaved && dirty && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border-2 border-amber-400/70 bg-amber-500/15 text-amber-200"
              title="변경 사항이 아직 저장되지 않았습니다"
            >
              <AlertTriangle size={10} /> 미저장
            </span>
          )}
        </div>

        {/* 디자이너: 자동화 활성/비활성 토글. 스위치 좌측에 녹색/회색 '점등 인디케이터'를
            두어 멀리서도 "지금 돌고 있나"를 0.5초 안에 판별할 수 있게 한다. 활성 시에는
            초록 글로우가 깜박이고, 비활성 시에는 무채색 점으로 정지감을 준다. */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`자동화 ${enabled ? '비활성화' : '활성화'}`}
          onClick={toggleEnabled}
          title={enabled ? '자동화 동작 중 — 클릭하면 일시 중지' : '자동화 일시 중지됨 — 클릭하면 재개'}
          className={`ml-auto inline-flex items-center gap-2 px-2 py-1 text-[10px] font-bold uppercase tracking-wider border-2 transition-colors ${focusRing} ${
            enabled
              ? 'border-emerald-400 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'
              : 'border-white/20 bg-black/30 text-white/50 hover:text-white/80 hover:border-white/40'
          }`}
        >
          <span
            aria-hidden="true"
            className={`inline-block w-2 h-2 rounded-full ${
              enabled
                ? `bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.75)]${reducedMotion ? '' : ' animate-pulse'}`
                : 'bg-white/30'
            }`}
          />
          <Power size={10} />
          {enabled ? '활성' : '일시 중지'}
          {/* 디자이너: 미니 토글 트랙 — 활성 여부를 색+위치 두 축으로 동시에 표현해 색각 이상 사용자도 즉시 인지. */}
          <span
            aria-hidden="true"
            className={`relative inline-block w-7 h-3 border ${enabled ? 'border-emerald-400 bg-emerald-500/30' : 'border-white/30 bg-black/40'}`}
          >
            <span
              className={`absolute top-[1px] w-2 h-2 transition-all ${enabled ? 'left-[15px] bg-emerald-300' : 'left-[1px] bg-white/40'}`}
            />
          </span>
        </button>

        <span className="basis-full text-[10px] text-white/50 flex items-center gap-1">
          <Info size={10} /> 위험도는 실행 시 영향 범위에 따라 색으로 구분됩니다.
        </span>
      </header>

      {/* 디자이너: 활성화된 자동화 옵션 요약 바. 현재 설정에서 어떤 단계까지 자동으로
          돌아가는지를 체크박스 형태로 한 줄에 보여줘, 상세 설정을 펼치지 않아도
          "이 프로젝트는 커밋까지만 자동으로 돈다" 같은 판단이 즉시 가능하게 한다. */}
      <div
        role="group"
        aria-label="활성화된 자동화 옵션 요약"
        className={`flex items-center gap-3 flex-wrap px-3 py-2 border-2 ${
          enabled ? 'border-[var(--pixel-border)] bg-black/30' : 'border-white/10 bg-black/20 opacity-70'
        }`}
      >
        <span className="text-[10px] uppercase tracking-wider text-white/50">현재 자동화 옵션</span>
        {optionSummary.map(opt => (
          <span
            key={opt.key}
            role="checkbox"
            aria-checked={opt.active}
            aria-label={`${opt.label} ${opt.active ? '활성' : '비활성'}`}
            title={opt.active ? `${opt.label} — 활성화됨` : `${opt.label} — 비활성`}
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider border-2 tabular-nums ${
              opt.active
                ? 'border-emerald-400 bg-emerald-500/15 text-emerald-200'
                : 'border-white/20 bg-black/30 text-white/40'
            }`}
          >
            <span
              aria-hidden="true"
              className={`inline-flex items-center justify-center w-3 h-3 border ${
                opt.active ? 'border-emerald-300 bg-emerald-500/30' : 'border-white/30 bg-black/40'
              }`}
            >
              {opt.active ? <Check size={9} /> : <Square size={7} className="opacity-0" />}
            </span>
            {opt.label}
          </span>
        ))}
        {!enabled && (
          <span className="ml-auto px-2 py-0.5 text-[10px] font-bold uppercase border-2 border-white/20 bg-black/40 text-white/60">
            일시 중지됨
          </span>
        )}
      </div>

      {/* 디자이너: 마지막 자동 커밋+푸시 실행 시각. 상대 시각(방금/분/시간/일)을 큼지막하게
          보여주고, 절대 시각은 title 툴팁과 sr-only로 제공한다. 실행 흐름(flow)이 현재 설정과
          다르면 "이전 실행은 X로 돌았음" 힌트를 덧붙여 사용자가 설정 변경 반영 여부를 확인하게 한다. */}
      <div
        role="status"
        aria-label="마지막 자동 커밋+푸시 실행 정보"
        className={`flex items-center gap-3 px-3 py-2 border-2 ${
          enabled ? 'border-[var(--pixel-border)] bg-black/30' : 'border-white/10 bg-black/20 opacity-70'
        }`}
      >
        <span className={`inline-flex items-center justify-center w-7 h-7 border-2 ${
          lastRunAt ? 'border-emerald-400/60 bg-emerald-500/10 text-emerald-300' : 'border-white/20 bg-black/30 text-white/40'
        }`}>
          <Clock3 size={14} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[9px] uppercase tracking-wider text-white/50">마지막 자동 커밋 + 푸시</div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span
              className={`text-[13px] font-mono tabular-nums ${lastRunAt ? 'text-white' : 'text-white/40 italic'}`}
              title={lastRunAbs || '마지막 실행 기록이 없습니다'}
            >
              {lastRunLabel}
            </span>
            {lastRunAbs && (
              <span className="text-[10px] text-white/40 font-mono truncate" aria-hidden="true">{lastRunAbs}</span>
            )}
            {lastRunAbs && <span className="sr-only">절대 시각 {lastRunAbs}</span>}
          </div>
        </div>
        {lastRunFlowOpt && lastRunStyle && (
          <span
            className={`px-2 py-0.5 text-[10px] font-bold uppercase border-2 tabular-nums ${lastRunStyle.chip}`}
            title={`지난 실행 흐름: ${lastRunFlowOpt.label}${lastRunFlow !== flow ? ' — 현재 설정과 다름' : ''}`}
          >
            <span className={`inline-block w-1.5 h-1.5 mr-1 align-middle ${lastRunStyle.dot}`} />
            {lastRunFlowOpt.label}
            {lastRunFlow !== flow && <span className="ml-1 text-white/70">≠</span>}
          </span>
        )}
        {!enabled && (
          <span className="px-2 py-0.5 text-[10px] font-bold uppercase border-2 border-white/20 bg-black/40 text-white/60">
            일시 중지됨
          </span>
        )}
      </div>

      {/* 디자이너: 실행 상태 행 — 커밋/푸시 단계의 pending/success/failure 를 두 배지로
          표시하고, 성공 시 커밋 해시(앞 7자)와 마지막 푸시 시각을 함께 노출한다. 스케줄러가
          돌지 않으면 전체가 '대기' 톤으로 눌려 보여 "아무 일도 일어나지 않고 있음"을 전달한다. */}
      <div
        role="status"
        aria-live="polite"
        aria-label="자동화 실행 상태"
        className={`flex items-center gap-3 px-3 py-2 border-2 flex-wrap ${
          enabled ? 'border-[var(--pixel-border)] bg-black/30' : 'border-white/10 bg-black/20 opacity-70'
        }`}
      >
        <span className="text-[10px] uppercase tracking-wider text-white/50 shrink-0">실행 상태</span>
        <StepStatusBadge
          icon={<GitCommit size={11} />}
          label="커밋"
          status={commitStatus}
          reducedMotion={reducedMotion}
        />
        <StepStatusBadge
          icon={<Upload size={11} />}
          label="푸시"
          status={pushStatus}
          reducedMotion={reducedMotion}
          muted={flow === 'commit'}
          mutedHint="Commit Only 흐름에서는 푸시가 실행되지 않습니다"
        />
        {/* 디자이너: 커밋 해시 칩 — 성공/대기와 무관하게 "가장 최근에 남긴 커밋"이 있으면
            항상 표시한다. 터미널 없이도 어떤 SHA 가 원격에 올라갔는지 확인 가능. */}
        {shortCommitHash(lastCommitHash) && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono tabular-nums border-2 border-[var(--pixel-border)] bg-black/40 text-white/80"
            title={`마지막 커밋: ${lastCommitHash}`}
            aria-label={`마지막 커밋 해시 ${shortCommitHash(lastCommitHash)}`}
          >
            <Hash size={10} className="text-[var(--pixel-accent)]" />
            {shortCommitHash(lastCommitHash)}
          </span>
        )}
        {/* 디자이너: 마지막 푸시 시각 — lastRunAt(=전체 사이클) 과 달리 "실제로 원격이 갱신된 마지막
            순간"만 표시. 실패한 사이클에서는 갱신되지 않아, 원격의 신선도를 신뢰할 수 있다. */}
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono border-2 tabular-nums ${
            lastPushAt
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
              : 'border-white/15 bg-black/30 text-white/40 italic'
          }`}
          title={lastPushAt ? `원격 푸시 완료: ${new Date(lastPushAt).toLocaleString('ko-KR')}` : '아직 원격 푸시 기록이 없습니다'}
        >
          <Upload size={10} /> 푸시 {formatRelativeTime(lastPushAt ?? null)}
        </span>
      </div>

      {/* 디자이너: 에러 토스트 — 패널 상단에 고정되는 인-패널 배너 형태. 전역 토스트로
          뺄 수도 있지만, "어느 설정에 문제가 생겼는지"를 맥락과 함께 보여주려면 패널
          안에 두는 편이 원인-결과 연결을 짧게 유지한다. role=alert 로 스크린리더에 즉시 알림. */}
      {lastError && (
        <div
          role="alert"
          className="flex items-start gap-2 px-3 py-2 border-2 border-red-400 bg-red-500/15 text-red-100"
        >
          <XCircle size={14} className="shrink-0 mt-0.5 text-red-300" />
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-red-200/80 font-bold">자동화 실패</div>
            <div className="text-[11px] font-mono break-words">{lastError}</div>
          </div>
          {onDismissError && (
            <button
              type="button"
              onClick={onDismissError}
              aria-label="에러 메시지 닫기"
              title="닫기"
              className={`shrink-0 p-1 border-2 border-red-400/50 text-red-200 hover:bg-red-500/25 hover:text-white transition-colors ${focusRing}`}
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}

      <fieldset className="grid grid-cols-1 md:grid-cols-3 gap-2" aria-label="자동화 흐름 수준 선택">
        <legend className="sr-only">자동화 흐름 수준 선택</legend>
        {FLOW_OPTIONS.map(opt => {
          const style = RISK_STYLE[opt.risk];
          const isActive = opt.key === flow;
          return (
            <label
              key={opt.key}
              title={opt.description}
              className={`relative cursor-pointer select-none border-2 p-3 flex flex-col gap-1 transition-all bg-black/30 hover:-translate-y-0.5 ${
                isActive
                  ? `${style.ring} ring-2`
                  : 'border-[var(--pixel-border)] hover:border-[var(--pixel-accent)]'
              }`}
            >
              <input
                type="radio"
                name="git-flow-level"
                value={opt.key}
                checked={isActive}
                onChange={() => setFlow(opt.key)}
                className={`sr-only peer ${focusRing}`}
                aria-describedby={`flow-${opt.key}-desc`}
              />
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center justify-center w-5 h-5 border-2 ${isActive ? style.chip : 'border-[var(--pixel-border)] bg-black/40'}`}>
                  {isActive && <span className={`w-2 h-2 ${style.dot}`} />}
                </span>
                <span className="text-[var(--pixel-accent)]">{opt.icon}</span>
                <span className="text-[12px] font-bold uppercase tracking-wider text-white">{opt.label}</span>
              </div>
              <span className="text-[10px] text-white/60 uppercase tracking-wider">{opt.subLabel}</span>
              <span id={`flow-${opt.key}-desc`} className="text-[10px] text-white/70 leading-relaxed">
                {opt.description}
              </span>
              <span className={`mt-1 self-start px-1.5 py-0.5 text-[9px] font-bold uppercase border tabular-nums ${style.chip}`}>
                <span className={`inline-block w-1 h-1 mr-1 align-middle ${style.dot}`} />
                {style.label}
              </span>
            </label>
          );
        })}
      </fieldset>

      {/* 디자이너: 브랜치 전략 2모드 라디오 시안(A안) — 4전략 카드와 병존하는 단순화 대안.
          시안 문서: tests/branch-mode-mockup.md. 이 블록은 아직 onSave 페이로드에 실리지
          않고, 4전략 라디오가 실제 저장 값을 담당한다. 팀이 A안(2모드) 채택을 결정하면
          아래 4전략 fieldset 을 철거하고 본 블록의 상태를 GitAutomationSettings 로 승격한다.
          시각 위계: 커밋 메시지·자동 푸시와 같은 "세션당 한 번" 레이어이므로 Template
          필드 블록과 동일한 border-2·bg-black/30 틀을 사용해 두께를 맞춘다. */}
      <fieldset
        role="radiogroup"
        aria-labelledby="branch-mode-sketch-heading"
        data-mockup="branch-mode-A"
        className="branch-mode border-2 border-[var(--pixel-border)] bg-black/30 p-3 space-y-2"
        data-mode={branchModeSketch}
      >
        <legend
          id="branch-mode-sketch-heading"
          className="px-1 text-[10px] font-bold text-[var(--pixel-accent)] uppercase tracking-wider flex items-center gap-2"
        >
          <GitBranch size={10} />
          브랜치 전략 · 2모드 시안 (A안)
          <span className="text-[9px] text-white/40 normal-case tracking-normal">
            — 단순화 대안 · 아직 저장되지 않음
          </span>
        </legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {BRANCH_MODE_OPTIONS.map(opt => {
            const isActive = branchModeSketch === opt.key;
            const isContinueActive = opt.key === 'continue' && isActive && !!activeBranch;
            return (
              <label
                key={opt.key}
                title={opt.description}
                data-kind={opt.key}
                data-active={isContinueActive ? '1' : '0'}
                className={`branch-mode__card relative cursor-pointer select-none flex flex-col gap-1 transition-colors ${
                  isActive ? '' : 'hover:border-[var(--pixel-accent)]/60'
                }`}
              >
                <input
                  type="radio"
                  name="git-branch-mode-sketch"
                  value={opt.key}
                  checked={isActive}
                  onChange={() => setBranchModeSketch(opt.key)}
                  aria-describedby={`branch-mode-${opt.key}-desc`}
                  className={`sr-only peer ${focusRing}`}
                />
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`inline-flex items-center justify-center w-4 h-4 border-2 ${
                      isActive
                        ? 'border-[var(--pixel-accent)] bg-[var(--pixel-accent)]/20'
                        : 'border-[var(--pixel-border)] bg-black/40'
                    }`}
                  >
                    {isActive && <span className="w-2 h-2 bg-[var(--pixel-accent)]" />}
                  </span>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-white">{opt.label}</span>
                </div>
                <span className="text-[9px] text-white/50 uppercase tracking-wider">{opt.subLabel}</span>
                <span
                  id={`branch-mode-${opt.key}-desc`}
                  className="branch-mode__hint"
                >
                  {opt.description}
                </span>
              </label>
            );
          })}
        </div>

        {branchModeSketch === 'new' && (
          <div className="branch-mode__body pt-2">
            <label className="block">
              <span className="flex items-center gap-2 text-[10px] font-bold text-[var(--pixel-accent)] uppercase tracking-wider mb-1">
                브랜치명
                <span className="text-[9px] text-white/40 normal-case">— 접두사는 아래 칩으로 교체할 수 있습니다</span>
              </span>
              <input
                type="text"
                value={branchNameSketch}
                onChange={e => setBranchNameSketch(e.target.value)}
                placeholder="feature/short-slug"
                aria-describedby="branch-mode-new-hint"
                className={`w-full bg-black/40 border-2 border-[var(--pixel-border)] px-3 py-2 text-sm text-white font-mono placeholder:text-white/30 focus:border-[var(--pixel-accent)] focus:outline-none ${focusRing}`}
              />
              <p id="branch-mode-new-hint" className="mt-1 text-[10px] flex items-center gap-1 branch-mode__hint">
                <Info size={10} />
                접두사 규칙: <code className="font-mono text-[var(--pixel-accent)]">feature/</code>·<code className="font-mono text-[var(--pixel-accent)]">fix/</code>·<code className="font-mono text-[var(--pixel-accent)]">chore/</code>·<code className="font-mono text-[var(--pixel-accent)]">docs/</code> 중 하나로 시작해 목적을 즉시 드러냅니다.
              </p>
            </label>
            <div className="flex flex-wrap items-center gap-2" aria-label="접두사 규칙 칩">
              <span className="text-[9px] text-white/50 uppercase tracking-wider">접두사:</span>
              {BRANCH_PREFIXES.map(p => (
                <button
                  key={p.prefix}
                  type="button"
                  onClick={() => setBranchNameSketch(prev => replaceBranchPrefix(prev, p.prefix))}
                  title={p.hint}
                  aria-label={`${p.prefix} 접두사로 교체`}
                  className={`branch-mode__prefix-chip ${focusRing}`}
                >
                  {p.prefix}
                </button>
              ))}
            </div>
          </div>
        )}

        {branchModeSketch === 'continue' && (
          <div className="branch-mode__body pt-2">
            <p className="text-[11px] text-white/80 leading-relaxed">
              <span className="text-[var(--branch-mode-continue-accent,_#34d399)] font-bold">현재 브랜치</span>
              {' '}에 이어서 커밋합니다. 새 브랜치는 만들어지지 않으며, 다음 세션도 같은 브랜치에 쌓입니다.
            </p>
            <div className="flex items-center gap-2 px-2 py-1.5 border-2 border-[var(--branch-mode-continue-accent,_#34d399)]/40 bg-black/40">
              <GitBranch size={12} className="text-[var(--branch-mode-continue-accent,_#34d399)]" />
              <span className="text-[9px] uppercase tracking-wider text-white/50">재사용할 브랜치</span>
              <span
                className={`font-mono tabular-nums text-[12px] ${activeBranch ? 'text-white' : 'text-white/40 italic'}`}
                title={activeBranch ?? '이번 세션에서 아직 결정되지 않았습니다'}
              >
                {activeBranch ?? '아직 결정되지 않음'}
              </span>
            </div>
            <p className="branch-mode__hint flex items-center gap-1">
              <Info size={10} />
              리뷰 이력이 길어지거나 단일 PR 에 여러 커밋을 누적하고 싶을 때 선택합니다. 사용하지 않는 브랜치가 누적되지 않도록 세션 종료 후 정리를 권장합니다.
            </p>
          </div>
        )}
      </fieldset>

      {/* 디자이너: 브랜치 전략 라디오 그룹. tests/branch-strategy-mockup.md 의 4전략을
          그대로 바인딩한다. `fixed-branch` 선택 시에만 아래 newBranchName 입력이 펼쳐지고,
          나머지 전략은 상단의 branchPattern 템플릿을 그대로 사용한다. 선택한 값은
          onSave → ProjectManagement 의 toServerSettings 를 거쳐 /api/git-automation/tick
          트리거 페이로드에 실린다. */}
      <fieldset
        role="radiogroup"
        aria-labelledby="branch-strategy-heading"
        className="border-2 border-[var(--pixel-border)] bg-black/30 p-3 space-y-2"
      >
        <legend id="branch-strategy-heading" className="px-1 text-[10px] font-bold text-[var(--pixel-accent)] uppercase tracking-wider">
          브랜치 전략
        </legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {BRANCH_STRATEGY_VALUES.map(kind => {
            const meta = BRANCH_STRATEGY_LABEL[kind];
            const isActive = branchStrategyChoice === kind;
            return (
              <label
                key={kind}
                title={meta.hint}
                className={`relative cursor-pointer select-none border-2 p-2 flex items-start gap-2 transition-colors ${
                  isActive
                    ? 'border-[var(--pixel-accent)] bg-[var(--pixel-accent)]/10'
                    : 'border-[var(--pixel-border)] hover:border-[var(--pixel-accent)]/60'
                }`}
              >
                <input
                  type="radio"
                  name="git-branch-strategy"
                  value={kind}
                  checked={isActive}
                  onChange={() => setBranchStrategyChoice(kind)}
                  aria-describedby={`strategy-${kind}-desc`}
                  className={`mt-0.5 accent-[var(--pixel-accent)] ${focusRing}`}
                />
                <div className="min-w-0">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-white">{meta.label}</div>
                  <div id={`strategy-${kind}-desc`} className="text-[10px] text-white/60 leading-relaxed">
                    {meta.hint}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
        {needsNewBranchInput && (
          <div className="pt-1">
            <label className="block">
              <span className="flex items-center gap-2 text-[10px] font-bold text-[var(--pixel-accent)] uppercase tracking-wider mb-1">
                새 브랜치명
                <span className="text-[9px] text-white/40 normal-case">— 고정 브랜치 재사용 시 사용됩니다</span>
              </span>
              <input
                type="text"
                value={newBranchName}
                onChange={e => setNewBranchName(e.target.value)}
                placeholder="예: auto/dev"
                aria-invalid={newBranchError !== null}
                aria-describedby="new-branch-name-hint"
                className={`w-full bg-black/40 border-2 ${
                  newBranchError ? 'border-red-400' : 'border-[var(--pixel-border)]'
                } px-3 py-2 text-sm text-white font-mono placeholder:text-white/30 focus:border-[var(--pixel-accent)] focus:outline-none ${focusRing}`}
              />
              <p
                id="new-branch-name-hint"
                role={newBranchError ? 'alert' : undefined}
                className={`mt-1 text-[10px] flex items-center gap-1 ${
                  newBranchError ? 'text-red-300' : 'text-white/50'
                }`}
              >
                {newBranchError ? <AlertTriangle size={10} /> : <Info size={10} />}
                {newBranchError ?? '영문·숫자·`-`·`_`·`.`·`/` 만 사용할 수 있으며, 연속된 특수문자는 허용되지 않습니다.'}
              </p>
            </label>
          </div>
        )}
      </fieldset>

      {/*
        태스크 경계 커밋(#f1d5ce51) — 브랜치 전략과 직교하는 "커밋 경계" 축.
        라디오 3종이 1:1 로 CommitStrategy 상수에 매핑되며, types.ts 의 라벨 한 곳에서
        문구를 관리한다. 선택값이 'manual' 이면 prefix 는 여전히 저장되지만 자동 커밋이
        돌지 않으므로 사실상 "수동 개시 시에만 사용되는 기본 접두어" 역할만 한다.
      */}
      <fieldset
        className="space-y-2 border border-[var(--pixel-border)] p-3"
        data-testid="commit-strategy-fieldset"
        aria-labelledby="commit-strategy-legend"
      >
        <legend
          id="commit-strategy-legend"
          className="px-1 text-[10px] font-bold uppercase tracking-wider text-[var(--pixel-accent)]"
        >
          태스크 경계 커밋
        </legend>
        <div
          role="radiogroup"
          aria-label="커밋 경계 전략"
          className="grid grid-cols-1 sm:grid-cols-3 gap-2"
        >
          {COMMIT_STRATEGY_VALUES.map((value) => {
            const shortLabel = COMMIT_STRATEGY_LABEL[value];
            const hint = COMMIT_STRATEGY_HINT[value];
            const active = commitStrategy === value;
            return (
              <label
                key={value}
                data-testid={`commit-strategy-option-${value}`}
                data-active={active ? 'true' : 'false'}
                className={`flex items-start gap-2 p-2 border-2 cursor-pointer transition-colors ${
                  active
                    ? 'border-[var(--pixel-accent)] bg-black/50'
                    : 'border-[var(--pixel-border)] bg-black/30 hover:bg-black/40'
                }`}
              >
                <input
                  type="radio"
                  name="git-commit-strategy"
                  value={value}
                  checked={active}
                  onChange={() => setCommitStrategy(value)}
                  data-testid={`commit-strategy-radio-${value}`}
                  aria-describedby={`commit-strategy-${value}-hint`}
                  className="mt-0.5"
                />
                <div className="min-w-0">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-white">
                    {shortLabel}
                  </div>
                  <div
                    id={`commit-strategy-${value}-hint`}
                    className="text-[10px] text-white/60 leading-relaxed"
                  >
                    {hint}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
        <label className="block pt-1">
          <span className="flex items-center gap-2 text-[10px] font-bold text-[var(--pixel-accent)] uppercase tracking-wider mb-1">
            커밋 메시지 접두어
            <span className="text-[9px] text-white/40 normal-case">— 모든 자동 커밋 제목 앞에 붙습니다</span>
          </span>
          <input
            type="text"
            value={commitMessagePrefix}
            onChange={(e) => setCommitMessagePrefix(e.target.value)}
            placeholder="예: auto: "
            data-testid="commit-message-prefix-input"
            className={`w-full bg-black/40 border-2 border-[var(--pixel-border)] px-3 py-2 text-sm text-white font-mono placeholder:text-white/30 focus:border-[var(--pixel-accent)] focus:outline-none ${focusRing}`}
          />
          <p className="mt-1 text-[10px] flex items-center gap-1 text-white/50">
            <Info size={10} />
            빈 값이면 접두어 없이 원문 커밋 메시지가 그대로 사용됩니다.
          </p>
        </label>
      </fieldset>

      <div className="space-y-3">
        <TemplateField
          label="브랜치 이름 패턴"
          value={branchPattern}
          onChange={setBranchPattern}
          onFocus={() => setActiveField('branch')}
          placeholder="{type}/{ticket}-{branch}"
          disabled={needsNewBranchInput}
          disabledHint="고정 브랜치 전략에서는 새 브랜치명이 직접 사용됩니다"
        />
        <TemplateField
          label="커밋 메시지 템플릿"
          value={commitTemplate}
          onChange={setCommitTemplate}
          onFocus={() => setActiveField('commit')}
          placeholder="{type}: {branch}"
        />
        <TemplateField
          label="PR 제목 템플릿"
          value={prTitleTemplate}
          onChange={setPrTitleTemplate}
          onFocus={() => setActiveField('pr')}
          placeholder="[{ticket}] {type} — {branch}"
          disabled={flow !== 'full-pr'}
          disabledHint="Full PR Flow에서만 사용됩니다"
        />
        <div className="flex flex-wrap items-center gap-2" aria-label="템플릿 변수 삽입">
          <span className="text-[10px] text-white/50 uppercase tracking-wider">변수 삽입:</span>
          {TEMPLATE_VARS.map(v => (
            <button
              key={v.name}
              type="button"
              onClick={() => insertVariable(v.name)}
              title={v.hint}
              aria-label={`${v.name} 변수를 ${activeField === 'branch' ? '브랜치' : activeField === 'commit' ? '커밋' : 'PR'} 필드에 삽입`}
              className={`px-2 py-0.5 text-[10px] font-mono bg-black/40 border-2 border-[var(--pixel-border)] text-[var(--pixel-accent)] hover:border-[var(--pixel-accent)] hover:bg-black/60 transition-colors ${focusRing}`}
            >
              {v.name}
            </button>
          ))}
        </div>
      </div>

      {(activeBranch || branchStrategy) && (() => {
        // 디자이너: 브랜치 중복 생성 회귀(#91aeaf7a) 대응. 템플릿 미리보기와 별개로
        // "지금 어떤 브랜치에 커밋이 쌓이고 있는가" + "그 브랜치가 어떤 전략으로 결정됐는가"
        // 를 상단에 한 줄로 고정 노출한다. 활성 브랜치가 없으면(미결정) 이탤릭으로
        // "아직 브랜치가 결정되지 않음" 을 표시해 세션 시작 전 상태와 구분한다.
        const strategyInfo = branchStrategy ? BRANCH_STRATEGY_LABEL[branchStrategy] : null;
        return (
          <div
            role="status"
            aria-live="polite"
            aria-label="현재 활성 브랜치 및 운영 전략"
            className="bg-black/40 border-2 border-[var(--pixel-border)] p-3 flex items-center gap-3 flex-wrap"
          >
            <span className="inline-flex items-center justify-center w-7 h-7 border-2 border-[var(--pixel-accent)] bg-black/40 text-[var(--pixel-accent)]">
              <GitBranch size={14} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[9px] uppercase tracking-wider text-white/50">활성 브랜치</div>
              <div
                className={`text-[13px] font-mono tabular-nums truncate ${activeBranch ? 'text-white' : 'text-white/40 italic'}`}
                title={activeBranch || '아직 이번 세션에서 브랜치가 결정되지 않았습니다'}
              >
                {activeBranch || '아직 결정되지 않음'}
              </div>
            </div>
            {strategyInfo && (
              <span
                className="px-2 py-0.5 text-[10px] font-bold uppercase border-2 border-[var(--pixel-accent)] bg-black/40 text-[var(--pixel-accent)] tabular-nums"
                title={strategyInfo.hint}
              >
                {strategyInfo.label}
              </span>
            )}
          </div>
        );
      })()}

      <div
        role="status"
        aria-live="polite"
        aria-label="실시간 미리보기"
        className="bg-black/40 border-2 border-[var(--pixel-border)] p-3 space-y-1.5 font-mono text-[11px]"
      >
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/50 mb-1">
          <Info size={10} />
          <span>미리보기 (샘플: type={sampleVars.type}, ticket={sampleVars.ticket}, branch={sampleVars.branch})</span>
        </div>
        <PreviewRow icon={<GitBranch size={11} />} label="branch" value={preview.branch} warn={!hasTemplateVariable(branchPattern)} />
        <PreviewRow icon={<GitCommit size={11} />} label="commit" value={preview.commit} warn={!hasTemplateVariable(commitTemplate)} />
        <PreviewRow
          icon={<GitPullRequest size={11} />}
          label="pr title"
          value={preview.prTitle}
          warn={flow === 'full-pr' && !hasTemplateVariable(prTitleTemplate)}
          muted={flow !== 'full-pr'}
        />
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={reset}
          disabled={!dirty}
          aria-label="Git 자동화 설정 초기화"
          className={`px-3 py-1.5 bg-black/30 border-2 border-[var(--pixel-border)] text-[11px] font-bold uppercase tracking-wider text-white/80 hover:border-[var(--pixel-accent)] hover:text-white flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-[var(--pixel-border)] disabled:hover:text-white/80 ${focusRing}`}
        >
          <RotateCcw size={12} /> 초기화
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || (needsNewBranchInput && !newBranchValidation.ok)}
          aria-label="Git 자동화 설정 저장"
          className={`ml-auto px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider border-b-2 flex items-center gap-1.5 hover:brightness-110 active:translate-y-px transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 disabled:active:translate-y-0 ${risk.cta} ${focusRing}`}
        >
          <Save size={12} /> 저장 · {selected.label}
        </button>
      </div>
    </section>
  );
}

function TemplateField({
  label, value, onChange, onFocus, placeholder, disabled, disabledHint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onFocus: () => void;
  placeholder: string;
  disabled?: boolean;
  disabledHint?: string;
}) {
  const hint = !value.trim()
    ? '비어 있음 — placeholder가 사용됩니다'
    : hasTemplateVariable(value)
      ? '변수가 감지되었습니다'
      : '변수가 없습니다 — 정적 문자열로 처리됩니다';
  const warnNoVar = !!value.trim() && !hasTemplateVariable(value);
  return (
    <label className={`block ${disabled ? 'opacity-50' : ''}`}>
      <span className="flex items-center gap-2 text-[10px] font-bold text-[var(--pixel-accent)] uppercase tracking-wider mb-1">
        {label}
        {disabled && disabledHint && (
          <span className="text-[9px] text-white/40 normal-case">— {disabledHint}</span>
        )}
      </span>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={onFocus}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={warnNoVar}
        className={`w-full bg-black/40 border-2 ${warnNoVar ? 'border-yellow-500/60' : 'border-[var(--pixel-border)]'} px-3 py-2 text-sm text-white font-mono placeholder:text-white/30 focus:border-[var(--pixel-accent)] focus:outline-none disabled:cursor-not-allowed ${focusRing}`}
      />
      <p className={`mt-1 text-[10px] flex items-center gap-1 ${warnNoVar ? 'text-yellow-300' : 'text-white/50'}`}>
        {warnNoVar && <AlertTriangle size={10} />}
        {hint}
      </p>
    </label>
  );
}

// 디자이너: 커밋/푸시 각 단계의 pending/success/failure 를 하나의 칩으로 묶어준다.
// pending 일 때만 스피너가 돌고, 나머지는 정적인 점 아이콘으로 표현해 노이즈를 최소화.
function StepStatusBadge({
  icon, label, status, reducedMotion, muted, mutedHint,
}: {
  icon: React.ReactNode;
  label: string;
  status: GitStepStatus;
  reducedMotion: boolean;
  muted?: boolean;
  mutedHint?: string;
}) {
  const style = STEP_STATUS_STYLE[status];
  const effectiveStatus: GitStepStatus = muted ? 'idle' : status;
  const effectiveStyle = STEP_STATUS_STYLE[effectiveStatus];
  return (
    <span
      role="status"
      aria-label={`${label} ${muted ? '해당 없음' : effectiveStyle.srLabel}`}
      title={muted && mutedHint ? mutedHint : `${label}: ${effectiveStyle.srLabel}`}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider border-2 tabular-nums ${effectiveStyle.chip} ${muted ? 'opacity-50' : ''}`}
    >
      <span aria-hidden="true" className="text-current">{icon}</span>
      <span className="font-sans">{label}</span>
      <span aria-hidden="true" className="inline-flex items-center justify-center w-3.5 h-3.5">
        {effectiveStatus === 'pending' && (
          <Loader2 size={11} className={reducedMotion ? '' : 'animate-spin'} />
        )}
        {effectiveStatus === 'success' && <Check size={11} />}
        {effectiveStatus === 'failure' && <XCircle size={11} />}
        {effectiveStatus === 'idle' && <span className={`inline-block w-1.5 h-1.5 ${style.dot}`} />}
      </span>
      <span className="font-sans">{effectiveStyle.label}</span>
    </span>
  );
}

function PreviewRow({
  icon, label, value, warn, muted,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  warn?: boolean;
  muted?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 ${muted ? 'opacity-40' : ''}`}>
      <span className="text-[var(--pixel-accent)] shrink-0">{icon}</span>
      <span className="text-[9px] uppercase tracking-wider text-white/50 w-16 shrink-0">{label}</span>
      <span className={`truncate ${warn ? 'text-yellow-300' : 'text-white'}`} title={value}>
        {value || <span className="opacity-40">(비어 있음)</span>}
      </span>
      {warn && <AlertTriangle size={10} className="text-yellow-300 shrink-0" aria-label="변수 없음 경고" />}
    </div>
  );
}
