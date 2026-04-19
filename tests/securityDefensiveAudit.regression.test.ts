// Run with: npx tsx --test tests/securityDefensiveAudit.regression.test.ts
//
// QA 회귀(지시 #369e1cfd) · 방어적 보안 감사 — 멀티미디어 입력·전역 오류 표면·
// 구독 세션 동기화의 위험 기반 검증.
//
// 범위
// ─────────────────────────────────────────────────────────────────────────────
//   SEC-1  mediaLoaders·mediaExporters 의 파일 타입 스푸핑·메타 주입 경로
//   SEC-2  이미지 붙여넣기(useMediaPasteCapture) dataURL·크기 가드
//   SEC-3  claudeSubscriptionSession localStorage/BroadcastChannel envelope 스키마
//   SEC-4  ErrorBoundary·Toast 경로가 서버 원문 메시지를 그대로 노출하는지
//
// React JSX 는 기본 이스케이핑되므로 직접적 XSS 경로는 `dangerouslySetInnerHTML`
// 사용처에 한해 발생 가능. 저장소 전체에 해당 API 는 0건인 것을 먼저 잠근다.
//
// 결정적 잠금 외의 실제 침투 재현은 수동 QA 절차(`docs/qa-security-defensive-audit-2026-04-19.md` §6) 로 이관.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR   = resolve(__dirname, '..', 'src');

function readSrc(rel: string): string {
  return readFileSync(resolve(SRC_DIR, rel), 'utf8');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

// ─── SEC-0 · 전역 XSS 표면이 없음을 잠근다 ────────────────────────────────────

test('SEC-0 · 저장소 어디에서도 dangerouslySetInnerHTML 을 사용하지 않는다', () => {
  const files = walk(SRC_DIR);
  const hits: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (/dangerouslySetInnerHTML/.test(text)) hits.push(f.replace(SRC_DIR, 'src'));
  }
  assert.deepEqual(hits, [],
    `dangerouslySetInnerHTML 사용처가 발견되었다. React 기본 이스케이핑을 우회하므로 XSS 경로가 열린다. 파일: ${hits.join(', ')}`);
});

test('SEC-0 · document.write / innerHTML 할당을 src 어디에서도 쓰지 않는다', () => {
  const files = walk(SRC_DIR);
  const hits: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (/document\.write\b|\.innerHTML\s*=/.test(text)) hits.push(f.replace(SRC_DIR, 'src'));
  }
  assert.deepEqual(hits, [],
    `document.write 또는 innerHTML 할당이 검출됐다. 입력이 통제된 경우여도 회귀 위험이 크므로 사용 금지. 파일: ${hits.join(', ')}`);
});

// ─── SEC-1 · mediaLoaders 입력 경계 ───────────────────────────────────────────

test('SEC-1 · detectMediaKind 는 판정 실패 시 null 을 반환해 업로드 자체가 중단되어야 한다', () => {
  const src = readSrc('utils/mediaLoaders.ts');
  assert.match(src, /return null/,
    '판정 실패 분기가 사라지면 알 수 없는 확장자 파일이 업로드 경로에 무조건 진입한다');
});

test('SEC-1 · uploadParseableFile 은 maxBytes 가드(기본 50MB)로 대용량을 즉시 차단한다', () => {
  const src = readSrc('utils/mediaLoaders.ts');
  assert.match(src, /DEFAULT_MAX_BYTES/);
  assert.match(src, /FILE_TOO_LARGE/);
});

// ─── SEC-2 · 이미지 붙여넣기 경로 ─────────────────────────────────────────────

test('SEC-2 · useMediaPasteCapture 는 기본 preventDefault=true 로 편집창 이중 삽입을 막는다', () => {
  const src = readSrc('utils/useMediaPasteCapture.ts');
  assert.match(src, /preventDefaultOnFiles\s*!==\s*false/,
    '기본값이 false 로 바뀌면 사용자가 붙여넣은 파일이 편집창에 base64 원문으로 추가 삽입될 위험');
});

