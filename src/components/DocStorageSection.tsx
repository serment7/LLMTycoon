// 문서 저장 위치 설정 — 현재 프로젝트의 docs/ 가 어디에 저장될지 선택한다.
//
// SettingsDrawer 안의 한 섹션으로 마운트되며, 프로젝트가 선택돼 있을 때만 의미가
// 있다. 모드 변경은 즉시 반영되지 않고 마이그레이션 모달을 거쳐 사용자가 기존
// docs/ 파일을 어떻게 처리할지(이동/복사/그대로) 결정한 뒤에 서버에 PATCH 된다.
//
// 디자인 원칙
//   · 모드 라디오는 "현재 모드" 만 시각적으로 강조한다(선택만으로 저장되지 않음).
//   · 다른 모드를 선택하면 즉시 모달이 열려 사용자가 마이그레이션 전략을 골라야
//     실제 변경이 일어난다 — "잘못 눌렀더니 docs 가 사라졌다" 회귀를 막는다.
//   · 마이그레이션 결과(이동/스킵 개수)는 토스트와 모달 footer 양쪽에 노출.

import React, { useCallback, useMemo, useState } from 'react';

import { useI18n } from '../i18n';
import { useToast } from './ToastProvider';
import { extractDocStorage, type DocStorageMode } from '../utils/docStorage';
import { useProjectOptions } from '../utils/useProjectOptions';

export interface DocStorageSectionProps {
  projectId: string | null;
}

type MigrationStrategy = 'move' | 'copy' | 'none';

interface MigrationResponse {
  ok: boolean;
  mode: DocStorageMode;
  moved: number;
  skipped: number;
  failed?: { path: string; error: string }[];
  alreadyInMode?: boolean;
}

export function DocStorageSection({ projectId }: DocStorageSectionProps): React.ReactElement | null {
  const { t } = useI18n();
  const toast = useToast();
  const { data, loading, refresh } = useProjectOptions(projectId ?? null);
  const [pendingTarget, setPendingTarget] = useState<DocStorageMode | null>(null);
  const [strategy, setStrategy] = useState<MigrationStrategy>('move');
  const [submitting, setSubmitting] = useState(false);

  const currentMode: DocStorageMode = useMemo(
    () => extractDocStorage(data?.settingsJson).mode,
    [data?.settingsJson],
  );

  const onPickMode = useCallback((next: DocStorageMode) => {
    if (!projectId) return;
    if (next === currentMode) return;
    setPendingTarget(next);
    setStrategy('move');
  }, [projectId, currentMode]);

  const closeModal = useCallback(() => {
    if (submitting) return;
    setPendingTarget(null);
  }, [submitting]);

  const onConfirm = useCallback(async () => {
    if (!projectId || !pendingTarget) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/docs/migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetMode: pendingTarget, strategy }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const out = await res.json() as MigrationResponse;
      // refresh — settingsJson 이 갱신됐으므로 useProjectOptions 캐시도 다시 받아 온다.
      await refresh();
      const summary = t('settings.docStorage.migrate.successSummary')
        .replace('{moved}', String(out.moved))
        .replace('{skipped}', String(out.skipped));
      toast.push({ title: t('settings.docStorage.migrate.successTitle'), description: summary, variant: 'success' });
      setPendingTarget(null);
    } catch (err) {
      toast.push({
        title: t('settings.docStorage.migrate.errorTitle'),
        description: (err as Error).message,
        variant: 'error',
      });
    } finally {
      setSubmitting(false);
    }
  }, [projectId, pendingTarget, strategy, refresh, toast, t]);

  if (!projectId) {
    return (
      <p className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
        {t('settings.docStorage.noProject')}
      </p>
    );
  }

  return (
    <div data-testid="doc-storage-section">
      <p className="text-[11px]" style={{ color: 'var(--color-text-muted)', marginBottom: 'var(--space-xs)' }}>
        {t('settings.docStorage.intro')}
      </p>
      <div role="radiogroup" aria-label={t('settings.docStorage.title')} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
        {(['workspace', 'central'] as DocStorageMode[]).map((mode) => {
          const checked = currentMode === mode;
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={checked}
              data-testid={`doc-storage-${mode}`}
              disabled={loading}
              onClick={() => onPickMode(mode)}
              style={{
                background: checked ? 'var(--color-accent)' : 'transparent',
                color: checked ? 'var(--color-accent-contrast)' : 'var(--color-text)',
                border: `1px solid ${checked ? 'var(--color-accent)' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius-sm)',
                padding: 'var(--space-xs) var(--space-sm)',
                cursor: loading ? 'wait' : 'pointer',
                textAlign: 'left',
              }}
            >
              <strong style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>
                {t(`settings.docStorage.${mode}.title`)}
              </strong>
              <small style={{ display: 'block', opacity: 0.85 }}>
                {t(`settings.docStorage.${mode}.hint`)}
              </small>
            </button>
          );
        })}
      </div>

      {pendingTarget && (
        <div
          data-testid="doc-storage-migrate-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="doc-storage-migrate-title"
          onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1200,
          }}
        >
          <div
            style={{
              width: 'min(420px, 90%)',
              background: 'var(--color-surface)',
              color: 'var(--color-text)',
              border: '2px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-lg)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-sm)',
            }}
          >
            <h3 id="doc-storage-migrate-title" style={{ fontSize: 'var(--font-size-md)', fontWeight: 'var(--font-weight-bold)' }}>
              {t('settings.docStorage.migrate.title')}
            </h3>
            <p className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
              {t('settings.docStorage.migrate.intro')
                .replace('{from}', t(`settings.docStorage.${currentMode}.title`))
                .replace('{to}', t(`settings.docStorage.${pendingTarget}.title`))}
            </p>
            <div role="radiogroup" aria-label={t('settings.docStorage.migrate.strategyLabel')} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
              {(['move', 'copy', 'none'] as MigrationStrategy[]).map((s) => (
                <label
                  key={s}
                  style={{
                    display: 'flex',
                    gap: 'var(--space-xs)',
                    alignItems: 'flex-start',
                    padding: 'var(--space-xs)',
                    border: `1px solid ${strategy === s ? 'var(--color-accent)' : 'var(--color-border)'}`,
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="doc-storage-migrate-strategy"
                    value={s}
                    checked={strategy === s}
                    onChange={() => setStrategy(s)}
                    data-testid={`doc-storage-migrate-strategy-${s}`}
                  />
                  <span>
                    <strong style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>
                      {t(`settings.docStorage.migrate.strategy.${s}.title`)}
                    </strong>
                    <small style={{ display: 'block', color: 'var(--color-text-muted)' }}>
                      {t(`settings.docStorage.migrate.strategy.${s}.hint`)}
                    </small>
                  </span>
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-xs)', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={closeModal}
                disabled={submitting}
                style={{
                  background: 'transparent',
                  color: 'var(--color-text-muted)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 'var(--space-xs) var(--space-sm)',
                  cursor: submitting ? 'wait' : 'pointer',
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={submitting}
                data-testid="doc-storage-migrate-confirm"
                style={{
                  background: 'var(--color-accent)',
                  color: 'var(--color-accent-contrast)',
                  border: '1px solid var(--color-accent)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 'var(--space-xs) var(--space-sm)',
                  cursor: submitting ? 'wait' : 'pointer',
                }}
              >
                {submitting ? t('common.loading') : t('settings.docStorage.migrate.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
