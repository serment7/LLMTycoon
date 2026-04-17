import React, { memo, useEffect, useMemo, useState } from 'react';
import type { CodeFile } from '../types';

// 팔레트 식별자. 외부 컨테이너(설정 패널·A/B 실험)에서 같은 리터럴을 참조할 수 있게 export.
// 유니언을 한 곳에만 두면 새로운 팔레트가 추가될 때 타입 검사기가 누락 분기를 전부 잡아낸다.
// - 'default'  : 시그니처 쿨톤(청·옐로·그린·오렌지). 낮/기본 아케이드 필 유지.
// - 'cb-safe'  : Wong(2011) 색약 친화. 좌측 패턴(TYPE_PATTERN)과 결합해 카테고리 분리.
// - 'warm-neon': 야간 세션용 웜 네온. CRT 스캔라인 위 장시간 호버 시 눈 피로를 낮추는 목적.
// - 'mono'     : 그레이스케일. 인쇄/스크린샷·QA 프리뷰에서 좌측 TYPE_PATTERN 이 유일한
//                카테고리 신호가 되게 강제한다 — 색에만 의존한 디자인 드리프트를 감지하는 장치.
export type TooltipPalette = 'default' | 'cb-safe' | 'warm-neon' | 'mono';

type Props = {
  file: CodeFile;
  x: number;
  y: number;
  workerNames?: string[];
  inDegree?: number;
  outDegree?: number;
  /** 뷰포트 경계. 주어지면 툴팁이 화면 밖으로 넘치지 않도록 반대편에 배치한다. */
  viewportWidth?: number;
  viewportHeight?: number;
  /** 컴팩트 모드: 힌트·아이디 라인을 숨긴다. 미니맵 등 좁은 영역용. */
  compact?: boolean;
  /** 강조 모드: 외곽선과 글로우를 강하게 표시한다. */
  highlighted?: boolean;
  /**
   * 팔레트 변형. 'default' 는 시그니처 톤, 'cb-safe' 는 색약 친화 팔레트.
   * 사용자 환경설정/접근성 모드와 연동해 상위 컨테이너에서 결정해 내려보낸다.
   */
  palette?: TooltipPalette;
  /**
   * 칩 형태로 표시할 작업자 수 상한. 미지정 시 MAX_WORKER_CHIPS(3)를 사용.
   * 상위 컨테이너가 가용 가로폭이 넉넉할 때 값을 키워 오버플로 표식을 줄일 수 있다.
   */
  maxWorkerChips?: number;
  /** 자동화 테스트에서 선택자로 사용하는 데이터 훅. UI 텍스트에 의존하지 않게 한다. */
  testId?: string;
};

const TYPE_LABEL: Record<CodeFile['type'], string> = {
  component: '컴포넌트',
  service: '서비스',
  util: '유틸',
  style: '스타일',
};

// 파일 타입별 시그니처 색상. 픽셀 톤 팔레트에 맞춰 채도를 살짝 낮춘 값을 쓴다.
const TYPE_ACCENT: Record<CodeFile['type'], string> = {
  component: '#7ad7ff',
  service: '#ffcb6b',
  util: '#c3e88d',
  style: '#f78c6c',
};

// 색약 친화 대체 팔레트. Wong(2011) 색상 권고를 픽셀 톤에 맞춰 미세 조정.
// 적록·청황 색약 사용자가 좌측 패턴(TYPE_PATTERN)과 결합해 카테고리를 구분할 수 있도록
// 명도 차이를 의도적으로 더 키웠다. palette='cb-safe' 일 때만 활성화.
const TYPE_ACCENT_CB_SAFE: Record<CodeFile['type'], string> = {
  component: '#56b4e9',
  service: '#e69f00',
  util: '#009e73',
  style: '#cc79a7',
};

// 웜 네온 팔레트. 야간 세션에서 청색광을 줄이고 따뜻한 호박/라벤더 계열로 전환.
// default 와 동일한 4 카테고리 구분은 유지하되 휘도 순서를 낮춰 장시간 시선 잔상을 줄인다.
// CRT 스캔라인 위에서도 텍스트 명도 대비 4.5:1 이상을 확보하도록 채도를 조정했다.
const TYPE_ACCENT_WARM_NEON: Record<CodeFile['type'], string> = {
  component: '#ffb38a',
  service: '#ffd27a',
  util: '#c7b3ff',
  style: '#ff9ec2',
};

// 그레이스케일 팔레트. 카테고리별 색상 차이를 의도적으로 제거하고 명도만 단계화한다.
// 좌측 TYPE_PATTERN 이 유일한 카테고리 신호가 되므로, 패턴이 사라지거나 약해진 리그레션을
// 인쇄/스크린샷/QA 프리뷰 단계에서 즉시 드러낸다. 대비는 검정 배경 위 WCAG AA 이상을 유지.
const TYPE_ACCENT_MONO: Record<CodeFile['type'], string> = {
  component: '#f2f2f2',
  service: '#cfcfcf',
  util: '#a8a8a8',
  style: '#8a8a8a',
};

