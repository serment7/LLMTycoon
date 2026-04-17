/**
 * GitHub / GitLab OAuth provider.
 * ON_PREMISE=false 일 때 사용. 로그인과 회원가입 모두 OAuth authorization code 흐름으로 처리.
 */

import { AuthConfig } from '../authConfig';
import type { AuthBackend, AuthUser, LoginInput, SignupInput } from '../authService';

interface ProviderEndpoints {
  authorize: string;
  token: string;
  user: string;
  scope: string;
}

const ENDPOINTS: Record<'github' | 'gitlab', ProviderEndpoints> = {
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    user: 'https://api.github.com/user',
    scope: 'read:user user:email',
  },
  gitlab: {
    authorize: 'https://gitlab.com/oauth/authorize',
    token: 'https://gitlab.com/oauth/token',
    user: 'https://gitlab.com/api/v4/user',
    scope: 'read_user',
  },
};

const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails';

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return '';
  }
}

export class OAuthProvider implements AuthBackend {
  constructor(private cfg: AuthConfig) {}

  private creds() {
    const p = this.cfg.provider;
    if (p === 'gitlab') {
      return { id: this.cfg.gitlabClientId, secret: this.cfg.gitlabClientSecret };
    }
    return { id: this.cfg.githubClientId, secret: this.cfg.githubClientSecret };
  }

  getAuthorizeUrl(state: string): string {
    const ep = ENDPOINTS[this.cfg.provider];
    const { id } = this.creds();
    const q = new URLSearchParams({
      client_id: id,
      redirect_uri: this.cfg.redirectUrl,
      response_type: 'code',
      scope: ep.scope,
      state,
    });
    return `${ep.authorize}?${q.toString()}`;
  }

  async login(input: LoginInput): Promise<AuthUser> {
    if (!input.code) throw new Error('oauth code required');
    return this.exchange(input.code);
  }

  async signup(input: SignupInput): Promise<AuthUser> {
    // OAuth 모드에서는 signup === login. 최초 code 교환 시 계정이 자동 생성됨.
    if (!(input as unknown as LoginInput).code) {
      throw new Error('oauth signup requires authorization code');
    }
    return this.exchange((input as unknown as LoginInput).code!);
  }

  private async exchange(code: string): Promise<AuthUser> {
    const ep = ENDPOINTS[this.cfg.provider];
    const { id, secret } = this.creds();
    if (!id || !secret) {
      throw new Error(`oauth credentials missing for provider "${this.cfg.provider}"`);
    }

    const tokenRes = await fetch(ep.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: id,
        client_secret: secret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: this.cfg.redirectUrl,
      }).toString(),
    });
    if (!tokenRes.ok) {
      throw new Error(`oauth token exchange failed: ${tokenRes.status} ${await readErrorBody(tokenRes)}`);
    }
    // GitHub은 실패해도 200을 내리고 body에 error 필드를 담는다.
    const tok = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
    if (tok.error) {
      throw new Error(`oauth token exchange error: ${tok.error}${tok.error_description ? ` - ${tok.error_description}` : ''}`);
    }
    if (!tok.access_token) throw new Error('oauth no access_token');

    const userRes = await fetch(ep.user, {
      headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' },
    });
    if (!userRes.ok) {
      throw new Error(`oauth user fetch failed: ${userRes.status} ${await readErrorBody(userRes)}`);
    }
    const raw = (await userRes.json()) as {
      id: number | string;
      login?: string;
      username?: string;
      name?: string;
      email?: string | null;
      avatar_url?: string;
    };

    let email = raw.email || undefined;
    if (!email && this.cfg.provider === 'github') {
      email = await this.fetchGithubPrimaryEmail(tok.access_token);
    }

    return {
      id: String(raw.id),
      username: raw.login || raw.username || raw.name || `user-${raw.id}`,
      email,
      provider: this.cfg.provider,
    };
  }

  /**
   * GitHub 프로필의 email이 private으로 숨겨져 있을 때,
   * user:email scope로 /user/emails를 조회해 primary+verified 항목을 선택한다.
   */
  private async fetchGithubPrimaryEmail(accessToken: string): Promise<string | undefined> {
    try {
      const res = await fetch(GITHUB_EMAILS_URL, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
      if (!res.ok) return undefined;
      const list = (await res.json()) as Array<{ email: string; primary?: boolean; verified?: boolean }>;
      if (!Array.isArray(list) || list.length === 0) return undefined;
      const primary = list.find((e) => e.primary && e.verified);
      return (primary || list.find((e) => e.verified) || list[0]).email;
    } catch {
      return undefined;
    }
  }
}
