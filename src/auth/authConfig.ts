/**
 * 인증 관련 환경설정 로더.
 * DEV_MODE / ON_PREMISE / OAuth 공급자 설정을 단일 객체로 노출한다.
 */

export type AuthProvider = 'github' | 'gitlab';

export interface AuthConfig {
  devMode: boolean;
  onPremise: boolean;
  provider: AuthProvider;
  githubClientId: string;
  githubClientSecret: string;
  gitlabClientId: string;
  gitlabClientSecret: string;
  redirectUrl: string;
  sessionSecret: string;
  mongoUri: string;
  mongoDb: string;
}

const DEFAULT_SESSION_SECRET = 'change-me';

function flag(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function parseProvider(raw: string | undefined): AuthProvider {
  const v = (raw || 'github').trim().toLowerCase();
  if (v === 'github' || v === 'gitlab') return v;
  console.warn(`[authConfig] unknown AUTH_PROVIDER="${raw}" — falling back to "github"`);
  return 'github';
}

function defaultRedirectUrl(env: NodeJS.ProcessEnv): string {
  const base = (env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/api/auth/callback`;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  return {
    devMode: flag(env.DEV_MODE, false),
    onPremise: flag(env.ON_PREMISE, true),
    provider: parseProvider(env.AUTH_PROVIDER),
    githubClientId: env.GITHUB_CLIENT_ID || '',
    githubClientSecret: env.GITHUB_CLIENT_SECRET || '',
    gitlabClientId: env.GITLAB_CLIENT_ID || '',
    gitlabClientSecret: env.GITLAB_CLIENT_SECRET || '',
    redirectUrl: env.OAUTH_REDIRECT_URL || defaultRedirectUrl(env),
    sessionSecret: env.SESSION_SECRET || DEFAULT_SESSION_SECRET,
    mongoUri: env.MONGODB_URI || 'mongodb://localhost:27017',
    mongoDb: env.MONGODB_DB || 'llm-tycoon',
  };
}

/**
 * 설정이 현재 모드에서 실제로 동작 가능한지 검사한다.
 * 문제가 없으면 빈 배열, 있으면 사람이 읽을 수 있는 오류 메시지 목록을 반환한다.
 * (throw 하지 않는다 — 호출 측이 경고/차단 여부를 결정)
 */
export function validateAuthConfig(cfg: AuthConfig): string[] {
  const errors: string[] = [];

  if (cfg.devMode) return errors; // DEV 모드에서는 나머지 설정이 의미 없음

  if (!cfg.onPremise) {
    const creds = cfg.provider === 'gitlab'
      ? { id: cfg.gitlabClientId, secret: cfg.gitlabClientSecret, keyId: 'GITLAB_CLIENT_ID', keySecret: 'GITLAB_CLIENT_SECRET' }
      : { id: cfg.githubClientId, secret: cfg.githubClientSecret, keyId: 'GITHUB_CLIENT_ID', keySecret: 'GITHUB_CLIENT_SECRET' };
    if (!creds.id) errors.push(`${creds.keyId} is required when ON_PREMISE=false`);
    if (!creds.secret) errors.push(`${creds.keySecret} is required when ON_PREMISE=false`);
    if (!cfg.redirectUrl) errors.push('OAUTH_REDIRECT_URL (or APP_URL) is required when ON_PREMISE=false');
  }

  if (cfg.sessionSecret === DEFAULT_SESSION_SECRET) {
    errors.push('SESSION_SECRET must be overridden (default "change-me" is unsafe)');
  }

  return errors;
}
