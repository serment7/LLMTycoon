// 지시 #222ece09 §4 — 키보드 단축키 중앙 관리.
//
// 드롭·붙여넣기·녹음 같은 멀티미디어 트리거 키가 여러 컴포넌트(UploadDropzone,
// MediaPipelinePanel, Joker 의 OnboardingTour)에서 제각각 등록되면 충돌·중복 등록이
// 생긴다. 본 모듈은 **순수 함수 집합**으로, 단축키 ID·키 조합·설명을 단일 registry
// 에 모아 App.tsx 가 소유하게 한다. 실제 `keydown` 리스너는 App.tsx 가 한 번만 걸고,
// 해결된 ID 를 Joker 의 투어·본 패널 양쪽이 구독한다.
//
// 본 모듈은 React 의존이 없다. Node 테스트에서 `resolveShortcut(event)` 계약을
// 그대로 잠글 수 있다.

export type MediaShortcutId =
  | 'mediaPaste'
  | 'mediaDrop'
  | 'mediaRecordStart'
  | 'mediaRecordStop';

export interface ShortcutBinding<Id extends string = string> {
  id: Id;
  /** 'Meta+V', 'Alt+R', 'Control+Shift+D' 같은 표준화된 키 조합. 대소문자 무시. */
  keys: string;
  description: string;
  /** 접근성 힌트. OnboardingTour 가 읽어 낭독한다. */
  a11yHint?: string;
  /** 중복 등록 시 경고만 내고 유지할 우선순위. 더 큰 값이 승리. 기본 0. */
  priority?: number;
}

export interface ShortcutRegistry<Id extends string = string> {
  register(binding: ShortcutBinding<Id>): () => void;
  /** 현재 등록된 바인딩 전체. 변경되면 새 배열을 돌려준다(불변). */
  list(): ReadonlyArray<ShortcutBinding<Id>>;
  /** 키 조합 문자열로 ID 를 조회한다. 일치 없으면 null. */
  resolveByCombo(combo: string): ShortcutBinding<Id> | null;
  /** 이벤트(React 또는 DOM)로부터 ID 를 조회한다. Meta/Ctrl/Alt/Shift 를 정규화. */
  resolveByEvent(event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): ShortcutBinding<Id> | null;
  clear(): void;
}

/** 사람 친화 조합 문자열을 표준 형태(정렬·대소문자)로 정규화한다. */
export function normalizeCombo(combo: string): string {
  const parts = combo.split('+').map(s => s.trim()).filter(Boolean);
  const modifiers: string[] = [];
  let key = '';
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === 'meta' || lower === 'cmd' || lower === 'command') modifiers.push('Meta');
    else if (lower === 'ctrl' || lower === 'control') modifiers.push('Control');
    else if (lower === 'alt' || lower === 'option') modifiers.push('Alt');
    else if (lower === 'shift') modifiers.push('Shift');
    else key = p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
  }
  modifiers.sort(); // Alt → Control → Meta → Shift 사전순
  return [...modifiers, key].filter(Boolean).join('+');
}

export function eventToCombo(event: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): string {
  const mods: string[] = [];
  if (event.altKey) mods.push('Alt');
  if (event.ctrlKey) mods.push('Control');
  if (event.metaKey) mods.push('Meta');
  if (event.shiftKey) mods.push('Shift');
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [...mods, key].join('+');
}