// 타입별 1문장 요약. 초심자에게는 도움말, 숙련자에게는 빠른 스캔용.
const TYPE_HINT: Record<CodeFile['type'], string> = {
  component: 'UI 조각 · 렌더링 책임',
  service: '비즈니스 로직 · 외부 통신',
  util: '순수 함수 · 재사용 헬퍼',
  style: '시각 토큰 · 테마',
};

// 타입별 이모지 글리프. 픽셀 폰트와 충돌 없이 가장자리 포인트만 주는 역할.
const TYPE_GLYPH: Record<CodeFile['type'], string> = {
  component: '◆',
  service: '▲',
  util: '●',
  style: '✦',
};

const FALLBACK_ACCENT = 'var(--pixel-accent)';
const FALLBACK_HINT = '분류 미지정';
const FALLBACK_GLYPH = '·';
const FALLBACK_LABEL = '알 수 없음';
const EMPTY_NAME = '(이름 없음)';

// 마우스 커서와 겹치지 않으면서 가장자리에서는 반대편으로 뒤집기 위한 상수.
const OFFSET_X = 12;
const OFFSET_Y = 28;
// 실측 DOM 폭 대신 고정치를 쓴다. 폰트·패딩이 안정적이라 측정 비용을 피할 수 있다.
const APPROX_WIDTH = 210;
const APPROX_HEIGHT = 110;
// 좌측 3px 강조 바 + 좌우 패딩(10+8)을 제외한 실 콘텐츠 폭. max-w-[*px]와 동기.
const CONTENT_MAX_WIDTH = APPROX_WIDTH - 20;
const EDGE_MARGIN = 4;
const MAX_WORKER_CHIPS = 3;
// 동시 작업자가 이 값 이상이면 병합 충돌 위험을 시각 경고로 알린다.
const CONFLICT_RISK_THRESHOLD = 2;
// 파일명이 지나치게 길면 CSS truncate 이전 단계에서 중앙 생략을 선적용해
// 확장자·접두 prefix 정보를 모두 보존한 채 식별 가능성을 유지한다.
const MAX_DISPLAY_NAME = 28;

// 픽셀 톤을 유지하면서 시인성을 높이기 위한 미세 스캔라인 배경.
// 가로 1px 간격의 짙은 선이 깜빡이지 않고 누적돼 CRT 느낌만 살짝 얹는다.
// 다른 패널(미니맵·타임라인 등)이 같은 톤을 공유하도록 export 한다.
export const SCANLINE_BG =
  'repeating-linear-gradient(180deg, rgba(255,255,255,0.04) 0 1px, transparent 1px 3px)';

// 디자인 토큰. 외부(예: AgentStatusPanel, 미니맵)에서 동일 팔레트를
// 재사용해 시각적 결속을 유지한다. 토큰은 읽기 전용 참조만 허용.
export const FILE_TOOLTIP_TOKENS = Object.freeze({
  accent: TYPE_ACCENT,
  accentCbSafe: TYPE_ACCENT_CB_SAFE,
  accentWarmNeon: TYPE_ACCENT_WARM_NEON,
  accentMono: TYPE_ACCENT_MONO,
  label: TYPE_LABEL,
  hint: TYPE_HINT,
  glyph: TYPE_GLYPH,
  fallbackAccent: FALLBACK_ACCENT,
  conflictColor: '#ff8f8f',
  conflictColorCbSafe: '#d55e00',
  // 웜 팔레트는 적색 대신 진한 코랄을 써 배경 대비는 지키면서 웜톤 가족에 머문다.
  conflictColorWarmNeon: '#ff6a4d',
  // 모노 팔레트는 색 신호를 제거하므로 경고는 굵은 흰색으로 두고, 인접 ⚠ 글리프와
  // TYPE_PATTERN 에 의존해 "주의" 의미를 전달한다.
  conflictColorMono: '#ffffff',
});

// 팔레트 키 → 액센트 맵. 새 팔레트가 늘어나면 여기서만 분기한다.
function resolveAccentMap(palette: TooltipPalette): Record<CodeFile['type'], string> {
  switch (palette) {
    case 'cb-safe':
      return TYPE_ACCENT_CB_SAFE;
    case 'warm-neon':
      return TYPE_ACCENT_WARM_NEON;
    case 'mono':
      return TYPE_ACCENT_MONO;
    default:
      return TYPE_ACCENT;
  }
}

