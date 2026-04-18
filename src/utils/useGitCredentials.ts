/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 프로젝트 설정 화면의 Git 자격증명(provider + username + personal access token)을
 * 서버 API(/api/projects/:id/git-credentials)와 동기화하는 훅.
 *
 * 설계 원칙:
 * 1) **localStorage 금지**: 토큰 원문은 브라우저 저장소에 두지 않는다. 서버 DB 만이
 *    원문을 소유하며, 훅은 항상 마스킹된 응답(hasToken 플래그)만 읽는다.
 * 2) **단일 프로젝트 1쌍**: projectId 가 바뀌면 내부 state 는 초기화되고 새 프로젝트
 *    자격증명을 lazy 하게 fetch 한다.
 * 3) **저장 후 즉시 마스킹**: POST 성공 응답도 서버가 token 을 지운 GitCredentialRedacted
 *    구조라서, UI 는 입력 필드를 비우고 "저장됨" 배지를 띄우면 된다.
 */

import { useCallback, useEffect, useState } from 'react';
import type { GitCredentialRedacted, SourceProvider } from '../types';

export interface UseGitCredentialsState {
  /** 현재 프로젝트의 저장된 자격증명. 아직 저장 전/로딩 전/삭제 직후면 null. */
  data: GitCredentialRedacted | null;
  loading: boolean;
  /** 최근 네트워크 오류 메시지. 성공 호출 시 자동으로 비워진다. */
  error: string | null;
  saving: boolean;
  save(input: { provider: SourceProvider; username: string; token: string }): Promise<void>;
  remove(): Promise<void>;
  refresh(): Promise<void>;
}

export function useGitCredentials(projectId: string | null | undefined): UseGitCredentialsState {
  const [data, setData] = useState<GitCredentialRedacted | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(id)}/git-credentials`);
      if (res.status === 404) {
        setData(null);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const body = await res.json() as GitCredentialRedacted;
      setData(body);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!projectId) {
      setData(null);
      return;
    }
    load(projectId);
  }, [projectId, load]);

  const save = useCallback(async (input: { provider: SourceProvider; username: string; token: string }) => {
    if (!projectId) throw new Error('projectId required');
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/git-credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const body = await res.json() as GitCredentialRedacted;
      setData(body);
    } catch (err) {
      setError((err as Error).message);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [projectId]);

  const remove = useCallback(async () => {
    if (!projectId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/git-credentials`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setData(null);
    } catch (err) {
      setError((err as Error).message);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [projectId]);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    await load(projectId);
  }, [projectId, load]);

  return { data, loading, error, saving, save, remove, refresh };
}
