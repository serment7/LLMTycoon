/**
 * Express 라우터: /api/auth/*
 *   GET  /api/auth/config    → 클라이언트에 DEV_MODE/ON_PREMISE/provider/설정 준비 상태 노출
 *   GET  /api/auth/me        → 현재 세션 사용자
 *   POST /api/auth/login     → 로그인 (온프레미스 모드)
 *   POST /api/auth/signup    → 회원가입 (온프레미스 모드)
 *   POST /api/auth/logout    → 세션 파기
 *   GET  /api/auth/authorize → OAuth 인가 페이지 리디렉트
 *   GET  /api/auth/callback  → OAuth 콜백 → 세션 부여 후 / 로 리디렉트
 *
 * 세션은 AuthService 가 발급하는 HMAC 서명 토큰을 쿠키에 그대로 싣는다.
 * 라우터는 더 이상 세션 스토어를 따로 들고 있지 않는다(단일 소스 원칙).
 *
 * server.ts 에서 `app.use(createAuthRouter(authService))` 로 마운트한다.
 */

import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { AuthService, AuthUser } from './authService';

const COOKIE = 'llm_tycoon_sid';
const STATE_TTL_MS = 10 * 60 * 1000;
const oauthStates = new Map<string, number>();

export function parseSidFromCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

export function issueOAuthState(): string {
  const now = Date.now();
  for (const [k, t] of oauthStates) if (now - t > STATE_TTL_MS) oauthStates.delete(k);
  const s = randomBytes(16).toString('hex');
  oauthStates.set(s, now);
  return s;
}

export function consumeOAuthState(state: string): boolean {
  const t = oauthStates.get(state);
  if (!t) return false;
  oauthStates.delete(state);
  return Date.now() - t <= STATE_TTL_MS;
}

function buildCookie(value: string, maxAgeSec: number): string {
  const parts = [
    `${COOKIE}=${value}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

function setSessionCookie(res: Response, token: string, expiresAt: number): void {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  res.setHeader('Set-Cookie', buildCookie(token, maxAge));
}

function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', buildCookie('', 0));
}

function readToken(req: Request): string | null {
  return parseSidFromCookie(req.headers.cookie);
}

export function createAuthRouter(auth: AuthService): Router {
  const r = Router();

  r.get('/api/auth/config', (_req, res) => {
    res.json({
      devMode: auth.isDevMode(),
      onPremise: auth.config.onPremise,
      provider: auth.config.provider,
      configReady: auth.isConfigReady(),
      configErrors: auth.configErrors,
    });
  });

  r.get('/api/auth/me', (req, res) => {
    if (auth.isDevMode()) {
      res.json({ id: 'dev-user', username: 'dev', provider: 'dev' });
      return;
    }
    const token = readToken(req);
    const session = token ? auth.verifySession(token) : null;
    if (!session) { res.status(401).json({ error: 'not authenticated' }); return; }
    res.json(session.user);
  });

  const issue = (res: Response, user: AuthUser) => {
    const session = auth.issueSession(user);
    setSessionCookie(res, session.token, session.expiresAt);
    return session;
  };

  r.post('/api/auth/login', async (req, res) => {
    try {
      const user = await auth.login(req.body || {});
      issue(res, user);
      res.json(user);
    } catch (e) {
      res.status(401).json({ error: (e as Error).message });
    }
  });

  r.post('/api/auth/signup', async (req, res) => {
    try {
      const user = await auth.signup(req.body || {});
      issue(res, user);
      res.json(user);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  r.post('/api/auth/logout', (req, res) => {
    const token = readToken(req);
    if (token) auth.logout(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  r.get('/api/auth/authorize', (_req, res) => {
    const state = issueOAuthState();
    const url = auth.getAuthorizeUrl(state);
    if (!url) { res.status(400).send('OAuth disabled'); return; }
    res.redirect(url);
  });

  r.get('/api/auth/callback', async (req, res) => {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    if (!consumeOAuthState(state)) {
      res.status(400).send('OAuth failed: invalid state');
      return;
    }
    try {
      const user = await auth.login({ code });
      issue(res, user);
      res.redirect('/');
    } catch (e) {
      res.status(400).send(`OAuth failed: ${(e as Error).message}`);
    }
  });

  return r;
}
