// 지시 #87cbd107 — 프로젝트 관리 메뉴의 "코드 컨벤션/룰 설정" 패널.
//
// 화면 개요
//   · 상단 scope 토글: local(이 프로젝트) / global(모든 프로젝트 공통)
//   · 들여쓰기 스타일·크기 · 따옴표 · 세미콜론 · 파일명 규칙 · 린터 프리셋
//   · 금지 패턴(regex) 목록: 이름 + pattern + 위반 메시지
//   · 추가 지시(자유 양식) textarea
//   · 저장 / 불러오기(JSON) / 내보내기(JSON) / 초기화
//
// 스토어는 싱글턴 편의 API 를 기본 경로로 쓰되, 테스트는 prop 으로 독립 인스턴스를
// 주입할 수 있도록 store 인터페이스를 열어 둔다.

import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Save, FileDown, FolderGit2, Globe2, RefreshCw, ClipboardCopy, Rocket } from 'lucide-react';
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
} from '../stores/codeRulesStore';

interface Props {
  projectId: string;
  /** 테스트 주입용. 미지정 시 싱글턴 편의 API 를 사용. */
  store?: CodeRulesStore;
  onLog?: (message: string) => void;
}

const focusRing = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pixel-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black';

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

export function ProjectCodeRulesPanel({ projectId, store, onLog }: Props) {
  const [scope, setScope] = useState<CodeRulesScope>('local');
  const [form, setForm] = useState<FormState>(defaultFormState);
  const [errors, setErrors] = useState<CodeRulesValidationError[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [importText, setImportText] = useState('');
  const [importOpen, setImportOpen] = useState(false);

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

  useEffect(() => {
    let cancelled = false;
    async function reload() {
      try {
        const rec = await api.load(scope, projectId);
        if (!cancelled) {
          setForm(recordToForm(rec));
          setSavedAt(rec?.updatedAt ?? null);
          setErrors([]);
        }
      } catch (err) {
        if (!cancelled) onLog?.(`규칙 불러오기 실패: ${(err as Error).message}`);
      }
    }
    reload();
    const subKey = scope === 'global' ? '' : projectId;
    const unsub = api.subscribe(subKey, () => { reload(); });
    return () => { cancelled = true; unsub(); };
  }, [projectId, scope, api, onLog]);

  const filePath = scope === 'local'
    ? `<프로젝트 루트>/${CODE_RULES_FILENAME}`
    : `<사용자 홈>/${CODE_RULES_FILENAME}`;

  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const addPattern = () => {
    setForm((prev) => ({
      ...prev,
      forbiddenPatterns: [...prev.forbiddenPatterns, { name: '', pattern: '', message: '' }],
    }));
  };

  const updatePattern = (index: number, key: keyof ForbiddenPattern, value: string) => {
    setForm((prev) => ({
      ...prev,
      forbiddenPatterns: prev.forbiddenPatterns.map((p, i) => i === index ? { ...p, [key]: value } : p),
    }));
  };

  const removePattern = (index: number) => {
    setForm((prev) => ({
      ...prev,
      forbiddenPatterns: prev.forbiddenPatterns.filter((_, i) => i !== index),
    }));
  };

  const onSave = async () => {
    const cleanedPatterns = form.forbiddenPatterns
      .map((p) => ({
        name: p.name.trim(),
        pattern: p.pattern,
        message: p.message?.trim() || undefined,
      }))
      .filter((p) => p.name || p.pattern);
    const input = {
      scope,
      projectId: scope === 'local' ? projectId : undefined,
      indentation: { style: form.indentStyle, size: form.indentSize },
      quotes: form.quotes,
      semicolons: form.semicolons,
      filenameConvention: form.filenameConvention,
      linterPreset: form.linterPreset,
      forbiddenPatterns: cleanedPatterns,
      extraInstructions: form.extraInstructions,
    };
    const found = validateCodeRulesInput(input);
    setErrors(found);
    if (found.length > 0) return;
    setSubmitting(true);
    try {
      const saved = await api.save(input);
      setSavedAt(saved.updatedAt);
      onLog?.(`코드 규칙 저장: [${scope}]${scope === 'local' ? ` projectId=${projectId}` : ''}`);
    } catch (err) {
      onLog?.(`코드 규칙 저장 실패: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const onReset = async () => {
    if (!confirm(`${scope === 'local' ? '로컬' : '전역'} 규칙을 기본값으로 초기화할까요?`)) return;
    try {
      await api.clear(scope, projectId);
      setForm(defaultFormState());
      setSavedAt(null);
      onLog?.(`코드 규칙 초기화: [${scope}]`);
    } catch (err) {
      onLog?.(`코드 규칙 초기화 실패: ${(err as Error).message}`);
    }
  };

  const onExport = async () => {
    const rec = await api.load(scope, projectId);
    const text = rec
      ? serializeCodeRulesForFile(rec)
      : serializeCodeRulesForFile({
        id: 'preview',
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
        extraInstructions: form.extraInstructions || undefined,
      });
    try {
      await navigator.clipboard?.writeText(text);
      onLog?.(`코드 규칙 JSON 을 클립보드로 복사 (${filePath} 에 저장하세요)`);
    } catch {
      onLog?.('클립보드 접근 실패 — 아래 import 패널을 열어 JSON 을 수동 복사하세요.');
      setImportText(text);
      setImportOpen(true);
    }
  };

  const onImportApply = () => {
    const parsed = parseCodeRulesFromFile(importText, {
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
    onLog?.(`코드 규칙 JSON 을 폼에 적용 (저장 버튼을 눌러야 스토어에 반영)`);
  };

  return (
    <section aria-labelledby="project-code-rules-heading" data-testid="project-code-rules-panel">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 id="project-code-rules-heading" className="text-lg font-bold text-[var(--pixel-accent)] uppercase tracking-wider flex items-center gap-2">
            <Rocket size={16} aria-hidden /> 코드 컨벤션 / 룰
          </h2>
          <span className="text-[10px] text-white/60 uppercase tracking-wider">
            {scope === 'local' ? '프로젝트 전용' : '모든 프로젝트 공통'}
          </span>
          {savedAt !== null && (
            <span className="text-[10px] text-white/50">
              저장됨: {new Date(savedAt).toLocaleString()}
            </span>
          )}
        </div>
        <div role="tablist" aria-label="코드 규칙 스코프 선택" className="flex items-center gap-1 bg-black/30 border-2 border-[var(--pixel-border)] p-1">
          <button
            role="tab"
            aria-selected={scope === 'local'}
            onClick={() => setScope('local')}
            className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider flex items-center gap-1 transition ${scope === 'local' ? 'bg-[var(--pixel-accent)] text-black' : 'text-white/70 hover:text-white'} ${focusRing}`}
          >
            <FolderGit2 size={12} aria-hidden /> 로컬
          </button>
          <button
            role="tab"
            aria-selected={scope === 'global'}
            onClick={() => setScope('global')}
            className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider flex items-center gap-1 transition ${scope === 'global' ? 'bg-[var(--pixel-accent)] text-black' : 'text-white/70 hover:text-white'} ${focusRing}`}
          >
            <Globe2 size={12} aria-hidden /> 전역
          </button>
        </div>
      </div>

      <p className="text-[10px] text-white/50 mb-4">
        설정 파일 경로: <code className="text-white/80">{filePath}</code>
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-white/70 mb-1">들여쓰기</label>
            <div className="flex items-center gap-2">
              <select
                value={form.indentStyle}
                onChange={(e) => updateForm('indentStyle', e.target.value as IndentStyle)}
                aria-label="들여쓰기 스타일"
                className={`bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white ${focusRing}`}
              >
                <option value="space">space</option>
                <option value="tab">tab</option>
              </select>
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
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-wider text-white/70 mb-1">따옴표</label>
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

          <div>
            <label className="block text-[10px] uppercase tracking-wider text-white/70 mb-1">세미콜론</label>
            <select
              value={form.semicolons}
              onChange={(e) => updateForm('semicolons', e.target.value as SemicolonPolicy)}
              aria-label="세미콜론 정책"
              className={`bg-black/30 border-2 border-[var(--pixel-border)] px-2 py-1.5 text-[12px] text-white ${focusRing}`}
            >
              <option value="required">required (문장 끝에 필수)</option>
              <option value="omit">omit (생략)</option>
            </select>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-white/70 mb-1">파일명 규칙</label>
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

          <div>
            <label className="block text-[10px] uppercase tracking-wider text-white/70 mb-1">린터 프리셋</label>
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
        </div>
      </div>

      <fieldset className="border-2 border-[var(--pixel-border)] p-3 mb-6 bg-black/20">
        <legend className="text-[10px] uppercase tracking-wider text-white/70 px-2">금지 패턴 (regex)</legend>
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
                aria-label={`금지 패턴 ${i + 1} regex`}
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
        </div>
        <div className="mt-3">
          <button
            onClick={addPattern}
            aria-label="금지 패턴 추가"
            className={`px-3 py-1.5 bg-black/40 border-2 border-[var(--pixel-border)] text-[11px] uppercase text-white hover:bg-black/60 flex items-center gap-1 ${focusRing}`}
          >
            <Plus size={12} /> 패턴 추가
          </button>
        </div>
      </fieldset>

      <div className="mb-6">
        <label className="block text-[10px] uppercase tracking-wider text-white/70 mb-1">추가 지시 (자유 양식, 한국어 권장)</label>
        <textarea
          value={form.extraInstructions}
          onChange={(e) => updateForm('extraInstructions', e.target.value)}
          aria-label="추가 지시"
          placeholder="예: 타입 단언(as) 사용 금지. 테스트는 반드시 integration 경로로 작성."
          rows={4}
          className={`w-full bg-black/30 border-2 border-[var(--pixel-border)] px-3 py-2 text-[12px] text-white font-mono ${focusRing}`}
        />
      </div>

      {errors.length > 0 && (
        <ul role="alert" aria-live="polite" className="border-2 border-red-500/70 bg-red-900/30 text-red-200 p-3 text-[11px] space-y-1 mb-4">
          {errors.map((e, i) => (
            <li key={i}>· [{e.field}] {e.message}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button
          onClick={onSave}
          disabled={submitting}
          aria-label="코드 규칙 저장"
          className={`px-3 py-2 bg-[var(--pixel-accent)] text-black text-[11px] font-bold uppercase border-b-2 border-[#0099cc] flex items-center gap-2 hover:brightness-110 active:translate-y-px transition disabled:opacity-40 ${focusRing}`}
        >
          <Save size={14} /> 저장
        </button>
        <button
          onClick={onExport}
          aria-label="JSON 내보내기"
          className={`px-3 py-2 bg-black/40 border-2 border-[var(--pixel-border)] text-[11px] uppercase text-white flex items-center gap-2 hover:bg-black/60 ${focusRing}`}
        >
          <ClipboardCopy size={14} /> JSON 내보내기
        </button>
        <button
          onClick={() => setImportOpen((v) => !v)}
          aria-label="JSON 불러오기 토글"
          aria-expanded={importOpen}
          className={`px-3 py-2 bg-black/40 border-2 border-[var(--pixel-border)] text-[11px] uppercase text-white flex items-center gap-2 hover:bg-black/60 ${focusRing}`}
        >
          <FileDown size={14} /> JSON 불러오기
        </button>
        <button
          onClick={onReset}
          aria-label="초기화"
          className={`px-3 py-2 bg-red-900/20 border-2 border-red-900/60 text-[11px] uppercase text-red-200 flex items-center gap-2 hover:bg-red-900/40 ${focusRing}`}
        >
          <RefreshCw size={14} /> 초기화
        </button>
      </div>

      {importOpen && (
        <div className="border-2 border-[var(--pixel-border)] p-3 bg-black/20 mb-4">
          <label className="block text-[10px] uppercase tracking-wider text-white/70 mb-1">
            {filePath} 의 JSON 본문을 붙여 넣으세요
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
              폼에 적용
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
    </section>
  );
}
