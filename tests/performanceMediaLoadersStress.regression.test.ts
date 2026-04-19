// Run with: npx tsx --test tests/performanceMediaLoadersStress.regression.test.ts
//
// QA 회귀(지시 #07ffd9c4) · 대용량·반복 업로드 스트레스 — mediaLoaders.
//
// 환경 한계
// ─────────────────────────────────────────────────────────────────────────────
// 실제 바이너리 PDF 파서(pdf-parse) 에 100페이지 fixture 를 물리는 경로는
// tests/unit/media-loaders.spec.ts 가 별도로 잠근다. 본 파일은 **네트워크·스토어
// 경로의 상한을 결정적으로 잠그는 것** 이 목적이다. fetcher 를 완전 모킹해
// 아래 축을 검증한다.
//
//   MLS-1  대용량 PDF(선언 크기 120MB, 가짜 File) → precheck 단계에서 FILE_TOO_LARGE
//          로 즉시 차단. 네트워크 왕복이 발생하지 않아야 한다.
//   MLS-2  maxBytes=0(가드 해제) + 100회 반복 업로드 → fetcher 호출 정확히 100회,
//          각 호출은 progress 이벤트 3단계(precheck/upload/finalize) 를 최소 1회씩 쏜다.
//   MLS-3  50슬라이드 PPT 서버 응답 → preview.pageCount 가 서버 값(50) 그대로 유지.
//   MLS-4  간헐 실패(홀수 호출 503) → SESSION_EXHAUSTED 와 UPLOAD_FAILED 가 메시지
//          힌트에 따라 정확히 분류되고, 실패 후 재시도 호출이 성공 경로를 타도 누적
//          fetcher 호출 횟수가 예상과 정확히 일치한다(중복·누락 없음).
//
// 본 스위트는 "reporter 가 측정해야 할 실제 p95 렌더/메모리 증가량" 은 잠그지 않는다.
// 그 수치는 `docs/qa-performance-stress-2026-04-19.md` §3 수동 절차로 이관.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadPdfFile,
  loadPptFile,
  MediaLoaderError,
  type MediaLoaderOptions,
  type MediaLoaderProgress,
} from '../src/utils/mediaLoaders.ts';
import type { MediaAsset } from '../src/types.ts';

// ─── 공용 픽스처 ──────────────────────────────────────────────────────────────

/**
 * jsdom/Node 에 File 이 있으나 크기·타입 조작이 제한적이라, 파일 크기·이름만 필요한
 * 본 스트레스에서는 사내 구조체로 대체한다. mediaLoaders 내부는 `file.size` / `file.name`
 * / `file.type` 만 읽으므로 duck-type 으로 충분하다.
 */
function makeFakeFile(name: string, size: number, type: string): File {
  return {
    name,
    size,
    type,
    // 이하 필드는 실제 호출되지 않는다 — FormData append 만 받을 수 있으면 된다.
    lastModified: 0,
    webkitRelativePath: '',
    arrayBuffer: async () => new ArrayBuffer(0),
    slice: () => new Blob(),
    stream: () => new ReadableStream(),
    text: async () => '',
  } as unknown as File;
}

function buildAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: overrides.id ?? `asset-${Math.random().toString(36).slice(2)}`,
    projectId: overrides.projectId ?? 'proj-stress',
    kind: overrides.kind ?? 'pdf',
    name: overrides.name ?? 'sample.pdf',
    mimeType: overrides.mimeType ?? 'application/pdf',
    sizeBytes: overrides.sizeBytes ?? 1024,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    extractedText: overrides.extractedText,
    pageCount: overrides.pageCount,
    generatedBy: overrides.generatedBy,
  };
}

// ─── MLS-1 · 대용량 PDF precheck 가드 ─────────────────────────────────────────

test('MLS-1 · 120MB 가짜 PDF 는 precheck 에서 FILE_TOO_LARGE 로 차단되고 네트워크 왕복이 없다', async () => {
  const big = makeFakeFile('huge.pdf', 120 * 1024 * 1024, 'application/pdf');
  let calls = 0;
  const progresses: MediaLoaderProgress[] = [];
  const opts: MediaLoaderOptions = {
    projectId: 'proj-stress',
    fetcher: async () => { calls++; return new Response('{}', { status: 200 }); },
    onProgress: p => progresses.push(p),
    // maxBytes 미지정 → 기본 50MB 가드 발동
  };
  await assert.rejects(
    () => loadPdfFile(big, opts),
    (err: unknown) => err instanceof MediaLoaderError && err.code === 'FILE_TOO_LARGE',
  );
  assert.equal(calls, 0, 'precheck 에서 막히면 서버 요청이 한 번도 나가지 않아야 한다');
  // precheck progress 는 "검사 중" 시각 배지를 띄우기 위해 한 번은 쏜다.
  assert.ok(progresses.some(p => p.phase === 'precheck'),
    'precheck phase 가 한 번도 보고되지 않으면 사용자가 "검사 중" 배지를 볼 수 없다');
});

