import React, { useState } from 'react';
import { Save, RotateCcw, AlertTriangle, Download } from 'lucide-react';
import type { ClaudeTokenUsageThresholds } from '../types';
import {
  parseThresholdInput,
  saveThresholdsToStorage,
  validateThresholds,
} from '../utils/claudeTokenUsageThresholds';
import { claudeTokenUsageStore, type UsageRange } from '../utils/claudeTokenUsageStore';
import { buildExportRows, toCsv, toJson, suggestFilename } from '../utils/claudeTokenUsageExport';

// ClaudeTokenUsage 상단바 위젯에서 '설정 아이콘' 클릭 또는 배지 우클릭 시 노출되는
// 임계값 입력 패널. tokens(=input+output 합)·usd(=estimatedCostUsd) 두 축을 별도
// 입력 필드로 받고, 저장하면 상위에 콜백으로 전달한다. 저장은 localStorage (키:
// `llmtycoon.tokenUsage.thresholds.v1`) 에 수행하며, 상위는 콜백으로 새 임계값을
// 받아 스토어 severity 계산에 즉시 반영할 수 있다.

interface Props {
  initial: ClaudeTokenUsageThresholds;
  onClose: () => void;
  onApply: (next: ClaudeTokenUsageThresholds) => void;
  onResetToday?: () => void;
}