test('SEC-2 · blobToDataUrl 은 FileReader·ArrayBuffer 두 경로 모두 mime 폴백을 "application/octet-stream" 으로 고정', () => {
  const src = readSrc('utils/mediaLoaders.ts');
  assert.match(src, /blob\.type \|\| fallbackMime \|\| 'application\/octet-stream'/,
    'mime 폴백이 text/html 계열이 되면 dataUrl 이 스크립트로 재해석될 위험');
});

// SEC-DEF-1 — extractFilesFromClipboard 에 크기 상한 없음(현재 결함).
test.skip('SEC-DEF-1 · extractFilesFromClipboard 에 maxTotalBytes 가드가 도입되면 회귀 잠금', () => {
  const src = readSrc('utils/mediaLoaders.ts');
  assert.match(src, /maxTotalBytes/,
    '붙여넣기 경로 초입에서 합계 크기 가드가 없어 악성 클립보드로 수백 MB 할당이 1회 발생할 수 있다');
});

// SEC-DEF-3 — 기본 acceptPrefix 화이트리스트(현재 미적용).
test.skip('SEC-DEF-3 · extractFilesFromClipboard 기본 acceptPrefix 가 이미지·PDF·PPT 화이트리스트로 제한되면 회귀 잠금', () => {
  const src = readSrc('utils/mediaLoaders.ts');
  // 수정 후 기대 패턴: const DEFAULT_CLIPBOARD_ALLOW = ['image/', 'application/pdf', ...]
  assert.match(src, /DEFAULT_CLIPBOARD_ALLOW/,
    '화이트리스트 없이 임의 MIME 을 통과시키면 실행 파일·스크립트 MIME 이 onFiles 로 흘러간다');
});

// ─── SEC-3 · claudeSubscriptionSession 세션 동기화 ────────────────────────────

test('SEC-3 · 저장 페이로드에 민감 토큰이 들어가지 않는다(스키마 상 필드가 4개 메타만)', () => {
  const src = readSrc('utils/claudeSubscriptionSession.ts');
  // Persisted 스키마 필드 고정. 새 필드 추가 시 검토 강제.
  const persistedFields = src.match(/export interface PersistedSubscriptionSession \{[\s\S]{0,400}?\}/);
  assert.ok(persistedFields, 'PersistedSubscriptionSession 인터페이스를 찾지 못했다 — 스키마 감시 불가');
  const body = persistedFields![0];
  // 허용 필드만 존재해야 한다. 추가되면 이 테스트가 떨어져 리뷰를 강제.
  for (const allowed of ['schemaVersion', 'state', 'status', 'statusReason', 'savedAtMs']) {
    assert.ok(body.includes(allowed), `PersistedSubscriptionSession 이 ${allowed} 필드를 잃으면 새로고침 복원이 깨진다`);
  }
  // API 토큰·세션쿠키 등을 시사하는 이름이 들어가면 즉시 실패.
  assert.doesNotMatch(body, /token|secret|apiKey|password|bearer|cookie/i,
    'Persisted 스키마에 민감 토큰 이름이 들어가면 localStorage 평문 저장이 위험해진다');
});

test('SEC-3 · parseSessionSyncEnvelope 는 스키마 버전·필수 필드를 엄격 검증한다', () => {
  const src = readSrc('utils/claudeSubscriptionSession.ts');
  assert.match(src, /if \(r\.schemaVersion !== 1\) return null/,
    '스키마 검증이 느슨해지면 악의적 탭(또는 브라우저 확장) 이 envelope 를 위조해 세션 역행 가능');
  assert.match(src, /if \(r\.kind !== 'state' && r\.kind !== 'status'\) return null/);
  assert.match(src, /if \(typeof r\.tabId !== 'string' \|\| r\.tabId\.length === 0\) return null/);
});

test('SEC-3 · shouldAcceptSyncEnvelope 는 기본 maxAge 60초로 재생 공격을 거절한다', () => {
  const src = readSrc('utils/claudeSubscriptionSession.ts');
  assert.match(src, /maxAgeMs\s*&&\s*params\.maxAgeMs\s*>\s*0\s*\?\s*params\.maxAgeMs\s*:\s*60_000/,
    '기본 60초 재생 방어가 해제되면 오래된 exhausted envelope 가 세션을 뒤집는다');
});

