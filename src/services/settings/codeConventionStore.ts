// 지시 #d7caa7af · 코드 컨벤션/규칙 설정 스토어.
//
// 전역(사용자별) 과 로컬(프로젝트별) 두 스코프를 localStorage 키로 분리해 저장한다.
// 로드 시 로컬 레코드가 존재하면 로컬 우선으로, 없으면 전역을 폴백으로 쓴다.
// 로컬 레코드가 부분적이면 전역 값을 필드 단위로 병합해 UI 가 항상 완전한
// CodeConvention 을 받도록 한다(부분 저장/누락 방어).
//
// 저장 규약
//   · 전역: localStorage['llmtycoon.codeConvention.global']
//       JSON { convention, updatedAt }
//   · 로컬: localStorage['llmtycoon.codeConvention.project.<id>']
//       JSON { convention, updatedAt }
//
// 주입 가능성
//   · 테스트와 SSR 대비로 Storage 훅을 주입할 수 있다. 미주입 시 window.localStorage
//     를 쓰되 window/localStorage 부재 시 in-memory 폴백으로 떨어진다.

import {
  DEFAULT_CODE_CONVENTION,
  FILENAME_CONVENTIONS,
  INDENTATION_SIZE_MAX,
  INDENTATION_SIZE_MIN,
  INDENTATION_STYLES,
  QUOTE_STYLES,
  SEMICOLON_POLICIES,
  type CodeConvention,
  type CodeConventionRecord,
  type CodeConventionScope,
  type FilenameConvention,
  type IndentationStyle,
  type QuoteStyle,
  type SemicolonPolicy,
} from '../../types/codeConvention';

export const CODE_CONVENTION_GLOBAL_KEY = 'llmtycoon.codeConvention.global';
export const CODE_CONVENTION_PROJECT_KEY_PREFIX = 'llmtycoon.codeConvention.project.';

export function codeConventionProjectKey(projectId: string): string {
  return `${CODE_CONVENTION_PROJECT_KEY_PREFIX}${projectId}`;
}

/** Storage 의 최소 슬라이스 — 테스트용 폴리필/메모리 구현이 이 모양만 충족하면 된다. */
export interface CodeConventionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CodeConventionStoreOptions {
  /** 미지정 시 window.localStorage 를 쓰며, 브라우저가 아니면 in-memory 로 폴백. */
  readonly storage?: CodeConventionStorage;
  /** updatedAt 에 쓸 시각 훅. 테스트 결정론용. */
  readonly now?: () => number;
}

function createMemoryStorage(): CodeConventionStorage {
  const map = new Map<string, string>();
  return {
    getItem(key) { return map.has(key) ? map.get(key)! : null; },
    setItem(key, value) { map.set(key, value); },
    removeItem(key) { map.delete(key); },
  };
}

function resolveStorage(override?: CodeConventionStorage): CodeConventionStorage {
  if (override) return override;
  try {
    const g = globalThis as unknown as { window?: { localStorage?: Storage } };
    const ls = g.window?.localStorage;
    if (ls) {
      return {
        getItem: (k) => ls.getItem(k),
        setItem: (k, v) => ls.setItem(k, v),
        removeItem: (k) => ls.removeItem(k),
      };
    }
  } catch {
    // 접근 거부된 환경(브라우저 프라이빗 모드 등) 에서는 메모리 폴백으로 떨어진다.
  }
  return createMemoryStorage();
}

// ────────────────────────────────────────────────────────────────────────────
// 파싱 · 정규화
// ────────────────────────────────────────────────────────────────────────────

function clampIndentSize(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < INDENTATION_SIZE_MIN) return INDENTATION_SIZE_MIN;
  if (rounded > INDENTATION_SIZE_MAX) return INDENTATION_SIZE_MAX;
  return rounded;
}

function parseIndentStyle(value: unknown, fallback: IndentationStyle): IndentationStyle {
  return INDENTATION_STYLES.includes(value as IndentationStyle) ? (value as IndentationStyle) : fallback;
}