// 팔레트별 충돌 경고색. 토큰과 렌더러가 같은 값을 읽게 해 디자인 드리프트를 막는다.
// 과거에는 토큰에만 두고 컴포넌트에서 인라인 리터럴로 같은 값을 재작성해
// 팔레트 추가 시 두 곳을 모두 손봐야 하는 중복이 있었다.
export function resolveConflictColor(palette: TooltipPalette): string {
  switch (palette) {
    case 'cb-safe':
      return FILE_TOOLTIP_TOKENS.conflictColorCbSafe;
    case 'warm-neon':
      return FILE_TOOLTIP_TOKENS.conflictColorWarmNeon;
    case 'mono':
      return FILE_TOOLTIP_TOKENS.conflictColorMono;
    default:
      return FILE_TOOLTIP_TOKENS.conflictColor;
  }
}

// 작업자 목록 정규화 결과. 렌더링과 분리해 스냅샷 없이 단위 테스트할 수 있도록 구조체로 반환한다.
export interface WorkerSummary {
  /** 공백·중복 제거 후 결정적으로 정렬된 작업자 이름. */
  unique: string[];
  /** 상한 이하의 칩으로 표시할 작업자 이름. */
  visible: string[];
  /** 상한을 넘어 접힌 작업자 수. 0 이면 오버플로 배지를 숨긴다. */
  overflow: number;
  /** 오버플로된 이름을 title/aria-label 용으로 쉼표 연결한 문자열. */
  overflowLabel: string;
  /** 동시 작업자가 임계값 이상인지. UI에서 ⚠ 기호로 표현. */
  conflictRisk: boolean;
}

// 작업자 배열을 툴팁이 소비할 수 있는 형태로 가공한다.
// - 정렬을 강제하지 않으면 부모가 배열 순서를 바꿀 때마다 칩 순서가 흔들려
//   시각적 깜빡임과 React key 안정성이 동시에 깨진다.
// - maxChips 가 비정상(NaN, 음수)이어도 안전한 하한으로 퇴화시켜 호출부 방어 부담을 덜어준다.
export function summarizeWorkers(
  workerNames: readonly string[] | undefined,
  maxChips: number = MAX_WORKER_CHIPS,
): WorkerSummary {
  const cap = Number.isFinite(maxChips) && maxChips > 0 ? Math.floor(maxChips) : MAX_WORKER_CHIPS;
  const unique = Array.from(
    new Set((workerNames ?? []).filter((n) => typeof n === 'string' && n.trim().length > 0)),
  ).sort((a, b) => a.localeCompare(b, 'ko'));
  const visible = unique.slice(0, cap);
  const overflow = Math.max(0, unique.length - visible.length);
  const overflowLabel = unique.slice(cap).join(', ');
  const conflictRisk = unique.length >= CONFLICT_RISK_THRESHOLD;
  return { unique, visible, overflow, overflowLabel, conflictRisk };
}

// 접근성: prefers-reduced-motion 사용자에게는 깜빡임·펄스를 비활성화.
// SSR 환경에서 window 부재 시 false 반환해 렌더러가 튀지 않게 한다.
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// 미디어 쿼리 구독 훅을 일반화. 모션·대비 선호가 모두 같은 패턴을 쓰기에
// 중복 useEffect를 피하고, 테스트에서도 window.matchMedia 한 군데만 흉내내면 된다.
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Safari < 14 호환: addEventListener 미지원 시 addListener 폴백.
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else mql.removeListener(onChange);
    };
  }, [query]);
  return matches;
}

// 사용자가 OS 설정을 도중에 토글해도 다음 렌더에 즉시 반영되도록 구독한다.
// 이전엔 모듈 로드 시점에만 측정해 한 번 설정되면 갱신되지 않았음.
function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

// 고대비 모드 구독. Windows/ macOS의 "대비 높이기" 설정과 연동한다.
// 활성 시 스캔라인·불투명도 장식을 제거해 시각 인지 부담을 낮춘다.
function useHighContrast(): boolean {
  return useMediaQuery('(prefers-contrast: more)');
}

// "Foo.bar.tsx" → "tsx". 마지막 점 이후를 소문자로 표준화.
// 점이 없거나 빈 문자열이면 빈 문자열을 반환해 호출부에서 분기 없이 합성 가능하게 한다.
export function getFileExtension(name: string): string {
  if (!name) return '';
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === name.length - 1) return '';
  return name.slice(lastDot + 1).toLowerCase();
}

// 상태 도트 펄스용 keyframes를 최초 한 번만 주입한다.
// 전역 CSS를 오염시키지 않기 위해 고유 ID로 중복 주입을 방어.
const PULSE_STYLE_ID = 'pixel-tooltip-pulse-keyframes';
if (typeof document !== 'undefined' && !document.getElementById(PULSE_STYLE_ID)) {
  const el = document.createElement('style');
  el.id = PULSE_STYLE_ID;
  el.textContent =
    '@keyframes pixelTooltipPulse {' +
    '0%,100% { transform: scale(1); opacity: 1; }' +
    '50% { transform: scale(1.25); opacity: 0.7; }' +
    '}';
  document.head.appendChild(el);
}

