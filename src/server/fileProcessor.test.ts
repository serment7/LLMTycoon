// Run with: npx tsx --test src/server/fileProcessor.test.ts
//
// QA: 서버 측 첨부 처리(fileProcessor.ts) 회귀 가드 (#FILE-PROC).
// processDirectiveFile / loadDirectiveRecord 두 export 만 직접 호출해 다음을 못박는다.
//
//   (1) PDF 업로드 → extractedText/images 가 모두 채워진 레코드로 저장
//   (2) PNG/JPEG 업로드 → kind=image, extractedText 빈 문자열, data URL 1장
//   (3) TXT 업로드 → kind=text, 본문 그대로 (UTF-8 보존)
//   (4) 동시 다중 업로드 → 같은 projectId 폴더 안에서 fileId 가 충돌하지 않음
//   (5) 알 수 없는 확장자/MIME 은 text 로 폴백 (서버는 거부하지 않고 텍스트로 처리)
//   (6) loadDirectiveRecord 라운드트립: 저장한 레코드를 그대로 다시 읽는다
//   (7) 에이전트 프롬프트 합성에 그대로 쓸 수 있는 구조 (extractedText/images 필드 보장)
//
// 본 파일에서 다루지 않는 시나리오 (사유):
//   - 20MiB 초과 거부 → 거부는 server.ts:251 의 multer({limits:{fileSize:25MiB}}) +
//     상위 핸들러에서 발생. fileProcessor 자체는 buffer 를 받는 순수 함수라 크기 검증
//     의무가 없다. (참고: multer limit 25MiB ≠ 사용자 노출 20MiB → 별도 가드 필요.)
//   - 미지원 확장자 차단 / 네트워크 재시도 / 삭제 버튼 → 라우트·UI 레벨이라
//     /api/directive/upload 의 통합 테스트에서 다룬다.
//
// 픽스처: os.tmpdir() 에 임시 dataRoot 를 잡고 t.after 에서 일괄 정리.
// 저장소를 더럽히지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  processDirectiveFile,
  loadDirectiveRecord,
  type DirectiveFileRecord,
} from './fileProcessor.ts';

// 1x1 투명 PNG. 추출 결과의 data URL 페이로드가 base64(PNG_1x1) 와 일치하는지
// 검증해, "이미지 첨부의 원본 보존" 규약을 못박는다.
const PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
const PNG_1x1 = Buffer.from(PNG_1x1_BASE64, 'base64');

// 작은 1페이지 PDF. xref 가 정상 형태이므로 pdf-parse 가 0개 페이지로라도 파싱한다.
const MIN_PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<<>>>>endobj',
    'xref',
    '0 4',
    '0000000000 65535 f ',
    '0000000009 00000 n ',
    '0000000053 00000 n ',
    '0000000099 00000 n ',
    'trailer<</Size 4/Root 1 0 R>>',
    'startxref',
    '0',
    '%%EOF',
    '',
  ].join('\n'),
);

interface Sandbox { root: string; }

function makeSandbox(): Sandbox {
  return { root: mkdtempSync(path.join(tmpdir(), 'llm-tycoon-fileproc-')) };
}

