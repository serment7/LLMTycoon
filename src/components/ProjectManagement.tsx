import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Download, Github, GitBranch, RefreshCw, FolderGit2, Link2Off, Server, BarChart3, Search, AlertTriangle, GitPullRequest, Check, Clock, FileDown, Sparkles, ClipboardCopy, Pin, Pencil } from 'lucide-react';
import type { SourceIntegration, ManagedProject, SourceProvider, UserPreferences, GitAutomationPreference, BranchStrategy, CommitStrategy } from '../types';
import {
  USER_PREFERENCES_KEY,
  BRANCH_STRATEGY_VALUES,
  COMMIT_STRATEGY_VALUES,
  DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG,
} from '../types';
import { GitAutomationPanel, DEFAULT_AUTOMATION, type GitAutomationSettings, type GitFlowLevel, type BranchMode } from './GitAutomationPanel';
import { GitCredentialsSection } from './GitCredentialsSection';
import { SharedGoalForm } from './SharedGoalForm';
import { EmptyState } from './EmptyState';
import { ProjectEditingHeader } from './EmptyProjectPlaceholder';
import { startGitAutomationScheduler } from '../utils/gitAutomation';

// UX: PR 대상 라디오 선택은 "매번 다시 고르기"보다 "한 번 정해두면 그대로"가 실수를
// 줄인다. 로컬 단말의 선호를 localStorage에 두고, 앱 재진입 시 자동 복원한다.
// 협업 동료의 선택과 섞이면 안 되므로 서버 DB가 아닌 브라우저 저장소를 쓴다.
const VALID_FLOW_LEVELS: readonly GitAutomationPreference['flowLevel'][] = ['commitOnly', 'commitPush', 'commitPushPR'];
const VALID_COMMIT_CONVENTIONS: readonly GitAutomationPreference['commitConvention'][] = ['conventional', 'plain'];

// Git 자동화 저장본이 깨졌거나 타입이 안 맞을 때 기본값을 잃지 않도록 방어한다.
// 새 필드를 추가할 때는 이 파서도 함께 늘려야 한다.
function parseGitAutomation(value: unknown): GitAutomationPreference | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.flowLevel !== 'string' || !VALID_FLOW_LEVELS.includes(v.flowLevel as GitAutomationPreference['flowLevel'])) return undefined;
  if (typeof v.branchTemplate !== 'string') return undefined;
  if (typeof v.commitConvention !== 'string' || !VALID_COMMIT_CONVENTIONS.includes(v.commitConvention as GitAutomationPreference['commitConvention'])) return undefined;
  if (typeof v.commitScope !== 'string') return undefined;
  if (typeof v.prTitleTemplate !== 'string') return undefined;
  if (!Array.isArray(v.reviewers) || v.reviewers.some(r => typeof r !== 'string')) return undefined;
  return {
    flowLevel: v.flowLevel as GitAutomationPreference['flowLevel'],
    branchTemplate: v.branchTemplate,
    commitConvention: v.commitConvention as GitAutomationPreference['commitConvention'],
    commitScope: v.commitScope,
    prTitleTemplate: v.prTitleTemplate,
    reviewers: v.reviewers as string[],
  };
}

// 베타(개발): 프로젝트별 설정 격리용 키 프리픽스. `projectId` 인자가 들어오면
// `<prefix>:<projectId>` 슬롯을 쓰고, 없으면 레거시 USER_PREFERENCES_KEY 로 폴백한다.
// 한 프로젝트의 설정 저장이 다른 프로젝트로 번지는 회귀(TC-PS1~PS4)를 차단한다.
export const PROJECT_SETTINGS_KEY_PREFIX = 'llm-tycoon:project-settings';

function projectScopedKey(projectId: string): string {
  return `${PROJECT_SETTINGS_KEY_PREFIX}:${projectId}`;
}

export function loadUserPreferences(projectId?: string): UserPreferences {
  try {
    const key = projectId ? projectScopedKey(projectId) : USER_PREFERENCES_KEY;
    const raw = typeof window !== 'undefined' ? window.localStorage?.getItem(key) : null;
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const obj = parsed as Record<string, unknown>;
    const out: UserPreferences = {};
    const id = obj.pinnedPrTargetProjectId;
    if (typeof id === 'string' && id.length > 0) out.pinnedPrTargetProjectId = id;
    const ga = parseGitAutomation(obj.gitAutomation);
    if (ga) out.gitAutomation = ga;
    return out;
  } catch {
    // 손상된 JSON은 조용히 무시하고 초기값으로 되돌린다. 선호값 한 건 때문에
    // 전체 화면을 막지 않도록 한다.
    return {};
  }
}

export function saveUserPreferences(next: UserPreferences, projectId?: string): void {
  try {
    if (typeof window === 'undefined') return;
    const key = projectId ? projectScopedKey(projectId) : USER_PREFERENCES_KEY;
    window.localStorage?.setItem(key, JSON.stringify(next));
  } catch {
    // localStorage가 사용 불가(프라이빗 모드 쿼터 초과 등)여도 세션 내 상태는 유지된다.
  }
}

// 레거시 단일 키에 남아 있던 선호값을 현재 프로젝트 슬롯으로 최초 1회만 이관한다.
// 이관 후 원본을 제거해 두 번째 프로젝트 부팅 시 "타인의 설정이 내 프로젝트로 번지는"
// 사고를 막는다. TC-PS4 계약.
export function migrateUserPreferencesToProject(projectId: string): void {
  try {
    if (typeof window === 'undefined') return;
    const legacy = window.localStorage?.getItem(USER_PREFERENCES_KEY);
    if (!legacy) return;
    window.localStorage?.setItem(projectScopedKey(projectId), legacy);
    window.localStorage?.removeItem(USER_PREFERENCES_KEY);
  } catch {
    // 마이그레이션은 best-effort. 실패해도 다음 부팅에서 다시 시도한다.
  }
}

// 개발자(베타): GitAutomationPanel 의 UI-친화 shape(GitAutomationSettings) 은 types.ts 의
// GitAutomationPreference 와 키가 달라 기존 UserPreferences 슬롯에 그대로 못 담는다.
// 컴포넌트 unmount 마다 초기화되는 회귀를 막기 위해 패널 전용 키로 분리 저장한다.
// 스키마 변경은 VALID_FLOW_KEYS 에 값을 추가하고 필요하면 이 파서를 확장해야 한다.
export const GIT_AUTOMATION_PANEL_KEY = 'llm-tycoon:git-automation-panel';
const VALID_FLOW_KEYS: readonly GitFlowLevel[] = ['commit', 'commit-push', 'full-pr'];

// UI 패널의 flow → 서버 DB의 flowLevel 매핑
const FLOW_TO_SERVER: Record<GitFlowLevel, string> = {
  'commit': 'commitOnly',
  'commit-push': 'commitPush',
  'full-pr': 'commitPushPR',
};
const SERVER_TO_FLOW: Record<string, GitFlowLevel> = {
  commitOnly: 'commit',
  commitPush: 'commit-push',
  commitPushPR: 'full-pr',
};

// UI 패널의 GitAutomationSettings → 서버 DB 형식 변환. branchStrategy·newBranchName
// 은 서버 `git_automation_settings` 레코드 밖(프로젝트 옵션 레벨)에서 쓰이는 값이지만,
// /api/git-automation/tick 트리거 페이로드가 settings 객체를 그대로 서버에 넘기므로
// 여기서 함께 직렬화해 자동화 파이프라인이 전략·고정 브랜치명을 동시에 읽을 수 있게 한다.
// UI BranchStrategy → 서버 GitAutomationBranchStrategy 변환
// 'fixed-branch'는 기존 브랜치에 커밋 → 'current', 나머지는 새 브랜치 생성 → 'new'
function uiToServerBranchStrategy(ui: BranchStrategy): 'new' | 'current' {
  return ui === 'fixed-branch' ? 'current' : 'new';
}

function toServerSettings(ui: GitAutomationSettings): Record<string, unknown> {
  let branchTemplate = ui.branchPattern;
  if (!branchTemplate.includes('{slug}')) {
    branchTemplate = branchTemplate.includes('{branch}')
      ? branchTemplate.replace('{branch}', '{slug}')
      : branchTemplate + '/{slug}';
  }
  const payload: Record<string, unknown> = {
    enabled: ui.enabled,
    flowLevel: FLOW_TO_SERVER[ui.flow] || 'commitOnly',
    branchTemplate,
    commitConvention: 'conventional',
    commitScope: '',
    prTitleTemplate: ui.prTitleTemplate,
    reviewers: [],
    // 서버 DB는 'new'|'current'만 허용. UI의 세부 전략은 별도 필드로 보존.
    branchStrategy: uiToServerBranchStrategy(ui.branchStrategy),
    // UI의 원본 브랜치 전략을 별도 필드로 저장하여 로드 시 복원 가능
    uiBranchStrategy: ui.branchStrategy,
    commitStrategy: ui.commitStrategy,
    commitMessagePrefix: ui.commitMessagePrefix,
  };
  if (ui.branchStrategy === 'fixed-branch' && ui.newBranchName.trim()) {
    payload.fixedBranchName = ui.newBranchName.trim();
    payload.newBranchName = ui.newBranchName.trim();
    payload.branchName = ui.newBranchName.trim();
  }
  // 2모드 시안(A안) — 서버 스키마의 `branchName` 필드와 충돌하지 않도록 별도 키로
  // 저장한다. UI round-trip 전용이며, 실제 자동화 파이프라인은 4전략 축을 소비한다.
  payload.branchModeSketch = ui.branchMode;
  payload.branchModeNewName = ui.branchModeNewName;
  return payload;
}

// 서버 DB 형식 → UI 패널의 GitAutomationSettings 변환
function fromServerSettings(server: Record<string, unknown>): GitAutomationSettings {
  const flow = SERVER_TO_FLOW[server.flowLevel as string] ?? 'commit';
  let branchPattern = (server.branchTemplate as string) || DEFAULT_AUTOMATION.branchPattern;
  // 서버의 {slug} → UI의 {branch} 로 역변환
  branchPattern = branchPattern.replace('{slug}', '{branch}');
  // UI 브랜치 전략 복원: uiBranchStrategy(원본) → branchStrategy('new'/'current' 폴백)
  let branchStrategy: BranchStrategy = DEFAULT_AUTOMATION.branchStrategy;
  const rawUiStrategy = server.uiBranchStrategy;
  if (typeof rawUiStrategy === 'string'
    && (BRANCH_STRATEGY_VALUES as readonly string[]).includes(rawUiStrategy)) {
    branchStrategy = rawUiStrategy as BranchStrategy;
  } else if (server.branchStrategy === 'current') {
    branchStrategy = 'fixed-branch';
  }
  const rawNewBranch = server.newBranchName ?? server.fixedBranchName ?? server.branchName;
  const newBranchName = typeof rawNewBranch === 'string' ? rawNewBranch : '';
  // 태스크 경계 커밋(#f1d5ce51) — 서버 저장 row 가 이 필드를 모르던 과거 프로젝트와도
  // 호환되도록 누락/오타는 기본값으로 폴백. COMMIT_STRATEGY_VALUES 밖의 임의 문자열은
  // 무시하고 DEFAULT 값 사용.
  const rawCommitStrategy = server.commitStrategy;
  const commitStrategy: CommitStrategy = typeof rawCommitStrategy === 'string'
    && (COMMIT_STRATEGY_VALUES as readonly string[]).includes(rawCommitStrategy)
      ? rawCommitStrategy as CommitStrategy
      : DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG.commitStrategy;
  // DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG 는 서버 실행 축의 설정만 담당하고 `commitMessagePrefix`
  // 는 갖고 있지 않다. UI 기본 접두어는 GitAutomationPanel 의 DEFAULT_AUTOMATION.commitMessagePrefix
  // 로 단일 출처를 두고 복원 경로에서 그대로 가져다 쓴다.
  const commitMessagePrefix = typeof server.commitMessagePrefix === 'string'
    ? server.commitMessagePrefix
    : DEFAULT_AUTOMATION.commitMessagePrefix;
  // 2모드 시안(A안) 복원. 서버 row 가 이 필드를 모르는 레거시 프로젝트는
  // DEFAULT_AUTOMATION 값으로 폴백해, 라디오가 항상 하나는 선택된 채로 뜨게 한다.
  const rawBranchMode = server.branchModeSketch;
  const branchMode: BranchMode = rawBranchMode === 'continue' || rawBranchMode === 'new'
    ? rawBranchMode
    : DEFAULT_AUTOMATION.branchMode;
  const branchModeNewName = typeof server.branchModeNewName === 'string'
    ? server.branchModeNewName
    : DEFAULT_AUTOMATION.branchModeNewName;
  return {
    flow,
    branchPattern,
    commitTemplate: DEFAULT_AUTOMATION.commitTemplate,
    prTitleTemplate: (server.prTitleTemplate as string) || DEFAULT_AUTOMATION.prTitleTemplate,
    enabled: server.enabled !== false,
    branchStrategy,
    newBranchName,
    commitStrategy,
    commitMessagePrefix,
    branchMode,
    branchModeNewName,
  };
}