function parseQuoteStyle(value: unknown, fallback: QuoteStyle): QuoteStyle {
  return QUOTE_STYLES.includes(value as QuoteStyle) ? (value as QuoteStyle) : fallback;
}

function parseSemicolonPolicy(value: unknown, fallback: SemicolonPolicy): SemicolonPolicy {
  return SEMICOLON_POLICIES.includes(value as SemicolonPolicy) ? (value as SemicolonPolicy) : fallback;
}

function parseFilenameConvention(value: unknown, fallback: FilenameConvention): FilenameConvention {
  return FILENAME_CONVENTIONS.includes(value as FilenameConvention) ? (value as FilenameConvention) : fallback;
}

function normalizeCustomRules(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  // 끝 공백과 CRLF 만 정리. 내용 자체는 그대로 보존한다.
  return value.replace(/\r\n?/g, '\n');
}

/** 부분 입력을 완전한 CodeConvention 으로 병합. fallback 은 필드 단위 폴백값. */
export function normalizeCodeConvention(
  input: Partial<CodeConvention> | null | undefined,
  fallback: CodeConvention = DEFAULT_CODE_CONVENTION,
): CodeConvention {
  const source = (input ?? {}) as Partial<CodeConvention>;
  const indentationSource = (source.indentation ?? {}) as Partial<CodeConvention['indentation']>;
  return {
    indentation: {
      style: parseIndentStyle(indentationSource.style, fallback.indentation.style),
      size: clampIndentSize(indentationSource.size, fallback.indentation.size),
    },
    quotes: parseQuoteStyle(source.quotes, fallback.quotes),
    semicolons: parseSemicolonPolicy(source.semicolons, fallback.semicolons),
    filenameConvention: parseFilenameConvention(source.filenameConvention, fallback.filenameConvention),
    customRules: normalizeCustomRules(source.customRules, fallback.customRules),
  };
}

interface StoredEnvelope {
  readonly convention?: Partial<CodeConvention>;
  readonly updatedAt?: unknown;
}

function readEnvelope(storage: CodeConventionStorage, key: string): StoredEnvelope | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as StoredEnvelope;
  } catch {
    // 손상된 JSON 은 조용히 무시하고 null 로 본다. 저장소 한 슬롯이 앱 전체를
    // 막지 않도록 한다.
    return null;
  }
}

function envelopeUpdatedAt(envelope: StoredEnvelope, fallback: number): number {
  const raw = envelope.updatedAt;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return fallback;
}

// ────────────────────────────────────────────────────────────────────────────
// 공개 API
// ────────────────────────────────────────────────────────────────────────────

export interface CodeConventionStore {
  /** 전역 레코드만 읽는다. 없으면 null. */
  loadGlobal(): CodeConventionRecord | null;
  /** 로컬 레코드만 읽는다. 없으면 null. */
  loadLocal(projectId: string): CodeConventionRecord | null;
  /**
   * UI 가 실제로 표시할 "합쳐진" 레코드. 로컬이 있으면 로컬 우선이고, 로컬이
   * 부분 저장이면 전역으로 필드 폴백, 둘 다 없으면 기본값 기반 global 레코드.
   */
  loadEffective(projectId: string | undefined): CodeConventionRecord;
  saveGlobal(convention: Partial<CodeConvention>): CodeConventionRecord;
  saveLocal(projectId: string, convention: Partial<CodeConvention>): CodeConventionRecord;
  clearGlobal(): void;
  clearLocal(projectId: string): void;
}

