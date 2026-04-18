// Run with: npx tsx --test src/components/DirectivePrompt.test.ts
//
// QA: 디렉티브 프롬프트(첨부 업로드 UI) 회귀 가드 (#DIR-ATTACH).
// DirectivePrompt.tsx 가 실제로 export 하는 두 퓨어 헬퍼만 단위 테스트로 고정한다 —
// 컴포넌트 본체는 드래그/드롭/클릭 등 DOM 인터랙션이 핵심이라 JSDOM harness
// 도입(별도 PR) 후 통합 테스트로 보강 예정. 본 파일은 그 전 단계의 안전망이다.
//
// 검증 시나리오 (사용자 문장 → 단위 테스트 불변식):
//   (1) 지원 확장자(.pdf/.png/.jpg/.jpeg/.txt 등) 화이트리스트
//       → classifyAttachment 가 각 확장자/MIME 을 정확한 kind 로 떨어뜨린다.
//   (2) 미지원 확장자(.exe/.zip/...) 차단의 시각적 근거
//       → classifyAttachment 가 'other' 로 떨어진다 (UI 가 회색 + "FILE" 라벨로 표기).
//   (3) 대용량 파일 표기
//       → formatFileSize 가 B/KB/MB/GB 경계에서 사람이 읽을 수 있게 축약한다.
//   (4) 비정상 입력(NaN/음수)에 깨지지 않는 안전한 라벨 ('-')
//
// 다음 시나리오는 본 파일에서 다루지 않는다 (사유):
//   - 20MB 초과 거부 → 컴포넌트 내부 onDropOrPick 가 maxBytes 로 필터하지만 함수가
//     export 되지 않아 직접 호출 불가. 부모 핸들러 + 서버 multer(limits.fileSize)
//     레벨 통합 테스트로 다룬다 (server.ts:251 directiveUpload limits 25MiB,
//     클라 측 maxBytes 는 호출부에서 20MiB 로 주입할 때 가드).
//   - 동시 다중 업로드 / 삭제 버튼 / 재시도 UX → 모두 컴포넌트 props 에 의존하는
//     DOM 인터랙션이라 JSDOM 도입 후 별도 테스트.
//
// 픽스처: 픽셀 데이터가 아니라 (mime, name) 쌍의 분류 표만 검증하므로 별도 파일 X.

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyAttachment, formatFileSize } from './DirectivePrompt.tsx';

// ---------------------------------------------------------------------------
// classifyAttachment: (MIME, name) → kind
// 분류표가 깨지면 색·아이콘·라벨이 동시에 어긋나므로 한 곳에서 묶어 못박는다.
// ---------------------------------------------------------------------------

test('TC-DP-01: PDF 는 MIME 우선, 확장자 폴백 모두 pdf 로 분류', () => {
  assert.equal(classifyAttachment('application/pdf', 'whatever.bin'), 'pdf');
  assert.equal(classifyAttachment('', 'spec.pdf'), 'pdf');
  assert.equal(classifyAttachment('', 'SPEC.PDF'), 'pdf', '확장자는 대소문자 무관');
  // MIME 만 정확하면 무확장자도 PDF
  assert.equal(classifyAttachment('application/pdf', 'noext'), 'pdf');
});

test('TC-DP-02: 이미지 MIME(image/*) 또는 png/jpg/jpeg/gif/webp/svg 는 image', () => {
  for (const name of ['icon.png', 'photo.JPG', 'photo.jpeg', 'logo.svg', 'frame.gif', 'banner.webp']) {
    assert.equal(classifyAttachment('', name), 'image', `${name} 가 image 로 분류돼야 한다`);
  }
  assert.equal(classifyAttachment('image/png', 'noext'), 'image');
  assert.equal(classifyAttachment('image/heic', 'shot.heic'), 'image', 'image/* 와일드카드');
});

test('TC-DP-03: 텍스트 MIME(text/*) 또는 txt/md/json/csv/yml/yaml/log 는 text', () => {
  for (const name of ['note.txt', 'README.md', 'data.json', 'rows.csv', 'app.yml', 'app.yaml', 'run.log']) {
    assert.equal(classifyAttachment('', name), 'text', `${name} 가 text 로 분류돼야 한다`);
  }
  assert.equal(classifyAttachment('text/plain', 'noext'), 'text');
  assert.equal(classifyAttachment('text/markdown', 'r.md'), 'text');
});

