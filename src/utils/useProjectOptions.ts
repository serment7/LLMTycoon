/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 프로젝트 관리 옵션(자동 개발/자동 커밋/자동 푸시 토글, 기본 브랜치, 원격 URL,
 * sharedGoalId, settingsJson) 을 서버 DB 와 동기화하는 React 훅.
 *
 * 설계 원칙:
 * 1) **DB 가 단일 진실 소스**: 기존에 메모리·localStorage 로 흩어져 있던 토글 상태를
 *    GET /api/projects/:id/options 로 불러와 페이지 새로고침·재로그인 후에도
 *    동일한 값을 복원한다.
 * 2) **낙관적 갱신 금지**: PATCH 응답이 도착해야 상태가 바뀐다. 네트워크 실패 시
 *    UI 가 "켠 것처럼 보이다가 되돌아가는" 회귀를 막기 위해 낙관 업데이트는 제공하지 않는다.
 * 3) **socket 동기화**: 다른 탭/브라우저에서의 변경이 `project-options:updated` 이벤트로
 *    방출되므로, 같은 projectId 를 구독 중이면 즉시 반영한다. socket 객체는 선택 주입.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface ProjectOptions {
  autoDevEnabled: boolean;
  autoCommitEnabled: boolean;
  autoPushEnabled: boolean;
  defaultBranch: string;
  gitRemoteUrl?: string;
  sharedGoalId?: string;
  settingsJson: Record<string, unknown>;
}

export interface ProjectOptionsUpdateInput {
  autoDevEnabled?: boolean;
  autoCommitEnabled?: boolean;
  autoPushEnabled?: boolean;
  defaultBranch?: string;
  gitRemoteUrl?: string | null;
  sharedGoalId?: string | null;
  settingsJson?: Record<string, unknown>;
}

export interface UseProjectOptionsState {
  data: ProjectOptions | null;
  loading: boolean;
  error: string | null;
  saving: boolean;
  update(patch: ProjectOptionsUpdateInput): Promise<ProjectOptions>;
  refresh(): Promise<void>;
}

type SocketLike = {
  on(event: string, handler: (payload: unknown) => void): void;
  off(event: string, handler: (payload: unknown) => void): void;
};

interface Options {
  /**
   * socket.io 클라이언트(선택). 주입 시 `project-options:updated` 이벤트로
   * 실시간 갱신을 구독한다. 테스트/SSR 환경에서는 생략 가능.
   */
  socket?: SocketLike | null;
  /** fetch 구현 주입(테스트용). 기본은 globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export function useProjectOptions(
  projectId: string | null | undefined,
  options: Options = {},
): UseProjectOptionsState {
  const { socket, fetchImpl = globalThis.fetch } = options;
  const [data, setData] = useState<ProjectOptions | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // projectId 가 바뀌는 도중 이전 요청이 늦게 도착해 state 를 오염시키는 것을 막는다.
  const requestIdRef = useRef(0);

  const load = useCallback(async (id: string) => {
    const myRequest = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchImpl(`/api/projects/${encodeURIComponent(id)}/options`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const body = await res.json() as ProjectOptions;
      if (requestIdRef.current === myRequest) setData(body);
    } catch (err) {
      if (requestIdRef.current === myRequest) setError((err as Error).message);
    } finally {
      if (requestIdRef.current === myRequest) setLoading(false);
    }
  }, [fetchImpl]);

  useEffect(() => {
    if (!projectId) {
      setData(null);
      return;
    }
    load(projectId);
  }, [projectId, load]);

  useEffect(() => {
    if (!socket || !projectId) return;
    const handler = (payload: unknown) => {
      const ev = payload as { projectId?: string; options?: ProjectOptions } | null;
      if (!ev || ev.projectId !== projectId || !ev.options) return;
      setData(ev.options);
    };
    socket.on('project-options:updated', handler);
    return () => { socket.off('project-options:updated', handler); };
  }, [socket, projectId]);

  const update = useCallback(async (patch: ProjectOptionsUpdateInput): Promise<ProjectOptions> => {
    if (!projectId) throw new Error('projectId required');
    setSaving(true);
    setError(null);
    try {
      const res = await fetchImpl(`/api/projects/${encodeURIComponent(projectId)}/options`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const body = await res.json() as ProjectOptions;
      setData(body);
      return body;
    } catch (err) {
      setError((err as Error).message);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [projectId, fetchImpl]);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    await load(projectId);
  }, [projectId, load]);

  return { data, loading, error, saving, update, refresh };
}