export function createCodeConventionStore(options: CodeConventionStoreOptions = {}): CodeConventionStore {
  const storage = resolveStorage(options.storage);
  const now = options.now ?? (() => Date.now());

  function loadGlobal(): CodeConventionRecord | null {
    const envelope = readEnvelope(storage, CODE_CONVENTION_GLOBAL_KEY);
    if (!envelope) return null;
    return {
      scope: 'global',
      convention: normalizeCodeConvention(envelope.convention ?? null),
      updatedAt: envelopeUpdatedAt(envelope, 0),
    };
  }

  function loadLocal(projectId: string): CodeConventionRecord | null {
    if (!projectId) return null;
    const envelope = readEnvelope(storage, codeConventionProjectKey(projectId));
    if (!envelope) return null;
    return {
      scope: 'local',
      projectId,
      convention: normalizeCodeConvention(envelope.convention ?? null),
      updatedAt: envelopeUpdatedAt(envelope, 0),
    };
  }

  function loadEffective(projectId: string | undefined): CodeConventionRecord {
    const global = loadGlobal();
    const rawLocalEnvelope = projectId
      ? readEnvelope(storage, codeConventionProjectKey(projectId))
      : null;
    if (rawLocalEnvelope) {
      // 로컬 원본 부분 페이로드를 전역(없으면 기본) 위에 얹어 필드 단위 병합.
      const fallback = global?.convention ?? DEFAULT_CODE_CONVENTION;
      const merged = normalizeCodeConvention(rawLocalEnvelope.convention ?? null, fallback);
      return {
        scope: 'local',
        projectId,
        convention: merged,
        updatedAt: envelopeUpdatedAt(rawLocalEnvelope, 0),
      };
    }
    if (global) return global;
    return {
      scope: 'global',
      convention: DEFAULT_CODE_CONVENTION,
      updatedAt: 0,
    };
  }

  function writeEnvelope(key: string, convention: CodeConvention, updatedAt: number): void {
    const payload = JSON.stringify({ convention, updatedAt });
    storage.setItem(key, payload);
  }

  function saveGlobal(input: Partial<CodeConvention>): CodeConventionRecord {
    const existing = loadGlobal();
    const convention = normalizeCodeConvention(input, existing?.convention ?? DEFAULT_CODE_CONVENTION);
    const updatedAt = now();
    writeEnvelope(CODE_CONVENTION_GLOBAL_KEY, convention, updatedAt);
    return { scope: 'global', convention, updatedAt };
  }

  function saveLocal(projectId: string, input: Partial<CodeConvention>): CodeConventionRecord {
    if (!projectId) {
      throw new Error('saveLocal: projectId 가 필요합니다.');
    }
    const existingLocal = loadLocal(projectId);
    const globalFallback = loadGlobal()?.convention ?? DEFAULT_CODE_CONVENTION;
    const convention = normalizeCodeConvention(
      input,
      existingLocal?.convention ?? globalFallback,
    );
    const updatedAt = now();
    writeEnvelope(codeConventionProjectKey(projectId), convention, updatedAt);
    return { scope: 'local', projectId, convention, updatedAt };
  }

  function clearGlobal(): void {
    storage.removeItem(CODE_CONVENTION_GLOBAL_KEY);
  }

  function clearLocal(projectId: string): void {
    if (!projectId) return;
    storage.removeItem(codeConventionProjectKey(projectId));
  }

  return {
    loadGlobal,
    loadLocal,
    loadEffective,
    saveGlobal,
    saveLocal,
    clearGlobal,
    clearLocal,
  };
}

/**
 * 싱글턴 편의 API — 기본 저장소(window.localStorage 또는 메모리 폴백) 로
 * 즉시 동작한다. 주입형 인스턴스를 원하면 createCodeConventionStore() 를 쓴다.
 */
let sharedStore: CodeConventionStore | null = null;

function getSharedStore(): CodeConventionStore {
  if (!sharedStore) sharedStore = createCodeConventionStore();
  return sharedStore;
}

export function resetCodeConventionStoreForTests(): void {
  sharedStore = null;
}

export function loadEffectiveCodeConvention(projectId?: string): CodeConventionRecord {
  return getSharedStore().loadEffective(projectId);
}

export function saveGlobalCodeConvention(convention: Partial<CodeConvention>): CodeConventionRecord {
  return getSharedStore().saveGlobal(convention);
}

export function saveLocalCodeConvention(projectId: string, convention: Partial<CodeConvention>): CodeConventionRecord {
  return getSharedStore().saveLocal(projectId, convention);
}