function disposeSandbox(s: Sandbox) {
  rmSync(s.root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (3) TXT — 가장 단순한 경로. "본문이 그대로 들어갔다" 가 핵심 계약.
// ---------------------------------------------------------------------------

test('TC-FP-01: TXT 첨부는 kind=text, extractedText 가 buffer 의 UTF-8 문자열', async (t) => {
  const sb = makeSandbox();
  t.after(() => disposeSandbox(sb));

  const rec = await processDirectiveFile({
    projectId: 'proj-A',
    originalName: 'note.txt',
    buffer: Buffer.from('hello 첨부 world', 'utf8'),
    mimeType: 'text/plain',
    dataRoot: sb.root,
  });
  assert.equal(rec.type, 'text');
  assert.equal(rec.name, 'note.txt');
  assert.equal(rec.extractedText, 'hello 첨부 world');
  assert.deepEqual(rec.images, []);
  // fileId 는 uuid v4 형태로 생성되어야 한다.
  assert.match(rec.fileId, /^[0-9a-f-]{36}$/);
});

test('TC-FP-02: 한글·이모지를 포함한 UTF-8 본문이 손실 없이 저장된다', async (t) => {
  const sb = makeSandbox();
  t.after(() => disposeSandbox(sb));
  const original = '안녕하세요 🚀\n두 번째 줄';
  const rec = await processDirectiveFile({
    projectId: 'proj-A',
    originalName: 'multi.txt',
    buffer: Buffer.from(original, 'utf8'),
    dataRoot: sb.root,
  });
  assert.equal(rec.extractedText, original);
});

// ---------------------------------------------------------------------------
// (2) 이미지 — base64 data URL 1장으로 환원. 원본 바이트 보존이 계약.
// ---------------------------------------------------------------------------

test('TC-FP-03: PNG 첨부는 kind=image, images=[data:image/png;base64,<원본>]', async (t) => {
  const sb = makeSandbox();
  t.after(() => disposeSandbox(sb));

  const rec = await processDirectiveFile({
    projectId: 'proj-A',
    originalName: 'icon.png',
    buffer: PNG_1x1,
    mimeType: 'image/png',
    dataRoot: sb.root,
  });
  assert.equal(rec.type, 'image');
  assert.equal(rec.extractedText, '');
  assert.equal(rec.images.length, 1);
  assert.equal(rec.images[0], `data:image/png;base64,${PNG_1x1_BASE64}`);
});

test('TC-FP-04: JPEG 는 mimeType 누락 시에도 확장자로 image/jpeg data URL 생성', async (t) => {
  const sb = makeSandbox();
  t.after(() => disposeSandbox(sb));

  // 실제 JPEG 바이트 대신 JPEG 시그니처만 — fileProcessor 는 디코더 없이 base64 만 만든다.
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const rec = await processDirectiveFile({
    projectId: 'proj-A',
    originalName: 'photo.jpg',
    buffer: fakeJpeg,
    dataRoot: sb.root,
  });
  assert.equal(rec.type, 'image');
  assert.equal(rec.images.length, 1);
  assert.match(rec.images[0], /^data:image\/jpeg;base64,/);
  // 본문은 fakeJpeg 의 base64 와 일치해야 한다.
  const b64 = rec.images[0].split(',')[1];
  assert.equal(b64, fakeJpeg.toString('base64'));
});

// ---------------------------------------------------------------------------
// (5) 알 수 없는 형식은 text 폴백 (현 구현 계약). 서버는 거부하지 않고 받아들여
// 모델이 본문으로 읽도록 한다 — 거부는 multer/handler 역할.
// ---------------------------------------------------------------------------

test('TC-FP-05: 미지원 확장자(.bin) 는 text 로 폴백되어 buffer.toString(utf8) 으로 보관', async (t) => {
  const sb = makeSandbox();
  t.after(() => disposeSandbox(sb));
  const rec = await processDirectiveFile({
    projectId: 'proj-A',
    originalName: 'blob.bin',
    buffer: Buffer.from('any-bytes', 'utf8'),
    dataRoot: sb.root,
  });
  assert.equal(rec.type, 'text');
  assert.equal(rec.extractedText, 'any-bytes');
});

// ---------------------------------------------------------------------------
// (1) PDF — pdf-parse 가 빈 텍스트라도 정상 종료하는 경계 케이스.
// pdfjs/canvas 를 통한 페이지 렌더는 환경에 따라 실패할 수 있는데(폰트/네이티브
// 빌드), 그 경우에도 try/catch 로 흡수되어 "텍스트는 있고 images 는 비어있는"
// 레코드가 떨어져야 한다 (서버 로그에 warning 남기는 것은 허용).
// ---------------------------------------------------------------------------

// 2026-04-18 dev 수정: extractPdf 가 pdf-parse v2 의 PDFParse 클래스 API 로 교체되어
// todo 가드를 해제한다. 이제 이 테스트는 hard-gate 로 동작 — PDF 추출이 다시 깨지면
// CI 가 바로 붉게 뜬다.
test(
  'TC-FP-06: 최소 PDF 는 type=pdf 로 분류, extractedText/images 필드 모두 정의됨',
  async (t) => {
    const sb = makeSandbox();
    t.after(() => disposeSandbox(sb));

    const rec = await processDirectiveFile({
      projectId: 'proj-A',
      originalName: 'tiny.pdf',
      buffer: MIN_PDF,
      mimeType: 'application/pdf',
      dataRoot: sb.root,
    });
    assert.equal(rec.type, 'pdf');
    // 빈 페이지여도 string 이어야 한다 (undefined 면 프롬프트 합성에서 "undefined" 가 박힌다).
    assert.equal(typeof rec.extractedText, 'string');
    // images 는 배열이어야 한다 (렌더 실패 시 빈 배열도 허용).
    assert.ok(Array.isArray(rec.images));
  },
);

// ---------------------------------------------------------------------------
// (6) loadDirectiveRecord 라운드트립
// ---------------------------------------------------------------------------

test('TC-FP-07: loadDirectiveRecord 는 저장한 레코드와 deepEqual 한 값을 반환', async (t) => {
  const sb = makeSandbox();
  t.after(() => disposeSandbox(sb));

  const saved = await processDirectiveFile({
    projectId: 'proj-RT',
    originalName: 'rt.txt',
    buffer: Buffer.from('round-trip body', 'utf8'),
    dataRoot: sb.root,
  });
  // 디스크에 JSON 이 실제로 떨어졌는지도 확인.
  const jsonPath = path.join(sb.root, 'proj-RT', `${saved.fileId}.json`);
  assert.ok(existsSync(jsonPath), 'JSON 파일이 디스크에 저장되어야 한다');
  const onDisk = JSON.parse(readFileSync(jsonPath, 'utf8')) as DirectiveFileRecord;
  assert.deepEqual(onDisk, saved);

  const loaded = loadDirectiveRecord('proj-RT', saved.fileId, sb.root);
  assert.deepEqual(loaded, saved);
});

test('TC-FP-08: loadDirectiveRecord 는 존재하지 않는 fileId 에 대해 throw', () => {
  const sb = makeSandbox();
  try {
    assert.throws(() => loadDirectiveRecord('proj-NA', 'no-such-id', sb.root));
  } finally { disposeSandbox(sb); }
});

// ---------------------------------------------------------------------------
// (4) 동시 다중 업로드: fileId 충돌 없음 + 각 파일 독립적으로 디스크에 떨어짐
// ---------------------------------------------------------------------------

test('TC-FP-09: 같은 projectId 로 N 개를 병렬 처리해도 fileId 가 모두 고유', async (t) => {
  const sb = makeSandbox();
  t.after(() => disposeSandbox(sb));

  const N = 8;
  const recs = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      processDirectiveFile({
        projectId: 'proj-MULTI',
        originalName: `f${i}.txt`,
        buffer: Buffer.from(`body-${i}`, 'utf8'),
        dataRoot: sb.root,
      }),
    ),
  );
  const ids = new Set(recs.map((r) => r.fileId));
  assert.equal(ids.size, N, '병렬 처리에서 fileId 충돌이 발생했다');
  // 각 파일이 독립적으로 디스크에 존재하고, 본문이 섞이지 않았는지 확인.
  for (let i = 0; i < N; i++) {
    const r = recs[i];
    const jsonPath = path.join(sb.root, 'proj-MULTI', `${r.fileId}.json`);
    assert.ok(existsSync(jsonPath));
    assert.equal(r.extractedText, `body-${i}`);
  }
});