test('TC-DP-04: 미지원 확장자/MIME 은 other 로 떨어져 회색 라벨로 표시', () => {
  // 알려진 위험 확장자도 컴포넌트 단계에서는 거부가 아니라 "other" 분류 — 거부는 부모/서버.
  // 그래도 분류만큼은 결정론적이어야 색·아이콘이 흔들리지 않는다.
  for (const [mime, name] of [
    ['', 'malware.exe'],
    ['', 'archive.zip'],
    ['', 'doc.docx'],
    ['', 'noext'],
    ['application/octet-stream', 'blob'],
  ] as Array<[string, string]>) {
    assert.equal(classifyAttachment(mime, name), 'other', `(${mime}, ${name}) → other`);
  }
});

test('TC-DP-05: 빈/공백 MIME 은 매칭 실패 후 확장자 폴백으로 분류', () => {
  // 일부 브라우저는 드롭된 파일의 type 을 빈 문자열로 준다 — 확장자 폴백이 안전망.
  assert.equal(classifyAttachment('', 'spec.pdf'), 'pdf');
  assert.equal(classifyAttachment(' ', 'photo.png'), 'image');
  assert.equal(classifyAttachment(' ', 'note.txt'), 'text');
});

test('TC-DP-05b: 드래그앤드롭 시 동시에 들어오는 PDF/이미지/텍스트 3종이 각자 정확히 분류', () => {
  // 통합 테스트(DirectivePrompt.integration.test.tsx TC-DP-INT-01) 가 DOM 까지
  // 확인하지만, 분류 테이블 자체도 한 묶음으로 잠가 둬 회귀가 두 층에서 동시에 떨어진다.
  const triad: Array<[string, string, 'pdf' | 'image' | 'text']> = [
    ['application/pdf', 'spec.pdf', 'pdf'],
    ['image/png', 'logo.png', 'image'],
    ['text/plain', 'note.txt', 'text'],
  ];
  for (const [mime, name, expected] of triad) {
    assert.equal(
      classifyAttachment(mime, name),
      expected,
      `(${mime}, ${name}) 가 ${expected} 로 분류돼야 한다`,
    );
  }
});

// ---------------------------------------------------------------------------
// formatFileSize: 바이트 → 사람이 읽는 라벨
// 경계(1KiB, 1MiB, 1GiB) 와 비정상(NaN/음수) 을 모두 못박는다.
// 첨부 행의 사이즈 칼럼 / 미리보기 모달 헤더가 같은 함수로 그려지므로
// 이 한 곳을 깨면 두 곳이 동시에 어긋난다.
// ---------------------------------------------------------------------------

test('TC-DP-06: 1024 미만은 바이트 단위', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(1), '1 B');
  assert.equal(formatFileSize(1023), '1023 B');
});

test('TC-DP-07: KB 구간은 10 미만일 때만 소수점 1자리', () => {
  assert.equal(formatFileSize(1024), '1.0 KB');
  assert.equal(formatFileSize(1024 * 9 + 512), '9.5 KB');
  // 10KB 이상은 정수.
  assert.equal(formatFileSize(1024 * 10), '10 KB');
  assert.equal(formatFileSize(1024 * 999), '999 KB');
});

test('TC-DP-08: MB 구간도 10 미만 1자리, 그 이상은 정수', () => {
  assert.equal(formatFileSize(1024 * 1024), '1.0 MB');
  assert.equal(formatFileSize(1024 * 1024 * 5 + 1024 * 512), '5.5 MB');
  assert.equal(formatFileSize(1024 * 1024 * 20), '20 MB');
  // 20MB 임계: 사용자가 화면에서 본 라벨이 검증·서버 응답 메시지와 동일해야 한다.
  assert.equal(formatFileSize(20 * 1024 * 1024), '20 MB');
});

test('TC-DP-09: GB 구간', () => {
  assert.equal(formatFileSize(1024 * 1024 * 1024), '1.0 GB');
  assert.equal(formatFileSize(1024 * 1024 * 1024 * 12), '12 GB');
});

test('TC-DP-10: NaN/음수/Infinity 는 깨진 라벨 대신 "-"', () => {
  // 진행 중 첨부의 size 가 일시적으로 누락되어도 "NaN B" 같은 흉물이 나오면 안 된다.
  assert.equal(formatFileSize(Number.NaN), '-');
  assert.equal(formatFileSize(-1), '-');
  assert.equal(formatFileSize(Number.POSITIVE_INFINITY), '-');
  assert.equal(formatFileSize(Number.NEGATIVE_INFINITY), '-');
});
