// 지시 #586ea74c — 프로젝트 관리 메뉴의 "코드 컨벤션/룰 설정" 완성형 뷰.
//
// 이전 라운드에서 Thanos 가 백엔드 스키마·로더(`src/stores/codeRulesStore.ts`)와
// 에이전트 프롬프트 주입(`src/services/agentDispatcher.ts` + `src/server/prompts.ts`)을
// 완성했고, 이번 라운드는 디자이너 시안(`docs/designs/code-rules-settings.md`) 에
// 맞춰 사용자 화면을 결합한다.
//
// 본 뷰가 책임지는 축
//   1) 범위 탭(로컬·전역) + 상속 상태 배지
//   2) 항목 그룹 6종 폼 필드(스키마 기반 제어 컴포넌트)
//   3) 로컬/전역 충돌 경고 배너 + 적용 미리보기 패널
//   4) JSON 내보내기/가져오기(미리보기 diff) + 최근 10건 변경 이력
//   5) 에이전트 프롬프트 주입 상태 확인 패널
//   6) 빈 상태·오류·저장 중 상태(낙관적 업데이트 + 롤백)
//
// 설계 포인트
//   · saveStatus 4종(idle/saving/error/dirty) 은 단일 상태에 폼 dirty 여부와
//     서버 응답 결과를 함께 반영. 저장 실패 시 optimistic 으로 밀어 넣었던 값은
//     직전 서버 스냅샷(baseline) 으로 롤백한다.
//   · 변경 이력은 localStorage(`llmtycoon:code-rules-history:<scope>:<projectId>`)
//     에 10건 순환 저장. 서버 DB 에 이력이 들어갈 때까지의 과도기 저장소.
//   · 에이전트 주입 미리보기는 renderCodeRulesBlock 결과를 그대로 노출한다.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  ClipboardCopy,
  FileDown,
  FolderGit2,
  Globe2,
  History,
  Lock,
  Plus,
  RefreshCw,
  Rocket,
  Save,
  Trash2,
} from 'lucide-react';
import {
  saveCodeRules,
  loadCodeRules,
  subscribeCodeRules,
  clearCodeRules,
  validateCodeRulesInput,
  serializeCodeRulesForFile,
  parseCodeRulesFromFile,
  DEFAULT_CODE_RULES,
  LINTER_PRESETS,
  FILENAME_CONVENTIONS,
  CODE_RULES_FILENAME,
  type CodeRulesRecord,
  type CodeRulesScope,
  type CodeRulesStore,
  type CodeRulesValidationError,
  type ForbiddenPattern,
  type IndentStyle,
  type QuoteStyle,
  type SemicolonPolicy,
  type FilenameConvention,
  type LinterPreset,
} from '../../stores/codeRulesStore';
import { renderCodeRulesBlock, type CodeRulesForPrompt } from '../../server/prompts';

interface Props {
  projectId: string;
  /** 테스트 주입용. 미지정 시 싱글턴 편의 API 를 사용. */
  store?: CodeRulesStore;
  onLog?: (message: string) => void;
}

// ────────────────────────────────────────────────────────────────────────────
// 폼 상태 — 낙관적 업데이트 대상
// ────────────────────────────────────────────────────────────────────────────

interface FormState {
  indentStyle: IndentStyle;
  indentSize: number;
  quotes: QuoteStyle;
  semicolons: SemicolonPolicy;
  filenameConvention: FilenameConvention;
  linterPreset: LinterPreset;
  forbiddenPatterns: ForbiddenPattern[];
  extraInstructions: string;
}

function defaultFormState(): FormState {
  const d = DEFAULT_CODE_RULES;
  return {
    indentStyle: d.indentation.style,
    indentSize: d.indentation.size,
    quotes: d.quotes,
    semicolons: d.semicolons,
    filenameConvention: d.filenameConvention,
    linterPreset: d.linterPreset,
    forbiddenPatterns: [],
    extraInstructions: '',
  };
}

function recordToForm(rec: CodeRulesRecord | null): FormState {
  if (!rec) return defaultFormState();
  return {
    indentStyle: rec.indentation.style,
    indentSize: rec.indentation.size,
    quotes: rec.quotes,
    semicolons: rec.semicolons,
    filenameConvention: rec.filenameConvention,
    linterPreset: rec.linterPreset,
    forbiddenPatterns: rec.forbiddenPatterns.map((p) => ({ ...p })),
    extraInstructions: rec.extraInstructions ?? '',
  };
}

function formToPreviewRecord(form: FormState, scope: CodeRulesScope, projectId: string): CodeRulesRecord {
  return {
    id: scope === 'local' ? `local:${projectId}` : 'global',
    scope,
    projectId: scope === 'local' ? projectId : '',
    schemaVersion: 1,
    updatedAt: Date.now(),
    indentation: { style: form.indentStyle, size: form.indentSize },
    quotes: form.quotes,
    semicolons: form.semicolons,
    filenameConvention: form.filenameConvention,
    linterPreset: form.linterPreset,
    forbiddenPatterns: form.forbiddenPatterns,
    extraInstructions: form.extraInstructions.trim() || undefined,
  };
}

