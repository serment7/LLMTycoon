/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 프로젝트 설정 화면에 붙이는 Git 자격증명 섹션. provider(GitHub/GitLab) ·
 * username · personal access token(PAT) 한 쌍을 서버에 저장·삭제한다.
 *
 * 정책:
 * - 토큰은 localStorage 에 절대 두지 않는다. 모든 상태는 useGitCredentials 훅을 통해
 *   서버 API 로만 흐른다.
 * - 저장 직후 token 입력 필드는 비워지고, "저장됨" 배지와 마스킹 표시(●●●●●●●●)로만
 *   노출된다. 서버 응답이 GitCredentialRedacted(hasToken 플래그) 라 원문은 재노출되지 않는다.
 * - 공개 PAT 가 화면에 남아 있는 시간을 최소화하기 위해 type="password" 를 강제.
 */

import React, { useState } from 'react';
import { GitBranch, Save, Trash2, Github, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import type { SourceProvider } from '../types';
import { useGitCredentials } from '../utils/useGitCredentials';
import { useI18n } from '../i18n';

interface Props {
  projectId: string;
  onLog?: (text: string) => void;
}

const PROVIDER_OPTIONS: ReadonlyArray<{ value: SourceProvider; label: string }> = [
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' },
];

const MASKED = '••••••••';

const focusRing = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pixel-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black';

export function GitCredentialsSection({ projectId, onLog }: Props) {
  const { t, locale } = useI18n();
  const { data, loading, saving, error, save, remove } = useGitCredentials(projectId);
  const [provider, setProvider] = useState<SourceProvider>('github');
  const [username, setUsername] = useState<string>('');
  const [token, setToken] = useState<string>('');

  // 서버가 내려준 저장 상태를 폼에 반영. 저장돼 있으면 provider/username 은 채워 두고
  // token 필드는 비워서 재입력을 유도(마스킹 배지가 "이미 저장됨" 신호를 대체).
  React.useEffect(() => {
    if (data) {
      setProvider(data.provider);
      setUsername(data.username);
      setToken('');
    }
  }, [data]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !token.trim()) {
      onLog?.(t('gitCredentials.errors.missingFields'));
      return;
    }
    try {
      await save({ provider, username: username.trim(), token: token.trim() });
      setToken('');
      onLog?.(
        t('gitCredentials.log.saved')
          .replace('{provider}', provider)
          .replace('{username}', username.trim()),
      );
    } catch (err) {
      onLog?.(t('gitCredentials.errors.saveFailed').replace('{message}', (err as Error).message));
    }
  };

  const discard = async () => {
    try {
      await remove();
      setUsername('');
      setToken('');
      onLog?.(t('gitCredentials.log.deleted'));
    } catch (err) {
      onLog?.(t('gitCredentials.errors.deleteFailed').replace('{message}', (err as Error).message));
    }
  };

  const hasStored = Boolean(data?.hasToken);

  return (
    <section
      role="region"
      aria-label={t('gitCredentials.sectionAria')}
      className="mb-4 bg-[#0f3460] border-2 border-[var(--pixel-border)] p-4 space-y-3"
    >
      <header className="flex items-center gap-2 flex-wrap">
        <GitBranch size={16} className="text-[var(--pixel-accent)]" />
        <h3 className="text-sm font-bold text-[var(--pixel-accent)] uppercase tracking-wider">{t('gitCredentials.sectionTitle')}</h3>
        {loading && (
          <span className="inline-flex items-center gap-1 text-[10px] text-white/60">
            <Loader2 size={10} className="animate-spin" /> {t('gitCredentials.loading')}
          </span>
        )}
        {hasStored && !loading && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border-2 border-emerald-400/70 bg-emerald-500/15 text-emerald-100"
            title={data?.updatedAt
              ? t('gitCredentials.lastSaved').replace('{datetime}', new Date(data.updatedAt).toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US'))
              : undefined}
          >
            <CheckCircle2 size={10} /> {t('gitCredentials.saved')}
          </span>
        )}
      </header>

      <p className="text-[10px] text-white/60 leading-relaxed">
        {t('gitCredentials.intro').replace('{mask}', MASKED)}
      </p>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 px-3 py-2 border-2 border-red-400 bg-red-500/15 text-red-100"
        >
          <AlertTriangle size={14} className="shrink-0 mt-0.5 text-red-300" />
          <div className="text-[11px] font-mono break-words">{error}</div>
        </div>
      )}

      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="flex items-center gap-2 text-[10px] font-bold text-[var(--pixel-accent)] uppercase tracking-wider mb-1">
            <Github size={10} /> {t('gitCredentials.providerLabel')}
          </span>
          <select
            value={provider}
            onChange={e => setProvider(e.target.value as SourceProvider)}
            className={`w-full bg-black/40 border-2 border-[var(--pixel-border)] px-3 py-2 text-sm text-white font-mono focus:border-[var(--pixel-accent)] ${focusRing}`}
            aria-label={t('gitCredentials.providerSelectAria')}
          >
            {PROVIDER_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-[10px] font-bold text-[var(--pixel-accent)] uppercase tracking-wider mb-1 block">
            {t('gitCredentials.usernameLabel')}
          </span>
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder={t('gitCredentials.usernamePlaceholder')}
            autoComplete="username"
            className={`w-full bg-black/40 border-2 border-[var(--pixel-border)] px-3 py-2 text-sm text-white font-mono placeholder:text-white/30 focus:border-[var(--pixel-accent)] ${focusRing}`}
          />
        </label>

        <label className="block">
          <span className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-bold text-[var(--pixel-accent)] uppercase tracking-wider">
              {t('gitCredentials.tokenLabel')}
            </span>
            {hasStored && (
              <span
                className="text-[10px] font-mono text-emerald-300"
                aria-label={t('gitCredentials.tokenMaskAria')}
                title={t('gitCredentials.tokenMaskTitle')}
              >
                {MASKED}
              </span>
            )}
          </span>
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder={hasStored ? t('gitCredentials.tokenPlaceholderReplace') : t('gitCredentials.tokenPlaceholderEmpty')}
            autoComplete="off"
            spellCheck={false}
            className={`w-full bg-black/40 border-2 border-[var(--pixel-border)] px-3 py-2 text-sm text-white font-mono placeholder:text-white/30 focus:border-[var(--pixel-accent)] ${focusRing}`}
          />
        </label>

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={discard}
            disabled={!hasStored || saving}
            aria-label={t('gitCredentials.deleteAria')}
            className={`px-3 py-1.5 bg-black/30 border-2 border-[var(--pixel-border)] text-[11px] font-bold uppercase tracking-wider text-white/80 hover:border-red-400 hover:text-red-200 flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${focusRing}`}
          >
            <Trash2 size={12} /> {t('gitCredentials.deleteButton')}
          </button>
          <button
            type="submit"
            disabled={saving || !username.trim() || !token.trim()}
            aria-label={t('gitCredentials.saveAria')}
            className={`ml-auto px-4 py-1.5 bg-emerald-500 border-b-2 border-b-emerald-700 text-black text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 hover:brightness-110 active:translate-y-px disabled:opacity-40 disabled:cursor-not-allowed ${focusRing}`}
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} {t('gitCredentials.saveButton')}
          </button>
        </div>
      </form>
    </section>
  );
}

export default GitCredentialsSection;
