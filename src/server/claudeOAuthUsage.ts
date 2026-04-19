// Claude Code 대화형 `/usage` 와 동일 출처에 가까운 구독 할당량을 가져온다.
// Anthropic 이 공개 문서화하지 않은 OAuth 엔드포인트이며, 커뮤니티(statusLine·tmux
// 위젯)에서 널리 쓰인다. `claude login`(claude.ai OAuth) 후 생성되는
// ~/.claude/.credentials.json 의 accessToken 으로 호출한다.
//
// 참고: https://github.com/anthropics/claude-code/issues/28999 등

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

export const ANTHROPIC_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const ANTHROPIC_OAUTH_USAGE_BETA = 'oauth-2025-04-20';

export interface ClaudeOAuthUsageBucket {
  readonly utilization?: number;
  readonly resets_at?: string;
  readonly [key: string]: unknown;
}

export interface ClaudeOAuthUsagePayload {
  readonly five_hour?: ClaudeOAuthUsageBucket;
  readonly seven_day?: ClaudeOAuthUsageBucket;
  readonly [key: string]: unknown;
}

export type OAuthUsageFetchResult =
  | { ok: true; data: ClaudeOAuthUsagePayload }
  | { ok: false; reason: string; status?: number };

function defaultCredentialsPath(): string {
  const override = process.env.CLAUDE_OAUTH_CREDENTIALS_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(homedir(), '.claude', '.credentials.json');
}

/** ~/.claude/.credentials.json 에서 claude.ai OAuth accessToken 추출 */
export function readClaudeAiOAuthAccessToken(credsPath = defaultCredentialsPath()): string | null {
  if (!existsSync(credsPath)) return null;
  try {
    const raw = readFileSync(credsPath, 'utf8');
    const j = JSON.parse(raw) as unknown;
    if (!j || typeof j !== 'object') return null;
    const root = j as Record<string, unknown>;
    const ai = root.claudeAiOauth;
    if (ai && typeof ai === 'object') {
      const tok = (ai as Record<string, unknown>).accessToken;
      if (typeof tok === 'string' && tok.length > 10) return tok;
    }
    const legacy = root.oauth;
    if (legacy && typeof legacy === 'object') {
      const tok = (legacy as Record<string, unknown>).accessToken;
      if (typeof tok === 'string' && tok.length > 10) return tok;
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchClaudeOAuthUsage(accessToken: string): Promise<OAuthUsageFetchResult> {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 18_000);
  try {
    const res = await fetch(ANTHROPIC_OAUTH_USAGE_URL, {
      method: 'GET',
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'anthropic-beta': ANTHROPIC_OAUTH_USAGE_BETA,
      },
    });
    clearTimeout(to);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'oauth_unauthorized', status: res.status };
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, reason: `http_${res.status}${t ? `: ${t.slice(0, 200)}` : ''}`, status: res.status };
    }
    const data = (await res.json()) as ClaudeOAuthUsagePayload;
    return { ok: true, data };
  } catch (e) {
    clearTimeout(to);
    const err = e as Error;
    return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : (err?.message || 'fetch_failed') };
  }
}

export async function loadOAuthUsageFromDisk(): Promise<OAuthUsageFetchResult> {
  const token = readClaudeAiOAuthAccessToken();
  if (!token) return { ok: false, reason: 'no_credentials' };
  return fetchClaudeOAuthUsage(token);
}