// 토큰 수 어림값 — 공백 포함 문자 수 / 4. agentDispatcher 가 주입하는 블록
// 길이를 사용자에게 감 잡게 해 주는 용도.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ────────────────────────────────────────────────────────────────────────────
// 변경 이력 — localStorage 기반 최근 10건
// ────────────────────────────────────────────────────────────────────────────

interface HistoryEntry {
  at: number;
  summary: string;
  changedFields: string[];
}

const HISTORY_LIMIT = 10;

function historyKey(scope: CodeRulesScope, projectId: string): string {
  return `llmtycoon:code-rules-history:${scope}:${scope === 'local' ? projectId : ''}`;
}

function loadHistory(scope: CodeRulesScope, projectId: string): HistoryEntry[] {
  try {
    if (typeof window === 'undefined') return [];
    const raw = window.localStorage?.getItem(historyKey(scope, projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is HistoryEntry =>
        !!e && typeof e === 'object'
        && typeof (e as HistoryEntry).at === 'number'
        && typeof (e as HistoryEntry).summary === 'string'
        && Array.isArray((e as HistoryEntry).changedFields))
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function appendHistory(scope: CodeRulesScope, projectId: string, entry: HistoryEntry): void {
  try {
    if (typeof window === 'undefined') return;
    const prev = loadHistory(scope, projectId);
    const next = [entry, ...prev].slice(0, HISTORY_LIMIT);
    window.localStorage?.setItem(historyKey(scope, projectId), JSON.stringify(next));
  } catch {
    /* localStorage 쿼터/프라이빗 모드 — 실패해도 세션 내 UI 는 유지 */
  }
}

function diffFields(prev: CodeRulesRecord | null, next: CodeRulesRecord): string[] {
  const changed: string[] = [];
  const p = prev ?? { ...DEFAULT_CODE_RULES, id: '', scope: next.scope, projectId: next.projectId, updatedAt: 0 } as CodeRulesRecord;
  if (p.indentation.style !== next.indentation.style || p.indentation.size !== next.indentation.size) changed.push('indentation');
  if (p.quotes !== next.quotes) changed.push('quotes');
  if (p.semicolons !== next.semicolons) changed.push('semicolons');
  if (p.filenameConvention !== next.filenameConvention) changed.push('filenameConvention');
  if (p.linterPreset !== next.linterPreset) changed.push('linterPreset');
  if (JSON.stringify(p.forbiddenPatterns) !== JSON.stringify(next.forbiddenPatterns)) changed.push('forbiddenPatterns');
  if ((p.extraInstructions ?? '') !== (next.extraInstructions ?? '')) changed.push('extraInstructions');
  return changed;
}

// ────────────────────────────────────────────────────────────────────────────
// 충돌 계산 — 로컬 vs 전역 필드별 비교
// ────────────────────────────────────────────────────────────────────────────

interface Conflict {
  field: string;
  label: string;
  local: string;
  global: string;
}

function diffScopes(local: CodeRulesRecord | null, global: CodeRulesRecord | null): Conflict[] {
  if (!local || !global) return [];
  const out: Conflict[] = [];
  const add = (field: string, label: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ field, label, local: String(a), global: String(b) });
    }
  };
  add('indentation', '들여쓰기',
    `${local.indentation.style} × ${local.indentation.size}`,
    `${global.indentation.style} × ${global.indentation.size}`);
  add('quotes', '따옴표', local.quotes, global.quotes);
  add('semicolons', '세미콜론', local.semicolons, global.semicolons);
  add('filenameConvention', '파일명 규칙', local.filenameConvention, global.filenameConvention);
  add('linterPreset', '린터 프리셋', local.linterPreset, global.linterPreset);
  if (JSON.stringify(local.forbiddenPatterns) !== JSON.stringify(global.forbiddenPatterns)) {
    out.push({
      field: 'forbiddenPatterns',
      label: '금지 패턴',
      local: `${local.forbiddenPatterns.length}개`,
      global: `${global.forbiddenPatterns.length}개`,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// 메인 뷰
// ────────────────────────────────────────────────────────────────────────────

type SaveStatus = 'idle' | 'saving' | 'error' | 'dirty';
type PageStatus = 'loading' | 'ready' | 'error';

const focusRing = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pixel-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black';

export function CodeRulesSettings({ projectId, store, onLog }: Props) {
  const [scope, setScope] = useState<CodeRulesScope>('local');
  const [form, setForm] = useState<FormState>(defaultFormState);
  const [errors, setErrors] = useState<CodeRulesValidationError[]>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [pageStatus, setPageStatus] = useState<PageStatus>('loading');
  const [pageError, setPageError] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [localRecord, setLocalRecord] = useState<CodeRulesRecord | null>(null);
  const [globalRecord, setGlobalRecord] = useState<CodeRulesRecord | null>(null);
  const [injectionOpen, setInjectionOpen] = useState(false);

  // 낙관적 업데이트 롤백을 위한 마지막 서버 스냅샷. save 직전에 직접 잡아 두고,
  // 실패 시 이 값으로 form 을 되돌린다.
  const baselineRef = useRef<FormState>(defaultFormState());

  const api = useMemo(() => {
    if (store) {
      return {
        save: store.save.bind(store),
        load: store.load.bind(store),
        clear: store.clear.bind(store),
        subscribe: store.subscribe.bind(store),
      };
    }
    return {
      save: saveCodeRules,
      load: loadCodeRules,
      clear: clearCodeRules,
      subscribe: subscribeCodeRules,
    };
  }, [store]);

  const reloadAll = useCallback(async () => {
    try {
      setPageStatus('loading');
      const [local, global] = await Promise.all([
        api.load('local', projectId),
        api.load('global'),
      ]);
      setLocalRecord(local);
      setGlobalRecord(global);
      const active = scope === 'local' ? (local ?? global) : global;
      const next = recordToForm(active);
      setForm(next);
      baselineRef.current = next;
      setSaveStatus('idle');
      setErrors([]);
      setPageError(null);
      setPageStatus('ready');
    } catch (err) {
      setPageError((err as Error).message);
      setPageStatus('error');
    }
  }, [api, projectId, scope]);

  useEffect(() => {
    reloadAll();
    const unsub = api.subscribe(projectId, () => { reloadAll(); });
    const unsubGlobal = api.subscribe('', () => { reloadAll(); });
    return () => { unsub(); unsubGlobal(); };
  }, [api, projectId, reloadAll]);

  useEffect(() => {
    setHistory(loadHistory(scope, projectId));
  }, [scope, projectId]);

  const activeRecord = scope === 'local' ? localRecord : globalRecord;
  const inheritedFromGlobal = scope === 'local' && !localRecord && !!globalRecord;
  const conflicts = useMemo(() => diffScopes(localRecord, globalRecord), [localRecord, globalRecord]);
  const filePath = scope === 'local'
    ? `<프로젝트 루트>/${CODE_RULES_FILENAME}`
    : `<사용자 홈>/${CODE_RULES_FILENAME}`;

  // 주입 미리보기 — prompts.renderCodeRulesBlock 결과.
  const injectionPreview = useMemo(() => {
    const previewRecord = formToPreviewRecord(form, scope, projectId);
    const forPrompt: CodeRulesForPrompt = {
      scope: previewRecord.scope,
      indentation: previewRecord.indentation,
      quotes: previewRecord.quotes,
      semicolons: previewRecord.semicolons,
      filenameConvention: previewRecord.filenameConvention,
      linterPreset: previewRecord.linterPreset,
      forbiddenPatterns: previewRecord.forbiddenPatterns,
      extraInstructions: previewRecord.extraInstructions,
    };
    const lines = renderCodeRulesBlock(forPrompt);
    const text = lines.join('\n');
    return { text, tokens: estimateTokens(text), lineCount: lines.length };
  }, [form, scope, projectId]);

  // 폼 입력 핸들러 — dirty 표기. save 전까지는 서버 스냅샷과 분리돼 있다.
  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaveStatus('dirty');
  };

  const addPattern = () => {
    setForm((prev) => ({
      ...prev,
      forbiddenPatterns: [...prev.forbiddenPatterns, { name: '', pattern: '', message: '' }],
    }));
    setSaveStatus('dirty');
  };

  const updatePattern = (index: number, key: keyof ForbiddenPattern, value: string) => {
    setForm((prev) => ({
      ...prev,
      forbiddenPatterns: prev.forbiddenPatterns.map((p, i) => i === index ? { ...p, [key]: value } : p),
    }));
    setSaveStatus('dirty');
  };

  const removePattern = (index: number) => {
    setForm((prev) => ({
      ...prev,
      forbiddenPatterns: prev.forbiddenPatterns.filter((_, i) => i !== index),
    }));
    setSaveStatus('dirty');
  };

  const cleanedPatterns = () => form.forbiddenPatterns
    .map((p) => ({
      name: p.name.trim(),
      pattern: p.pattern,
      message: p.message?.trim() || undefined,
    }))
    .filter((p) => p.name || p.pattern);

  const onSave = async () => {
    const input = {
      scope,
      projectId: scope === 'local' ? projectId : undefined,
      indentation: { style: form.indentStyle, size: form.indentSize },
      quotes: form.quotes,
      semicolons: form.semicolons,
      filenameConvention: form.filenameConvention,
      linterPreset: form.linterPreset,
      forbiddenPatterns: cleanedPatterns(),
      extraInstructions: form.extraInstructions,
    };
    const found = validateCodeRulesInput(input);
    setErrors(found);
    if (found.length > 0) {
      setSaveStatus('dirty');
      return;
    }
    const prevBaseline = baselineRef.current;
    setSaveStatus('saving');
    // 낙관적 업데이트: form 자체는 이미 반영돼 있으니 baseline 만 선-갱신.
    baselineRef.current = { ...form, forbiddenPatterns: form.forbiddenPatterns.map((p) => ({ ...p })) };
    try {
      const saved = await api.save(input);
      const changed = diffFields(scope === 'local' ? localRecord : globalRecord, saved);
      if (scope === 'local') setLocalRecord(saved); else setGlobalRecord(saved);
      setSaveStatus('idle');
      if (changed.length > 0) {
        const entry: HistoryEntry = {
          at: saved.updatedAt,
          summary: `[${scope}] ${changed.join(', ')} 변경`,
          changedFields: changed,
        };
        appendHistory(scope, projectId, entry);
        setHistory((h) => [entry, ...h].slice(0, HISTORY_LIMIT));
      }
      onLog?.(`코드 규칙 저장 성공: [${scope}] ${changed.join(', ') || '(변경 없음)'}`);
    } catch (err) {
      // 롤백: baseline 으로 form 복원.
      baselineRef.current = prevBaseline;
      setForm(prevBaseline);
      setSaveStatus('error');
      setPageError((err as Error).message);
      onLog?.(`코드 규칙 저장 실패 — 롤백 적용: ${(err as Error).message}`);
    }
  };

  const onReset = async () => {
    if (!confirm(`${scope === 'local' ? '로컬' : '전역'} 규칙을 기본값으로 초기화할까요?`)) return;
    try {
      await api.clear(scope, projectId);
      const next = defaultFormState();
      setForm(next);
      baselineRef.current = next;
      if (scope === 'local') setLocalRecord(null); else setGlobalRecord(null);
      setSaveStatus('idle');
      onLog?.(`코드 규칙 초기화: [${scope}]`);
    } catch (err) {
      setSaveStatus('error');
      onLog?.(`코드 규칙 초기화 실패: ${(err as Error).message}`);
    }
  };

  const onExport = async () => {
    const rec = activeRecord ?? formToPreviewRecord(form, scope, projectId);
    const envelope = {
      exportedAt: new Date().toISOString(),
      schemaVersion: 1,
      scope,
      rules: JSON.parse(serializeCodeRulesForFile(rec)),
    };
    const text = JSON.stringify(envelope, null, 2);
    try {
      await navigator.clipboard?.writeText(text);
      onLog?.(`코드 규칙 JSON 클립보드 복사 완료 — ${filePath} 에 저장 가능`);
    } catch {
      setImportText(text);
      setImportOpen(true);
      onLog?.('클립보드 접근 실패 — 아래 패널에서 수동 복사');
    }
  };

  const onImportApply = () => {
    // envelope 래퍼를 허용해 내보낸 JSON 과 raw 둘 다 받는다.
    let bodyText = importText;
    try {
      const maybe = JSON.parse(importText);
      if (maybe && typeof maybe === 'object' && !Array.isArray(maybe) && 'rules' in maybe) {
        bodyText = JSON.stringify((maybe as Record<string, unknown>).rules, null, 2);
      }
    } catch {
      /* fallthrough — parseCodeRulesFromFile 가 한 번 더 검증 */
    }
    const parsed = parseCodeRulesFromFile(bodyText, {
      scope,
      projectId: scope === 'local' ? projectId : undefined,
    });
    if (parsed.errors.length > 0) {
      setErrors(parsed.errors);
      return;
    }
    const r = parsed.record;
    setForm({
      indentStyle: r.indentation?.style ?? DEFAULT_CODE_RULES.indentation.style,
      indentSize: r.indentation?.size ?? DEFAULT_CODE_RULES.indentation.size,
      quotes: r.quotes ?? DEFAULT_CODE_RULES.quotes,
      semicolons: r.semicolons ?? DEFAULT_CODE_RULES.semicolons,
      filenameConvention: r.filenameConvention ?? DEFAULT_CODE_RULES.filenameConvention,
      linterPreset: r.linterPreset ?? DEFAULT_CODE_RULES.linterPreset,
      forbiddenPatterns: r.forbiddenPatterns ?? [],
      extraInstructions: r.extraInstructions ?? '',
    });
    setErrors([]);
    setImportOpen(false);
    setSaveStatus('dirty');
    onLog?.('코드 규칙 JSON 을 폼에 반영 — 저장 버튼을 눌러야 영속화됩니다.');
  };

  // ─────────────────────────────────────────────────────────────────────────
  // 렌더
  // ─────────────────────────────────────────────────────────────────────────

  if (pageStatus === 'loading') {
    return (
      <section aria-labelledby="code-rules-title" data-testid="code-rules-settings-loading" className="space-y-3">
        <h2 id="code-rules-title" className="text-lg font-bold text-[var(--pixel-accent)] uppercase tracking-wider flex items-center gap-2">
          <Rocket size={16} aria-hidden /> 코드 컨벤션 / 룰
        </h2>
        <div role="status" aria-live="polite" className="text-[11px] text-white/60">
          규칙 스키마를 불러오는 중…
        </div>
        <div className="space-y-2" aria-hidden>
          <div className="h-6 bg-white/5 animate-pulse" />
          <div className="h-6 bg-white/5 animate-pulse w-2/3" />
          <div className="h-6 bg-white/5 animate-pulse w-1/2" />
        </div>
      </section>
    );
  }

  if (pageStatus === 'error') {
    return (
      <section aria-labelledby="code-rules-title" data-testid="code-rules-settings-error" className="space-y-3">
        <h2 id="code-rules-title" className="text-lg font-bold text-[var(--pixel-accent)] uppercase tracking-wider flex items-center gap-2">
          <Rocket size={16} aria-hidden /> 코드 컨벤션 / 룰
        </h2>
        <div role="alert" className="border-2 border-red-500/70 bg-red-900/30 text-red-200 p-3 text-[11px]">
          <div className="flex items-center gap-2 mb-1 font-bold uppercase"><AlertTriangle size={14} /> 규칙을 불러오지 못했어요</div>
          <div>{pageError ?? '알 수 없는 오류'}</div>
          <button
            onClick={() => reloadAll()}
            className={`mt-2 px-3 py-1.5 bg-red-900/40 border-2 border-red-900/60 text-[11px] uppercase text-red-100 flex items-center gap-1 ${focusRing}`}
          >
            <RefreshCw size={12} /> 재시도
          </button>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="code-rules-title" data-testid="code-rules-settings" className="space-y-4">
      {/* 헤더 */}
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 id="code-rules-title" className="text-lg font-bold text-[var(--pixel-accent)] uppercase tracking-wider flex items-center gap-2">
            <Rocket size={16} aria-hidden /> 코드 컨벤션 / 룰
          </h2>
          <SaveStatusBadge status={saveStatus} at={activeRecord?.updatedAt ?? null} />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onExport}
            aria-label="JSON 내보내기"
            className={`px-3 py-1.5 bg-black/40 border-2 border-[var(--pixel-border)] text-[11px] uppercase text-white flex items-center gap-1 hover:bg-black/60 ${focusRing}`}
          >
            <ClipboardCopy size={12} /> JSON 내보내기
          </button>
          <button
            onClick={() => setImportOpen((v) => !v)}
            aria-label="JSON 가져오기 토글"
            aria-expanded={importOpen}
            className={`px-3 py-1.5 bg-black/40 border-2 border-[var(--pixel-border)] text-[11px] uppercase text-white flex items-center gap-1 hover:bg-black/60 ${focusRing}`}
          >
            <FileDown size={12} /> JSON 가져오기
          </button>
        </div>
      </header>

      {/* ① 범위 탭 + 상속 배지 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div role="tablist" aria-label="규칙 범위 선택" className="flex items-center gap-1 bg-black/30 border-2 border-[var(--pixel-border)] p-1">
          <button
            role="tab"
            id="rules-scope-tab-local"
            aria-selected={scope === 'local'}
            aria-controls="rules-scope-panel-local"
            onClick={() => setScope('local')}
            className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider flex items-center gap-1 transition ${scope === 'local' ? 'bg-[var(--pixel-accent)] text-black' : 'text-white/70 hover:text-white'} ${focusRing}`}
          >
            <FolderGit2 size={12} aria-hidden /> 로컬(이 프로젝트)
          </button>
          <button
            role="tab"
            id="rules-scope-tab-global"
            aria-selected={scope === 'global'}
            aria-controls="rules-scope-panel-global"
            onClick={() => setScope('global')}
            className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider flex items-center gap-1 transition ${scope === 'global' ? 'bg-[var(--pixel-accent)] text-black' : 'text-white/70 hover:text-white'} ${focusRing}`}
          >
            <Globe2 size={12} aria-hidden /> 전역(기본값)
          </button>
        </div>
        {scope === 'local' && (
          <InheritanceBadge
            inherited={inheritedFromGlobal}
            conflictCount={conflicts.length}
          />
        )}
      </div>

      <p className="text-[10px] text-white/50">
        설정 파일 경로: <code className="text-white/80">{filePath}</code>
      </p>

      {/* 충돌 배너 */}
      {conflicts.length > 0 && (
        <ConflictBanner conflicts={conflicts} scope={scope} />
      )}

      {/* 빈 상태: 전역 탭 첫 진입 */}
      {scope === 'global' && !globalRecord && (
        <EmptyGlobalState
          hasLocal={!!localRecord}
          onStartFromLocal={() => {
            if (!localRecord) return;
            setForm(recordToForm(localRecord));
            setSaveStatus('dirty');
          }}
        />
      )}

      {/* ② 폼 그룹 */}
      <div
        role="tabpanel"
        id={`rules-scope-panel-${scope}`}
        aria-labelledby={`rules-scope-tab-${scope}`}
        className="space-y-4"
      >
        <FormGroup title="1. 들여쓰기" inherited={inheritedFromGlobal}>
          <div className="flex items-center gap-2">
            <label className="w-24 text-[10px] uppercase text-white/70">스타일</label>
            <select
              value={form.indentStyle}
              onChange={(e) => updateForm('indentStyle', e.target.value as IndentStyle)}
              aria-label="들여쓰기 스타일"
              className={`bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white ${focusRing}`}
            >
              <option value="space">space</option>
              <option value="tab">tab</option>
            </select>
            <label className="w-14 text-[10px] uppercase text-white/70 ml-4">크기</label>
            <input
              type="number"
              min={1}
              max={8}
              value={form.indentSize}
              onChange={(e) => updateForm('indentSize', Number(e.target.value) || 1)}
              aria-label="들여쓰기 크기"
              className={`w-20 bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white ${focusRing}`}
            />
            <span className="text-[10px] text-white/50">(1~8)</span>
          </div>
        </FormGroup>

        <FormGroup title="2. 따옴표" inherited={inheritedFromGlobal}>
          <div className="flex items-center gap-2">
            <label className="w-24 text-[10px] uppercase text-white/70">스타일</label>
            <select
              value={form.quotes}
              onChange={(e) => updateForm('quotes', e.target.value as QuoteStyle)}
              aria-label="따옴표 스타일"
              className={`bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white ${focusRing}`}
            >
              <option value="single">single (&apos;)</option>
              <option value="double">double (&quot;)</option>
              <option value="backtick">backtick (`)</option>
            </select>
          </div>
        </FormGroup>

        <FormGroup title="3. 세미콜론" inherited={inheritedFromGlobal}>
          <div className="flex items-center gap-2">
            <label className="w-24 text-[10px] uppercase text-white/70">정책</label>
            <select
              value={form.semicolons}
              onChange={(e) => updateForm('semicolons', e.target.value as SemicolonPolicy)}
              aria-label="세미콜론 정책"
              className={`bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white ${focusRing}`}
            >
              <option value="required">required (문장 끝 필수)</option>
              <option value="omit">omit (생략)</option>
            </select>
          </div>
        </FormGroup>

        <FormGroup title="4. 파일명 규칙" inherited={inheritedFromGlobal}>
          <div className="flex items-center gap-2">
            <label className="w-24 text-[10px] uppercase text-white/70">컨벤션</label>
            <select
              value={form.filenameConvention}
              onChange={(e) => updateForm('filenameConvention', e.target.value as FilenameConvention)}
              aria-label="파일명 규칙"
              className={`bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white ${focusRing}`}
            >
              {FILENAME_CONVENTIONS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </FormGroup>

        <FormGroup title="5. 금지 패턴 (정규식)" inherited={inheritedFromGlobal}>
          <div className="space-y-2">
            {form.forbiddenPatterns.length === 0 && (
              <p className="text-[11px] text-white/50 italic">등록된 금지 패턴이 없습니다.</p>
            )}
            {form.forbiddenPatterns.map((p, i) => (
              <div key={i} className="grid grid-cols-1 md:grid-cols-[1fr_1.5fr_1.5fr_auto] gap-2 items-start">
                <input
                  value={p.name}
                  onChange={(e) => updatePattern(i, 'name', e.target.value)}
                  aria-label={`금지 패턴 ${i + 1} 이름`}
                  placeholder="이름"
                  className={`bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white ${focusRing}`}
                />
                <input
                  value={p.pattern}
                  onChange={(e) => updatePattern(i, 'pattern', e.target.value)}
                  aria-label={`금지 패턴 ${i + 1} 정규식`}
                  placeholder="regex (예: console\\.log)"
                  className={`bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white font-mono ${focusRing}`}
                />
                <input
                  value={p.message ?? ''}
                  onChange={(e) => updatePattern(i, 'message', e.target.value)}
                  aria-label={`금지 패턴 ${i + 1} 위반 메시지`}
                  placeholder="위반 메시지 (선택)"
                  className={`bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white ${focusRing}`}
                />
                <button
                  onClick={() => removePattern(i)}
                  aria-label={`금지 패턴 ${i + 1} 삭제`}
                  className={`p-1.5 bg-red-900/20 border-2 border-red-900/60 hover:bg-red-900 text-red-300 hover:text-white transition-colors ${focusRing}`}
                  title="삭제"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button
              onClick={addPattern}
              aria-label="금지 패턴 추가"
              className={`px-3 py-1.5 bg-black/40 border-2 border-[var(--pixel-border)] text-[11px] uppercase text-white hover:bg-black/60 flex items-center gap-1 ${focusRing}`}
            >
              <Plus size={12} /> 패턴 추가
            </button>
          </div>
        </FormGroup>

        <FormGroup title="6. 언어별 린터 프리셋" inherited={inheritedFromGlobal}>
          <div className="flex items-center gap-2">
            <label className="w-24 text-[10px] uppercase text-white/70">프리셋</label>
            <select
              value={form.linterPreset}
              onChange={(e) => updateForm('linterPreset', e.target.value as LinterPreset)}
              aria-label="린터 프리셋"
              className={`bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white ${focusRing}`}
            >
              {LINTER_PRESETS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
        </FormGroup>

        <FormGroup title="추가 지시 (자유 양식, 한국어 권장)" inherited={inheritedFromGlobal}>
          <textarea
            value={form.extraInstructions}
            onChange={(e) => updateForm('extraInstructions', e.target.value)}
            aria-label="추가 지시"
            placeholder="예: 타입 단언(as) 사용 금지. 테스트는 반드시 integration 경로로 작성."
            rows={4}
            className={`w-full bg-black/30 border-2 border-[var(--pixel-border)] px-3 py-2 text-[12px] text-white font-mono ${focusRing}`}
          />
        </FormGroup>
      </div>

      {/* 검증 오류 */}
      {errors.length > 0 && (
        <ul role="alert" aria-live="polite" className="border-2 border-red-500/70 bg-red-900/30 text-red-200 p-3 text-[11px] space-y-1">
          {errors.map((e, i) => (
            <li key={i}>· [{e.field}] {e.message}</li>
          ))}
        </ul>
      )}

      {/* 액션 */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onSave}
          disabled={saveStatus === 'saving'}
          aria-label="코드 규칙 저장"
          className={`px-3 py-2 bg-[var(--pixel-accent)] text-black text-[11px] font-bold uppercase border-b-2 border-[#0099cc] flex items-center gap-2 hover:brightness-110 active:translate-y-px transition disabled:opacity-40 ${focusRing}`}
        >
          <Save size={14} /> {saveStatus === 'saving' ? '저장 중…' : '저장'}
        </button>
        <button
          onClick={onReset}
          aria-label="기본값으로 초기화"
          className={`px-3 py-2 bg-red-900/20 border-2 border-red-900/60 text-[11px] uppercase text-red-200 flex items-center gap-2 hover:bg-red-900/40 ${focusRing}`}
        >
          <RefreshCw size={14} /> 초기화
        </button>
      </div>

      {/* JSON 가져오기 */}
      {importOpen && (
        <div className="border-2 border-[var(--pixel-border)] p-3 bg-black/20" role="dialog" aria-label="JSON 가져오기">
          <label className="block text-[10px] uppercase tracking-wider text-white/70 mb-1">
            {filePath} 의 JSON 본문을 붙여 넣으세요. 내보낸 envelope(`{'{exportedAt,schemaVersion,scope,rules}'}`) 도 지원합니다.
          </label>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={8}
            aria-label="코드 규칙 JSON 입력"
            className={`w-full bg-black/40 border-2 border-[var(--pixel-border)] px-3 py-2 text-[11px] text-white font-mono ${focusRing}`}
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={onImportApply}
              aria-label="JSON 폼에 반영"
              className={`px-3 py-1.5 bg-[var(--pixel-accent)] text-black text-[11px] font-bold uppercase border-b-2 border-[#0099cc] ${focusRing}`}
            >
              폼에 적용(미리보기)
            </button>
            <button
              onClick={() => { setImportText(''); setImportOpen(false); }}
              aria-label="불러오기 취소"
              className={`px-3 py-1.5 bg-black/40 border-2 border-[var(--pixel-border)] text-[11px] uppercase text-white ${focusRing}`}
            >
              취소
            </button>
          </div>
        </div>
      )}

      {/* ③ 에이전트 프롬프트 주입 상태 */}
      <InjectionPanel
        preview={injectionPreview}
        open={injectionOpen}
        onToggle={() => setInjectionOpen((v) => !v)}
        scope={scope}
      />

      {/* ④ 변경 이력 */}
      <HistoryPanel
        history={history}
        open={historyOpen}
        onToggle={() => setHistoryOpen((v) => !v)}
      />
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 보조 컴포넌트
// ────────────────────────────────────────────────────────────────────────────

function SaveStatusBadge({ status, at }: { status: SaveStatus; at: number | null }) {
  const map: Record<SaveStatus, { label: string; color: string; icon: React.ReactNode; role: 'status' | 'alert' }> = {
    idle:   { label: at ? `저장됨 · ${new Date(at).toLocaleTimeString()}` : '대기', color: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/60', icon: <Check size={12} />, role: 'status' },
    saving: { label: '저장 중…',                                               color: 'bg-blue-500/20 text-blue-200 border-blue-500/60 animate-pulse',        icon: <RefreshCw size={12} />, role: 'status' },
    dirty:  { label: '저장되지 않음',                                           color: 'bg-amber-500/20 text-amber-200 border-amber-500/60',                  icon: <AlertTriangle size={12} />, role: 'status' },
    error:  { label: '저장 실패',                                               color: 'bg-red-500/20 text-red-200 border-red-500/60',                        icon: <AlertTriangle size={12} />, role: 'alert' },
  };
  const { label, color, icon, role } = map[status];
  return (
    <span
      role={role}
      aria-live="polite"
      data-testid="code-rules-save-status"
      className={`inline-flex items-center gap-1 px-2 py-1 border-2 text-[10px] uppercase tracking-wider ${color}`}
    >
      {icon} {label}
    </span>
  );
}

function InheritanceBadge({ inherited, conflictCount }: { inherited: boolean; conflictCount: number }) {
  if (inherited) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 border-2 border-white/30 text-[10px] uppercase text-white/70">
        <Lock size={12} /> 전역 상속 중 — 편집 시 로컬 승격
      </span>
    );
  }
  if (conflictCount === 0) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 border-2 border-emerald-500/50 text-[10px] uppercase text-emerald-200">
        <Check size={12} /> 로컬 단독
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 border-2 border-amber-500/60 text-[10px] uppercase text-amber-200">
      <AlertTriangle size={12} /> 전역과 {conflictCount}개 충돌
    </span>
  );
}

function ConflictBanner({ conflicts, scope }: { conflicts: Conflict[]; scope: CodeRulesScope }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      role="status"
      aria-live="polite"
      className="border-2 border-amber-500/60 bg-amber-500/10 text-amber-100 p-3 text-[11px]"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-bold">
          <AlertTriangle size={14} />
          로컬과 전역이 충돌합니다 — {conflicts.map((c) => c.label).join(' · ')} ({conflicts.length} 필드).
          <span className="text-amber-200/80 font-normal">
            {scope === 'local' ? '이 탭에서는 로컬 값이 프롬프트에 주입됩니다.' : '이 탭에서는 전역 값이 프롬프트에 주입됩니다.'}
          </span>
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={`px-2 py-1 bg-amber-500/20 border-2 border-amber-500/60 text-[10px] uppercase ${focusRing}`}
        >
          {open ? '닫기' : '충돌 보기'}
        </button>
      </div>
      {open && (
        <table className="w-full mt-2 text-[11px] border-collapse">
          <thead>
            <tr className="text-amber-300">
              <th className="text-left py-1 border-b border-amber-500/30">필드</th>
              <th className="text-left py-1 border-b border-amber-500/30">전역</th>
              <th className="text-left py-1 border-b border-amber-500/30">로컬</th>
              <th className="text-left py-1 border-b border-amber-500/30">적용될 값</th>
            </tr>
          </thead>
          <tbody>
            {conflicts.map((c) => (
              <tr key={c.field} className="border-b border-amber-500/20">
                <td className="py-1 pr-2">{c.label}</td>
                <td className="py-1 pr-2 text-white/70">{c.global}</td>
                <td className="py-1 pr-2">{c.local}</td>
                <td className="py-1 pr-2 text-emerald-200 border-l-4 border-emerald-500/70 pl-2">
                  {scope === 'local' ? c.local : c.global}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EmptyGlobalState({ hasLocal, onStartFromLocal }: { hasLocal: boolean; onStartFromLocal: () => void }) {
  return (
    <div className="border-2 border-[var(--pixel-border)] bg-black/20 p-6 text-center">
      <Rocket size={24} className="mx-auto text-[var(--pixel-accent)] mb-2" aria-hidden />
      <h3 className="text-sm font-bold uppercase text-white/80 mb-1">아직 전역 규칙이 없어요</h3>
      <p className="text-[11px] text-white/60 mb-3">
        이 프로젝트에서 만든 규칙을 전역으로 올리거나 기본값에서 시작해 보세요.
      </p>
      <div className="flex items-center justify-center gap-2">
        {hasLocal && (
          <button
            onClick={onStartFromLocal}
            className={`px-3 py-1.5 bg-[var(--pixel-accent)] text-black text-[11px] font-bold uppercase border-b-2 border-[#0099cc] ${focusRing}`}
          >
            로컬 값으로 채우기
          </button>
        )}
        <span className="text-[10px] text-white/40">또는 아래 폼에서 직접 편집 후 저장</span>
      </div>
    </div>
  );
}

function FormGroup({ title, inherited, children }: { title: string; inherited: boolean; children: React.ReactNode }) {
  return (
    <fieldset className="border-2 border-[var(--pixel-border)] p-3 bg-black/20">
      <legend className="text-[10px] uppercase tracking-wider text-white/70 px-2 flex items-center gap-2">
        {title}
        {inherited && (
          <span className="inline-flex items-center gap-1 text-white/50 border border-white/20 px-1">
            <Lock size={10} /> 전역 상속
          </span>
        )}
      </legend>
      {children}
    </fieldset>
  );
}

function InjectionPanel({ preview, open, onToggle, scope }: {
  preview: { text: string; tokens: number; lineCount: number };
  open: boolean;
  onToggle: () => void;
  scope: CodeRulesScope;
}) {
  return (
    <section
      aria-label="에이전트 프롬프트 주입 상태"
      className="border-2 border-cyan-500/40 bg-cyan-500/5 p-3"
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-[11px] text-cyan-100">
          <Bot size={14} aria-hidden />
          <span className="font-bold uppercase">주입 미리보기</span>
          <span className="text-white/60">
            범위 [{scope}] · 약 {preview.tokens} 토큰 · {preview.lineCount} 라인
          </span>
        </div>
        <button
          onClick={onToggle}
          aria-expanded={open}
          className={`px-2 py-1 bg-black/40 border-2 border-cyan-500/40 text-[10px] uppercase text-cyan-100 ${focusRing}`}
        >
          {open ? '닫기' : '프롬프트 본문 보기'}
        </button>
      </div>
      {open && (
        <pre className="mt-2 text-[10px] text-white/80 whitespace-pre-wrap break-words font-mono max-h-64 overflow-auto bg-black/40 p-2 border border-cyan-500/20">
{preview.text || '(현재 규칙이 기본값과 동일해 프롬프트 블록이 삽입되지 않습니다.)'}
        </pre>
      )}
    </section>
  );
}

function HistoryPanel({ history, open, onToggle }: {
  history: HistoryEntry[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <section aria-label="변경 이력" className="border-2 border-[var(--pixel-border)] bg-black/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] text-white/80">
          <History size={14} aria-hidden />
          <span className="font-bold uppercase">변경 이력 (최근 {HISTORY_LIMIT}건)</span>
          <span className="text-white/50">{history.length}건 기록됨</span>
        </div>
        <button
          onClick={onToggle}
          aria-expanded={open}
          className={`px-2 py-1 bg-black/40 border-2 border-[var(--pixel-border)] text-[10px] uppercase text-white ${focusRing}`}
        >
          {open ? '닫기' : '펼치기'}
        </button>
      </div>
      {open && (
        <ul className="mt-2 space-y-1 text-[11px]">
          {history.length === 0 && (
            <li className="text-white/50 italic">아직 변경 이력이 없습니다.</li>
          )}
          {history.map((e, i) => (
            <li key={`${e.at}-${i}`} className="flex items-center gap-2 border-b border-white/10 pb-1">
              <span className="text-white/50 font-mono">{new Date(e.at).toLocaleString()}</span>
              <span className="text-white/80">{e.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
