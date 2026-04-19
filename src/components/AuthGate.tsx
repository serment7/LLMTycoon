/**
 * AuthGate - 앱 진입 시 인증 상태를 결정하는 최상위 컴포넌트.
 * 1) /api/auth/config 로 서버측 DEV_MODE / ON_PREMISE / provider 를 가져온다.
 * 2) DEV_MODE → 바로 children 렌더.
 * 3) 세션이 없으면 LoginForm/SignupForm 표시.
 * 4) 로그인 성공 → 세션 쿠키 세팅 후 children 렌더.
 *
 * children 은 useAuth() 훅으로 현재 사용자/로그아웃 핸들러를 사용할 수 있다.
 */

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { LoginForm } from './LoginForm';
import { SignupForm } from './SignupForm';

interface AuthConfigDTO {
  devMode: boolean;
  onPremise: boolean;
  provider: 'github' | 'gitlab';
}

interface AuthUserDTO {
  id: string;
  username: string;
  provider: string;
}

interface AuthContextValue {
  user: AuthUserDTO | null;
  devMode: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthGate>');
  return ctx;
}

interface AuthGateProps {
  children: React.ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const [cfg, setCfg] = useState<AuthConfigDTO | null>(null);
  const [user, setUser] = useState<AuthUserDTO | null>(null);
  const [screen, setScreen] = useState<'login' | 'signup'>('login');
  const [error, setError] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setBootError(null);
        const cfgRes = await fetch('/api/auth/config');
        if (!cfgRes.ok) throw new Error(`config ${cfgRes.status}`);
        const cfgJson = (await cfgRes.json()) as AuthConfigDTO;
        if (cancelled) return;
        setCfg(cfgJson);

        const meRes = await fetch('/api/auth/me');
        if (!cancelled && meRes.ok) {
          setUser((await meRes.json()) as AuthUserDTO);
        }
      } catch (e) {
        if (!cancelled) setBootError((e as Error).message);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const extractError = async (r: Response, fallback: string): Promise<string> => {
    try {
      const body = (await r.json()) as { error?: string };
      return body.error ?? fallback;
    } catch {
      return fallback;
    }
  };

  const handleLogin = async (username: string, password: string) => {
    setError(null);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!r.ok) {
        setError(await extractError(r, '로그인 실패'));
        return;
      }
      setUser((await r.json()) as AuthUserDTO);
    } catch (e) {
      // 네트워크 끊김·DNS 실패 등은 fetch 자체가 throw 한다. 과거에는 포착되지
      // 않은 Promise rejection 으로 콘솔에만 흘러 사용자에게는 "버튼이 먹통" 처럼
      // 보였다. 한국어 메시지로 에러 상태를 명시해 LoginForm 의 `role="alert"`
      // 배너로 흘려준다.
      setError(`로그인 실패: ${(e as Error).message || '네트워크 오류'}`);
    }
  };

  const handleSignup = async (username: string, password: string, email: string) => {
    setError(null);
    try {
      const r = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, email }),
      });
      if (!r.ok) {
        setError(await extractError(r, '회원가입 실패'));
        return;
      }
      setUser((await r.json()) as AuthUserDTO);
    } catch (e) {
      setError(`회원가입 실패: ${(e as Error).message || '네트워크 오류'}`);
    }
  };

  const handleOAuth = () => {
    window.location.href = '/api/auth/authorize';
  };

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // 네트워크 실패여도 로컬 상태는 비운다.
    }
    setUser(null);
    setScreen('login');
  }, []);

  if (!ready) {
    return (
      <div
        className="auth-loading"
        role="status"
        aria-live="polite"
        data-testid="auth-loading"
      >
        로딩 중…
      </div>
    );
  }

  if (bootError || !cfg) {
    return (
      <div
        className="auth-loading"
        role="alert"
        data-testid="auth-boot-error"
        style={{ textAlign: 'center', padding: 32 }}
      >
        <p>인증 서버에 연결할 수 없습니다.</p>
        <p style={{ opacity: 0.7, fontSize: 12 }}>{bootError ?? 'unknown error'}</p>
        <button
          type="button"
          aria-label="인증 서버 연결 다시 시도"
          onClick={() => { setReady(false); setReloadKey((k) => k + 1); }}
        >
          다시 시도
        </button>
      </div>
    );
  }

  if (cfg.devMode || user) {
    return (
      <AuthContext.Provider value={{ user, devMode: cfg.devMode, logout }}>
        {children}
      </AuthContext.Provider>
    );
  }

  if (screen === 'signup') {
    return (
      <SignupForm
        onPremise={cfg.onPremise}
        provider={cfg.provider}
        onSubmit={handleSignup}
        onOAuth={handleOAuth}
        onSwitchToLogin={() => { setError(null); setScreen('login'); }}
        error={error}
      />
    );
  }
  return (
    <LoginForm
      onPremise={cfg.onPremise}
      provider={cfg.provider}
      onSubmit={handleLogin}
      onOAuth={handleOAuth}
      onSwitchToSignup={() => { setError(null); setScreen('signup'); }}
      error={error}
    />
  );
}