// 서버 DB에서 설정을 로드한다. (비동기)
export async function loadGitAutomationSettings(projectId: string): Promise<GitAutomationSettings> {
  try {
    const res = await fetch(`/api/projects/${projectId}/git-automation`);
    if (!res.ok) return DEFAULT_AUTOMATION;
    const data = await res.json();
    return fromServerSettings(data);
  } catch {
    return DEFAULT_AUTOMATION;
  }
}

// 서버 DB에 설정을 저장한다. (비동기)
export async function saveGitAutomationSettings(next: GitAutomationSettings, projectId?: string): Promise<void> {
  if (!projectId) return;
  try {
    const res = await fetch(`/api/projects/${projectId}/git-automation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toServerSettings(next)),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error('[git-automation] 서버 저장 실패:', body);
    }
  } catch (err) {
    console.error('[git-automation] 서버 저장 요청 실패:', err);
  }
}

interface Props {
  onLog: (text: string, from?: string) => void;
  // 앱 전역의 현재 프로젝트. null/undefined 이면 본 컴포넌트는 아예 렌더되지 않는다.
  // 이 값이 바뀌면 내부 selectedProjectId 와 캐시도 해당 프로젝트의 슬롯으로 스위치된다.
  currentProjectId?: string | null;
}

type SortKey = 'name' | 'provider' | 'recent';

// QA: 호스트 URL이 http(s) 스킴으로 시작하는지 확인한다. 사용자가 "github.com"처럼
// 스킴 없이 입력하면 URL 파싱이 서버에서 실패하므로 폼 단계에서 차단한다.
// 추가로 `https://user:pass@evil.com`처럼 userinfo가 포함된 URL은 거절한다 —
// 토큰과 별개로 Basic 인증이 몰래 섞여 들어가 감사 로그를 우회할 수 있기 때문.
// export로 공개해 단위 테스트가 DOM 없이 검증하도록 한다.
export function isValidHost(raw: string): boolean {
  const v = raw.trim();
  if (!v) return false;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    if (!u.hostname) return false;
    return true;
  } catch {
    return false;
  }
}

// QA: 토큰 프리픽스 힌트. 잘못된 제공자에 토큰을 붙여 넣는 사고를 조기에 경고한다.
export function tokenPrefixMismatch(provider: SourceProvider, token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  if (provider === 'github') return !(t.startsWith('ghp_') || t.startsWith('github_pat_'));
  if (provider === 'gitlab') return !t.startsWith('glpat-');
  return false;
}

// QA: 실제 제공자 토큰은 최소 20자 이상이다. 사용자가 토큰 일부만 복사해 붙여 넣은
// 사고를 조기에 포착해, 의미 없는 401 라운드트립과 감사 로그를 아끼자.
export const MIN_TOKEN_LEN = 20;
export function isTokenTooShort(token: string): boolean {
  return token.trim().length > 0 && token.trim().length < MIN_TOKEN_LEN;
}

// QA: 로그·에러 메시지에 토큰이 섞여 들어가는 사고는 토큰 로테이션까지 요구하는
// 고비용 보안 이벤트다. 어디서든 "혹시 토큰일 수도 있는 문자열"을 표시할 일이 생기면
// 이 함수로 마스킹하여 앞 4자리 프리픽스와 길이만 남긴다. onLog로 직접 토큰을
// 흘리지 않도록 사용처에서 꼭 호출할 것.
export function maskToken(token: string): string {
  const t = token.trim();
  if (!t) return '';
  if (t.length <= 8) return '•'.repeat(t.length);
  return `${t.slice(0, 4)}…(${t.length}자)`;
}

// QA: 서버 에러 메시지·응답 본문을 그대로 onLog로 흘릴 때, 본문에 토큰 원문이
// 섞여 들어오는 사고 사례가 있었다(예: GitHub가 잘못된 URL을 에코하며 Authorization
// 헤더의 일부를 응답에 포함). 자유 텍스트에서 알려진 프리픽스 토큰 패턴을 찾아
// maskToken 표현으로 치환한다. 패턴은 프리픽스 + URL-safe 문자 20자 이상.
// 새 제공자 프리픽스가 생기면 배열에 추가만 하면 된다.
const TOKEN_PATTERN = /\b(?:ghp_|github_pat_|glpat-|gho_|ghs_|ghu_)[A-Za-z0-9_-]{20,}\b/g;
export function redactTokens(raw: string): string {
  if (!raw) return raw;
  return raw.replace(TOKEN_PATTERN, m => maskToken(m));
}

// QA: 라벨에 제어문자(\u0000-\u001F, \u007F)가 섞이면 로그 출력 시 줄바꿈 위조,
// ANSI 이스케이프, 터미널 커서 조작 등 가짜 로그 엔트리를 만들어내는 로그 인젝션이
// 가능하다. 표시 전용 필드지만 "표시되는 곳 모두"를 방어하는 것보다 입력 시점에
// 한 번 거르는 쪽이 회귀에 강하다. 탭(\u0009)은 허용 — 사용자가 의도적으로
// 정렬용 공백으로 쓸 수 있고, 로그 인젝션 위험은 낮다.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000A-\u001F\u007F]/;
export function hasControlChars(raw: string): boolean {
  return CONTROL_CHAR_RE.test(raw);
}

// QA: 두 호스트가 동일 엔드포인트를 가리키는지 비교한다. trailing slash·대소문자·기본 포트
// 차이로 중복 연동이 등록되면 import 작업이 서로를 덮어써 리서치 데이터가 훼손된다.
// userinfo는 식별자가 아니라 자격증명이므로 비교 키에서 제거한다.
// http://host:80 와 http://host, https://host:443 와 https://host 는 동일 엔드포인트이므로
// 기본 포트는 제거하여 동등성 비교가 직관과 맞도록 한다.
export function normalizeHost(raw: string | undefined | null): string {
  const v = (raw || '').trim();
  if (!v) return '';
  try {
    const u = new URL(v);
    const isDefaultPort =
      (u.protocol === 'http:' && u.port === '80') ||
      (u.protocol === 'https:' && u.port === '443');
    const host = (isDefaultPort ? u.hostname : u.host).toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${host}${path}`;
  } catch {
    return v.toLowerCase().replace(/\/+$/, '');
  }
}

// QA: 신규 연동이 기존 목록과 (provider, host) 조합으로 충돌하는지 검사한다.
export function findDuplicateIntegration(
  existing: Pick<SourceIntegration, 'provider' | 'host' | 'label'>[],
  provider: SourceProvider,
  host: string,
): { label: string } | null {
  const target = normalizeHost(host);
  const hit = existing.find(
    i => i.provider === provider && normalizeHost(i.host || '') === target,
  );
  return hit ? { label: hit.label } : null;
}

// 마지막 새로고침 시각을 "방금", "5분 전" 처럼 상대 표현으로 포맷한다.
// 테스트 가능하도록 now를 주입 가능한 시그니처로 유지.
export function formatRefreshAge(ts: number | null, now: number = Date.now()): string {
  if (!ts) return '아직 새로고침 안 됨';
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return '방금';
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}

// QA: 서버로 전송될 라벨·호스트 최대 길이. DB 컬럼(varchar 200)과 URL 표준 권고(2048)에 맞춘다.
const MAX_LABEL_LEN = 80;
const MAX_HOST_LEN = 2048;

// 연구원: 리서치 비교 단위. 설명이 이보다 짧으면 "요약이 부족함"으로 간주해
// 추후 LLM에게 설명 보강을 요청할 후보로 표시한다. 근거는 내부 리서치 샘플에서
// 30자 미만 설명은 프로젝트 정체성을 설명하기에 통계적으로 부족했다는 점.
export const SHORT_DESCRIPTION_THRESHOLD = 30;

// 연구원: 리서치 스냅샷에 쓰이는 제공자 분포 다양성 지수. Simpson 다양성(1 - Σp²)을
// 사용해 0(한 제공자 독점)~1(완벽 균등)으로 정규화한다. 프로젝트 포트폴리오가
// 한 벤더에 치우쳐 있는지 한 눈에 보기 위한 지표.
export function providerDiversity(byProvider: Record<string, number>): number {
  const counts = Object.values(byProvider);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 1) return 0;
  const sumSq = counts.reduce((acc, c) => acc + (c / total) ** 2, 0);
  // n개 범주의 이론적 최대 다양성으로 스케일링해, 제공자가 2개만 있어도
  // 50:50이면 1.0으로 보고되도록 한다(사용자의 직관과 일치).
  const n = counts.length;
  if (n <= 1) return 0;
  const maxDiversity = 1 - 1 / n;
  const raw = 1 - sumSq;
  return Math.max(0, Math.min(1, raw / maxDiversity));
}

// 연구원: 리서치 스냅샷을 CSV 한 줄씩 직렬화한다. 외부 데이터 분석 도구
// (Excel/Sheets/pandas)로 가져가 장기 추세를 비교할 때 쓰인다.
// 쉼표/따옴표/개행이 섞인 설명도 안전하게 이스케이프한다.
export function toCsvRow(cells: (string | number)[]): string {
  return cells
    .map(c => {
      const s = String(c ?? '');
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}

// 연구원: 설명 품질 점수 0~1. 길이와 고유 토큰 수(정보 밀도)를 결합한다.
// "Awesome list" 같은 2단어 설명과 "Collection of awesome tools for X" 같은
// 같은 길이의 정보 풍부한 설명을 분리해 리서치 우선순위를 매기기 위함.
// 근거: 내부 샘플에서 고유 토큰 수 < 4 이면 주제 추론이 어려웠다.
export function descriptionQualityScore(raw: string | undefined | null): number {
  const desc = (raw || '').trim();
  if (!desc) return 0;
  // 길이 성분: SHORT_DESCRIPTION_THRESHOLD의 4배(≈120자)에서 포화.
  const lenSaturation = SHORT_DESCRIPTION_THRESHOLD * 4;
  const lenScore = Math.min(1, desc.length / lenSaturation);
  // 어휘 다양성 성분: 공백/구두점 기준 토큰 중 중복 제외 비율.
  const tokens = desc.toLowerCase().split(/[\s,.;:!?()[\]{}/\\|"'`~]+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const unique = new Set(tokens).size;
  const lexScore = Math.min(1, unique / 12);
  // 두 성분의 기하 평균: 둘 다 낮으면 크게 페널티. 연구원이 "충분히 설명된" 카드만
  // 빠르게 추려내기 위함.
  return Math.sqrt(lenScore * lexScore);
}

// 연구원: LLM 설명 보강 후보를 품질 점수 낮은 순으로 정렬하고 상한을 둔다.
// 한 번의 보강 배치에 투입할 수 있는 LLM 호출 수가 제한적이므로, 가장 개선
// 여지가 큰 카드부터 처리할 수 있게 해준다.
export function rankEnrichmentCandidates(
  projects: ManagedProject[],
  limit = 10,
): { project: ManagedProject; score: number }[] {
  const scored = projects.map(p => ({ project: p, score: descriptionQualityScore(p.description) }));
  // 낮은 점수가 먼저. 동률이면 이름 오름차순으로 결과 재현성 확보.
  scored.sort((a, b) => a.score - b.score || a.project.fullName.localeCompare(b.project.fullName));
  return scored.slice(0, Math.max(0, limit));
}

// 연구원: 상위 N개 후보를 보강했을 때 평균 품질 점수가 얼마나 오를지 예측한다.
// 보강 후 점수는 낙관적 상한(=1.0)이 아니라, 전체 모집단의 상위 25% 분위수를
// 사용한다. 이는 "현실적으로 도달 가능한 양호 설명"의 보수적 기대치이며,
// 실제 LLM 보강 결과를 사후 검증할 때 과대평가하지 않게 해준다.
export function estimateEnrichmentImpact(
  projects: ManagedProject[],
  limit = 10,
): { current: number; projected: number; delta: number; targetScore: number } {
  const n = projects.length;
  if (n === 0) return { current: 0, projected: 0, delta: 0, targetScore: 0 };
  const scores = projects.map(p => descriptionQualityScore(p.description));
  const current = scores.reduce((a, b) => a + b, 0) / n;
  // 상위 25% 분위수: 정렬 후 0.75 위치의 보간 없는 보수적 인덱스.
  const sortedDesc = [...scores].sort((a, b) => b - a);
  const q1Index = Math.floor(n * 0.25);
  const targetScore = sortedDesc[Math.min(q1Index, n - 1)] ?? 0;
  // 가장 낮은 limit개를 targetScore로 끌어올린다고 가정.
  const sortedAsc = [...scores].sort((a, b) => a - b);
  const k = Math.min(Math.max(0, limit), n);
  let projectedSum = 0;
  for (let i = 0; i < n; i += 1) {
    projectedSum += i < k ? Math.max(sortedAsc[i], targetScore) : sortedAsc[i];
  }
  const projected = projectedSum / n;
  return { current, projected, delta: projected - current, targetScore };
}

// 연구원: 설명 품질 점수를 4개 티어로 버킷화한다. LLM 보강 예산을 집행할 때
// "우선 투입(poor) / 검토(fair) / 유지(good) / 제외(excellent)" 네 단계로 단순화하면
// 리뷰 회의에서 의사결정을 훨씬 빨리 내릴 수 있다. 임계값은 내부 샘플의 사분위수에서
// 얻은 것이므로, 샘플을 갱신하면 재보정이 필요하다. 버킷 경계는 "포함 여부" 기준으로
// poor < 0.25 ≤ fair < 0.5 ≤ good < 0.75 ≤ excellent.
export type QualityBucket = 'poor' | 'fair' | 'good' | 'excellent';
export function qualityBucketOf(score: number): QualityBucket {
  if (score < 0.25) return 'poor';
  if (score < 0.5) return 'fair';
  if (score < 0.75) return 'good';
  return 'excellent';
}
export function bucketByQuality(projects: ManagedProject[]): Record<QualityBucket, number> {
  const buckets: Record<QualityBucket, number> = { poor: 0, fair: 0, good: 0, excellent: 0 };
  for (const p of projects) {
    buckets[qualityBucketOf(descriptionQualityScore(p.description))] += 1;
  }
  return buckets;
}

// 연구원: Herfindahl-Hirschman 지수(HHI). Simpson 다양성과 짝을 이루는 집중도 지표.
// 값 범위는 1/n ~ 1. 1에 가까울수록 한 제공자에 집중되어 있음을 의미한다.
// Simpson 다양성은 "얼마나 고른가"를, HHI는 "얼마나 쏠려 있는가"를 표현하므로
// 두 지표를 함께 보면 포트폴리오 형태를 더 입체적으로 이해할 수 있다.
export function providerConcentration(byProvider: Record<string, number>): number {
  const counts = Object.values(byProvider);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  return counts.reduce((acc, c) => acc + (c / total) ** 2, 0);
}

// 개발자: 채팅/커밋 메시지에 붙여넣기 좋은 한 줄 요약. 예:
// "managed=42 · described=31(73%) · providers=github:30,gitlab:12 · avg=87자"
// 디버깅 중 상태를 빠르게 공유하기 위한 용도이며, 민감한 필드는 포함하지 않는다.
export function summarizeForDev(
  projects: ManagedProject[],
): string {
  const total = projects.length;
  if (total === 0) return 'managed=0';
  const byProvider: Record<string, number> = {};
  let described = 0;
  let totalLen = 0;
  for (const p of projects) {
    byProvider[p.provider] = (byProvider[p.provider] || 0) + 1;
    const d = (p.description || '').trim();
    if (d) { described += 1; totalLen += d.length; }
  }
  const coverage = Math.round((described / total) * 100);
  const avg = described === 0 ? 0 : Math.round(totalLen / described);
  const providerStr = Object.entries(byProvider)
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${p}:${n}`)
    .join(',');
  return `managed=${total} · described=${described}(${coverage}%) · providers=${providerStr} · avg=${avg}자`;
}

export function managedToCsv(projects: ManagedProject[]): string {
  // qualityScore 컬럼을 함께 내보내 외부 도구에서도 보강 우선순위를 재현할 수 있게 한다.
  const header = toCsvRow(['id', 'fullName', 'provider', 'url', 'descriptionLength', 'qualityScore', 'description']);
  const rows = projects.map(p => toCsvRow([
    p.id,
    p.fullName,
    p.provider,
    p.url,
    (p.description || '').length,
    descriptionQualityScore(p.description).toFixed(3),
    p.description || '',
  ]));
  return [header, ...rows].join('\n');
}

// 디자이너: "현재 편집 중인 프로젝트"를 헤더 배지로 전달하기 위한 레이블 포맷터.
// 순수 함수로 분리해 JSDOM 없이도 스냅샷 회귀를 막는다. fullName 은 "org/repo"
// 형태라 좁은 화면에서 잘리기 쉬우므로, org 와 repo 를 각각 돌려 헤더에서 계층적으로
// 표현할 수 있게 한다. 선택 프로젝트가 없는 상태도 독립된 라벨로 반환해, 본문 UI
// 가 "선택 없음" 톤 변형(점선 테두리·반투명)으로 분기하도록 한다.
export interface EditingProjectLabel {
  hasProject: boolean;
  title: string;        // 강조 표시할 repo 이름(없으면 placeholder)
  subtitle?: string;    // 보조로 표시할 org/네임스페이스 ("org/"까지)
  fullName?: string;    // 툴팁·접근성 레이블에 쓸 전체 경로
  branch?: string;      // 현재 PR 작업이 향하는 base 브랜치
}

export function formatEditingProjectLabel(project: ManagedProject | null | undefined): EditingProjectLabel {
  if (!project) return { hasProject: false, title: '선택된 프로젝트 없음' };
  const full = project.fullName || project.name || '';
  const slash = full.indexOf('/');
  const title = slash >= 0 ? full.slice(slash + 1) : full;
  const subtitle = slash >= 0 ? full.slice(0, slash + 1) : undefined;
  const branch = (project.prBaseBranch || project.defaultBranch || '').trim() || undefined;
  return { hasProject: true, title: title || full, subtitle, fullName: full, branch };
}

// 디자이너: "이 프로젝트에만 적용됨" 스코프 인디케이터의 텍스트 카피.
// 본체 UI(아이콘+툴팁)와 테스트가 동일 문자열을 공유해 번역/문구 회귀를 방지한다.
// 기본 톤은 "계정 전역이 아니라 현재 프로젝트에만 묶임"을 직관적으로 전달하는 짧은
// 한 줄. aria-label 과 title 모두에 같은 값을 꽂아 스크린리더 사용자에게도 동일한
// 맥락을 준다.
export const PROJECT_SCOPE_LABEL = '프로젝트 전용 설정';
export const PROJECT_SCOPE_TOOLTIP = '이 설정은 현재 편집 중인 프로젝트에만 적용됩니다. 다른 프로젝트로 전환하면 별도의 값이 유지됩니다.';

export function describeProjectScope(projectLabel: EditingProjectLabel): string {
  // 선택된 프로젝트가 있으면 "이 설정은 org/repo 에만 적용됩니다" 형태로 구체화해
  // 스코프 오해(전역에 적용된다고 착각)를 줄인다. 없으면 기본 카피로 폴백.
  if (projectLabel.hasProject && projectLabel.fullName) {
    return `이 설정은 ${projectLabel.fullName} 에만 적용됩니다. 다른 프로젝트로 전환하면 별도의 값이 유지됩니다.`;
  }
  return PROJECT_SCOPE_TOOLTIP;
}

// Design: 공통 포커스 링 — 키보드 네비게이션에서 "현재 어디에 있는지"를 확실히 보여준다.
// Tailwind 변수로 정의된 accent 색상과 동일한 톤을 사용해 테마 변경에도 자동 대응한다.
const focusRing = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pixel-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black';

// 상위에서 현재 프로젝트가 지정되지 않았으면 관리 메뉴의 본 내용을 렌더하지
// 않는다. 훅이 걸리기 전(컴포넌트 경계)에서 분기해 Rules of Hooks 를 지키면서도
// 불필요한 네트워크/localStorage 접근을 차단한다.
//
// 2026-04-19 UX 감사(docs/ui-audit-2026-04-19.md §4-Ⅱ) 반영:
// 과거에는 여기서 `null` 을 돌려 프로젝트 관리 탭 직진입 시 "완전한 빈 화면" 이
// 되는 회귀가 있었다. 사용자는 사이드바에서 탭 5 를 눌렀는데 아무것도 안 뜨는
// 이유를 알 수 없었다. 본 변경에서는 작은 안내 박스로 교체해 "왜 비어 있는지 +
// 어디를 눌러야 하는지" 를 한눈에 전달한다. 박스 자체는 React 훅을 쓰지 않아
// `null` 반환과 마찬가지로 훅 규칙을 위반하지 않는다.
export function ProjectManagement({ onLog, currentProjectId }: Props) {
  if (!currentProjectId) {
    // 2026-04-19 ux-cleanup-visual 시안 §5 에 따라 공통 EmptyState 로 치환.
    // outer wrapper 는 기존 회귀 테스트(tests/projectManagementNoProjectPlaceholder.
    // regression.test.ts) 의 계약(role="status"·aria-live·data-testid) 을 지키기
    // 위해 그대로 유지한다. 현재 선택된 프로젝트가 없습니다 / 프로젝트를 먼저
    // 선택하면 두 문구를 같은 DOM 에 함께 담아 회귀 정규식과 정합 유지.
    // 2026-04-19 §9.4 이관 해소: 아이콘 없이 텍스트만 있던 빈 상태에 로고급
    // 아이콘(FolderGit2) 을 병기해 시각 계층을 상향. 공통 EmptyState 의 icon 슬롯
    // 을 그대로 활용하므로 디자인 토큰(--empty-state-icon-fg) 과 일관성을 유지한다.
    return (
      <div
        data-testid="project-management-no-project"
        role="status"
        aria-live="polite"
        className="p-8 max-w-2xl mx-auto"
      >
        <EmptyState
          variant="empty"
          icon={<FolderGit2 size={24} aria-hidden="true" style={{ color: 'var(--empty-state-icon-fg)' }} />}
          title="프로젝트를 먼저 선택하세요"
          description={<>
            현재 선택된 프로젝트가 없습니다. "프로젝트" 탭(단축키{' '}
            <kbd className="px-1.5 py-0.5 border border-white/25 rounded text-[10px]">2</kbd>)에서
            작업할 프로젝트를 먼저 선택하면, 공동 목표·Git 자동화·자격증명 설정이 이 화면에 표시됩니다.
          </>}
        />
      </div>
    );
  }
  return <ProjectManagementInner onLog={onLog} currentProjectId={currentProjectId} />;
}

function ProjectManagementInner({ onLog, currentProjectId }: Props & { currentProjectId: string }) {
  const [integrations, setIntegrations] = useState<SourceIntegration[]>([]);
  const [managed, setManaged] = useState<ManagedProject[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [busyIntegrationId, setBusyIntegrationId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [loadError, setLoadError] = useState<string | null>(null);
  // UX: 푸시/PR 생성은 일괄 작업이 아니라 "한 프로젝트"에 대한 신중한 행동이다.
  // 다중 선택 UI(체크박스)는 실수로 여러 저장소에 PR을 날릴 여지를 주므로,
  // 단일 선택(라디오 유사)으로 제한한다. null = 선택 없음.
  // 초기값은 localStorage에 보관된 "핀 고정 선택"으로 복원한다. 다음 PR 생성 흐름에서
  // 사용자가 라디오를 다시 고를 필요 없이 저장된 값을 기본으로 쓰기 위함.
  const [pinnedPrTargetProjectId, setPinnedPrTargetProjectId] = useState<string | null>(
    () => loadUserPreferences().pinnedPrTargetProjectId ?? null,
  );
  // 앱 전역이 알려주는 currentProjectId 를 기본 선택으로 삼는다. 핀 고정 값은 currentProjectId
  // 가 비어 있는 구버전 경로에서만 폴백으로 작동한다(본 컴포넌트는 이제 currentProjectId 없이는
  // 마운트되지 않지만, 초기 mount 타이밍에 pinned 값이 남아 있으면 먼저 보이는 것도 허용).
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    () => currentProjectId ?? pinnedPrTargetProjectId,
  );
  // 고정 선택 모드: true면 라디오는 잠겨 있고 "변경" 버튼으로만 해제 가능.
  // 초기 진입 시 이미 핀이 있다면 잠긴 상태에서 시작해 오조작을 막는다.
  const [isPrTargetLocked, setIsPrTargetLocked] = useState<boolean>(() => pinnedPrTargetProjectId !== null);
  const [pushingProjectId, setPushingProjectId] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  // 개발자(베타): Git 자동화 패널의 설정은 프로젝트마다 독립 슬롯에 보관한다.
  // 과거엔 전역 단일 state 에 올려 프로젝트 A 에서의 저장이 B 의 설정을 덮어쓰는
  // 치명적 버그가 있었다(감마 TC-PROJ*/TC-PS*). 읽기·쓰기 시 structuredClone 으로
  // 패널이 내부에 유지하는 참조와 연결을 끊어 mutation 전파도 함께 차단한다.
  const [gitAutomationByProject, setGitAutomationByProject] = useState<Record<string, GitAutomationSettings>>({});
  // 현재 선택된 프로젝트의 설정. 캐시 미스 시 DEFAULT_AUTOMATION 으로 폴백하며,
  // useEffect 가 비동기로 저장본을 로드해 캐시를 채운다. 리렌더마다 새 객체를
  // 만들면 하단 useEffect(scheduler) 가 매번 재시작되므로 clone 은 캐시 경계에서만.
  const gitAutomationSettings = useMemo<GitAutomationSettings>(() => {
    if (!selectedProjectId) return DEFAULT_AUTOMATION;
    return gitAutomationByProject[selectedProjectId] ?? DEFAULT_AUTOMATION;
  }, [selectedProjectId, gitAutomationByProject]);
  // UX: PR 대상 선택은 "관리 화면을 깔끔하게 유지"하기 위한 별도 동선이다.
  // 모달을 열면 가져온 모든 프로젝트가 검색 가능한 형태로 노출되며,
  // 체크박스 토글이 즉시 서버 PATCH로 반영된다. 닫으면 본 화면은 prTarget=true 만 보인다.
  const [showPrTargetSelector, setShowPrTargetSelector] = useState(false);
  const [selectorQuery, setSelectorQuery] = useState('');
  const [togglingPrTargetIds, setTogglingPrTargetIds] = useState<Set<string>>(new Set());
  // QA: 사용자가 새로고침을 연타하면 예전 응답이 최신 응답을 덮어쓰는 레이스가 발생한다.
  // 매 호출마다 AbortController를 갱신하고, 언마운트 시에도 in-flight 요청을 취소한다.
  const refreshAbortRef = useRef<AbortController | null>(null);
  // 개발자: "/" 단축키로 검색창에 빠르게 포커스. 입력 중인 다른 필드가 있으면 가로채지 않는다.
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = async () => {
    refreshAbortRef.current?.abort();
    const ctrl = new AbortController();
    refreshAbortRef.current = ctrl;
    setRefreshing(true);
    setLoadError(null);
    try {
      // 관리 메뉴 데이터는 서버에서 projectId 스코프로만 반환된다. currentProjectId
      // 가 비어 있으면 상위에서 이미 return null 로 컴포넌트가 마운트되지 않으므로
      // 여기서는 쿼리 파라미터로 붙이기만 하면 된다.
      const qs = `?projectId=${encodeURIComponent(currentProjectId)}`;
      const [iRes, mRes] = await Promise.all([
        fetch(`/api/integrations${qs}`, { signal: ctrl.signal }),
        fetch(`/api/managed-projects${qs}`, { signal: ctrl.signal }),
      ]);
      const errors: string[] = [];
      if (iRes.ok) {
        const data = await iRes.json();
        setIntegrations(Array.isArray(data) ? data : []);
      } else {
        errors.push(`연동 목록 (${iRes.status})`);
      }
      if (mRes.ok) {
        const data = await mRes.json();
        setManaged(Array.isArray(data) ? data : []);
      } else {
        errors.push(`프로젝트 목록 (${mRes.status})`);
      }
      if (errors.length > 0) {
        const msg = `로드 실패: ${errors.join(', ')}`;
        setLoadError(msg);
        onLog(msg);
      } else {
        setLastRefreshedAt(Date.now());
      }
    } catch (err) {
      // AbortError는 사용자가 의도한 취소이므로 에러 UI로 승격하지 않는다.
      if ((err as Error).name === 'AbortError') return;
      const msg = `새로고침 실패: ${(err as Error).message}`;
      setLoadError(msg);
      onLog(msg);
    } finally {
      if (refreshAbortRef.current === ctrl) setRefreshing(false);
    }
  };

  useEffect(() => {
    refresh();
    return () => refreshAbortRef.current?.abort();
  }, []);

  // 서버에서 prTarget=true인 프로젝트가 로드되면, 저장된 핀 선택이 여전히 유효한지
  // 확인한다. 다른 단말에서 대상을 바꿨거나 저장소가 삭제되어 stale이 된 경우엔
  // 핀을 조용히 무효화해 사용자가 "사라진 선택"을 계속 보지 않게 한다.
  useEffect(() => {
    if (managed.length === 0) return;
    if (pinnedPrTargetProjectId && !managed.some(p => p.id === pinnedPrTargetProjectId)) {
      setPinnedPrTargetProjectId(null);
      setIsPrTargetLocked(false);
      setSelectedProjectId(prev => (prev === pinnedPrTargetProjectId ? null : prev));
      saveUserPreferences({});
    }
  }, [managed, pinnedPrTargetProjectId]);

  // "5분 전" 같은 상대 시간 표시가 멈춰 있지 않도록 30초 간격으로 리렌더 유도.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!lastRefreshedAt) return;
    const id = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, [lastRefreshedAt]);

  // UX: ESC 키로 추가 폼을 닫아, 모달-유사 영역에서의 일관된 탈출 경험을 제공한다.
  useEffect(() => {
    if (!showAddForm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowAddForm(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showAddForm]);

  // 개발자 QoL: "/" 로 검색창에 포커스. 텍스트 입력 중이면 간섭하지 않는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/') return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 앱 전역 currentProjectId 가 바뀌면 내부 선택 상태도 해당 프로젝트로 즉시 전환한다.
  // useEffect 로 동기화하면 prop 변경 프레임에서 paint 된 뒤 한 틱 뒤에야 selectedProjectId
  // 가 따라오면서 "이전 프로젝트 컨텍스트의 PR 대상 표기"가 1프레임 노출되는 플래시가
  // 발생했다. useLayoutEffect 로 paint 직전에 동기 보정해 깜빡임을 제거한다.
  useLayoutEffect(() => {
    setSelectedProjectId(prev => (prev === currentProjectId ? prev : currentProjectId));
  }, [currentProjectId]);

  // 프로젝트 진입 시 서버 DB에서 설정을 로드한다.
  useEffect(() => {
    if (!selectedProjectId) return;
    let cancelled = false;
    loadGitAutomationSettings(selectedProjectId).then(loaded => {
      if (cancelled) return;
      setGitAutomationByProject(prev => ({ ...prev, [selectedProjectId]: loaded }));
    });
    return () => { cancelled = true; };
  }, [selectedProjectId]);

  // 개발자(베타): 설정이 enabled 이고 flow 가 push 를 포함할 때만 주기 러너를 깨운다.
  // 기존엔 gitAutomation.ts 에 스케줄러 자체가 없어 "토글은 켜져 있는데 아무것도 안
  // 돌아가는" 상태가 발생했다. 서버 러너가 아직 없다면 404 로 오므로, 한 번 404 를
  // 만나면 그 마운트 동안은 조용히 중단해 로그/네트워크 스팸을 차단한다.
  useEffect(() => {
    if (!gitAutomationSettings.enabled) return;
    if (gitAutomationSettings.flow === 'commit') return;
    let serverMissing = false;
    const stop = startGitAutomationScheduler({
      intervalMs: 120_000,
      isEnabled: () => gitAutomationSettings.enabled && !serverMissing,
      run: async () => {
        // trigger_git_automation 페이로드에 선택한 브랜치 전략과 'fixed-branch' 의
        // newBranchName 이 함께 직렬화되도록 서버 포맷으로 변환해 보낸다.
        const res = await fetch('/api/git-automation/tick', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: selectedProjectId,
            settings: toServerSettings(gitAutomationSettings),
          }),
        }).catch(() => null);
        if (!res) return;
        if (res.status === 404) { serverMissing = true; return; }
        if (!res.ok) onLog(`Git 자동화 주기 실행 실패 (${res.status})`);
      },
      onError: (err) => onLog(`Git 자동화 스케줄러 오류: ${(err as Error).message}`),
    });
    return stop;
  }, [gitAutomationSettings, selectedProjectId, onLog]);

  const addIntegration = async (provider: SourceProvider, label: string, accessToken: string, host: string) => {
    // QA guards: the form enforces these too, but programmatic callers
    // (tests, future automations) shouldn't be able to POST empty tokens.
    if (!accessToken.trim()) { onLog('액세스 토큰이 비어 있습니다'); return; }
    if (isTokenTooShort(accessToken)) {
      // QA: 토큰 자체를 로그로 흘리지 말고 마스킹된 힌트만 보여준다.
      onLog(`토큰이 너무 짧습니다 (최소 ${MIN_TOKEN_LEN}자, 입력: ${maskToken(accessToken)})`);
      return;
    }
    if (host && !/^https?:\/\//i.test(host)) { onLog('호스트 URL은 http(s):// 로 시작해야 합니다'); return; }
    if (label.length > MAX_LABEL_LEN) { onLog(`라벨이 너무 깁니다 (최대 ${MAX_LABEL_LEN}자)`); return; }
    if (host.length > MAX_HOST_LEN) { onLog('호스트 URL이 너무 깁니다'); return; }
    // QA: 라벨에 개행·ANSI 이스케이프 같은 제어문자가 있으면 로그 라인 위조에 악용될 수 있다.
    if (hasControlChars(label)) { onLog('라벨에 허용되지 않는 제어문자가 포함되어 있습니다'); return; }
    const dup = findDuplicateIntegration(integrations, provider, host);
    if (dup) { onLog(`중복 연동: 이미 "${dup.label}"가 같은 호스트로 등록됨`); return; }
    try {
      const res = await fetch('/api/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: currentProjectId, provider, label, accessToken, host: host || undefined }),
      });
      if (res.ok) {
        onLog(`${provider.toUpperCase()} 연동 추가: ${label}`);
        setShowAddForm(false);
        refresh();
      } else {
        const body = await res.json().catch(() => ({} as { error?: string }));
        // QA: 서버 에러 본문에 토큰 원문이 에코될 가능성에 대비해 redact 후 로깅.
        onLog(`연동 추가 실패: ${redactTokens(String(body.error || res.status))}`);
      }
    } catch (err) {
      onLog(`연동 추가 중 오류: ${redactTokens((err as Error).message)}`);
    }
  };

  const deleteIntegration = async (id: string, label: string) => {
    if (!confirm(`${label} 연동을 삭제할까요? 가져온 프로젝트 목록은 유지됩니다.`)) return;
    try {
      const res = await fetch(`/api/integrations/${id}`, { method: 'DELETE' });
      if (res.ok) { onLog(`연동 삭제: ${label}`); refresh(); }
      else onLog(`연동 삭제 실패: ${label} (${res.status})`);
    } catch (err) {
      onLog(`연동 삭제 중 오류: ${(err as Error).message}`);
    }
  };

  const importFromIntegration = async (integration: SourceIntegration) => {
    // Prevent double-clicks from firing a second import while the first is in flight.
    if (busyIntegrationId === integration.id) return;
    setBusyIntegrationId(integration.id);
    try {
      const res = await fetch(`/api/integrations/${integration.id}/import`, { method: 'POST' });
      if (res.ok) {
        const body = await res.json().catch(() => ({ imported: 0 } as { imported?: number }));
        onLog(`${integration.label}에서 프로젝트 ${body.imported ?? 0}개 가져옴`);
        refresh();
      } else {
        const body = await res.json().catch(() => ({} as { error?: string }));
        onLog(`가져오기 실패: ${body.error || res.status}`);
      }
    } catch (err) {
      onLog(`가져오기 중 오류: ${(err as Error).message}`);
    } finally {
      setBusyIntegrationId(null);
    }
  };

  // 선택된 단일 프로젝트에 대해서만 푸시/PR 생성 엔드포인트를 호출한다.
  // 서버가 해당 라우트를 아직 구현하지 않더라도, UI는 실패 메시지를 통해 안내한다.
  const pushAndCreatePR = async () => {
    if (!selectedProjectId) { onLog('PR을 생성할 프로젝트를 먼저 선택하세요'); return; }
    const target = managed.find(p => p.id === selectedProjectId);
    if (!target) { onLog('선택한 프로젝트를 찾을 수 없습니다'); return; }
    if (!confirm(`${target.fullName}에 변경사항을 푸시하고 PR을 생성할까요?`)) return;
    setPushingProjectId(selectedProjectId);
    try {
      // 개발자: PushPRActionBar에서 사용자가 지정한 대상 브랜치를 서버로 함께 보낸다.
      // 비어 있으면 서버가 defaultBranch로 폴백하도록 undefined로 떨어뜨린다.
      const baseBranch = (target.prBaseBranch || '').trim() || undefined;
      const res = await fetch(`/api/managed-projects/${selectedProjectId}/push-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseBranch }),
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({} as { prUrl?: string }));
        onLog(`PR 생성: ${target.fullName}${body.prUrl ? ` — ${body.prUrl}` : ''}`);
      } else {
        const body = await res.json().catch(() => ({} as { error?: string }));
        onLog(`PR 생성 실패: ${target.fullName} (${body.error || res.status})`);
      }
    } catch (err) {
      onLog(`PR 생성 중 오류: ${(err as Error).message}`);
    } finally {
      setPushingProjectId(null);
    }
  };

  const deleteManaged = async (id: string, name: string) => {
    if (!confirm(`${name}을(를) 관리 목록에서 제외할까요?`)) return;
    // QA: deleteIntegration과 달리 과거 코드는 네트워크 예외를 잡지 않아,
    // 오프라인 상태에서 버튼이 침묵으로 실패하는 회귀를 만들었다. try/catch로 통일.
    try {
      const res = await fetch(`/api/managed-projects/${id}`, { method: 'DELETE' });
      if (res.ok) {
        onLog(`관리 프로젝트 제외: ${name}`);
        // 삭제된 항목이 현재 선택 대상이었다면 선택 상태를 비워 stale한 푸시/PR 시도를 막는다.
        if (selectedProjectId === id) setSelectedProjectId(null);
        refresh();
      }
      else onLog(`제외 실패: ${name} (${res.status})`);
    } catch (err) {
      onLog(`제외 중 오류: ${(err as Error).message}`);
    }
  };

  // 관리 화면 본 목록은 PR 대상으로 표시한 프로젝트만 노출한다. 사용자가
  // 명시적으로 "PR 대상으로 지정"한 항목만 일상적 작업 동선에 들어오게 해
  // 수십~수백 개의 외부 저장소가 카드 그리드를 압도하지 않도록 한다.
  const prTargetManaged = useMemo(
    () => managed.filter(p => p.prTarget === true),
    [managed],
  );

  const stats = useMemo(() => {
    let described = 0;
    let totalDescLen = 0;
    let shortDesc = 0;
    const byProvider: Record<string, number> = {};
    // 통계는 본 화면이 다루는 단위(=PR 대상으로 지정된 프로젝트)에 대해 계산한다.
    // 그래야 "표시"·"보강 권장" 등 인사이트가 화면과 정합한다.
    for (const p of prTargetManaged) {
      byProvider[p.provider] = (byProvider[p.provider] || 0) + 1;
      const desc = (p.description || '').trim();
      if (desc.length > 0) {
        described += 1;
        totalDescLen += desc.length;
        if (desc.length < SHORT_DESCRIPTION_THRESHOLD) shortDesc += 1;
      }
    }
    const coverage = prTargetManaged.length === 0 ? 0 : Math.round((described / prTargetManaged.length) * 100);
    // 연구원: 평균은 "설명이 있는 프로젝트만" 기준으로 계산한다. 빈 설명까지
    // 합산 평균에 포함하면 카드가 늘어날수록 평균이 0으로 쏠려 정보량이 사라진다.
    const avgDescLen = described === 0 ? 0 : Math.round(totalDescLen / described);
    const diversity = providerDiversity(byProvider);
    const qualityBuckets = bucketByQuality(prTargetManaged);
    return { byProvider, described, coverage, avgDescLen, shortDesc, diversity, qualityBuckets };
  }, [prTargetManaged]);

  // 연구원: 현재 가져온 프로젝트 목록을 CSV로 내보낸다. 다운로드 직후 URL을 해제해
  // 장시간 세션에서 객체 URL이 누적되는 것을 막는다. 파일명에 ISO 일자를 포함해
  // 일별 스냅샷 비교가 쉽도록 한다.
  const downloadSnapshot = () => {
    // 본 화면이 다루는 단위(PR 대상)만 스냅샷 대상이 되도록 한다.
    if (prTargetManaged.length === 0) { onLog('내보낼 프로젝트가 없습니다'); return; }
    const csv = managedToCsv(prTargetManaged);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `research-snapshot-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // revoke는 a.click이 파일 저장 다이얼로그를 띄운 뒤 안전하게 수행한다.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    onLog(`리서치 스냅샷 내보냄: ${prTargetManaged.length}개 프로젝트`);
  };

  // 단일 선택 정책: PR 대상은 프로젝트 하나만 지정할 수 있다.
  // 새로운 항목을 켜면 기존 대상을 먼저 해제하고, 서버 저장도 연쇄적으로 수행한다.
  const togglePrTarget = async (project: ManagedProject, next: boolean) => {
    const previousTargets = next
      ? managed.filter(p => p.prTarget === true && p.id !== project.id)
      : [];
    // 낙관적 업데이트: 새 대상은 true로, 기존 대상들은 즉시 해제해 UI가 단일 선택처럼 보이게 한다.
    setManaged(prev => prev.map(p => {
      if (p.id === project.id) return { ...p, prTarget: next || undefined };
      if (next && p.prTarget === true) return { ...p, prTarget: undefined };
      return p;
    }));
    const touchedIds = [project.id, ...previousTargets.map(p => p.id)];
    setTogglingPrTargetIds(prev => { const s = new Set(prev); touchedIds.forEach(id => s.add(id)); return s; });
    try {
      // 먼저 기존 대상들을 서버에서 해제한다. 실패는 아래 refresh로 보정.
      await Promise.all(previousTargets.map(async prev => {
        const res = await fetch(`/api/managed-projects/${prev.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prTarget: false }),
        });
        if (res.ok) {
          const saved = await res.json() as ManagedProject;
          setManaged(cur => cur.map(p => p.id === prev.id ? saved : p));
        }
      }));
      const res = await fetch(`/api/managed-projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prTarget: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        onLog(`PR 대상 저장 실패: ${project.fullName} (${body.error || res.status})`);
        refresh();
        return;
      }
      const saved = await res.json() as ManagedProject;
      setManaged(prev => prev.map(p => p.id === project.id ? saved : p));
      if (next && previousTargets.length > 0) {
        onLog(`PR 대상 변경: ${previousTargets.map(p => p.fullName).join(', ')} → ${project.fullName}`);
      } else {
        onLog(`PR 대상 ${next ? '지정' : '해제'}: ${project.fullName}`);
      }
      // 새 대상을 지정하면 푸시/PR 선택도 해당 프로젝트로 맞춘다. 해제 시에는 stale 선택을 비운다.
      if (next) setSelectedProjectId(project.id);
      else if (selectedProjectId === project.id) setSelectedProjectId(null);
    } catch (err) {
      onLog(`PR 대상 저장 중 오류: ${(err as Error).message}`);
      refresh();
    } finally {
      setTogglingPrTargetIds(prev => { const s = new Set(prev); touchedIds.forEach(id => s.delete(id)); return s; });
    }
  };

  const visibleManaged = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const base = prTargetManaged;
    const filtered = needle
      ? base.filter(p =>
          p.fullName.toLowerCase().includes(needle) ||
          (p.description || '').toLowerCase().includes(needle))
      : base;
    // Stable ordering so research comparisons stay reproducible across refreshes.
    const sorted = [...filtered];
    // QA: 'recent'는 서버 응답 순서(최근 가져온 것부터)를 그대로 쓰므로 정렬 생략.
    // 'name'/'provider'는 로케일 비교로 한글·영문 혼재 목록을 안정적으로 정렬한다.
    if (sortKey === 'name') sorted.sort((a, b) => a.fullName.localeCompare(b.fullName));
    else if (sortKey === 'provider') sorted.sort((a, b) => a.provider.localeCompare(b.provider) || a.fullName.localeCompare(b.fullName));
    return sorted;
  }, [prTargetManaged, query, sortKey]);

  // 모달 검색 결과: 가져온 모든 프로젝트(=managed) 위에서 selectorQuery 로 필터링한다.
  // 정렬은 PR 대상 우선 → 이름순으로, 이미 선택한 항목이 위에 모이도록 한다.
  const selectorVisible = useMemo(() => {
    const needle = selectorQuery.trim().toLowerCase();
    const filtered = needle
      ? managed.filter(p =>
          p.fullName.toLowerCase().includes(needle) ||
          (p.description || '').toLowerCase().includes(needle))
      : managed;
    return [...filtered].sort((a, b) => {
      const at = a.prTarget === true ? 0 : 1;
      const bt = b.prTarget === true ? 0 : 1;
      if (at !== bt) return at - bt;
      return a.fullName.localeCompare(b.fullName);
    });
  }, [managed, selectorQuery]);

  // 디자이너: 선택(또는 핀 고정)된 "현재 편집 중인 프로젝트"를 헤더로 끌어올려
  // 어떤 프로젝트 컨텍스트에서 작업 중인지를 페이지 최상단에서 즉시 보여준다.
  // 선택이 없으면 placeholder 톤으로 렌더링해, 하단 설정이 "선택 없이 전역처럼"
  // 적용된다는 오해를 방지한다.
  const editingProject = prTargetManaged.find(p => p.id === selectedProjectId) || null;
  const editingLabel = formatEditingProjectLabel(editingProject);
  const scopeTooltip = describeProjectScope(editingLabel);

  return (
    <div className="p-8 space-y-8">
      {/* 디자이너 v2 시안(EmptyProjectPlaceholder.tsx ProjectEditingHeader) 으로 교체.
          기존 인라인 헤더는 editingLabel 을 무시하고 항상 placeholder 만 보여주는
          버그가 있었다(선택해도 "선택된 프로젝트 없음" 고정 표기). 시안 컴포넌트는
          data-state 분기 + 좌측 스트라이프 + branch meta 칩까지 한 번에 처리한다. */}
      <ProjectEditingHeader
        projectName={editingLabel.hasProject ? editingLabel.fullName ?? editingLabel.title : null}
        meta={editingLabel.hasProject && editingLabel.branch ? (
          <span
            className="pm-editing-header__meta inline-flex items-center gap-1 px-2 py-1 border-2 border-[var(--pixel-border)] bg-black/30 text-[10px] uppercase tracking-wider text-white/80"
            title={`PR base 브랜치: ${editingLabel.branch}`}
            aria-label={`PR base 브랜치 ${editingLabel.branch}`}
          >
            <GitBranch size={10} aria-hidden /> {editingLabel.branch}
          </span>
        ) : undefined}
      />
      {loadError && (
        <div
          role="alert"
          aria-live="polite"
          className="border-2 border-red-500/70 bg-red-900/30 text-red-200 p-3 flex items-center gap-2 text-[11px]"
        >
          <AlertTriangle size={14} className="shrink-0" />
          <span className="flex-1">{loadError}</span>
          <button
            onClick={refresh}
            className="px-2 py-1 bg-red-900/40 border border-red-500/70 hover:bg-red-900/70 text-[10px] uppercase font-bold"
          >
            재시도
          </button>
        </div>
      )}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-[var(--pixel-accent)] uppercase tracking-wider">소스 연동</h2>
            <SectionBadge count={integrations.length} />
          </div>
          <div className="flex items-center gap-2">
            <span
              className="hidden sm:inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-white/50"
              title={lastRefreshedAt ? new Date(lastRefreshedAt).toLocaleString() : '아직 새로고침 안 됨'}
              aria-live="polite"
            >
              <Clock size={10} /> {formatRefreshAge(lastRefreshedAt)}
            </span>
            <button
              onClick={refresh}
              disabled={refreshing}
              aria-label="연동 및 프로젝트 목록 새로고침"
              aria-busy={refreshing}
              className={`p-2 bg-black/30 border-2 border-[var(--pixel-border)] hover:border-[var(--pixel-accent)] transition-colors disabled:opacity-40 ${focusRing}`}
              title="새로고침"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={() => setShowAddForm(v => !v)}
              aria-expanded={showAddForm}
              aria-controls="integration-add-form"
              className={`px-3 py-2 bg-[var(--pixel-accent)] text-black text-[11px] font-bold uppercase border-b-2 border-[#0099cc] flex items-center gap-2 hover:brightness-110 active:translate-y-px transition ${focusRing}`}
            >
              <Plus size={14} /> 연동 추가
            </button>
          </div>
        </div>

        {showAddForm && (
          <div id="integration-add-form">
            <IntegrationForm onSubmit={addIntegration} onCancel={() => setShowAddForm(false)} />
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {integrations.length === 0 && (
            <EmptyState
              icon={<Link2Off size={28} />}
              title="연동된 소스가 없습니다"
              description="GitHub 또는 GitLab 액세스 토큰으로 저장소를 연결하세요."
            />
          )}
          {integrations.map(i => (
            <div key={i.id} className="bg-[#0f3460] border-2 border-[var(--pixel-border)] p-4 flex items-center justify-between hover:border-[var(--pixel-accent)] transition-colors">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 border-2 border-black bg-[var(--pixel-bg)] flex items-center justify-center shrink-0">
                  {i.provider === 'github' ? <Github size={18} /> : <GitBranch size={18} />}
                </div>
                <div className="min-w-0">
                  <h4 className="text-sm font-bold text-[var(--pixel-accent)] truncate">{i.label}</h4>
                  <p className="text-[10px] opacity-70 uppercase flex items-center gap-1 truncate">
                    <span>{i.provider}</span>
                    {i.host && (
                      <>
                        <span className="opacity-50">·</span>
                        <Server size={10} className="opacity-70" />
                        <span className="truncate">{i.host.replace(/^https?:\/\//, '')}</span>
                      </>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => importFromIntegration(i)}
                  disabled={busyIntegrationId === i.id}
                  className="p-2 bg-black/30 border-2 border-[var(--pixel-border)] hover:border-[var(--pixel-accent)] transition-colors disabled:opacity-40"
                  title="프로젝트 가져오기"
                >
                  {busyIntegrationId === i.id ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
                </button>
                <button
                  onClick={() => deleteIntegration(i.id, i.label)}
                  className="p-2 bg-red-900/20 border-2 border-red-900/60 hover:bg-red-900 hover:border-red-500 text-red-300 hover:text-white transition-colors"
                  title="연동 삭제"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-[var(--pixel-accent)] uppercase tracking-wider">PR 대상 프로젝트</h2>
            <SectionBadge count={prTargetManaged.length} />
            <span className="text-[10px] text-white/50 uppercase tracking-wider" title="가져온 전체 저장소 중 PR 대상으로 지정된 수">
              / 전체 {managed.length}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {pinnedPrTargetProjectId && (
              isPrTargetLocked ? (
                <button
                  onClick={() => {
                    // "변경" 버튼: 잠금을 풀어 라디오 재선택을 허용한다. 핀 자체는 유지해,
                    // 사용자가 변경을 취소하고 이탈해도 기존 기본값이 보존된다.
                    setIsPrTargetLocked(false);
                    onLog('PR 대상 변경 모드: 잠금 해제');
                  }}
                  className={`px-3 py-2 bg-black/30 border-2 border-[var(--pixel-border)] text-[11px] font-bold uppercase text-white/80 hover:border-[var(--pixel-accent)] hover:text-[var(--pixel-accent)] flex items-center gap-2 transition ${focusRing}`}
                  title="고정된 PR 대상을 해제하고 다른 프로젝트로 변경합니다"
                  aria-label="PR 대상 변경"
                >
                  <Pencil size={14} /> 변경
                </button>
              ) : (
                <button
                  onClick={() => {
                    // 핀 제거: 다음 세션부터는 자동 복원하지 않는다. 라디오는 이미 해제 상태.
                    setPinnedPrTargetProjectId(null);
                    saveUserPreferences({});
                    onLog('PR 대상 고정 해제');
                  }}
                  className={`px-3 py-2 bg-black/30 border-2 border-[var(--pixel-border)] text-[11px] font-bold uppercase text-white/80 hover:border-red-400 hover:text-red-300 flex items-center gap-2 transition ${focusRing}`}
                  title="저장된 기본 PR 대상 고정을 제거합니다"
                  aria-label="PR 대상 고정 해제"
                >
                  고정 해제
                </button>
              )
            )}
            <button
              onClick={() => setShowPrTargetSelector(true)}
              className={`px-3 py-2 bg-[var(--pixel-accent)] text-black text-[11px] font-bold uppercase border-b-2 border-[#0099cc] flex items-center gap-2 hover:brightness-110 active:translate-y-px transition ${focusRing}`}
              title="가져온 모든 프로젝트에서 PR 작업 대상을 검색·선택합니다"
            >
              <Search size={14} /> PR 대상 선택
            </button>
            <div className={`flex items-center gap-1 bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1 transition-colors ${query ? 'border-[var(--pixel-accent)]' : ''}`}>
              <Search size={12} className={query ? 'text-[var(--pixel-accent)]' : 'opacity-60'} />
              <input
                ref={searchInputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                // UX: 툴팁이 약속한 "검색 초기화 (Esc)"를 실제로 이행한다.
                // 비어 있는 상태에서 Esc는 브라우저·부모 핸들러로 전파되도록 둔다.
                onKeyDown={e => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }}
                placeholder="검색 (/)"
                aria-label="프로젝트 검색"
                className="bg-transparent text-[11px] text-white w-32 focus:outline-none placeholder:text-white/40"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  aria-label="검색어 지우기"
                  title="검색 초기화 (Esc)"
                  className="text-white/60 hover:text-[var(--pixel-accent)] text-[11px] font-bold px-1"
                >
                  ×
                </button>
              )}
            </div>
            <select
              value={sortKey}
              onChange={e => setSortKey(e.target.value as SortKey)}
              className="bg-black/30 border-2 border-[var(--pixel-border)] text-[11px] text-white px-2 py-1"
              title="정렬 기준"
            >
              <option value="name">이름순</option>
              <option value="provider">제공자순</option>
              <option value="recent">원래 순서</option>
            </select>
          </div>
        </div>
        {/* QA: 검색 시 결과 수를 스크린리더에 알려, 시력 보조 사용자가 필터 변화를 감지하게 한다. */}
        <span className="sr-only" role="status" aria-live="polite">
          {query.trim() ? `검색 결과 ${visibleManaged.length}개` : ''}
        </span>

        {/* 공동 목표(SharedGoal) 입력 폼: 프로젝트 관리 메뉴에 진입한 순간부터
            prTarget 등록 여부와 무관하게 항상 렌더되어야 한다. 자동 개발 ON 의
            전제조건이 "활성 공동 목표 1건" 이기 때문(서버 taskRunner 가드 + App
            sharedGoalPromptOpen 계약). 폼 내부는 사용자가 [목표 저장] 버튼을
            명시적으로 누를 때에만 POST 하므로, GET 이 아직 돌아오지 않은 시점
            에도 사용자의 편집이 서버 응답에 덮이지 않는다 — GitAutomationPanel
            1587ea9 하이드레이션 레이스와 동일 교훈. */}
        <SharedGoalForm projectId={selectedProjectId} onLog={onLog} />

        {prTargetManaged.length > 0 && (
          <ResearchInsights
            stats={stats}
            total={prTargetManaged.length}
            visible={visibleManaged.length}
            onExport={downloadSnapshot}
            onCopyDevSummary={async () => {
              // 개발자: 채팅·이슈에 붙여넣기 좋은 한 줄 상태 요약을 클립보드로 복사한다.
              // 클립보드 API는 비보안 컨텍스트에서 거부될 수 있으므로 textarea 폴백을 둔다.
              const summary = summarizeForDev(prTargetManaged);
              try {
                if (navigator.clipboard?.writeText) {
                  await navigator.clipboard.writeText(summary);
                } else {
                  const ta = document.createElement('textarea');
                  ta.value = summary;
                  ta.setAttribute('readonly', '');
                  ta.style.position = 'fixed';
                  ta.style.opacity = '0';
                  document.body.appendChild(ta);
                  ta.select();
                  document.execCommand('copy');
                  ta.remove();
                }
                onLog(`개발자 요약 복사: ${summary}`);
              } catch (err) {
                onLog(`요약 복사 실패: ${(err as Error).message}`);
              }
            }}
          />
        )}

        {prTargetManaged.length > 0 && (
          <div className="space-y-2">
            {/* 디자이너: 설정 패널 바로 위에 "이 프로젝트에만 적용됨" 스코프 인디케이터를
                붙여, 사용자가 저장 버튼을 누르기 직전에 스코프 맥락을 다시 한 번 확인하게 한다.
                헤더와 동일한 카피를 공유해 용어 분열을 막는다. */}
            <div
              className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/70"
              data-testid="automation-scope-indicator"
              title={scopeTooltip}
              aria-label={`${PROJECT_SCOPE_LABEL}: ${scopeTooltip}`}
            >
              <Pin size={10} className="text-[var(--pixel-accent)]" />
              <span className="text-[var(--pixel-accent)] font-bold">{PROJECT_SCOPE_LABEL}</span>
              <span className="text-white/50 normal-case tracking-normal truncate">
                — {editingLabel.hasProject ? editingLabel.fullName : '프로젝트를 선택해 스코프를 고정하세요'}
              </span>
            </div>
            {selectedProjectId && (
              <GitCredentialsSection
                projectId={selectedProjectId}
                onLog={onLog}
              />
            )}
            {/* 저장/로드 레이스 방지: 서버에서 설정을 불러오기 전까지는 GitAutomationPanel
                을 마운트하지 않는다. GitAutomationPanel 은 `initial` 을 useState 초기값으로만
                읽기 때문에, DEFAULT_AUTOMATION 으로 먼저 마운트한 뒤 비동기 로드가 끝난
                다음에 `initial` 이 갱신돼도 내부 local state 는 그대로 남아 사용자가 저장한
                값이 "되돌아간 것처럼" 보이는 회귀가 있었다. 로드 완료 여부는
                `gitAutomationByProject[selectedProjectId]` 의 존재로 판정하고, 프로젝트가
                바뀔 때 key 를 달리 줘 새 프로젝트의 저장값으로 반드시 재초기화되게 한다. */}
            {selectedProjectId && gitAutomationByProject[selectedProjectId] === undefined ? (
              // 2026-04-19 ux-cleanup-visual 시안 §5 에 따라 공통 EmptyState(variant=loading)
              // 로 치환. data-testid 는 기존 테스트/DOM 쿼리와 맞물릴 수 있어 유지.
              <EmptyState
                variant="loading"
                title="Git 자동화 설정을 불러오는 중…"
                description="프로젝트별 저장된 자동화 옵션을 서버에서 가져오고 있습니다."
                fillMinHeight={false}
                testId="git-automation-panel-loading"
              />
            ) : (
              // 프로젝트 전환 시 `GitAutomationPanel` 을 반드시 재마운트하기 위해
              // Fragment 의 key 로 selectedProjectId 를 넘긴다. 자식이 `initial` 을
              // useState 초기값으로만 읽기 때문에, 캐시된 두 프로젝트 간을 오갈 때
              // 이전 프로젝트의 local state 가 남지 않도록 강제 리셋한다. `key` 를
              // 패널 자체에 두는 대안은 해당 컴포넌트 Props 타입에 `key` 가 없어
              // 회귀 타입체크에서 경고를 유발하므로 Fragment 로 감싼다.
              <React.Fragment key={selectedProjectId || 'no-project'}>
              <GitAutomationPanel
                initial={gitAutomationSettings}
                onSave={(next) => {
                  // 스코프 격리: 현재 선택된 projectId 의 슬롯만 갱신한다. 프로젝트를
                  // 선택하지 않은 상태의 저장은 "어느 저장소에 적용될지 모호"하므로 차단.
                  if (!selectedProjectId) { onLog('설정을 저장할 프로젝트를 먼저 선택하세요'); return; }
                  // structuredClone 으로 패널이 유지할 수 있는 참조와 분리. 이후 패널
                  // 쪽에서 상태를 mutate 해도 우리 state/localStorage 는 오염되지 않는다.
                  const cloned = structuredClone(next);
                  setGitAutomationByProject(prev => ({ ...prev, [selectedProjectId]: cloned }));
                  saveGitAutomationSettings(cloned, selectedProjectId);
                }}
                onLog={onLog}
                sample={(() => {
                  const sel = prTargetManaged.find(p => p.id === selectedProjectId);
                  return sel
                    ? { branch: (sel.prBaseBranch || sel.defaultBranch || 'main') }
                    : undefined;
                })()}
              />
              </React.Fragment>
            )}
          </div>
        )}

        {prTargetManaged.length > 0 && (
          <PushPRActionBar
            selected={prTargetManaged.find(p => p.id === selectedProjectId) || null}
            onClear={() => setSelectedProjectId(null)}
            onPush={pushAndCreatePR}
            busy={pushingProjectId !== null}
            onBaseBranchChange={async (id, branch) => {
              // DB에 PR 대상 브랜치를 저장한다. 낙관적 업데이트 후 서버 응답으로 정합성 보정.
              setManaged(prev => prev.map(p => p.id === id ? { ...p, prBaseBranch: branch || undefined } : p));
              try {
                const res = await fetch(`/api/managed-projects/${id}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ prBaseBranch: branch }),
                });
                if (!res.ok) {
                  const body = await res.json().catch(() => ({} as { error?: string }));
                  onLog(`PR 대상 브랜치 저장 실패 (${body.error || res.status})`);
                  refresh();
                  return;
                }
                const saved = await res.json() as ManagedProject;
                setManaged(prev => prev.map(p => p.id === id ? saved : p));
                onLog(`PR 대상 브랜치 저장: ${saved.fullName} → ${saved.prBaseBranch || saved.defaultBranch || '(기본)'}`);
              } catch (err) {
                onLog(`PR 대상 브랜치 저장 중 오류: ${(err as Error).message}`);
                refresh();
              }
            }}
          />
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {managed.length === 0 && (
            <EmptyState
              icon={<FolderGit2 size={28} />}
              title="가져온 프로젝트가 없습니다"
              description="연동된 소스의 다운로드 버튼으로 저장소를 가져오세요."
            />
          )}
          {managed.length > 0 && prTargetManaged.length === 0 && (
            <EmptyState
              icon={<GitPullRequest size={28} />}
              title="PR 대상으로 지정된 프로젝트가 없습니다"
              description={'"PR 대상 선택" 버튼으로 가져온 저장소 중 작업 대상을 골라 추가하세요.'}
            />
          )}
          {prTargetManaged.length > 0 && visibleManaged.length === 0 && (
            <EmptyState
              icon={<Search size={28} />}
              title="검색 결과가 없습니다"
              description={`"${query}"에 해당하는 PR 대상 프로젝트가 없습니다.`}
            />
          )}
          {visibleManaged.map(p => {
            const isSelected = selectedProjectId === p.id;
            return (
            <article
              key={p.id}
              aria-selected={isSelected}
              data-editing={isSelected ? 'true' : undefined}
              className={`relative bg-[#0f3460] border-2 p-4 hover:-translate-y-0.5 transition-all ${isSelected ? 'border-[var(--pixel-accent)] bg-gradient-to-br from-[#0f3460] to-[#123a6b] ring-2 ring-[var(--pixel-accent)]/60 ring-offset-2 ring-offset-[#16213e] shadow-[inset_0_0_0_1px_rgba(0,212,255,0.35),0_0_18px_-6px_rgba(0,212,255,0.55)]' : 'border-[var(--pixel-border)] hover:border-[var(--pixel-accent)]'}`}
            >
              {isSelected && (
                <span
                  aria-label="현재 편집 중인 프로젝트"
                  title="이 프로젝트의 설정을 편집 중입니다"
                  className="absolute -top-2 left-3 px-2 py-0.5 bg-[var(--pixel-accent)] text-black text-[9px] font-bold uppercase tracking-[0.18em] border-2 border-black shadow-[1px_1px_0_0_rgba(0,0,0,0.6)] inline-flex items-center gap-1"
                >
                  <Pin size={9} /> 편집 중
                </span>
              )}
              <div className="flex justify-between items-start mb-3 gap-2">
                <label className={`flex items-center gap-2 min-w-0 select-none ${isPrTargetLocked ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                  <input
                    type="radio"
                    name="pr-target-project"
                    checked={isSelected}
                    disabled={isPrTargetLocked}
                    onChange={() => {
                      // 잠금 상태에서 라디오는 disabled이므로 onChange가 호출되지 않는다.
                      // 잠금 해제 상태에서만 새 대상을 선택하고 즉시 "핀 고정"으로 영속화한다.
                      setSelectedProjectId(p.id);
                      setPinnedPrTargetProjectId(p.id);
                      saveUserPreferences({ pinnedPrTargetProjectId: p.id });
                      setIsPrTargetLocked(true);
                      onLog(`PR 대상 고정: ${p.fullName}`);
                    }}
                    aria-label={`${p.fullName}을(를) PR 대상으로 선택`}
                    className={`accent-[var(--pixel-accent)] shrink-0 ${isPrTargetLocked ? 'cursor-not-allowed opacity-60' : `cursor-pointer ${focusRing}`}`}
                  />
                  <h3 className="text-sm font-bold text-[var(--pixel-accent)] truncate" title={p.fullName}>{p.fullName}</h3>
                  {isSelected && pinnedPrTargetProjectId === p.id && (
                    <Pin size={12} className="text-[var(--pixel-accent)] shrink-0" aria-label="고정된 PR 대상" />
                  )}
                </label>
                <span
                  className="px-2 py-1 bg-black/30 text-[9px] uppercase font-bold border border-[var(--pixel-border)] shrink-0"
                  aria-label={`제공자 ${p.provider}`}
                >
                  {p.provider}
                </span>
              </div>
              <p className="text-white/70 text-[11px] mb-3 h-8 line-clamp-2" title={p.description || ''}>
                {p.description || <span className="opacity-40">설명 없음</span>}
              </p>
              <div className="flex items-center justify-between">
                <a
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`${p.fullName} 저장소 새 창에서 열기`}
                  className={`text-[10px] text-[var(--pixel-accent)] underline opacity-80 hover:opacity-100 ${focusRing}`}
                >
                  저장소 열기 ↗
                </a>
                <button
                  onClick={() => deleteManaged(p.id, p.fullName)}
                  aria-label={`${p.fullName} 관리 목록에서 제외`}
                  className={`p-1.5 bg-red-900/20 border-2 border-red-900/60 hover:bg-red-900 text-red-300 hover:text-white transition-colors ${focusRing}`}
                  title="제외"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </article>
            );
          })}
        </div>
      </section>

      {showPrTargetSelector && (
        <PrTargetSelectorModal
          all={managed}
          visible={selectorVisible}
          query={selectorQuery}
          onQueryChange={setSelectorQuery}
          onClose={() => { setShowPrTargetSelector(false); setSelectorQuery(''); }}
          onToggle={togglePrTarget}
          togglingIds={togglingPrTargetIds}
        />
      )}
    </div>
  );
}

function PrTargetSelectorModal({
  all,
  visible,
  query,
  onQueryChange,
  onClose,
  onToggle,
  togglingIds,
}: {
  all: ManagedProject[];
  visible: ManagedProject[];
  query: string;
  onQueryChange: (v: string) => void;
  onClose: () => void;
  onToggle: (project: ManagedProject, next: boolean) => void | Promise<void>;
  togglingIds: Set<string>;
}) {
  // ESC로 닫기 — 다른 모달 패턴과 일관성을 유지한다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // 단일 선택 정책: 현재 선택된 프로젝트(있다면)와 해제 버튼을 노출한다.
  const currentTarget = all.find(p => p.prTarget === true) || null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="PR 대상 프로젝트 선택"
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-[#16213e] border-2 border-[var(--pixel-accent)] w-full max-w-3xl max-h-[80vh] flex flex-col"
      >
        <div className="flex items-center justify-between p-4 border-b-2 border-[var(--pixel-border)] gap-3">
          <div className="flex items-center gap-2 text-[var(--pixel-accent)]">
            <GitPullRequest size={16} />
            <h3 className="text-sm font-bold uppercase tracking-wider">PR 대상 프로젝트 선택</h3>
            <span className="text-[10px] text-white/60 normal-case font-normal">
              {currentTarget ? `선택: ${currentTarget.fullName}` : `미선택 · 총 ${all.length}개`}
            </span>
            {currentTarget && (
              <button
                onClick={() => onToggle(currentTarget, false)}
                disabled={togglingIds.has(currentTarget.id)}
                className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border-2 border-[var(--pixel-border)] hover:border-[var(--pixel-accent)] bg-black/30 normal-case ${focusRing}`}
                aria-label="현재 PR 대상 해제"
                title="현재 PR 대상 해제"
              >
                선택 해제
              </button>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="닫기"
            className={`px-2 py-1 bg-black/30 border-2 border-[var(--pixel-border)] hover:border-[var(--pixel-accent)] text-[11px] font-bold ${focusRing}`}
          >
            닫기 (Esc)
          </button>
        </div>
        <div className="p-4 border-b-2 border-[var(--pixel-border)]">
          <div className={`flex items-center gap-2 bg-black/30 border-2 px-3 py-2 transition-colors ${query ? 'border-[var(--pixel-accent)]' : 'border-[var(--pixel-border)]'}`}>
            <Search size={14} className={query ? 'text-[var(--pixel-accent)]' : 'opacity-60'} />
            <input
              autoFocus
              value={query}
              onChange={e => onQueryChange(e.target.value)}
              placeholder="프로젝트 이름·설명으로 검색"
              aria-label="PR 대상 프로젝트 검색"
              className="bg-transparent text-[12px] text-white flex-1 focus:outline-none placeholder:text-white/40"
            />
            {query && (
              <button
                onClick={() => onQueryChange('')}
                aria-label="검색어 지우기"
                className="text-white/60 hover:text-[var(--pixel-accent)] text-[12px] font-bold px-1"
              >
                ×
              </button>
            )}
          </div>
          <p className="text-[10px] text-white/50 mt-2">
            PR 대상은 한 번에 하나만 지정할 수 있습니다. 라디오 버튼을 선택하면 이전 대상은 자동으로 해제되고, 변경사항은 즉시 저장됩니다.
          </p>
        </div>
        <div className="overflow-y-auto flex-1 p-2">
          {all.length === 0 && (
            <div className="p-8 text-center text-[11px] text-white/50">
              먼저 소스 연동에서 저장소를 가져와야 합니다.
            </div>
          )}
          {all.length > 0 && visible.length === 0 && (
            <div className="p-8 text-center text-[11px] text-white/50">
              "{query}"에 해당하는 프로젝트가 없습니다.
            </div>
          )}
          {visible.map(p => {
            const checked = p.prTarget === true;
            const busy = togglingIds.has(p.id);
            return (
              <label
                key={p.id}
                className={`flex items-center gap-3 p-2 border-b border-[var(--pixel-border)]/50 cursor-pointer hover:bg-black/30 ${checked ? 'bg-[var(--pixel-accent)]/5' : ''}`}
              >
                <input
                  type="radio"
                  name="pr-target-selector-modal"
                  checked={checked}
                  disabled={busy}
                  onChange={() => onToggle(p, true)}
                  aria-label={`${p.fullName}을(를) PR 대상으로 선택`}
                  className={`accent-[var(--pixel-accent)] shrink-0 ${focusRing}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-bold text-white truncate" title={p.fullName}>{p.fullName}</span>
                    <span className="px-1.5 py-0.5 bg-black/30 text-[9px] uppercase font-bold border border-[var(--pixel-border)] shrink-0">
                      {p.provider}
                    </span>
                    {checked && (
                      <span className="text-[9px] uppercase font-bold text-[var(--pixel-accent)] flex items-center gap-1">
                        <Check size={10} /> PR 대상
                      </span>
                    )}
                  </div>
                  {p.description && (
                    <p className="text-[10px] text-white/60 truncate mt-0.5" title={p.description}>
                      {p.description}
                    </p>
                  )}
                </div>
                {busy && <RefreshCw size={12} className="animate-spin opacity-70 shrink-0" />}
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PushPRActionBar({
  selected,
  onClear,
  onPush,
  busy,
  onBaseBranchChange,
}: {
  selected: ManagedProject | null;
  onClear: () => void;
  onPush: () => void;
  busy: boolean;
  onBaseBranchChange: (id: string, branch: string) => void | Promise<void>;
}) {
  const disabled = !selected || busy;
  // 로컬 드래프트: 사용자가 타이핑하는 중에는 서버 저장하지 않고, blur/Enter 시점에만 커밋한다.
  // 이렇게 해야 매 키 입력마다 DB를 치지 않고, 폴백 표시(defaultBranch)와도 충돌하지 않는다.
  const [draft, setDraft] = useState('');
  useEffect(() => {
    setDraft(selected?.prBaseBranch ?? '');
  }, [selected?.id, selected?.prBaseBranch]);
  const commitBranch = () => {
    if (!selected) return;
    const next = draft.trim();
    const current = (selected.prBaseBranch ?? '').trim();
    if (next === current) return;
    onBaseBranchChange(selected.id, next);
  };
  return (
    <div
      role="region"
      aria-label="푸시 및 PR 생성"
      className={`mb-4 border-2 p-3 flex flex-wrap items-center gap-3 text-[11px] transition-colors ${selected ? 'border-[var(--pixel-accent)] bg-[#0f3460] shadow-[inset_0_0_0_1px_rgba(0,212,255,0.2)]' : 'border-dashed border-[var(--pixel-border)] bg-black/20'}`}
    >
      <div className="flex items-center gap-2 text-[var(--pixel-accent)]">
        <GitPullRequest size={14} />
        <span className="font-bold uppercase tracking-wider">PR 대상</span>
      </div>
      <div className="flex-1 min-w-[180px] truncate">
        {selected ? (
          <span className="flex items-center gap-2">
            <Check size={12} className="text-[var(--pixel-accent)]" />
            <span className="font-bold truncate" title={selected.fullName}>{selected.fullName}</span>
            <span className="opacity-60 uppercase text-[9px]">{selected.provider}</span>
          </span>
        ) : (
          <span className="opacity-60">카드의 라디오 버튼으로 PR을 생성할 프로젝트 하나를 선택하세요.</span>
        )}
      </div>
      {selected && (
        <label className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-white/70">
          <GitBranch size={12} className="text-[var(--pixel-accent)]" />
          <span>대상 브랜치</span>
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commitBranch}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
              if (e.key === 'Escape') { e.preventDefault(); setDraft(selected.prBaseBranch ?? ''); (e.target as HTMLInputElement).blur(); }
            }}
            disabled={busy}
            placeholder={selected.defaultBranch || 'main'}
            aria-label="PR 대상 브랜치"
            title={selected.prBaseBranch ? '저장된 대상 브랜치' : `기본 브랜치(${selected.defaultBranch || 'main'})로 폴백`}
            className={`bg-black/40 border-2 border-[var(--pixel-border)] px-2 py-1 w-32 text-[11px] text-white focus:border-[var(--pixel-accent)] focus:outline-none ${focusRing}`}
          />
        </label>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={onClear}
          disabled={!selected || busy}
          className={`px-2 py-1 bg-black/30 border-2 border-[var(--pixel-border)] text-[10px] uppercase font-bold text-white/80 hover:border-[var(--pixel-accent)] hover:text-white transition-colors disabled:opacity-50 disabled:text-white/40 disabled:border-[var(--pixel-border)]/60 disabled:cursor-not-allowed disabled:hover:border-[var(--pixel-border)]/60 disabled:hover:text-white/40 ${focusRing}`}
        >
          선택 해제
        </button>
        <button
          onClick={onPush}
          disabled={disabled}
          aria-disabled={disabled}
          className={`px-3 py-1.5 bg-[var(--pixel-accent)] text-black text-[11px] font-bold uppercase border-b-2 border-[#0099cc] flex items-center gap-2 hover:brightness-110 active:translate-y-px transition disabled:bg-[var(--pixel-accent)]/40 disabled:text-black/50 disabled:border-b-[#0099cc]/40 disabled:cursor-not-allowed disabled:hover:brightness-100 disabled:active:translate-y-0 ${focusRing}`}
        >
          {busy ? <RefreshCw size={12} className="animate-spin" /> : <GitPullRequest size={12} />}
          푸시 & PR 생성
        </button>
      </div>
    </div>
  );
}

function ResearchInsights({
  stats,
  total,
  visible,
  onExport,
  onCopyDevSummary,
}: {
  stats: {
    byProvider: Record<string, number>;
    described: number;
    coverage: number;
    avgDescLen: number;
    shortDesc: number;
    diversity: number;
    qualityBuckets: Record<QualityBucket, number>;
  };
  total: number;
  visible: number;
  onExport: () => void;
  onCopyDevSummary: () => void | Promise<void>;
}) {
  const providers = Object.entries(stats.byProvider).sort((a, b) => b[1] - a[1]);
  // 연구원: 커버리지가 낮거나 짧은 설명이 다수면 LLM 보강의 기대 효과가 크다는 힌트를 준다.
  const needsEnrichment = stats.coverage < 70 || stats.shortDesc > Math.max(1, Math.round(total * 0.2));
  return (
    <div className="mb-4 bg-black/30 border-2 border-[var(--pixel-border)] p-3 flex flex-wrap items-center gap-4 text-[11px]">
      <div className="flex items-center gap-2 text-[var(--pixel-accent)]">
        <BarChart3 size={14} />
        <span className="font-bold uppercase tracking-wider">리서치 요약</span>
      </div>
      <InsightPill label="총" value={`${total}`} />
      <InsightPill label="표시" value={`${visible}`} />
      <InsightPill
        label="설명 보유"
        value={`${stats.described} (${stats.coverage}%)`}
        title="비어있지 않은 설명을 가진 프로젝트의 비율"
      />
      <InsightPill
        label="평균 설명 길이"
        value={`${stats.avgDescLen}자`}
        title="설명이 있는 프로젝트만 기준으로 한 평균 글자 수"
      />
      <InsightPill
        label="짧은 설명"
        value={`${stats.shortDesc}`}
        title={`${SHORT_DESCRIPTION_THRESHOLD}자 미만인 프로젝트 수 — LLM 보강 후보`}
      />
      <InsightPill
        label="제공자 다양성"
        value={`${Math.round(stats.diversity * 100)}%`}
        title="Simpson 다양성 지수(정규화). 100%는 제공자 간 완전 균등 분포"
      />
      {providers.map(([p, n]) => (
        <InsightPill key={p} label={p} value={`${n}`} />
      ))}
      <InsightPill
        label="품질 티어"
        value={`P${stats.qualityBuckets.poor}·F${stats.qualityBuckets.fair}·G${stats.qualityBuckets.good}·E${stats.qualityBuckets.excellent}`}
        title="설명 품질 버킷 — Poor/Fair/Good/Excellent. LLM 보강 예산은 Poor부터 투입 권장."
      />

      {needsEnrichment && (
        <span
          className="flex items-center gap-1 px-2 py-1 border-2 border-yellow-500/60 bg-yellow-900/20 text-yellow-200 uppercase font-bold tracking-wider"
          title="설명 커버리지 또는 상세도가 낮습니다. LLM으로 설명을 보강해 리서치 품질을 올릴 수 있습니다."
        >
          <Sparkles size={10} /> 보강 권장
        </span>
      )}
      <button
        onClick={onCopyDevSummary}
        className={`ml-auto flex items-center gap-1 px-2 py-1 bg-black/40 border-2 border-[var(--pixel-border)] hover:border-[var(--pixel-accent)] text-[10px] uppercase font-bold tracking-wider transition-colors ${focusRing}`}
        title="개발자용 한 줄 요약을 클립보드로 복사 (이슈/채팅에 붙여넣기 용)"
      >
        <ClipboardCopy size={10} /> 개발자 요약 복사
      </button>
      <button
        onClick={onExport}
        className={`flex items-center gap-1 px-2 py-1 bg-black/40 border-2 border-[var(--pixel-border)] hover:border-[var(--pixel-accent)] text-[10px] uppercase font-bold tracking-wider transition-colors ${focusRing}`}
        title="현재 프로젝트 목록을 CSV 스냅샷으로 내보냅니다"
      >
        <FileDown size={10} /> 스냅샷 내보내기
      </button>
    </div>
  );
}

function InsightPill({ label, value, title }: { label: string; value: string; title?: string; key?: string }) {
  return (
    <span
      className="px-2 py-1 bg-[#0f3460] border-2 border-[var(--pixel-border)] tabular-nums"
      title={title}
    >
      <span className="opacity-60 uppercase mr-1">{label}</span>
      <span className="text-[var(--pixel-accent)] font-bold">{value}</span>
    </span>
  );
}

function SectionBadge({ count }: { count: number }) {
  return (
    <span
      className="px-2 py-0.5 text-[10px] font-bold uppercase border-2 border-[var(--pixel-border)] bg-black/40 text-white/80 tabular-nums"
      title={`총 ${count}개`}
    >
      {count.toString().padStart(2, '0')}
    </span>
  );
}

function IntegrationForm({ onSubmit, onCancel }: {
  onSubmit: (provider: SourceProvider, label: string, token: string, host: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState<SourceProvider>('github');
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [useSelfHosted, setUseSelfHosted] = useState(false);
  const [host, setHost] = useState('');

  const hostPlaceholder = provider === 'github'
    ? 'https://github.mycompany.com'
    : 'https://gitlab.mycompany.com';

  const hostInvalid = useSelfHosted && host.trim().length > 0 && !isValidHost(host);
  const tokenWarning = tokenPrefixMismatch(provider, token);
  const tokenLengthWarning = isTokenTooShort(token);
  // QA: 프리픽스는 "경고"로 약화했지만, 최소 길이는 실제 인증 실패가 예견되므로 전송 자체를 막는다.
  const canSubmit = token.trim().length >= MIN_TOKEN_LEN && (!useSelfHosted || isValidHost(host));

  return (
    <div className="bg-black/40 border-2 border-[var(--pixel-border)] p-4 mb-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] font-bold text-[var(--pixel-accent)] uppercase mb-1">제공자</label>
          <select
            value={provider}
            onChange={e => setProvider(e.target.value as SourceProvider)}
            className="w-full bg-black/40 border-2 border-[var(--pixel-border)] px-3 py-2 text-sm text-white"
          >
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-bold text-[var(--pixel-accent)] uppercase mb-1">라벨</label>
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="예: 회사 GitHub"
            maxLength={80}
            className="w-full bg-black/40 border-2 border-[var(--pixel-border)] px-3 py-2 text-sm text-white"
          />
        </div>
      </div>
      <div>
        <label className="flex items-center gap-2 text-[11px] text-white/80 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={useSelfHosted}
            onChange={e => { setUseSelfHosted(e.target.checked); if (!e.target.checked) setHost(''); }}
          />
          자체 호스팅 서버 사용 (Enterprise / Self-hosted)
        </label>
        {useSelfHosted && (
          <div className="mt-2">
            <label className="block text-[10px] font-bold text-[var(--pixel-accent)] uppercase mb-1">호스트 URL</label>
            <input
              value={host}
              onChange={e => setHost(e.target.value)}
              placeholder={hostPlaceholder}
              aria-invalid={hostInvalid}
              className={`w-full bg-black/40 border-2 px-3 py-2 text-sm text-white ${hostInvalid ? 'border-red-500' : 'border-[var(--pixel-border)]'}`}
            />
            {hostInvalid && (
              <p className="text-[10px] text-red-300 mt-1 flex items-center gap-1">
                <AlertTriangle size={10} /> URL은 https:// 또는 http://로 시작해야 합니다.
              </p>
            )}
            <p className="text-[10px] text-white/50 mt-1">
              {provider === 'github'
                ? 'GitHub Enterprise Server 베이스 URL을 입력하세요. /api/v3는 자동 추가됩니다.'
                : 'Self-hosted GitLab 베이스 URL을 입력하세요. /api/v4는 자동 추가됩니다.'}
            </p>
          </div>
        )}
      </div>
      <div>
        <label className="block text-[10px] font-bold text-[var(--pixel-accent)] uppercase mb-1">액세스 토큰</label>
        <input
          type="password"
          value={token}
          onChange={e => setToken(e.target.value)}
          placeholder="ghp_... 또는 glpat-..."
          autoComplete="off"
          spellCheck={false}
          className="w-full bg-black/40 border-2 border-[var(--pixel-border)] px-3 py-2 text-sm text-white"
        />
        {tokenWarning && (
          <p className="text-[10px] text-yellow-300 mt-1 flex items-center gap-1">
            <AlertTriangle size={10} /> {provider === 'github'
              ? '일반적인 GitHub 토큰 프리픽스(ghp_/github_pat_)가 아닙니다. 제공자 선택을 확인하세요.'
              : 'GitLab 토큰은 보통 glpat-로 시작합니다. 제공자 선택을 확인하세요.'}
          </p>
        )}
        {tokenLengthWarning && (
          <p className="text-[10px] text-red-300 mt-1 flex items-center gap-1">
            <AlertTriangle size={10} /> 토큰이 너무 짧습니다 (최소 {MIN_TOKEN_LEN}자). 전체 토큰을 복사했는지 확인하세요.
          </p>
        )}
        <p className="text-[10px] text-white/50 mt-1">토큰은 서버 DB에 저장됩니다. 읽기 권한(repo/read_api)만 있는 토큰을 권장합니다.</p>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => canSubmit && onSubmit(provider, label.trim() || provider, token.trim(), host.trim())}
          disabled={!canSubmit}
          className="flex-1 bg-[var(--pixel-accent)] text-black py-2 text-[11px] font-bold uppercase border-b-2 border-[#0099cc] hover:brightness-110 active:translate-y-px transition disabled:bg-[var(--pixel-accent)]/40 disabled:text-black/50 disabled:border-b-[#0099cc]/40 disabled:cursor-not-allowed disabled:hover:brightness-100 disabled:active:translate-y-0"
        >
          연동 저장
        </button>
        <button
          onClick={onCancel}
          className="flex-1 bg-gray-700 text-white py-2 text-[11px] font-bold uppercase border-b-2 border-gray-900"
        >
          취소
        </button>
      </div>
    </div>
  );
}