// SEC-DEF-5 — origin 검증 훅 미도입(현재 결함).
test.skip('SEC-DEF-5 · shouldAcceptSyncEnvelope 에 선택적 originCheck 콜백이 도입되면 회귀 잠금', () => {
  const src = readSrc('utils/claudeSubscriptionSession.ts');
  assert.match(src, /originCheck\??:\s*\(envelope: SessionSyncEnvelope\) => boolean/);
});

// ─── SEC-4 · ErrorBoundary·Toast 정보 누출 경로 ──────────────────────────────

test('SEC-4 · ErrorBoundary 는 mapUnknownError 경유로 서버 원문을 한 번 정화한다', () => {
  const src = readSrc('components/ErrorBoundary.tsx');
  // mapUnknownError 호출이 사라지면 서버 원문 Error.message 가 title 로 그대로 노출된다.
  assert.match(src, /mapUnknownError\(/);
});

test('SEC-4 · 토스트 버스 emit 경로가 title/body/variant 3 필드만 받는 좁은 타입을 유지한다', () => {
  const toastSrc = readSrc('components/ToastProvider.tsx');
  // Toast 버스 타입을 과도하게 자유롭게 바꾸면 임의 HTML 이 주입될 수 있다.
  assert.match(toastSrc, /title\s*:\s*string/);
  assert.match(toastSrc, /body\??:\s*string/);
});

// SEC-DEF-2 — mapUnknownError 가 원문 body 를 그대로 노출(현재 결함).
test.skip('SEC-DEF-2 · mapUnknownError 가 허용되지 않은 코드·메시지에 대해 서버 원문을 노출하지 않는다', () => {
  const src = readSrc('utils/errorMessages.ts');
  // 수정 후 기대 동작: 구조화 code 미매치 시 body 에 err.message 를 붙이지 않고
  // 안내 문구+'자세히는 콘솔 참조' 로 수렴.
  assert.doesNotMatch(src, /body:\s*msg\s*}/,
    '원문 메시지를 body 로 그대로 복사하면 서버 스택 트레이스·내부 경로가 토스트로 유출될 수 있다');
});

// ─── SEC-5 · 다운로드 URL 안전성 ──────────────────────────────────────────────

test('SEC-5 · prepareDownload 는 텍스트 본문을 encodeURIComponent 로 이스케이프해 data URL 을 만든다', () => {
  const src = readSrc('utils/mediaExporters.ts');
  assert.match(src, /data:text\/plain;charset=utf-8,\$\{encodeURIComponent\(text\)\}/,
    'encodeURIComponent 가 빠지면 개행·따옴표가 URL 파싱을 깨뜨려 다운로드 실패 또는 의외 해석');
});

// SEC-DEF-4 — data URL 길이 상한 미지정(현재 결함).
test.skip('SEC-DEF-4 · prepareDownload 텍스트 상한(예: 512KB) 초과 시 Blob + createObjectURL 경로로 전환되면 회귀 잠금', () => {
  const src = readSrc('utils/mediaExporters.ts');
  assert.match(src, /createObjectURL|MAX_DATA_URL_BYTES/,
    'data URL 은 브라우저별 상한(~2MB) 이 있어, 긴 추출 본문은 Blob 경로로 분기해야 한다');
});

// ─── META · 보안 보고서 섹션 동기화 가드 ──────────────────────────────────────

test('META · 보안 감사 보고서 §번호가 본 테스트와 동기화돼 있다', () => {
  const doc = readFileSync(
    resolve(__dirname, '..', 'docs', 'qa-security-defensive-audit-2026-04-19.md'),
    'utf8',
  );
  for (const marker of ['SEC-DEF-1', 'SEC-DEF-2', 'SEC-DEF-3', 'SEC-DEF-4', 'SEC-DEF-5']) {
    assert.ok(doc.includes(marker), `${marker} 섹션이 보고서에서 사라지면 본 테스트 근거가 끊긴다`);
  }
});
