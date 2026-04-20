// 지시 #d7caa7af · 프로젝트 관리 "코드 컨벤션·규칙 설정" 패널.
//
// 범위 탭(로컬·전역) 을 분리하고, 각 탭은 들여쓰기·따옴표·세미콜론·파일명 규칙·
// 커스텀 규칙 자유 기술 필드를 가진다. 저장은 codeConventionStore 가 책임지며,
// 로컬 스코프가 빈 경우 전역 값이 자동 폴백되어 UI 에 보인다.

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  DEFAULT_CODE_CONVENTION,
  FILENAME_CONVENTIONS,
  INDENTATION_SIZE_MAX,
  INDENTATION_SIZE_MIN,
  INDENTATION_STYLES,
  QUOTE_STYLES,
  SEMICOLON_POLICIES,
  type CodeConvention,
  type CodeConventionScope,
  type FilenameConvention,
  type IndentationStyle,
  type QuoteStyle,
  type SemicolonPolicy,
} from '../../types/codeConvention';
import {
  createCodeConventionStore,
  type CodeConventionStore,
} from '../../services/settings/codeConventionStore';

export interface CodeConventionPanelProps {
  /** 로컬 스코프 편집 대상 프로젝트 id. 빈 값이면 로컬 탭이 비활성화된다. */
  projectId?: string;
  /** 테스트 주입용. 미지정 시 내부에서 기본 스토어를 만들어 쓴다. */
  store?: CodeConventionStore;
  onLog?: (message: string) => void;
}

type TabKey = CodeConventionScope;

const TAB_LABEL: Record<TabKey, string> = {
  local: '로컬(프로젝트)',
  global: '전역(사용자)',
};

const FILENAME_LABEL: Record<FilenameConvention, string> = {
  camelCase: 'camelCase',
  'kebab-case': 'kebab-case',
  PascalCase: 'PascalCase',
};

function radioRowClass(selected: boolean): string {
  return `inline-flex items-center gap-1 px-2 py-1 border text-[11px] uppercase tracking-wider ${
    selected ? 'bg-[var(--pixel-accent)] text-black border-[var(--pixel-accent)]' : 'text-white/70 border-white/20 hover:text-white'
  }`;
}

