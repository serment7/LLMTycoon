// Run with: npx tsx --test tests/pptParser.edgecases.unit.test.ts
//
// 지시 #ee26652f — pptParser 엣지케이스 회귀 방어.
//
// 본 파일은 `tests/pptImportPipeline.unit.test.ts` 가 잠근 "성공 경로 + 기본 가드"
// 5 축(A1~A5, B, C, D, E, F, G) 밖의 엣지 계약을 추가로 잠근다. 발견된 의심 결함은
// docs/qa/ppt-parser-qa-2026-04-19.md 에 재현 절차·기대값·실제값으로 기록.
//
// 테스트 축
//   EC-01  <a:t/> 자기종료·빈 텍스트·공백 전용 페어
//   EC-02  십진 · 16진 · 이모지 XML 엔티티 디코딩
//   EC-03  <dc:title> 자기종료 · 속성 동반 · 공백만
//   EC-04  sldId 속성 순서 역전(r:id 가 id 보다 먼저)
//   EC-05  rel 누락 rId 는 조용히 스킵 · 뒤따르는 슬라이드 인덱스는 연속
//   EC-06  rels 자체 부재 + presentation.xml 의 rids 존재 — 현 구현 관찰값 잠금
//   EC-07  rids 빈 배열 폴백(filename 스캔) — 지리 파일명 정렬
//   EC-08  maxTextBytes 로 UTF-8 경계 절단
//   EC-09  ppt/media/ 하위 폴더(예: sub/image.png) 는 상대경로 보존
//   EC-10  thumbnail 이 .png 인 경우 탐지
//   EC-11  onProgress 가 throw 해도 parse 는 계속 진행
//   EC-12  parse 중간(슬라이드 사이)에 abort → 그때까지 누적된 슬라이드는 폐기

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPptParser,
  extractSlideText,
  type ZipArchive,
  type ZipEngine,
} from '../src/lib/multimedia/pptParser.ts';
import { MultimediaImportError } from '../src/lib/multimedia/types.ts';

function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function stubArchive(files: Record<string, string | Uint8Array>): ZipArchive {
  return {
    list() { return Object.keys(files); },
    open(name) {
      if (!(name in files)) return null;
      const v = files[name];
      const bytes = typeof v === 'string' ? encode(v) : v;
      return { name, async read() { return bytes; } };
    },
  };
}

function stubEngine(files: Record<string, string | Uint8Array>): ZipEngine {
  const archive = stubArchive(files);
  return { async read() { return archive; } };
}

function makeFakePptx(): Blob {
  const head = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  return new Blob([head]);
}

// ────────────────────────────────────────────────────────────────────────────
// EC-01 · extractSlideText 의 자기종료·공백·빈 태그 처리
// ────────────────────────────────────────────────────────────────────────────

test('EC-01. extractSlideText — 자기종료 <a:t/> 는 텍스트 수집 대상에서 제외', () => {
  // 자기종료 태그는 정규식 <a:t...>...</a:t> 에 매치되지 않으므로 무시된다.
  const xml = '<a:p><a:r><a:t/></a:r><a:r><a:t>본문</a:t></a:r></a:p>';
  const text = extractSlideText(xml);
  assert.equal(text, '본문');
});

test('EC-01b. extractSlideText — 완전히 빈 문자열 처리', () => {
  assert.equal(extractSlideText(''), '');
  assert.equal(extractSlideText('<p:sld/>'), '');
});

test('EC-01c. extractSlideText — <a:t> 에 속성이 있어도 캡처', () => {
  const xml = '<a:t xml:space="preserve">  사이 공백  </a:t>';
  const text = extractSlideText(xml);
  // 내부 공백은 보존(정규식이 본문을 그대로 담고, 최종 trim() 만 적용).
  assert.ok(text.includes('사이 공백'));
});

// ────────────────────────────────────────────────────────────────────────────
// EC-02 · XML 엔티티(숫자 · 16진 · 이모지) 디코딩
// ────────────────────────────────────────────────────────────────────────────

test('EC-02. extractSlideText — &#46; &#x1F600; 를 각각 "." 과 😀 로 디코딩', () => {
  const xml = '<a:t>A&#46;B &#x1F600; end</a:t>';
  const text = extractSlideText(xml);
  assert.ok(text.includes('A.B'));
  // 이모지(서러게이트 페어)도 단일 코드포인트로 디코딩되어 Array.from 기준 1 grapheme.
  const emoji = String.fromCodePoint(0x1F600);
  assert.ok(text.includes(emoji));
});