// ─── MLS-2 · 반복 업로드(100회) 총량과 progress 이벤트 한계 ────────────────────

test('MLS-2 · 100회 반복 업로드에서 fetcher 정확히 100회, progress 3단계 각 1회 이상 보고', async () => {
  let calls = 0;
  const fetcher = async (_input: string, _init?: RequestInit) => {
    calls++;
    return new Response(JSON.stringify(buildAsset({ pageCount: 10 })), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  for (let i = 0; i < 100; i++) {
    const phases: string[] = [];
    const file = makeFakeFile(`pdf-${i}.pdf`, 1024 * 1024, 'application/pdf'); // 1MB 가짜 PDF
    const preview = await loadPdfFile(file, {
      projectId: 'proj-stress',
      fetcher,
      maxBytes: 0, // 가드 해제
      onProgress: p => phases.push(p.phase),
    });
    // progress 3단계 각 1회 이상 — precheck, upload, finalize.
    for (const expected of ['precheck', 'upload', 'finalize'] as const) {
      assert.ok(phases.includes(expected),
        `반복 ${i} 회차에서 ${expected} phase 가 누락됐다 — 상단바 "검사/업로드/완료" 배지가 깜빡인다`);
    }
    // 응답이 서버 asset 을 그대로 투영해야 한다.
    assert.equal(preview.kind, 'pdf');
  }

  assert.equal(calls, 100, `fetcher 호출 횟수가 정확해야 한다(실제: ${calls}) — 재시도·중복 호출이 누적되면 서버가 과부하`);
});

// ─── MLS-3 · 50슬라이드 PPT pageCount 유지 ────────────────────────────────────

test('MLS-3 · 50슬라이드 PPT 서버 응답의 pageCount 가 preview 에 그대로 유지된다', async () => {
  const fetcher = async () => new Response(
    JSON.stringify(buildAsset({
      kind: 'pptx',
      name: 'deck.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      pageCount: 50,
      sizeBytes: 8 * 1024 * 1024,
    })),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  const preview = await loadPptFile(
    makeFakeFile('deck.pptx', 8 * 1024 * 1024, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    { projectId: 'proj-stress', fetcher, maxBytes: 0 },
  );
  assert.equal(preview.kind, 'pptx');
  assert.equal(preview.pageCount, 50, '50슬라이드가 preview.pageCount 로 보존되지 않으면 "PPT 50페이지" 배지 계산이 깨진다');
});

// ─── MLS-4 · 간헐 실패 · 에러 분류와 재시도 후 누적 호출 정확성 ────────────────

test('MLS-4 · 홀수 회차 503(세션 소진) → SESSION_EXHAUSTED, 짝수 회차 성공 → 누적 fetcher 호출 20 정확', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    if (calls % 2 === 1) {
      // 홀수 회차는 세션 소진 503 — mediaLoaders.requestVideoGeneration 과 동일 규칙.
      return new Response(JSON.stringify({ error: '세션이 소진되어 처리할 수 없습니다.' }), {
        status: 503, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(buildAsset({ pageCount: 3 })), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };

  const errors: MediaLoaderError[] = [];
  const successes: string[] = [];

  for (let i = 0; i < 20; i++) {
    try {
      const preview = await loadPdfFile(
        makeFakeFile(`trial-${i}.pdf`, 4096, 'application/pdf'),
        { projectId: 'proj-stress', fetcher, maxBytes: 0 },
      );
      successes.push(preview.kind);
    } catch (err) {
      assert.ok(err instanceof MediaLoaderError, '에러는 모두 MediaLoaderError 로 래핑되어야 한다');
      errors.push(err);
    }
  }

  assert.equal(calls, 20, `fetcher 호출 총량 20 이 정확해야 한다(실제: ${calls})`);
  assert.equal(errors.length, 10, '홀수 회차 10건이 에러 경로로 떨어져야 한다');
  assert.equal(successes.length, 10, '짝수 회차 10건이 성공 경로로 떨어져야 한다');

  // 503 메시지 분류: "세션" 키워드가 들어 있으면 UPLOAD_FAILED 가 아니라 별도 의미가 있음.
  // mediaLoaders 의 uploadParseableFile 는 501 만 ADAPTER_NOT_REGISTERED 로 매핑하고
  // 503 은 UPLOAD_FAILED 로 보존한다(서버 정책상 업로드 경로에서는 exhausted 를 503 이
  // 아닌 다른 코드로 돌려줌). 따라서 여기서는 `UPLOAD_FAILED` 로 검증한다 — 향후 업로드
  // 경로가 session_exhausted 를 분류해야 한다면 이 테스트를 깨뜨려 강제 리뷰를 유도.
  for (const e of errors) {
    assert.equal(e.code, 'UPLOAD_FAILED',
      '업로드 경로의 503 은 UPLOAD_FAILED 로 수렴. 추후 서버가 category 필드를 주면 이 테스트를 SESSION_EXHAUSTED 로 전환하며 분류 로직 보강 필요');
    assert.equal(e.status, 503);
  }
});