export function TokenUsageSettingsPanel({ initial, onClose, onApply, onResetToday }: Props) {
  const [cautionTokens, setCautionTokens] = useState<string>(initial.caution.tokens?.toString() ?? '');
  const [cautionUsd, setCautionUsd] = useState<string>(initial.caution.usd?.toString() ?? '');
  const [warningTokens, setWarningTokens] = useState<string>(initial.warning.tokens?.toString() ?? '');
  const [warningUsd, setWarningUsd] = useState<string>(initial.warning.usd?.toString() ?? '');
  const [error, setError] = useState<string | null>(null);
  const [exportRange, setExportRange] = useState<UsageRange>('today');

  /** 현재 스토어 상태에서 선택 범위를 CSV 또는 JSON 으로 즉시 다운로드. */
  const handleExport = (format: 'csv' | 'json') => {
    if (typeof window === 'undefined') return;
    const state = claudeTokenUsageStore.getSnapshot();
    const rows = buildExportRows(state, exportRange);
    const nowIso = new Date().toISOString();
    const body = format === 'csv' ? toCsv(rows) : toJson(rows, { range: exportRange, exportedAt: nowIso });
    const blob = new Blob([body], {
      type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestFilename(exportRange, nowIso, format);
    document.body.appendChild(a);
    a.click();
    a.remove();
    // URL 해제는 브라우저 내부 다운로드가 참조를 유지하는 동안에도 안전하도록
    // 짧은 딜레이 뒤에 수행. setTimeout 0 이면 여전히 leak 이 생길 수 있음.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const next: ClaudeTokenUsageThresholds = {
      caution: parseThresholdInput({ tokens: cautionTokens, usd: cautionUsd }),
      warning: parseThresholdInput({ tokens: warningTokens, usd: warningUsd }),
    };
    const v = validateThresholds(next);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    // #3c0b0d6f: 저장 실패(쿼터 초과·사생활 보호 모드 등) 는 이전에는 조용히 삼켜져
    // "저장된 것처럼" 보였다. boolean 반환으로 검사해 실패 시 배너를 남기고 onApply/
    // onClose 를 지연시킨다. 사용자는 "저장되지 않았음" 을 명확히 인지해 다른 저장소
    // 또는 브라우저 설정으로 재시도할 수 있다.
    const saved = saveThresholdsToStorage(next);
    if (!saved) {
      setError('저장 실패 — 브라우저 저장 공간이 부족하거나 접근할 수 없습니다. 다시 시도하거나 다른 브라우저를 사용하세요.');
      return;
    }
    setError(null);
    onApply(next);
    onClose();
  };

  const handleClearAll = () => {
    setCautionTokens(''); setCautionUsd('');
    setWarningTokens(''); setWarningUsd('');
    setError(null);
  };

  return (
    <div
      role="dialog"
      aria-label="토큰 사용량 임계값 설정"
      data-testid="token-usage-settings-panel"
      className="absolute top-full right-0 mt-1 z-50 min-w-[300px] p-3 text-[11px] text-white/90"
      style={{
        background: 'var(--token-usage-tooltip-bg)',
        border: `2px solid var(--token-usage-tooltip-border)`,
        borderRadius: 'var(--token-usage-tooltip-radius)',
        boxShadow: 'var(--token-usage-tooltip-shadow)',
      }}
      onClick={e => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--token-usage-axis-input-fg)' }}>
          임계값 설정
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className="text-[11px] px-1"
          style={{
            color: 'var(--shared-goal-modal-cancel-fg)',
            background: 'transparent',
            border: 'none',
          }}
        >
          ×
        </button>
      </div>
      <p className="text-[10px] mb-2" style={{ color: 'var(--token-usage-tooltip-subtle-fg)' }}>
        누적 합계(입력+출력 토큰) 또는 대략 비용(USD) 중 하나라도 넘어서면 상단 배지가 해당 단계 색으로 전환됩니다.
        빈 값은 "미설정" 입니다.
      </p>

      <form onSubmit={handleSave} className="space-y-3" noValidate>
        <fieldset className="space-y-1" style={{ borderLeft: `3px solid var(--token-usage-caution-border)`, paddingLeft: 8 }}>
          <legend className="text-[10px] uppercase" style={{ color: 'var(--token-usage-caution-fg)' }}>
            주의(caution)
          </legend>
          <label className="flex items-center justify-between gap-2">
            <span>토큰 합계 ≥</span>
            <input
              type="number"
              min={1}
              inputMode="numeric"
              value={cautionTokens}
              onChange={e => setCautionTokens(e.target.value)}
              placeholder="예: 500000"
              data-testid="threshold-caution-tokens"
              className="bg-black/30 border border-[var(--pixel-border)] text-[11px] text-white px-2 py-1 w-[140px] focus:outline-none focus:border-[var(--token-usage-caution-border)]"
            />
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>비용(USD) ≥</span>
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={cautionUsd}
              onChange={e => setCautionUsd(e.target.value)}
              placeholder="예: 5"
              data-testid="threshold-caution-usd"
              className="bg-black/30 border border-[var(--pixel-border)] text-[11px] text-white px-2 py-1 w-[140px] focus:outline-none focus:border-[var(--token-usage-caution-border)]"
            />
          </label>
        </fieldset>

        <fieldset className="space-y-1" style={{ borderLeft: `3px solid var(--token-usage-warning-border)`, paddingLeft: 8 }}>
          <legend className="text-[10px] uppercase" style={{ color: 'var(--token-usage-warning-fg)' }}>
            경고(warning)
          </legend>
          <label className="flex items-center justify-between gap-2">
            <span>토큰 합계 ≥</span>
            <input
              type="number"
              min={1}
              inputMode="numeric"
              value={warningTokens}
              onChange={e => setWarningTokens(e.target.value)}
              placeholder="예: 2000000"
              data-testid="threshold-warning-tokens"
              className="bg-black/30 border border-[var(--pixel-border)] text-[11px] text-white px-2 py-1 w-[140px] focus:outline-none focus:border-[var(--token-usage-warning-border)]"
            />
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>비용(USD) ≥</span>
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={warningUsd}
              onChange={e => setWarningUsd(e.target.value)}
              placeholder="예: 20"
              data-testid="threshold-warning-usd"
              className="bg-black/30 border border-[var(--pixel-border)] text-[11px] text-white px-2 py-1 w-[140px] focus:outline-none focus:border-[var(--token-usage-warning-border)]"
            />
          </label>
        </fieldset>

        {error && (
          <div
            role="alert"
            data-testid="token-usage-settings-error"
            className="flex items-center gap-1 text-[10px]"
            style={{ color: 'var(--error-state-title-fg)' }}
          >
            <AlertTriangle size={12} style={{ color: 'var(--error-state-icon-fg)' }} /> {error}
          </div>
        )}

        <fieldset
          className="space-y-1 pt-2"
          style={{ borderTop: `1px solid var(--token-usage-tooltip-divider)` }}
          data-testid="token-usage-export-section"
        >
          <legend className="text-[10px] uppercase" style={{ color: 'var(--token-usage-axis-input-fg)' }}>
            캐시 사용 내역 내보내기
          </legend>
          <div role="radiogroup" aria-label="내보내기 범위" className="flex items-center gap-3 text-[10px]">
            {(['today', 'week', 'all'] as UsageRange[]).map(r => (
              <label key={r} className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="token-usage-export-range"
                  value={r}
                  checked={exportRange === r}
                  onChange={() => setExportRange(r)}
                  data-testid={`token-usage-export-range-${r}`}
                  className="accent-[var(--pixel-accent)]"
                />
                <span>{r === 'today' ? '오늘' : r === 'week' ? '최근 7일' : '전체'}</span>
              </label>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => handleExport('csv')}
              data-testid="token-usage-export-csv"
              className="inline-flex items-center gap-1 text-[10px] px-2 py-1 border border-white/30 text-white/85 hover:bg-white/5"
            >
              <Download size={10} /> CSV
            </button>
            <button
              type="button"
              onClick={() => handleExport('json')}
              data-testid="token-usage-export-json"
              className="inline-flex items-center gap-1 text-[10px] px-2 py-1 border border-white/30 text-white/85 hover:bg-white/5"
            >
              <Download size={10} /> JSON
            </button>
          </div>
        </fieldset>

        <div className="flex items-center justify-between pt-2 border-t border-white/10">
          <button
            type="button"
            onClick={handleClearAll}
            data-testid="threshold-clear-all"
            className="text-[10px] px-2 py-1 border border-white/20 text-white/70 hover:bg-white/5"
          >
            모두 지우기
          </button>
          <div className="flex items-center gap-2">
            {onResetToday && (
              <button
                type="button"
                onClick={() => { onResetToday(); onClose(); }}
                data-testid="token-usage-reset-today"
                className="inline-flex items-center gap-1 text-[10px] px-2 py-1 border border-white/20 text-white/80 hover:bg-white/5"
              >
                <RotateCcw size={10} /> 오늘만 리셋
              </button>
            )}
            <button
              type="submit"
              data-testid="threshold-save"
              data-focus-tone="success"
              className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-1"
              style={{
                background: 'var(--shared-goal-modal-confirm-bg)',
                border: `1px solid var(--shared-goal-modal-confirm-border)`,
                color: 'var(--shared-goal-modal-confirm-fg)',
                borderRadius: 4,
              }}
            >
              <Save size={10} /> 저장
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