export function CodeConventionPanel(props: CodeConventionPanelProps): React.ReactElement {
  const { projectId, store: injectedStore, onLog } = props;
  const store = useMemo<CodeConventionStore>(() => injectedStore ?? createCodeConventionStore(), [injectedStore]);
  const localAvailable = typeof projectId === 'string' && projectId.length > 0;
  const [tab, setTab] = useState<TabKey>(localAvailable ? 'local' : 'global');

  // 각 탭의 폼 상태는 탭 단위로 분리해 탭 전환 시 편집 중 값이 섞이지 않게 한다.
  const [globalForm, setGlobalForm] = useState<CodeConvention>(DEFAULT_CODE_CONVENTION);
  const [localForm, setLocalForm] = useState<CodeConvention>(DEFAULT_CODE_CONVENTION);
  const [fallbackActive, setFallbackActive] = useState<boolean>(false);
  const [saveMessage, setSaveMessage] = useState<string>('');

  const reload = useCallback(() => {
    const globalRecord = store.loadGlobal();
    setGlobalForm(globalRecord?.convention ?? DEFAULT_CODE_CONVENTION);
    if (localAvailable) {
      const localRecord = store.loadLocal(projectId!);
      if (localRecord) {
        setLocalForm(localRecord.convention);
        setFallbackActive(false);
      } else {
        // 로컬이 없으면 전역(없으면 기본) 이 효과값. 편집 시작점으로 이를 채워 둔다.
        setLocalForm(globalRecord?.convention ?? DEFAULT_CODE_CONVENTION);
        setFallbackActive(true);
      }
    }
  }, [store, projectId, localAvailable]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!localAvailable && tab === 'local') setTab('global');
  }, [localAvailable, tab]);

  const current = tab === 'global' ? globalForm : localForm;
  const setCurrent = tab === 'global' ? setGlobalForm : setLocalForm;

  function updateField<K extends keyof CodeConvention>(key: K, value: CodeConvention[K]): void {
    setCurrent((prev) => ({ ...prev, [key]: value }));
    setSaveMessage('');
  }

  function updateIndentation(partial: Partial<CodeConvention['indentation']>): void {
    setCurrent((prev) => ({ ...prev, indentation: { ...prev.indentation, ...partial } }));
    setSaveMessage('');
  }

  function handleSave(): void {
    if (tab === 'global') {
      const saved = store.saveGlobal(globalForm);
      setGlobalForm(saved.convention);
      setSaveMessage('전역 코드 컨벤션을 저장했습니다.');
      onLog?.('코드 컨벤션: 전역 저장');
    } else {
      if (!localAvailable) return;
      const saved = store.saveLocal(projectId!, localForm);
      setLocalForm(saved.convention);
      setFallbackActive(false);
      setSaveMessage('로컬 코드 컨벤션을 저장했습니다.');
      onLog?.(`코드 컨벤션: 로컬 저장(${projectId})`);
    }
  }

  function handleClear(): void {
    if (tab === 'global') {
      store.clearGlobal();
      onLog?.('코드 컨벤션: 전역 초기화');
    } else if (localAvailable) {
      store.clearLocal(projectId!);
      onLog?.(`코드 컨벤션: 로컬 초기화(${projectId})`);
    }
    setSaveMessage('초기화 후 전역/기본 값으로 되돌렸습니다.');
    reload();
  }

  return (
    <section aria-label="코드 컨벤션·규칙 설정" data-testid="code-convention-panel" className="space-y-3">
      <div role="tablist" aria-label="코드 컨벤션 범위" className="flex items-center gap-1 bg-black/30 border-2 border-[var(--pixel-border)] p-1 w-fit">
        {(['local', 'global'] as const).map((key) => {
          const disabled = key === 'local' && !localAvailable;
          const selected = tab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={selected}
              disabled={disabled}
              onClick={() => !disabled && setTab(key)}
              className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition ${
                selected ? 'bg-[var(--pixel-accent)] text-black' : 'text-white/70 hover:text-white'
              } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
              data-testid={`code-convention-tab-${key}`}
            >
              {TAB_LABEL[key]}
            </button>
          );
        })}
      </div>

      {tab === 'local' && fallbackActive && (
        <p
          role="status"
          className="text-[11px] text-white/70 border border-dashed border-white/30 p-2"
          data-testid="code-convention-fallback-notice"
        >
          로컬 설정이 비어 있어 전역(또는 기본) 값이 표시됩니다. 저장하면 이 프로젝트 전용 값으로 고정됩니다.
        </p>
      )}

      <fieldset className="space-y-3 border-2 border-[var(--pixel-border)] p-3">
        <legend className="text-[11px] font-bold uppercase tracking-wider px-1">기본 규칙</legend>

        <div className="space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider">들여쓰기</span>
          <div className="flex flex-wrap items-center gap-2">
            {INDENTATION_STYLES.map((style) => (
              <button
                key={style}
                type="button"
                onClick={() => updateIndentation({ style })}
                className={radioRowClass(current.indentation.style === style)}
                aria-pressed={current.indentation.style === style}
                data-testid={`code-convention-indent-style-${style}`}
              >
                {style === 'space' ? '스페이스' : '탭'}
              </button>
            ))}
            <label className="inline-flex items-center gap-1 text-[11px]">
              <span className="uppercase tracking-wider">크기</span>
              <input
                type="number"
                min={INDENTATION_SIZE_MIN}
                max={INDENTATION_SIZE_MAX}
                value={current.indentation.size}
                onChange={(e) => updateIndentation({ size: Number(e.target.value) })}
                className="w-16 bg-black/50 border border-white/30 px-1 py-0.5 text-right"
                data-testid="code-convention-indent-size"
                aria-label="들여쓰기 크기"
              />
            </label>
          </div>
        </div>

        <div className="space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider">따옴표</span>
          <div className="flex flex-wrap items-center gap-2">
            {QUOTE_STYLES.map((style) => (
              <button
                key={style}
                type="button"
                onClick={() => updateField('quotes', style as QuoteStyle)}
                className={radioRowClass(current.quotes === style)}
                aria-pressed={current.quotes === style}
                data-testid={`code-convention-quotes-${style}`}
              >
                {style === 'single' ? "'single'" : '"double"'}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider">세미콜론</span>
          <div className="flex flex-wrap items-center gap-2">
            {SEMICOLON_POLICIES.map((policy) => (
              <button
                key={policy}
                type="button"
                onClick={() => updateField('semicolons', policy as SemicolonPolicy)}
                className={radioRowClass(current.semicolons === policy)}
                aria-pressed={current.semicolons === policy}
                data-testid={`code-convention-semicolons-${policy}`}
              >
                {policy === 'required' ? '필수' : '생략'}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider">파일명 규칙</span>
          <div className="flex flex-wrap items-center gap-2">
            {FILENAME_CONVENTIONS.map((convention) => (
              <button
                key={convention}
                type="button"
                onClick={() => updateField('filenameConvention', convention as FilenameConvention)}
                className={radioRowClass(current.filenameConvention === convention)}
                aria-pressed={current.filenameConvention === convention}
                data-testid={`code-convention-filename-${convention}`}
              >
                {FILENAME_LABEL[convention]}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <label htmlFor="code-convention-custom" className="text-[11px] font-bold uppercase tracking-wider">
            커스텀 규칙(자유 기술)
          </label>
          <textarea
            id="code-convention-custom"
            value={current.customRules}
            onChange={(e) => updateField('customRules', e.target.value)}
            className="w-full min-h-[120px] bg-black/50 border border-white/30 p-2 text-[12px] leading-relaxed"
            placeholder="예) 모든 API 응답은 Result<T> 로 감싼다. export default 는 금지."
            data-testid="code-convention-custom-rules"
          />
        </div>
      </fieldset>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider bg-[var(--pixel-accent)] text-black"
          data-testid="code-convention-save"
          disabled={tab === 'local' && !localAvailable}
        >
          저장
        </button>
        <button
          type="button"
          onClick={handleClear}
          className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider border border-white/40 text-white/80 hover:text-white"
          data-testid="code-convention-clear"
          disabled={tab === 'local' && !localAvailable}
        >
          초기화
        </button>
        {saveMessage && (
          <span role="status" className="text-[11px] text-white/80" data-testid="code-convention-status">
            {saveMessage}
          </span>
        )}
      </div>
    </section>
  );
}

export default CodeConventionPanel;