// ---------------------------------------------------------------------------
// (7) 프롬프트 합성에 들어가는 구조 — 필드 누락 회귀 가드
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (1) PDF 계약 — 파일 픽스처 기반 + pdf-parse v2 호출 회귀 가드
// ---------------------------------------------------------------------------
//
// TC-FP-06 이 인라인 상수로 "분류/필드 존재" 를 검증한다면, 아래 세 테스트는
// 실제 파일을 읽어서 들어온 버퍼로도 동일 계약이 성립하는지를 못박는다.
//
// 픽스처: tests/fixtures/sample.pdf — 레포에 체크인된 최소 PDF.
// 누락 시 MIN_PDF 상수(위) 로 폴백해 CI 가 fixture 부재로 실패하지 않게 한다.
// (task 지시: "없으면 pdfkit 로 런타임 생성 또는 아주 작은 더미 PDF 바이트 상수 사용").

const SAMPLE_PDF_PATH = fileURLToPath(
  new URL('../../tests/fixtures/sample.pdf', import.meta.url),
);

function loadSamplePdf(): { buffer: Buffer; source: 'fixture' | 'inline' } {
  try {
    return { buffer: readFileSync(SAMPLE_PDF_PATH), source: 'fixture' };
  } catch {
    // 픽스처가 아직 체크인되지 않은 개발 브랜치에서도 테스트가 계약을 검증할 수 있게
    // MIN_PDF 로 폴백. CI 가 조용히 픽스처 부재를 눈치채게 표시는 남겨 둔다.
    return { buffer: MIN_PDF, source: 'inline' };
  }
}

test('TC-FP-11: tests/fixtures/sample.pdf 를 읽어 처리 → type=pdf, extractedText:string, images:string[]', async (t) => {
  const sb = makeSandbox();
  t.after(() => disposeSandbox(sb));

  const { buffer, source } = loadSamplePdf();
  if (source === 'inline') {
    t.diagnostic('[TC-FP-11] tests/fixtures/sample.pdf 없음 — MIN_PDF 로 폴백 (계약만 검증)');
  }

  const rec = await processDirectiveFile({
    projectId: 't',
    originalName: 'a.pdf',
    buffer,
    mimeType: 'application/pdf',
    dataRoot: sb.root,
  });

  assert.equal(rec.type, 'pdf', 'PDF 업로드는 kind=pdf 로 분류돼야 한다');
  assert.equal(rec.name, 'a.pdf');
  assert.equal(typeof rec.extractedText, 'string', 'extractedText 는 string — 빈 문자열도 허용');
  assert.ok(Array.isArray(rec.images), 'images 는 배열 — 렌더 실패 시 빈 배열도 허용');
  for (const img of rec.images) {
    assert.equal(typeof img, 'string', 'images 배열의 원소는 string(data URL)');
  }
  // fileId 는 uuid v4 형태.
  assert.match(rec.fileId, /^[0-9a-f-]{36}$/);
});

