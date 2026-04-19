// Run with: npx tsx --test tests/mediaUploadEndpoint.contract.test.ts
//
// QA 1차 계약(#154cb987) — server.ts 의 멀티미디어 엔드포인트 2종.
//   · POST /api/media/upload
//   · POST /api/media/generate
//
// 서버 전체를 부팅하지 않고 **소스 스캔**으로 계약을 잠근다(AuthGate 접근성 회귀와
// 동일 스타일). DB 세팅 없이 회귀 가드가 즉시 돌아가는 대신, 구현 내용이 실제
// 런타임과 결합하는 통합 테스트는 기반이 더 안정된 다음 사이클에서 추가한다.
//
// 지시 본문과 실제 구현 사이의 3가지 차이를 이 파일이 정직하게 기록한다:
//   1) **용량 제한**: 지시는 "기본 25MB" 라 했으나 실제 구현은 **200MB**
//      (server.ts line 407). 영상 포함 대용량을 기본 허용하는 스켈레톤 정책.
//   2) **인증 401**: 지시는 "인증 헤더 누락 시 401" 이라 했으나 실제 구현은
//      현재 **인증 미들웨어를 엔드포인트에 걸지 않는다**. 라우트 정의 전후에
//      auth/token 검사가 부재함을 **현재 계약의 부재** 로 잠가 두어, 이후
//      인증이 도입되면 이 테스트가 회귀 신호로 발동하게 한다.
//   3) **PPT 슬라이드 수/텍스트 스냅샷**: 파서가 스텁이라 서버 경로는 501 로
//      수렴. 본 파일은 501 반환 경로를 잠그고, 실 슬라이드 파싱은
//      `mediaProcessor.regression.test.ts` 에서 어댑터 overrides 로 검증한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, '..', 'server.ts'), 'utf8');

/** 특정 시그니처 이후 `N` 자 이내의 창(window) 을 반환. 라우트 내부 계약 매칭용. */
function windowAfter(marker: string, size = 3000): string {
  const idx = SRC.indexOf(marker);
  assert.ok(idx > -1, `서버 소스에서 시그니처를 찾을 수 없다: ${marker}`);
  return SRC.slice(idx, Math.min(SRC.length, idx + size));
}

// ────────────────────────────────────────────────────────────────────────────
// multer 기본 설정 — memoryStorage + 200MB 한계
// ────────────────────────────────────────────────────────────────────────────