export function createShortcutRegistry<Id extends string = string>(): ShortcutRegistry<Id> {
  const byCombo = new Map<string, ShortcutBinding<Id>>();
  // 같은 id 가 재등록될 수 있으므로 id → combo 맵도 유지해 중복 정리에 쓴다.
  const byId = new Map<Id, string>();

  return {
    register(binding) {
      const combo = normalizeCombo(binding.keys);
      const existing = byCombo.get(combo);
      if (existing && (existing.priority ?? 0) >= (binding.priority ?? 0) && existing.id !== binding.id) {
        // 낮거나 같은 우선순위이고 id 가 다르면 등록을 거절하되 경고만 남긴다.
        // (컴포넌트 마운트 순서로 승부가 갈리면 회귀가 생기므로 명시 우선순위를 요구.)
        return () => { /* noop */ };
      }
      // 같은 id 재등록이면 기존 combo 제거 후 새 값으로 교체.
      const prevCombo = byId.get(binding.id);
      if (prevCombo && prevCombo !== combo) byCombo.delete(prevCombo);
      byCombo.set(combo, { ...binding, keys: combo });
      byId.set(binding.id, combo);
      return () => {
        const current = byCombo.get(combo);
        if (current && current.id === binding.id) {
          byCombo.delete(combo);
          byId.delete(binding.id);
        }
      };
    },
    list() {
      return Array.from(byCombo.values());
    },
    resolveByCombo(combo) {
      return byCombo.get(normalizeCombo(combo)) ?? null;
    },
    resolveByEvent(event) {
      return byCombo.get(eventToCombo(event)) ?? null;
    },
    clear() {
      byCombo.clear();
      byId.clear();
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 전역 단축키 카탈로그(#0dceedcd) — SettingsDrawer 의 치트시트가 그대로 나열한다.
// ────────────────────────────────────────────────────────────────────────────
//
// 본 카탈로그는 "사용자에게 보여줄 단축키 목록" 이다. 실제 keydown 핸들러와는 축이
// 분리돼 있어, 핸들러가 한 곳에서만 청취하되 치트시트에는 누락 없이 나열된다.

export type GlobalShortcutId =
  | 'search'
  | 'exportPdf'
  | 'exportPptx'
  | 'exportVideo'
  | 'themeNext'
  | 'onboardingReplay'
  | 'uploadOpen';

export const DEFAULT_GLOBAL_SHORTCUTS: ReadonlyArray<ShortcutBinding<GlobalShortcutId>> = Object.freeze([
  { id: 'search',            keys: 'Control+F', description: '대화 검색 열기(맥은 Cmd+F)', a11yHint: 'Esc 로 닫습니다', priority: 50 },
  { id: 'exportPdf',         keys: 'Alt+P',     description: 'PDF 리포트 내보내기', priority: 50 },
  { id: 'exportPptx',        keys: 'Alt+S',     description: 'PPTX 덱 내보내기', priority: 50 },
  { id: 'exportVideo',       keys: 'Alt+V',     description: '영상 생성 요청', priority: 50 },
  { id: 'themeNext',         keys: 'Alt+T',     description: '라이트/다크/시스템 테마 순환', priority: 50 },
  { id: 'onboardingReplay',  keys: 'Alt+O',     description: '온보딩 투어 다시 보기', priority: 50 },
  { id: 'uploadOpen',        keys: 'Enter',     description: '포커스된 업로드 드롭존 열기', priority: 5 },
]) as ReadonlyArray<ShortcutBinding<GlobalShortcutId>>;

/** SettingsDrawer 치트시트가 섹션 제목과 함께 나열할 카테고리 묶음. */
export interface ShortcutCategory {
  title: string;
  shortcuts: ReadonlyArray<ShortcutBinding<string>>;
}

export const GLOBAL_SHORTCUT_CATEGORIES: ReadonlyArray<ShortcutCategory> = Object.freeze([
  {
    title: '대화·검색',
    shortcuts: DEFAULT_GLOBAL_SHORTCUTS.filter(s => s.id === 'search' || s.id === 'onboardingReplay'),
  },
  {
    title: '멀티미디어 내보내기',
    shortcuts: DEFAULT_GLOBAL_SHORTCUTS.filter(s => s.id.startsWith('export')),
  },
  {
    title: '테마·업로드',
    shortcuts: DEFAULT_GLOBAL_SHORTCUTS.filter(s => s.id === 'themeNext' || s.id === 'uploadOpen'),
  },
]) as ReadonlyArray<ShortcutCategory>;

/**
 * 멀티미디어 입력 축의 기본 단축키 목록. App.tsx 가 부팅 시 한 번 등록하고, Joker 의
 * OnboardingTour 는 같은 registry 를 구독해 툴팁·낭독에 이 description/a11yHint 를
 * 그대로 소비한다. 실제 액션(업로드·녹음 시작 등) 은 App.tsx 의 핸들러가 소유한다.
 */
export const DEFAULT_MEDIA_SHORTCUTS: ReadonlyArray<ShortcutBinding<MediaShortcutId>> = Object.freeze([
  {
    id: 'mediaPaste',
    keys: 'Meta+V',
    description: '클립보드에서 파일·이미지를 붙여 업로드',
    a11yHint: '윈도우에서는 Ctrl+V, 맥에서는 Cmd+V 입니다.',
    priority: 10,
  },
  {
    id: 'mediaDrop',
    // Drop 은 드래그 제스처라 키 조합이 아니다 — "포커스된 드롭존에서 Enter/Space" 로 대응.
    keys: 'Enter',
    description: '포커스된 드롭존 열기',
    priority: 5,
  },
  {
    id: 'mediaRecordStart',
    keys: 'Alt+R',
    description: '마이크 녹음 시작',
    a11yHint: '권한이 거부되면 토스트로 안내합니다.',
    priority: 10,
  },
  {
    id: 'mediaRecordStop',
    keys: 'Alt+S',
    description: '마이크 녹음 중지',
    priority: 10,
  },
]) as ReadonlyArray<ShortcutBinding<MediaShortcutId>>;