test('TC-FP-12: PDF 입력 처리 중 "pdfParse is not a function" TypeError 회귀가 없다', async (t) => {
  // 과거 regressions: pdf-parse v2 전환 시 `pdfParseMod.default || pdfParseMod` 경로가
  // namespace 객체를 함수로 호출해 TypeError 를 던졌다. 이 테스트는 "처리가 성공하고
  // TypeError 가 아니었다" 를 긍정 경로와 부정 경로에서 모두 못박는다.
  const sb = makeSandbox();
  t.after(() => disposeSandbox(sb));

  const { buffer } = loadSamplePdf();
  let error: unknown = null;
  try {
    await processDirectiveFile({
      projectId: 't',
      originalName: 'regression.pdf',
      buffer,
      mimeType: 'application/pdf',
      dataRoot: sb.root,
    });
  } catch (e) {
    error = e;
  }

  // 긍정 경로: 에러 자체가 없어야 한다.
  assert.equal(error, null, 'PDF 처리가 예외 없이 끝나야 한다');

  // 부정 경로(방어): 만에 하나 다른 이유로 실패했더라도 v2 호출 시그니처 회귀는 아닌지
  // 메시지 수준에서 검증한다. 이 assert 는 error===null 이면 자동 통과.
  if (error instanceof Error) {
    assert.ok(
      !(error instanceof TypeError) ||
        !/pdfParse is not a function/i.test(error.message),
      `pdf-parse v2 호출 시그니처가 다시 깨졌다: ${error.message}`,
    );
  }
});

test('TC-FP-13: 처리 후 JSON 레코드가 실제 디스크에 존재하고 after-hook 이 정리한다', async (t) => {
  const sb = makeSandbox();
  // 정리 검증을 위해 sandbox 경로를 hook 바깥에도 노출.
  t.after(() => disposeSandbox(sb));

  const { buffer } = loadSamplePdf();
  const rec = await processDirectiveFile({
    projectId: 't',
    originalName: 'disk-check.pdf',
    buffer,
    mimeType: 'application/pdf',
    dataRoot: sb.root,
  });

  const jsonPath = path.join(sb.root, 't', `${rec.fileId}.json`);
  assert.ok(existsSync(jsonPath), 'JSON 파일이 디스크에 떨어져야 한다');

  // 저장된 JSON 이 반환 레코드와 byte-identical 한지도 검증 (직렬화 버그 예방).
  const onDisk = JSON.parse(readFileSync(jsonPath, 'utf8')) as DirectiveFileRecord;
  assert.deepEqual(onDisk, rec);
  assert.equal(onDisk.type, 'pdf');

  // after-hook 이 동작하는지 별도 sandbox 로 분리 실행해 검증.
  // (t.after 는 현재 테스트 종료 후에만 실행되므로 인라인 확인이 필요하다.)
  const tempSb = makeSandbox();
  await processDirectiveFile({
    projectId: 't',
    originalName: 'ephemeral.pdf',
    buffer,
    mimeType: 'application/pdf',
    dataRoot: tempSb.root,
  });
  assert.ok(existsSync(tempSb.root), '임시 dataRoot 는 정리 직전까지 존재');
  disposeSandbox(tempSb);
  assert.equal(
    existsSync(tempSb.root),
    false,
    'disposeSandbox(= t.after 가 부르는 rmSync recursive) 가 실제로 디렉터리를 지운다',
  );
});

test('TC-FP-10: 모든 type 의 레코드가 fileId/name/type/extractedText/images 5필드를 항상 노출', async (t) => {
  const sb = makeSandbox();
  t.after(() => disposeSandbox(sb));

  const inputs: Array<{ name: string; mime?: string; buf: Buffer }> = [
    { name: 'a.txt', mime: 'text/plain', buf: Buffer.from('t', 'utf8') },
    { name: 'b.png', mime: 'image/png', buf: PNG_1x1 },
    { name: 'c.pdf', mime: 'application/pdf', buf: MIN_PDF },
    { name: 'd.bin', buf: Buffer.from('x', 'utf8') }, // fallback to text
  ];

  for (const { name, mime, buf } of inputs) {
    const rec = await processDirectiveFile({
      projectId: 'proj-SHAPE',
      originalName: name,
      buffer: buf,
      mimeType: mime,
      dataRoot: sb.root,
    });
    assert.equal(typeof rec.fileId, 'string');
    assert.equal(typeof rec.name, 'string');
    assert.ok(['pdf', 'image', 'text'].includes(rec.type));
    assert.equal(typeof rec.extractedText, 'string');
    assert.ok(Array.isArray(rec.images));
  }
});