test('EC-02b. extractSlideText — 기본 5 엔티티(&lt;&gt;&amp;&quot;&apos;) 디코딩', () => {
  const xml = '<a:t>&lt;tag&gt; a &amp; b &quot;c&quot; &apos;d&apos;</a:t>';
  const text = extractSlideText(xml);
  assert.equal(text, `<tag> a & b "c" 'd'`);
});

// ────────────────────────────────────────────────────────────────────────────
// EC-03 · core.xml 메타 추출의 엣지
// ────────────────────────────────────────────────────────────────────────────

test('EC-03. core.xml — <dc:title/> 자기종료는 undefined, 속성 포함은 값 채움', async () => {
  const parser = createPptParser({
    zipEngine: stubEngine({
      'ppt/presentation.xml': '<p:presentation xmlns:p="x"/>',
      'docProps/core.xml':
        '<cp:coreProperties xmlns:cp="x" xmlns:dc="z">' +
        '<dc:title/>' +
        '<dc:creator xml:lang="ko">홍길동</dc:creator>' +
        '</cp:coreProperties>',
    }),
  });
  const result = await parser.parse(makeFakePptx());
  assert.equal(result.metadata.title, undefined);
  assert.equal(result.metadata.author, '홍길동');
});

// ────────────────────────────────────────────────────────────────────────────
// EC-04 · sldId 속성 순서 — r:id 가 id 보다 앞에 오는 경우
// ────────────────────────────────────────────────────────────────────────────

test('EC-04. slideOrderFromPresentationXml — 속성 순서 역전(r:id 먼저)도 인식', async () => {
  const parser = createPptParser({
    zipEngine: stubEngine({
      'ppt/presentation.xml':
        '<p:presentation xmlns:p="x" xmlns:r="y">' +
        '<p:sldIdLst>' +
        '<p:sldId r:id="rId1" id="256"/>' +
        '<p:sldId r:id="rId2" id="257"/>' +
        '</p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels':
        '<Relationships>' +
        '<Relationship Id="rId1" Target="slides/slide1.xml"/>' +
        '<Relationship Id="rId2" Target="slides/slide2.xml"/>' +
        '</Relationships>',
      'ppt/slides/slide1.xml': '<a:p><a:t>S1</a:t></a:p>',
      'ppt/slides/slide2.xml': '<a:p><a:t>S2</a:t></a:p>',
    }),
  });
  const result = await parser.parse(makeFakePptx());
  assert.equal(result.slides.length, 2);
  assert.ok(result.slides[0].text.includes('S1'));
  assert.ok(result.slides[1].text.includes('S2'));
});

// ────────────────────────────────────────────────────────────────────────────
// EC-05 · rels 에서 특정 rId 가 누락되면 해당 슬라이드는 조용히 제외
// ────────────────────────────────────────────────────────────────────────────

test('EC-05. rel 누락 rId 는 조용히 스킵되고 뒤따르는 슬라이드는 연속 인덱스', async () => {
  const parser = createPptParser({
    zipEngine: stubEngine({
      'ppt/presentation.xml':
        '<p:presentation xmlns:p="x" xmlns:r="y">' +
        '<p:sldIdLst>' +
        '<p:sldId id="1" r:id="rId1"/>' +
        '<p:sldId id="2" r:id="rIdMissing"/>' +
        '<p:sldId id="3" r:id="rId3"/>' +
        '</p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels':
        '<Relationships>' +
        '<Relationship Id="rId1" Target="slides/slide1.xml"/>' +
        '<Relationship Id="rId3" Target="slides/slide3.xml"/>' +
        '</Relationships>',
      'ppt/slides/slide1.xml': '<a:p><a:t>첫째</a:t></a:p>',
      'ppt/slides/slide3.xml': '<a:p><a:t>셋째</a:t></a:p>',
    }),
  });
  const result = await parser.parse(makeFakePptx());
  assert.equal(result.slides.length, 2, '누락된 rIdMissing 은 스킵');
  // 인덱스는 0/1 로 연속 — "원본 슬라이드 번호" 가 아닌 "추출 순서" 기준.
  assert.equal(result.slides[0].index, 0);
  assert.equal(result.slides[1].index, 1);
});

// ────────────────────────────────────────────────────────────────────────────
// EC-06 · rels 파일 자체가 없을 때의 현 구현 관찰값
//   presentation.xml 에 rids 가 존재하면 rels 빈 맵 때문에 전부 continue →
//   결과적으로 슬라이드 0개. 실제 slide*.xml 파일이 있어도 filename 폴백이
//   작동하지 않아 "조용한 유실" 이 발생한다. QA 보고서 §D-01 참고.
// ────────────────────────────────────────────────────────────────────────────

