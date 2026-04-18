import crypto from 'crypto';

// 프로젝트별 Git 푸시·PR 자동화에 쓰이는 개인 액세스 토큰을 "암호화 상태로"
// 서버 DB(Mongo 컬렉션 `project_git_credentials`) 에 보관하기 위한 단일 진입점.
//
// 설계 원칙:
//   1) 대칭 암호화는 AES-256-GCM 만 쓴다. 기밀성 + 무결성(인증태그) 을 한 번에
//      보장하므로, 토큰이 DB 덤프 경로로 새어 나가도 키 없이는 평문 복원이
//      불가능하고, 저장된 바이트가 외부에서 변조되면 복호화가 즉시 실패한다.
//   2) 마스터 키는 절대 코드/DB 에 고정하지 않는다. 환경변수 `GIT_TOKEN_ENC_KEY`
//      로만 주입하며, 누락되면 암호/복호 함수는 즉시 throw 한다. 배포 파이프라인
//      에서 키를 회전하려면 같은 환경변수를 교체한 뒤 저장된 자격증명을 재발급하면 된다.
//   3) API 응답에 평문 토큰을 실어 보내지 않는다. `toPublicView` 가 username 과
//      `hasToken: true` 플래그만 남겨, 클라이언트는 "저장되어 있는지" 만 알 수 있다.

export type GitCredentialProvider = 'github' | 'gitlab' | 'bitbucket' | 'generic';

// Mongo 저장 형태. tokenEncrypted 는 `iv(12) || authTag(16) || ciphertext` 바이트 열을
// base64 로 인코딩한 문자열이다. DB 바이트가 외부에 유출돼도 복호화는 키 없이 불가능.
export interface ProjectGitCredential {
  projectId: string;
  provider: GitCredentialProvider;
  username: string;
  tokenEncrypted: string;
  createdAt: string;
  updatedAt: string;
}

// 외부(REST·UI) 로 돌려주는 공개 뷰. 실제 토큰은 절대 포함하지 않는다. hasToken
// 플래그만으로 "해당 provider 에 자격증명이 이미 저장됐는가" 를 판정하게 한다.
export interface ProjectGitCredentialPublic {
  projectId: string;
  provider: GitCredentialProvider;
  username: string;
  hasToken: true;
  createdAt: string;
  updatedAt: string;
}

const KEY_ENV = 'GIT_TOKEN_ENC_KEY';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGO = 'aes-256-gcm';

// 환경변수에서 32바이트 키를 얻는다. hex(64자) / base64(32바이트) 를 먼저 시도하고,
// 어느 형식도 아니면 SHA-256 으로 압축해 "어떤 임의 문자열이든 32바이트로 수렴" 시킨다.
// 마지막 SHA-256 폴백은 운영 편의(비-16진 키를 임시로 쓰는 개발 환경)용이며,
// 프로덕션에서는 64자 hex 또는 44자 base64 를 사용하라.
function resolveKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw || !raw.trim()) {
    throw new Error(`[git-credentials] ${KEY_ENV} 환경변수가 설정되지 않았습니다`);
  }
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
  if (/^[A-Za-z0-9+/]{42,44}={0,2}$/.test(trimmed)) {
    try {
      const b = Buffer.from(trimmed, 'base64');
      if (b.length === 32) return b;
    } catch {
      // fall through to SHA-256 fallback
    }
  }
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest();
}

export function encryptToken(plainToken: string): string {
  if (typeof plainToken !== 'string' || plainToken.length === 0) {
    throw new Error('[git-credentials] 빈 토큰은 저장할 수 없습니다');
  }
  const key = resolveKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plainToken, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptToken(encoded: string): string {
  const key = resolveKey();
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error('[git-credentials] 암호문 길이가 비정상입니다');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function toPublicView(row: ProjectGitCredential): ProjectGitCredentialPublic {
  return {
    projectId: row.projectId,
    provider: row.provider,
    username: row.username,
    hasToken: true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// push 용 원격 URL 에 username/token 을 인라인 주입한다. HTTPS 기반 remote 에서만
// 의미가 있으며, SSH 는 별도 키 인증을 쓰므로 undefined 를 돌려 호출자가 기본
// 경로로 폴백하도록 한다. 토큰이 URL 쿼리/로그에 누수되지 않도록, 호출자는 반환된
// 문자열을 명령 인자로만 쓰고 stdout/stderr 에 직접 찍지 말아야 한다.
export function injectTokenIntoRemoteUrl(
  remoteUrl: string,
  username: string,
  token: string,
): string | undefined {
  try {
    const u = new URL(remoteUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    u.username = encodeURIComponent(username);
    u.password = encodeURIComponent(token);
    return u.toString();
  } catch {
    return undefined;
  }
}

// 원격 URL 문자열에서 `https://user:token@host/...` 형태의 인증 정보를 지워
// 로그/UI 에 절대 토큰이 새어 나가지 않도록 마스킹한다. 호출자는 stderr/stdout
// 을 직렬화하기 직전에 이 함수를 한 번 통과시키면 된다.
export function redactRemoteUrl(raw: string): string {
  return raw.replace(/(https?:\/\/)([^:@\s]+):([^@\s]+)@/gi, '$1$2:***@');
}

// 저장 가능한 provider 값을 검증한다. 잘못된 값이 들어오면 REST 엔드포인트에서
// 400 으로 거르는 단일 출처. 새 provider 를 추가할 때는 타입(GitCredentialProvider)
// 과 이 집합을 함께 갱신해야 한다.
const ALLOWED_PROVIDERS: ReadonlySet<GitCredentialProvider> = new Set<GitCredentialProvider>([
  'github',
  'gitlab',
  'bitbucket',
  'generic',
]);

export function isValidProvider(value: unknown): value is GitCredentialProvider {
  return typeof value === 'string' && ALLOWED_PROVIDERS.has(value as GitCredentialProvider);
}