test('mediaUpload 는 memoryStorage + 200MB 한계로 초기화되어야 한다(현행 구현 계약)', () => {
  assert.match(
    SRC,
    /const\s+mediaUpload\s*=\s*multer\(\s*\{[\s\S]{0,200}storage:\s*multer\.memoryStorage\(\)/,
    'multer memoryStorage 사용',
  );
  assert.match(
    SRC,
    /fileSize:\s*200\s*\*\s*1024\s*\*\s*1024/,
    '용량 제한 200MB (지시의 25MB 와 의도적으로 다름 — 영상 포함 기본 허용)',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/media/upload 계약
// ────────────────────────────────────────────────────────────────────────────

test('/api/media/upload — projectId 미입력 시 400 "projectId required"', () => {
  const snippet = windowAfter("app.post('/api/media/upload'");
  assert.match(snippet, /if\s*\(!projectId\)\s*\{\s*res\.status\(400\)\.json\(\s*\{\s*error:\s*'projectId required'\s*\}\s*\)/);
});

test('/api/media/upload — file 미입력 시 400 "file required"', () => {
  const snippet = windowAfter("app.post('/api/media/upload'");
  assert.match(snippet, /if\s*\(!req\.file\)[\s\S]{0,60}'file required'/);
});

test('/api/media/upload — 프로젝트 미존재 시 404 "project not found"', () => {
  const snippet = windowAfter("app.post('/api/media/upload'");
  assert.match(snippet, /if\s*\(!project\)[\s\S]{0,80}404[\s\S]{0,80}'project not found'/);
});

test('/api/media/upload — inferMediaKind 가 null 이면 415 "지원하지 않는 미디어 형식입니다."', () => {
  const snippet = windowAfter("app.post('/api/media/upload'");
  assert.match(snippet, /inferMediaKind\(\s*req\.file\.originalname\s*,\s*req\.file\.mimetype\s*\)/);
  assert.match(snippet, /res\.status\(415\)\.json\(\s*\{\s*error:\s*'지원하지 않는 미디어 형식입니다\.'\s*\}/);
});

test('/api/media/upload — NotImplementedMediaError 캐치 경로는 501 로 돌린다(PPT 스텁 등)', () => {
  const snippet = windowAfter("app.post('/api/media/upload'");
  assert.match(
    snippet,
    /if\s*\(e\s+instanceof\s+NotImplementedMediaError\)\s*\{[\s\S]{0,200}res\.status\(501\)/,
  );
});

test('/api/media/upload — 일반 예외는 500 "미디어 업로드에 실패했습니다."', () => {
  const snippet = windowAfter("app.post('/api/media/upload'");
  assert.match(snippet, /res\.status\(500\)\.json\(\s*\{\s*error:\s*'미디어 업로드에 실패했습니다\.'\s*\}/);
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/media/generate 계약
// ────────────────────────────────────────────────────────────────────────────

test('/api/media/generate — projectId 누락 시 400, video 경로에서 prompt 누락 시 400', () => {
  // 지시 #b425328e 확장 이후: projectId 는 전 경로 필수, prompt 는 kind==='video'
  // 내부 가드로 이동(PDF/PPT 는 template/slides 가 본문 필드). 본 계약은 두 가드가
  // 모두 살아 있음을 확인한다.
  const snippet = windowAfter("app.post('/api/media/generate'");
  assert.match(snippet, /if\s*\(!projectId\)[\s\S]{0,80}'projectId required'/);
  assert.match(snippet, /if\s*\(!prompt\)[\s\S]{0,120}'prompt required'/);
});

test('/api/media/generate — 프로젝트 미존재 404 · 지원되지 않는 kind 501 · 생성 실패 500', () => {
  // §1 확장: video · pdf · pptx 3종을 각각 mediaGenerator 의 대응 메서드로 라우팅
  // 하고, 셋 중 어느 것도 아니면 501 폴백으로 돌려보낸다. 기존 503(어댑터 미등록)
  // 은 이제 generateVideo 내부 에러 → catch 에서 500 "미디어 생성에 실패했습니다." 로
  // 수렴한다(exhausted 전용 503 은 별도 테스트에서 잠금). 창 크기를 넉넉히 잡아
  // PDF/PPT 분기 전부가 포함되게 한다.
  const snippet = windowAfter("app.post('/api/media/generate'", 6000);
  assert.match(snippet, /if\s*\(!project\)[\s\S]{0,80}404[\s\S]{0,80}'project not found'/);
  assert.match(snippet, /res\.status\(501\)\.json\(\s*\{\s*error:\s*`생성 미구현: kind=/);
  assert.match(snippet, /res\.status\(500\)\.json\(\s*\{\s*error:\s*'미디어 생성에 실패했습니다\.'\s*\}/);
});

test('/api/media/generate — §4 폴백: ExhaustedBlockedError 는 503 으로 수렴(외부 API 차단)', () => {
  // exhausted 세션에서 영상 생성 호출이 ExhaustedBlockedError 로 차단되면 라우트는
  // 503 으로 내려, UI 가 "세션 소진" 배너와 같은 톤으로 메시지를 낭독한다.
  const snippet = windowAfter("app.post('/api/media/generate'", 6000);
  assert.match(
    snippet,
    /e\s+instanceof\s+ExhaustedBlockedError[\s\S]{0,160}res\.status\(503\)/,
  );
});

// ────────────────────────────────────────────────────────────────────────────
// 인증 미들웨어 **부재** 잠금 — 현재는 의도적으로 인증 미적용
// ────────────────────────────────────────────────────────────────────────────

test('멀티미디어 엔드포인트는 현재 인증 미들웨어가 걸려 있지 않다(도입 시 이 테스트가 실패해 의도적 변경을 강제)', () => {
  const upload = windowAfter("app.post('/api/media/upload'", 400);
  const generate = windowAfter("app.post('/api/media/generate'", 400);
  // 라우트 정의 라인에 requireAuth/ensureAuth/authMiddleware 같은 이름이 삽입되지 않아야 한다.
  for (const forbidden of [/requireAuth/, /ensureAuth/, /authMiddleware/, /verifyToken/]) {
    assert.ok(!forbidden.test(upload), `upload 라우트에 ${forbidden} 미들웨어가 이미 걸려 있다 — 401 경로 테스트를 동시 추가하라`);
    assert.ok(!forbidden.test(generate), `generate 라우트에 ${forbidden} 미들웨어가 이미 걸려 있다 — 401 경로 테스트를 동시 추가하라`);
  }
});