test('EC-06. rels 부재 + presentation.xml 에 rids 존재 → 현 구현은 슬라이드 0개(결함 관찰)', async () => {
  const parser = createPptParser({
    zipEngine: stubEngine({
      'ppt/presentation.xml':
        '<p:presentation xmlns:p="x" xmlns:r="y">' +
        '<p:sldIdLst><p:sldId id="1" r:id="rId1"/></p:sldIdLst>' +
        '</p:presentation>',
      // 일부러 rels 를 생략.
      'ppt/slides/slide1.xml': '<a:p><a:t>유실 위험</a:t></a:p>',
    }),
  });
  const result = await parser.parse(makeFakePptx());
  // 관찰값(현 시점). 합류 후 filename 폴백이 추가되면 이 테스트는 `>=1` 로 갱신되어야 한다.
  assert.equal(result.slides.length, 0, 'QA §D-01: rels 부재 시 filename 폴백 미동작 (실제 slide1.xml 이 있어도 0)');
});

// ────────────────────────────────────────────────────────────────────────────
// EC-07 · rids 빈 배열(=sldIdLst 자체가 없음)일 때 filename 스캔 폴백
// ────────────────────────────────────────────────────────────────────────────

test('EC-07. sldIdLst 없음 → filename 스캔 · 번호순 정렬 · zero-pad 이름도 처리', async () => {
  const parser = createPptParser({
    zipEngine: stubEngine({
      'ppt/presentation.xml': '<p:presentation xmlns:p="x"/>', // sldIdLst 없음
      'ppt/slides/slide10.xml': '<a:p><a:t>텐</a:t></a:p>',
      'ppt/slides/slide2.xml': '<a:p><a:t>투</a:t></a:p>',
      'ppt/slides/slide1.xml': '<a:p><a:t>원</a:t></a:p>',
    }),
  });
  const result = await parser.parse(makeFakePptx());
  assert.equal(result.slides.length, 3);
  // 번호순으로 정렬(1, 2, 10) — lexicographic(1, 10, 2) 이 아님.
  assert.ok(result.slides[0].text.includes('원'));
  assert.ok(result.slides[1].text.includes('투'));
  assert.ok(result.slides[2].text.includes('텐'));
});

// ────────────────────────────────────────────────────────────────────────────
// EC-08 · maxTextBytes 로 UTF-8 경계 절단
// ────────────────────────────────────────────────────────────────────────────

test('EC-08. maxTextBytes — 한글(3 bytes per char) 경계에서 안전하게 절단', async () => {
  const parser = createPptParser({
    zipEngine: stubEngine({
      'ppt/presentation.xml':
        '<p:presentation xmlns:p="x" xmlns:r="y">' +
        '<p:sldIdLst><p:sldId id="1" r:id="rId1"/></p:sldIdLst>' +
        '</p:presentation>',
      'ppt/_rels/presentation.xml.rels':
        '<Relationships>' +
        '<Relationship Id="rId1" Target="slides/slide1.xml"/>' +
        '</Relationships>',
      'ppt/slides/slide1.xml': '<a:p><a:t>' + '가'.repeat(1000) + '</a:t></a:p>',
    }),
  });
  // 100 바이트 = 약 33 글자(한글 3 bytes + 헤더 "# 슬라이드 1\n" 정도).
  const result = await parser.parse(makeFakePptx(), { maxTextBytes: 100 });
  // QA §D-02 관찰: truncateUtf8 는 bytes.slice(0, maxBytes) 후 fatal:false 로 디코딩하므로,
  // 잘린 멀티바이트 시퀀스가 U+FFFD(3 bytes) 하나로 치환되어 재인코딩 시 최대 +3 초과.
  // 본 테스트는 "상한 약속 + 단일 U+FFFD 슬랙(3B)" 을 관찰값으로 고정한다. 합류 후 정확 상한을
  // 지키도록 수정되면 본 단언을 `<= 100` 로 조여야 한다.
  const enc = new TextEncoder();
  const actual = enc.encode(result.text).length;
  assert.ok(actual <= 100 + 3, `text bytes 가 maxBytes(100) + U+FFFD 슬랙(3) 을 초과: ${actual}`);
});

// ────────────────────────────────────────────────────────────────────────────
// EC-09 · ppt/media/ 하위 폴더 상대경로 보존
// ────────────────────────────────────────────────────────────────────────────

test('EC-09. mediaFiles — ppt/media/sub/image.png 의 상대경로 `sub/image.png` 보존', async () => {
  const parser = createPptParser({
    zipEngine: stubEngine({
      'ppt/presentation.xml': '<p:presentation xmlns:p="x"/>',
      'ppt/media/image1.png': 'x',
      'ppt/media/sub/image2.jpg': 'x',
    }),
  });
  const result = await parser.parse(makeFakePptx());
  // 현 구현은 "ppt/media/" 만 벗기므로, 하위 폴더 경로는 그대로 남는다.
  assert.deepEqual(result.mediaFiles.sort(), ['image1.png', 'sub/image2.jpg']);
});

