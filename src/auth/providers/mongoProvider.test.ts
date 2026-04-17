// Run with: tsx --test src/auth/providers/mongoProvider.test.ts
//
// MongoDB 연결이 필요한 login/signup/findUserById 경로는 통합 테스트로 다루고,
// 여기서는 provider 내부의 순수 헬퍼(정규화·해시·중복키 매핑)만 검증한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isDuplicateKeyError, duplicateKeyMessage, __testing } from './mongoProvider.ts';

const { normalizeUsername, normalizeEmail, pickAvatarHue, hashPassword, verifyPassword, looksLikeEmail, USERNAME_RE, EMAIL_RE } = __testing;

test('normalizeUsername — trims and lowercases', () => {
  assert.equal(normalizeUsername('  Alice  '), 'alice');
  assert.equal(normalizeUsername('BoB'), 'bob');
});

test('normalizeEmail — returns undefined for blank, lowercased otherwise', () => {
  assert.equal(normalizeEmail(undefined), undefined);
  assert.equal(normalizeEmail('   '), undefined);
  assert.equal(normalizeEmail('  Foo@Bar.COM '), 'foo@bar.com');
});

test('pickAvatarHue — deterministic in [0,360)', () => {
  const h = pickAvatarHue('alice');
  assert.equal(h, pickAvatarHue('alice'));
  assert.ok(h >= 0 && h < 360);
  assert.notEqual(pickAvatarHue('alice'), pickAvatarHue('bob'));
});

test('USERNAME_RE — allows lowercase alnum . _ - only', () => {
  assert.ok(USERNAME_RE.test('a.b_c-1'));
  assert.ok(!USERNAME_RE.test('Alice')); // 대문자 불가
  assert.ok(!USERNAME_RE.test('a b'));   // 공백 불가
  assert.ok(!USERNAME_RE.test('한글'));
});

test('looksLikeEmail — detects @ sign', () => {
  assert.equal(looksLikeEmail('a@b.co'), true);
  assert.equal(looksLikeEmail('alice'), false);
  assert.equal(looksLikeEmail(''), false);
});

test('EMAIL_RE — basic shape check', () => {
  assert.ok(EMAIL_RE.test('a@b.co'));
  assert.ok(!EMAIL_RE.test('no-at-sign'));
  assert.ok(!EMAIL_RE.test('a@b'));
});

test('hashPassword / verifyPassword — round trip, unique salt', async () => {
  const h1 = await hashPassword('secret123');
  const h2 = await hashPassword('secret123');
  assert.notEqual(h1, h2, '같은 비밀번호라도 salt 때문에 해시가 달라야 함');
  assert.ok(h1.startsWith('scrypt$'));
  assert.equal(await verifyPassword('secret123', h1), true);
  assert.equal(await verifyPassword('wrong', h1), false);
});

test('verifyPassword — rejects malformed hash strings', async () => {
  assert.equal(await verifyPassword('x', 'bcrypt$abc$def'), false);
  assert.equal(await verifyPassword('x', 'scrypt$onlyonepart'), false);
  assert.equal(await verifyPassword('x', ''), false);
});

test('isDuplicateKeyError — matches Mongo codes 11000/11001', () => {
  assert.equal(isDuplicateKeyError({ code: 11000 }), true);
  assert.equal(isDuplicateKeyError({ code: 11001 }), true);
  assert.equal(isDuplicateKeyError({ code: 1 }), false);
  assert.equal(isDuplicateKeyError(null), false);
  assert.equal(isDuplicateKeyError(undefined), false);
});

test('duplicateKeyMessage — uses keyPattern when available', () => {
  assert.equal(
    duplicateKeyMessage({ code: 11000, keyPattern: { email: 1 } }),
    '이미 사용 중인 이메일입니다.',
  );
  assert.equal(
    duplicateKeyMessage({ code: 11000, keyPattern: { username: 1 } }),
    '이미 사용 중인 아이디입니다.',
  );
});

test('duplicateKeyMessage — falls back to keyValue, then message', () => {
  assert.equal(
    duplicateKeyMessage({ code: 11000, keyValue: { email: 'x@y.z' } }),
    '이미 사용 중인 이메일입니다.',
  );
  assert.equal(
    duplicateKeyMessage({ code: 11000, message: 'E11000 dup key: users_email_1' }),
    '이미 사용 중인 이메일입니다.',
  );
  // pattern/value 없고 메시지에 email 없으면 username 기본
  assert.equal(
    duplicateKeyMessage({ code: 11000, message: 'dup on users_username_1' }),
    '이미 사용 중인 아이디입니다.',
  );
});
