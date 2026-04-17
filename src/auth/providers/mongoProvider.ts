/**
 * 온프레미스 회원 관리 provider.
 * MongoDB users 컬렉션에 대해 scrypt 해시 기반 로그인/회원가입을 수행.
 */

import { MongoClient, Db, Collection } from 'mongodb';
import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { AuthConfig } from '../authConfig';
import type { AuthBackend, AuthUser, LoginInput, SignupInput } from '../authService';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>;

interface UserDoc {
  _id: string;
  username: string;
  email?: string;
  displayName?: string;
  avatarHue?: number;
  passwordHash: string;
  createdAt: Date;
}

const MIN_USERNAME = 3;
const MAX_USERNAME = 32;
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 256;
const USERNAME_RE = /^[a-z0-9._-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
const HASH_PREFIX = 'scrypt$';

function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

function normalizeEmail(raw?: string): string | undefined {
  const v = raw?.trim().toLowerCase();
  return v || undefined;
}

function looksLikeEmail(raw: string): boolean {
  return raw.includes('@');
}

function pickAvatarHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scryptAsync(plain, salt, SCRYPT_KEYLEN);
  return `${HASH_PREFIX}${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash.startsWith(HASH_PREFIX)) return false;
  const [, saltB64, derivedB64] = hash.split('$');
  if (!saltB64 || !derivedB64) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(derivedB64, 'base64');
  } catch {
    return false;
  }
  const actual = await scryptAsync(plain, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export class MongoAuthProvider implements AuthBackend {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private indexReady = false;

  constructor(private cfg: AuthConfig) {}

  private async users(): Promise<Collection<UserDoc>> {
    if (!this.client) {
      this.client = new MongoClient(this.cfg.mongoUri);
      await this.client.connect();
      this.db = this.client.db(this.cfg.mongoDb);
    }
    const col = this.db!.collection<UserDoc>('users');
    if (!this.indexReady) {
      await col.createIndex({ username: 1 }, { unique: true });
      await col.createIndex(
        { email: 1 },
        { unique: true, partialFilterExpression: { email: { $type: 'string' } } }
      );
      this.indexReady = true;
    }
    return col;
  }

  async login(input: LoginInput): Promise<AuthUser> {
    const raw = input.username ?? '';
    const password = input.password ?? '';
    const ident = raw.trim();
    if (!ident || !password) throw new Error('아이디와 비밀번호를 입력해 주세요.');
    const col = await this.users();
    const query = looksLikeEmail(ident)
      ? { email: normalizeEmail(ident) }
      : { username: normalizeUsername(ident) };
    const doc = await col.findOne(query);
    const ok = doc ? await verifyPassword(password, doc.passwordHash) : false;
    if (!doc || !ok) {
      throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.');
    }
    return this.toAuthUser(doc);
  }

  async signup(input: SignupInput): Promise<AuthUser> {
    const username = normalizeUsername(input.username ?? '');
    const password = input.password ?? '';
    const email = normalizeEmail(input.email);
    if (username.length < MIN_USERNAME || username.length > MAX_USERNAME) {
      throw new Error(`아이디는 ${MIN_USERNAME}~${MAX_USERNAME}자여야 합니다.`);
    }
    if (!USERNAME_RE.test(username)) {
      throw new Error('아이디는 영문 소문자·숫자·._- 만 사용할 수 있습니다.');
    }
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      throw new Error(`비밀번호는 ${MIN_PASSWORD}~${MAX_PASSWORD}자여야 합니다.`);
    }
    if (email && !EMAIL_RE.test(email)) {
      throw new Error('이메일 형식이 올바르지 않습니다.');
    }
    const col = await this.users();
    const id = `u_${Date.now()}_${randomBytes(4).toString('hex')}`;
    const doc: UserDoc = {
      _id: id,
      username,
      email,
      displayName: username,
      avatarHue: pickAvatarHue(username),
      passwordHash: await hashPassword(password),
      createdAt: new Date(),
    };
    try {
      await col.insertOne(doc);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new Error(duplicateKeyMessage(err));
      }
      throw err;
    }
    return this.toAuthUser(doc);
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    if (!id) return null;
    const col = await this.users();
    const doc = await col.findOne({ _id: id });
    return doc ? this.toAuthUser(doc) : null;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      this.indexReady = false;
    }
  }

  private toAuthUser(doc: UserDoc): AuthUser {
    return {
      id: doc._id,
      username: doc.username,
      email: doc.email,
      provider: 'mongo',
    };
  }
}

export function isDuplicateKeyError(err: unknown): boolean {
  const code = (err as { code?: number })?.code;
  return code === 11000 || code === 11001;
}

/**
 * Mongo duplicate-key 오류에서 충돌 필드를 읽어 사용자용 한국어 메시지로 변환.
 * keyPattern(권장)→keyValue→message 순으로 폴백하여, 드라이버/버전 차이에 견고하게 대응.
 */
export function duplicateKeyMessage(err: unknown): string {
  const e = err as {
    keyPattern?: Record<string, unknown>;
    keyValue?: Record<string, unknown>;
    message?: string;
  };
  const fieldFromPattern = e.keyPattern ? Object.keys(e.keyPattern)[0] : undefined;
  const fieldFromValue = e.keyValue ? Object.keys(e.keyValue)[0] : undefined;
  const field = fieldFromPattern ?? fieldFromValue;
  if (field === 'email') return '이미 사용 중인 이메일입니다.';
  if (field === 'username') return '이미 사용 중인 아이디입니다.';
  // 문자열 폴백: 인덱스 이름이 메시지에 포함되는 경우가 많음.
  if (e.message && /email/i.test(e.message)) return '이미 사용 중인 이메일입니다.';
  return '이미 사용 중인 아이디입니다.';
}

export const __testing = {
  normalizeUsername,
  normalizeEmail,
  pickAvatarHue,
  hashPassword,
  verifyPassword,
  looksLikeEmail,
  USERNAME_RE,
  EMAIL_RE,
};