// ────────────────────────────────────────────────────────────────────────────
// EC-10 · thumbnail.png 확장자 · 대소문자 혼합
// ────────────────────────────────────────────────────────────────────────────

test('EC-10. thumbnailName — .JPG 대문자·.png 도 탐지', async () => {
  // 대문자 확장자
  const parserUpper = createPptParser({
    zipEngine: stubEngine({
      'ppt/presentation.xml': '<p:presentation xmlns:p="x"/>',
      'docProps/thumbnail.JPG': 'x',
    }),
  });
  const r1 = await parserUpper.parse(makeFakePptx());
  assert.equal(r1.thumbnailName, 'docProps/thumbnail.JPG');

  // PNG 확장자
  const parserPng = createPptParser({
    zipEngine: stubEngine({
      'ppt/presentation.xml': '<p:presentation xmlns:p="x"/>',
      'docProps/thumbnail.png': 'x',
    }),
  });
  const r2 = await parserPng.parse(makeFakePptx());
  assert.equal(r2.thumbnailName, 'docProps/thumbnail.png');
});

// ────────────────────────────────────────────────────────────────────────────
// EC-11 · onProgress 가 throw 해도 parse 는 계속 진행
// ────────────────────────────────────────────────────────────────────────────

test('EC-11. onProgress 예외는 흡수 — parse 결과는 정상 반환', async () => {
  const parser = createPptParser({
    zipEngine: stubEngine({
      'ppt/presentation.xml':
        '<p:presentation xmlns:p="x" xmlns:r="y">' +
        '<p:sldIdLst><p:sldId id="1" r:id="rId1"/></p:sldIdLst>' +
        '</p:presentation>',
      'ppt/_rels/presentation.xml.rels':
        '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
      'ppt/slides/slide1.xml': '<a:p><a:t>진행</a:t></a:p>',
    }),
  });
  let called = 0;
  const result = await parser.parse(makeFakePptx(), {
    onProgress: () => {
      called += 1;
      throw new Error('callback explode');
    },
  });
  assert.ok(called > 0, 'onProgress 는 호출되었다');
  assert.equal(result.slides.length, 1, 'throw 흡수 후 파싱 완료');
});

// ────────────────────────────────────────────────────────────────────────────
// EC-12 · 슬라이드 사이 abort — 누적된 슬라이드는 폐기되고 예외로 끝남
// ────────────────────────────────────────────────────────────────────────────

test('EC-12. 슬라이드 사이 abort — MULTIMEDIA_PARSE_ABORTED 로 reject · 부분 결과 반환 금지', async () => {
  const parser = createPptParser({
    zipEngine: stubEngine({
      'ppt/presentation.xml':
        '<p:presentation xmlns:p="x" xmlns:r="y">' +
        '<p:sldIdLst>' +
        '<p:sldId id="1" r:id="rId1"/>' +
        '<p:sldId id="2" r:id="rId2"/>' +
        '<p:sldId id="3" r:id="rId3"/>' +
        '</p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels':
        '<Relationships>' +
        '<Relationship Id="rId1" Target="slides/slide1.xml"/>' +
        '<Relationship Id="rId2" Target="slides/slide2.xml"/>' +
        '<Relationship Id="rId3" Target="slides/slide3.xml"/>' +
        '</Relationships>',
      'ppt/slides/slide1.xml': '<a:p><a:t>A</a:t></a:p>',
      'ppt/slides/slide2.xml': '<a:p><a:t>B</a:t></a:p>',
      'ppt/slides/slide3.xml': '<a:p><a:t>C</a:t></a:p>',
    }),
  });
  const ctrl = new AbortController();
  // 첫 슬라이드 parse 이벤트가 발생한 직후 abort — 두 번째 슬라이드 진입 시 catch.
  const events: Array<{ phase: string; current: number; total: number }> = [];
  const promise = parser.parse(makeFakePptx(), {
    signal: ctrl.signal,
    onProgress: (ev) => {
      events.push(ev);
      if (ev.phase === 'parse' && ev.current === 1) ctrl.abort();
    },
  });
  await assert.rejects(promise, (err: unknown) => {
    return err instanceof MultimediaImportError && err.code === 'MULTIMEDIA_PARSE_ABORTED';
  });
  // 부분 결과는 반환되지 않으므로(예외 경로), 호출자는 events 만으로 상태를 안다.
  assert.ok(events.some((e) => e.phase === 'parse' && e.current === 1));
});
