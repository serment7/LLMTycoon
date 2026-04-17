/**
 * AuthService - DEV_MODE / 온프레미스(Mongo) / OAuth(GitHub·GitLab) 를 스위칭하는 파사드.
 * 실제 구현은 providers/mongoProvider, providers/oauthProvider 에 위임한다.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { AuthConfig, loadAuthConfig, validateAuthConfig } from './authConfig';
import { MongoAuthProvider } from './providers/mongoProvider';
import { OAuthProvider } from './providers/oauthProvider';

export interface AuthUser {
  id: string;
  username: string;
  email?: string;
  provider: 'dev' | 'mongo' | 'github' | 'gitlab';
}

export interface LoginInput {
  username?: string;
  password?: string;
  code?: string; // OAuth callback 코드
}

export interface SignupInput {
  username: string;
  password: string;
  email?: string;
}

export interface AuthBackend {
  login(input: LoginInput): Promise<AuthUser>;
  signup(input: SignupInput): Promise<AuthUser>;
  getAuthorizeUrl?(state: string): string;
}

export interface AuthSession {
  user: AuthUser;
  token: string;
  issuedAt: number;
  expiresAt: number;
}

const DEV_USER: AuthUser = {
  id: 'dev-user',
  username: 'dev',
  email: 'dev@localhost',
  provider: 'dev',
};

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7일

export class AuthService {
  readonly config: AuthConfig;
  readonly configErrors: string[];
  private backend: AuthBackend;
  private activeSessions = new Map<string, AuthSession>();

  constructor(config: AuthConfig = loadAuthConfig()) {
    this.config = config;
    this.configErrors = validateAuthConfig(config);
    this.backend = config.onPremise
      ? new MongoAuthProvider(config)
      : new OAuthProvider(config);
  }

  isDevMode(): boolean {
    return this.config.devMode;
  }

  isConfigReady(): boolean {
    return this.configErrors.length === 0;
  }

  async login(input: LoginInput): Promise<AuthUser> {
    if (this.config.devMode) return DEV_USER;
    return this.backend.login(input);
  }

  async signup(input: SignupInput): Promise<AuthUser> {
    if (this.config.devMode) return DEV_USER;
    return this.backend.signup(input);
  }

  getAuthorizeUrl(state: string): string | null {
    if (this.config.devMode || this.config.onPremise) return null;
    return this.backend.getAuthorizeUrl?.(state) ?? null;
  }

  /**
   * 주어진 토큰이 유효한 세션을 가리키면 세션을 반환, 아니면 null.
   * - 서명 검증 후 만료/철회 여부를 메모리 스토어에서 확인.
   */
  verifySession(token: string): AuthSession | null {
    const parsed = this.decodeToken(token);
    if (!parsed) return null;
    const session = this.activeSessions.get(parsed.sid);
    if (!session) return null;
    if (session.token !== token) return null;
    if (Date.now() >= session.expiresAt) {
      this.activeSessions.delete(parsed.sid);
      return null;
    }
    return session;
  }

  logout(token: string): boolean {
    const parsed = this.decodeToken(token);
    if (!parsed) return false;
    return this.activeSessions.delete(parsed.sid);
  }

  /**
   * 인증된 사용자에게 서명된 세션 토큰을 발급한다.
   * 라우터가 쿠키로 내려보내고, 이후 verifySession으로 검증.
   */
  issueSession(user: AuthUser): AuthSession {
    const sid = randomBytes(16).toString('hex');
    const issuedAt = Date.now();
    const expiresAt = issuedAt + SESSION_TTL_MS;
    const payload = `${sid}.${user.id}.${issuedAt}.${expiresAt}`;
    const sig = this.sign(payload);
    const token = `${Buffer.from(payload).toString('base64url')}.${sig}`;
    const session: AuthSession = { user, token, issuedAt, expiresAt };
    this.activeSessions.set(sid, session);
    return session;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.config.sessionSecret).update(payload).digest('base64url');
  }

  private decodeToken(token: string): { sid: string } | null {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    let payload: string;
    try {
      payload = Buffer.from(body, 'base64url').toString('utf8');
    } catch {
      return null;
    }
    const expected = this.sign(payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const [sid] = payload.split('.');
    return sid ? { sid } : null;
  }
}