// 타입별 좌측 패턴. 색약 사용자에게도 구분 가능한 2차 채널로 쓴다.
// 색상만으로 식별을 강제하지 않도록 한 디자인 원칙에 따른 것.
const TYPE_PATTERN: Record<CodeFile['type'], string> = {
  component: 'repeating-linear-gradient(45deg, currentColor 0 2px, transparent 2px 5px)',
  service: 'repeating-linear-gradient(0deg, currentColor 0 2px, transparent 2px 5px)',
  util: 'radial-gradient(circle at 2px 2px, currentColor 1px, transparent 1.5px)',
  style: 'repeating-linear-gradient(-45deg, currentColor 0 2px, transparent 2px 5px)',
};

// 순수 함수로 분리해 렌더링과 분리된 단위 테스트가 가능하도록 한다.
export function shortId(id: string): string {
  if (!id) return '??';
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

// 파일명을 '머리…꼬리' 형태로 줄여 접두어와 확장자를 모두 남긴다.
// 예: "AgentWorkspaceManager.presenter.tsx" → "AgentWork…nter.tsx"
// CSS truncate 만으로는 끝부분이 잘려 타입을 못 알아보는 문제를 보완한다.
export function truncateName(name: string, max: number = MAX_DISPLAY_NAME): string {
  if (!name) return EMPTY_NAME;
  if (name.length <= max) return name;
  const keep = max - 1; // ellipsis 한 글자분
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

// 외부로 노출해 경계 케이스(좌상단 음수, vw 미전달 등)를 스냅샷 없이 검증할 수 있게 한다.
// QA 메모: 상위에서 포인터 이벤트 좌표가 NaN/Infinity 로 흘러들면 transform 이 깨져
// 툴팁이 0,0 으로 사라지는 회귀가 있었다. 좌표를 숫자 정규화해 렌더 안정성을 보장한다.
export function clampPosition(
  x: number,
  y: number,
  vw?: number,
  vh?: number,
): { tx: number; ty: number } {
  const safeX = Number.isFinite(x) ? x : 0;
  const safeY = Number.isFinite(y) ? y : 0;
  let tx = safeX + OFFSET_X;
  let ty = safeY - OFFSET_Y;
  if (vw !== undefined && Number.isFinite(vw) && tx + APPROX_WIDTH > vw - EDGE_MARGIN) {
    tx = safeX - OFFSET_X - APPROX_WIDTH;
  }
  if (vh !== undefined && Number.isFinite(vh) && ty + APPROX_HEIGHT > vh - EDGE_MARGIN) {
    ty = safeY - OFFSET_Y - APPROX_HEIGHT;
  }
  if (tx < EDGE_MARGIN) tx = EDGE_MARGIN;
  if (ty < EDGE_MARGIN) ty = EDGE_MARGIN;
  // 뷰포트가 툴팁 고정 치수보다 좁을 때 한 번의 플립만으로는 오른쪽/아래 오버플로가
  // 남을 수 있다. 하한 클램프 뒤에 상한 클램프를 한 번 더 걸어 assertClampedWithinViewport
  // 가 참으로 유지되도록 보장한다. 하한이 상한보다 크면 하한을 우선한다(미니 뷰포트 케이스).
  if (vw !== undefined && Number.isFinite(vw)) {
    const maxTx = vw - EDGE_MARGIN - APPROX_WIDTH;
    if (maxTx >= EDGE_MARGIN && tx > maxTx) tx = maxTx;
  }
  if (vh !== undefined && Number.isFinite(vh)) {
    const maxTy = vh - EDGE_MARGIN - APPROX_HEIGHT;
    if (maxTy >= EDGE_MARGIN && ty > maxTy) ty = maxTy;
  }
  return { tx, ty };
}

// 품질 관리 도우미: 런타임에 prop 집합이 내부 규약을 만족하는지 점검한다.
// 프로덕션 렌더 경로에서는 throw 하지 않고 위반 목록만 돌려주므로, 호출부는
// 개발 환경에서 console.warn 하거나 테스트에서 toEqual([]) 로 단언할 수 있다.
// 외형 렌더 이전에 데이터 계층이 망가졌음을 빠르게 드러내는 것이 목적.
//
// QA 설계 원칙:
// - 한국어 메시지는 UX 변경에 따라 바뀔 수 있으므로 기계 비교용으로는 `code` 필드를 쓴다.
// - 위반 수집은 끝까지 누적한다(조기 반환 금지). 한 번의 호출로 전 지표를 파악해야 리포트가 안정적이다.
// - 경계값(0, NaN, 빈 문자열)을 모두 위반으로 잡되, 정상값 스펙은 좁게 고정해 거짓 음성을 피한다.
export type TooltipPropIssueCode =
  | 'FILE_MISSING'
  | 'FILE_ID_INVALID'
  | 'FILE_NAME_INVALID'
  | 'FILE_TYPE_UNSUPPORTED'
  | 'X_NON_FINITE'
  | 'Y_NON_FINITE'
  | 'IN_DEGREE_INVALID'
  | 'OUT_DEGREE_INVALID'
  | 'MAX_WORKER_CHIPS_INVALID'
  | 'WORKER_NAMES_NOT_ARRAY'
  | 'WORKER_NAME_EMPTY'
  | 'VIEWPORT_WIDTH_INVALID'
  | 'VIEWPORT_HEIGHT_INVALID'
  | 'PALETTE_UNKNOWN';

export interface TooltipPropIssue {
  /** 안정적 식별 키. 회귀 테스트 어서션에 사용한다. */
  code: TooltipPropIssueCode;
  /** 사람용 설명. 한국어 문구는 변경될 수 있으니 기계 비교에 쓰지 않는다. */
  message: string;
}

const SUPPORTED_FILE_TYPES: ReadonlyArray<CodeFile['type']> = ['component', 'service', 'util', 'style'];
const SUPPORTED_PALETTES: ReadonlyArray<TooltipPalette> = ['default', 'cb-safe', 'warm-neon', 'mono'];

export interface ValidateTooltipInput {
  file?: Partial<CodeFile> | null;
  x?: number;
  y?: number;
  workerNames?: readonly unknown[];
  inDegree?: number;
  outDegree?: number;
  maxWorkerChips?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  palette?: string;
}

// 구조화 버전. 신규 호출부는 이 쪽을 쓰고, 기존 문자열 API 는 아래 래퍼가 유지한다.
export function validateTooltipPropsIssues(input: ValidateTooltipInput): TooltipPropIssue[] {
  const issues: TooltipPropIssue[] = [];
  const push = (code: TooltipPropIssueCode, message: string) => issues.push({ code, message });
  const file = input.file;
  if (!file) push('FILE_MISSING', 'file prop 누락');
  else {
    if (typeof file.id !== 'string' || file.id.length === 0) push('FILE_ID_INVALID', 'file.id 누락/형식');
    if (typeof file.name !== 'string') push('FILE_NAME_INVALID', 'file.name 형식');
    if (
      typeof file.type !== 'string' ||
      !SUPPORTED_FILE_TYPES.includes(file.type as CodeFile['type'])
    ) {
      push('FILE_TYPE_UNSUPPORTED', 'file.type 미지원');
    }
  }
  if (input.x !== undefined && !Number.isFinite(input.x)) push('X_NON_FINITE', 'x 좌표 비정상');
  if (input.y !== undefined && !Number.isFinite(input.y)) push('Y_NON_FINITE', 'y 좌표 비정상');
  if (input.inDegree !== undefined && (!Number.isFinite(input.inDegree) || input.inDegree < 0)) {
    push('IN_DEGREE_INVALID', 'inDegree 음수/비정상');
  }
  if (input.outDegree !== undefined && (!Number.isFinite(input.outDegree) || input.outDegree < 0)) {
    push('OUT_DEGREE_INVALID', 'outDegree 음수/비정상');
  }
  if (
    input.maxWorkerChips !== undefined &&
    (!Number.isFinite(input.maxWorkerChips) || input.maxWorkerChips <= 0)
  ) {
    push('MAX_WORKER_CHIPS_INVALID', 'maxWorkerChips 0 이하');
  }
  if (input.workerNames !== undefined) {
    if (!Array.isArray(input.workerNames)) push('WORKER_NAMES_NOT_ARRAY', 'workerNames 배열 아님');
    else if (input.workerNames.some((n) => typeof n !== 'string' || n.trim().length === 0)) {
      // 빈 문자열/공백만 있는 이름은 칩으로 렌더되면 유령 박스를 만든다.
      push('WORKER_NAME_EMPTY', 'workerNames 에 빈 문자열 포함');
    }
  }
  if (input.viewportWidth !== undefined && (!Number.isFinite(input.viewportWidth) || input.viewportWidth <= 0)) {
    push('VIEWPORT_WIDTH_INVALID', 'viewportWidth 0 이하/비정상');
  }
  if (input.viewportHeight !== undefined && (!Number.isFinite(input.viewportHeight) || input.viewportHeight <= 0)) {
    push('VIEWPORT_HEIGHT_INVALID', 'viewportHeight 0 이하/비정상');
  }
  if (input.palette !== undefined && !SUPPORTED_PALETTES.includes(input.palette as TooltipPalette)) {
    push('PALETTE_UNKNOWN', 'palette 미지원 값');
  }
  return issues;
}

// 기존 호출부 호환을 위한 문자열 리스트 형태. 신규 코드는 *Issues 를 권장.
export function validateTooltipProps(input: ValidateTooltipInput): string[] {
  return validateTooltipPropsIssues(input).map((i) => i.message);
}

// 렌더 직전에 clampPosition 결과가 내부 불변식을 지키는지 확인하는 가드.
// 뷰포트가 주어졌을 때 툴팁이 반드시 EDGE_MARGIN 이상 안쪽에 있어야 한다.
// 이 함수가 false 를 돌려주면 clampPosition 에 회귀가 생긴 것 — 스냅샷 대신 이 가드로 잡는다.
export function assertClampedWithinViewport(
  tx: number,
  ty: number,
  vw?: number,
  vh?: number,
): boolean {
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return false;
  if (tx < EDGE_MARGIN || ty < EDGE_MARGIN) return false;
  if (vw !== undefined && Number.isFinite(vw) && tx + APPROX_WIDTH > vw + EDGE_MARGIN) return false;
  if (vh !== undefined && Number.isFinite(vh) && ty + APPROX_HEIGHT > vh + EDGE_MARGIN) return false;
  return true;
}

// QA 텔레메트리용 평탄 스냅샷. 안정적 키 순서로 JSON 직렬화해
// 스크린샷 대신 해시 비교·회귀 단언에 쓴다.
export interface TooltipRenderShape {
  fileId: string;
  fileType: CodeFile['type'] | 'unknown';
  workerCount: number;
  overflow: number;
  conflictRisk: boolean;
  hasExtension: boolean;
  compact: boolean;
  highlighted: boolean;
  palette: TooltipPalette;
}

// 스크린리더용 한 줄 요약을 순수 함수로 분리. 렌더러와 분리해 스냅샷 없이 단위 테스트할 수 있다.
// 빈 토큰(null/undefined/빈 문자열)은 제외하고 쉼표로 이어 붙인다.
// QA 메모: 확장자 배지는 시각적으로만 노출되므로 보조기술 경로에서 요약에 반드시 합류시켜야 한다.
export function buildAriaSummary(params: {
  displayName: string;
  extension?: string | null;
  typeLabel: string;
  workerCount: number;
  conflictRisk: boolean;
  inDegree?: number;
  outDegree?: number;
}): string {
  const showGraph = params.inDegree !== undefined || params.outDegree !== undefined;
  return [
    params.displayName,
    params.extension ? `확장자 ${params.extension}` : null,
    params.typeLabel,
    params.workerCount > 0 ? `작업자 ${params.workerCount}명` : '작업자 없음',
    params.conflictRisk ? '충돌 위험' : null,
    showGraph ? `의존 in ${params.inDegree ?? 0}, out ${params.outDegree ?? 0}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

// 개발 환경에서 prop 규약 위반을 콘솔로 한 번만 경고한다.
// 동일 code 집합은 재경고하지 않아 마우스 호버로 수백 번 재렌더되는 경로에서 로그가 폭주하지 않게 한다.
// 프로덕션 빌드에서는 no-op 로 소멸한다.
const WARNED_ISSUE_SIGNATURES = new Set<string>();
function warnOnTooltipPropIssues(issues: TooltipPropIssue[]): void {
  if (issues.length === 0) return;
  if (typeof process === 'undefined' || process.env?.NODE_ENV === 'production') return;
  const signature = issues.map((i) => i.code).sort().join('|');
  if (WARNED_ISSUE_SIGNATURES.has(signature)) return;
  WARNED_ISSUE_SIGNATURES.add(signature);
  // eslint-disable-next-line no-console
  console.warn('[FileTooltip] prop 규약 위반:', issues);
}

export function toRenderShape(
  file: Pick<CodeFile, 'id' | 'type' | 'name'> | null | undefined,
  workerNames: readonly string[] | undefined,
  opts?: { compact?: boolean; highlighted?: boolean; palette?: TooltipPalette; maxWorkerChips?: number },
): TooltipRenderShape {
  const summary = summarizeWorkers(workerNames, opts?.maxWorkerChips);
  return {
    fileId: file?.id ?? '',
    fileType: file && SUPPORTED_FILE_TYPES.includes(file.type) ? file.type : 'unknown',
    workerCount: summary.unique.length,
    overflow: summary.overflow,
    conflictRisk: summary.conflictRisk,
    hasExtension: !!file?.name && getFileExtension(file.name).length > 0,
    compact: !!opts?.compact,
    highlighted: !!opts?.highlighted,
    palette: opts?.palette ?? 'default',
  };
}

// QA 회귀 감지용 렌더 쉐이프 비교. 직전 스냅샷 대비 "나빠진" 신호만 추려내
// 텔레메트리 알람 노이즈를 줄인다. 좋아진 변화는 의도된 UX로 간주하고 무시한다.
// 다른 파일(fileId 변경) 사이의 비교는 의미가 없으므로 플래그 없이 빈 배열을 돌려준다.
export type RenderShapeRegressionFlag =
  | 'FILE_TYPE_DEGRADED'
  | 'NEW_CONFLICT_RISK'
  | 'WORKER_COUNT_INCREASED'
  | 'NEW_OVERFLOW'
  | 'EXTENSION_LOST';

export function diffRenderShape(
  prev: TooltipRenderShape,
  next: TooltipRenderShape,
): RenderShapeRegressionFlag[] {
  if (prev.fileId !== next.fileId) return [];
  const flags: RenderShapeRegressionFlag[] = [];
  if (prev.fileType !== 'unknown' && next.fileType === 'unknown') flags.push('FILE_TYPE_DEGRADED');
  if (!prev.conflictRisk && next.conflictRisk) flags.push('NEW_CONFLICT_RISK');
  if (next.workerCount > prev.workerCount) flags.push('WORKER_COUNT_INCREASED');
  if (prev.overflow === 0 && next.overflow > 0) flags.push('NEW_OVERFLOW');
  if (prev.hasExtension && !next.hasExtension) flags.push('EXTENSION_LOST');
  return flags;
}

function FileTooltipImpl({
  file,
  x,
  y,
  workerNames = [],
  inDegree,
  outDegree,
  viewportWidth,
  viewportHeight,
  compact = false,
  highlighted = false,
  palette = 'default',
  maxWorkerChips,
  testId,
}: Props) {
  // 팔레트 결정은 한 곳에서. 충돌 경고색도 동일 팔레트 가족 내에서 선택해
  // 강조와 위험 신호가 시각적으로 같은 톤 위에 머물도록 한다.
  const accentMap = resolveAccentMap(palette);
  const conflictColor = resolveConflictColor(palette);
  const accent = accentMap[file.type] ?? FALLBACK_ACCENT;
  const label = TYPE_LABEL[file.type] ?? FALLBACK_LABEL;
  const hint = TYPE_HINT[file.type] ?? FALLBACK_HINT;
  const glyph = TYPE_GLYPH[file.type] ?? FALLBACK_GLYPH;
  const displayName = truncateName(file.name || EMPTY_NAME);
  // 확장자 배지: 잘린 이름에서 끝부분이 사라져도 파일 종류 단서를 남긴다.
  const extension = useMemo(() => getFileExtension(file.name || ''), [file.name]);
  const showGraph = inDegree !== undefined || outDegree !== undefined;

  // 작업자 정규화·정렬·오버플로 계산을 순수 헬퍼에 위임한다.
  // 이렇게 하면 렌더러가 아니라 summarizeWorkers 쪽 단위 테스트만으로
  // 중복·공백·오버플로·충돌 경고 조건을 검증할 수 있어 회귀 방지력이 높아진다.
  const workers = useMemo(
    () => summarizeWorkers(workerNames, maxWorkerChips),
    [workerNames, maxWorkerChips],
  );
  const { unique: uniqueWorkers, visible: visibleChips, overflow, overflowLabel, conflictRisk } =
    workers;

  const { tx, ty } = useMemo(
    () => clampPosition(x, y, viewportWidth, viewportHeight),
    [x, y, viewportWidth, viewportHeight],
  );

  // 강조 시 외곽 글로우 + 내부 강조 바를 동시에. 비강조 시엔 드롭 섀도만.
  const boxShadow = highlighted
    ? `inset 3px 0 0 ${accent}, 0 0 0 1px ${accent}, 0 0 8px ${accent}55, 3px 3px 0 rgba(0,0,0,0.7)`
    : `inset 3px 0 0 ${accent}, 2px 2px 0 rgba(0,0,0,0.6)`;

  const pattern = TYPE_PATTERN[file.type];
  // 작업자 유무에 따른 상태 도트. 디자인 시스템의 활성/휴면 기호와 통일.
  const statusDotColor = uniqueWorkers.length > 0 ? accent : 'rgba(255,255,255,0.25)';
  // 모션 감응 사용자 배려: 펄스 애니메이션은 접근성 설정을 존중.
  // 토글 변화에도 반응하도록 구독 훅을 사용한다.
  const motionSafe = !useReducedMotion();
  // 고대비 모드에서는 스캔라인·은은한 불투명도 같은 장식을 걷어내고
  // 순수한 톤 대비만 남긴다. 디자인보다 가독성을 우선하는 정책.
  const highContrast = useHighContrast();
  // 활성 작업자가 있고 모션 허용이면 도트가 은은히 숨쉬게 만들어
  // "여기 누가 있다"는 사실을 제스처 없이 전달한다.
  const pulseAnim = uniqueWorkers.length > 0 && motionSafe
    ? 'pixelTooltipPulse 1.6s ease-in-out infinite'
    : 'none';

  // 스크린리더용 한 줄 요약. 시각 요소가 가려진 사용자에게도 동일한 정보를 전달한다.
  const ariaSummary = useMemo(
    () =>
      buildAriaSummary({
        displayName,
        extension,
        typeLabel: label,
        workerCount: uniqueWorkers.length,
        conflictRisk,
        inDegree: showGraph ? inDegree : undefined,
        outDegree: showGraph ? outDegree : undefined,
      }),
    [displayName, extension, label, uniqueWorkers.length, conflictRisk, showGraph, inDegree, outDegree],
  );

  // 개발 시 prop 규약 위반을 한 번만 경고. 렌더 경로에서 프로덕션에는 비용이 없다.
  useEffect(() => {
    if (typeof process === 'undefined' || process.env?.NODE_ENV === 'production') return;
    warnOnTooltipPropIssues(
      validateTooltipPropsIssues({
        file,
        x,
        y,
        workerNames,
        inDegree,
        outDegree,
        maxWorkerChips,
        viewportWidth,
        viewportHeight,
        palette,
      }),
    );
  }, [file, x, y, workerNames, inDegree, outDegree, maxWorkerChips, viewportWidth, viewportHeight, palette]);

  return (
    <div
      role="tooltip"
      aria-label={ariaSummary}
      data-testid={testId}
      data-highlighted={highlighted ? 'true' : 'false'}
      data-compact={compact ? 'true' : 'false'}
      data-high-contrast={highContrast ? 'true' : 'false'}
      data-file-type={file.type}
      data-conflict-risk={conflictRisk ? 'true' : 'false'}
      data-worker-count={uniqueWorkers.length}
      className="absolute z-30 pointer-events-none bg-black/90 border-2 px-2 py-1 text-[10px] text-white whitespace-nowrap shadow-lg"
      style={{
        transform: `translate3d(${tx}px, ${ty}px, 0)`,
        borderColor: accent,
        boxShadow,
        paddingLeft: 10,
        // 고대비 모드에선 장식 스캔라인을 제거해 텍스트 명도 대비를 최대화한다.
        backgroundImage: highContrast ? 'none' : SCANLINE_BG,
        // 고대비 모드에선 전체 배경을 완전 불투명 검정으로 밀어 최소 7:1 대비 확보.
        backgroundColor: highContrast ? '#000' : undefined,
      }}
    >
      {pattern && !highContrast && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-0 bottom-0 w-[3px] opacity-40"
          style={{ color: accent, backgroundImage: pattern }}
        />
      )}
      <div
        className="font-bold truncate flex items-center gap-1"
        style={{ color: accent, maxWidth: CONTENT_MAX_WIDTH }}
      >
        <span
          aria-hidden="true"
          className="inline-block w-[6px] h-[6px] rounded-full"
          style={{
            backgroundColor: statusDotColor,
            boxShadow: uniqueWorkers.length > 0 ? `0 0 4px ${accent}` : 'none',
            animation: pulseAnim,
          }}
        />
        <span aria-hidden="true">{glyph}</span>
        <span className="truncate">{displayName}</span>
        {extension && !compact && (
          <span
            aria-hidden="true"
            className="ml-auto px-1 border text-[8px] uppercase tracking-wider opacity-70"
            style={{ borderColor: accent, color: accent }}
          >
            {extension}
          </span>
        )}
      </div>
      <div className="opacity-70">
        유형: <span style={{ color: accent }}>{label}</span>
      </div>
      {!compact && <div className="opacity-50">{hint}</div>}
      {showGraph && (
        <div className="opacity-70">
          의존: ← <span style={{ color: accent }}>{inDegree ?? 0}</span>
          {' · '}→ <span style={{ color: accent }}>{outDegree ?? 0}</span>
        </div>
      )}
      {uniqueWorkers.length > 0 ? (
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          <span className="opacity-70">작업 중:</span>
          {conflictRisk && (
            <span
              className="px-1"
              title={`동시 작업자 ${uniqueWorkers.length}명 · 병합 충돌 가능성 있음`}
              aria-label="충돌 위험"
              style={{ color: conflictColor }}
            >
              ⚠
            </span>
          )}
          {visibleChips.map((name) => (
            <span
              key={name}
              className="px-1 border"
              style={{ borderColor: accent, color: accent }}
            >
              {name}
            </span>
          ))}
          {overflow > 0 && (
            <span
              className="opacity-60"
              title={overflowLabel}
              aria-label={`추가 작업자 ${overflow}명: ${overflowLabel}`}
            >
              +{overflow}
            </span>
          )}
        </div>
      ) : (
        // 10px 소형 텍스트 기준 WCAG AA(4.5:1)를 만족시키기 위해 opacity 40 → 60 으로 상향.
        !compact && <div className="opacity-60">작업자 없음</div>
      )}
      {!compact && <div className="opacity-60">#{shortId(file.id)}</div>}
    </div>
  );
}

// 파일 노드 위를 빠르게 훑을 때 같은 props로 자주 재호출되므로 memo로 감싼다.
export const FileTooltip = memo(FileTooltipImpl);

export default FileTooltip;
