// Run with: node tests/fixtures/generate-fixtures.mjs
//
// QA 회귀 픽스처 생성기(지시 #5f4902b0).
//
// 본 스크립트는 tests/fixtures/ 아래에 **저작권 문제가 없는 자작·최소 바이너리**를
// 프로그래밍 방식으로 배치한다. 모든 파일은 사내 QA 스위트 전용이며, 출시물에
// 포함되지 않는다. 각 파일의 바이트 수와 매직은 파서·로더가 신뢰하는 최소 스키마만
// 만족하도록 설계했다 — 실제 콘텐츠 품질(글자·이미지 정확도)은 검증 대상이 아님.
//
// 생성 대상:
//   small.pdf          1 페이지 PDF(~1KB)           — 기존 sample.pdf 의 alias
//   medium.pdf         ~30 페이지 PDF(~20KB)
//   large.pdf          ~120 페이지 PDF(~80KB)
//   deck-small.pptx    0 슬라이드 ZIP 헤더 PPTX(~80B) — 어댑터 미등록 경로 검증
//   pixel.png          1x1 PNG(67B)
//   pixel.jpg          1x1 JPEG(~130B)
//   pixel.svg          48B SVG 텍스트
//   silence.wav        짧은 무음 WAV(44B RIFF 헤더 + 0 샘플)
//   silence.mp3        최소 MPEG-1 Layer III 프레임 헤더만(~32B, 재생 불가 · 로더 가드용)
//   corrupt.bin        임의 바이트 64B — 손상 경로 검증
//   README.md          본 스크립트와 파일 목록 설명

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = (n) => resolve(__dirname, n);

// ─── PDF ────────────────────────────────────────────────────────────────────
// 최소 유효 PDF 를 직접 작성한다. pdf-parse 가 pageCount 를 계산할 수 있도록
// `/Type /Pages /Count N` 를 포함한다. 실제 페이지 콘텐츠(Contents) 는 비워 둔다.
function buildMinimalPdf(pageCount) {
  const objects = [];
  const pages = [];
  // 각 페이지 obj 는 3·4·5… 번부터 할당(1=Catalog, 2=Pages 라고 가정하면 페이지 n은 2+n).
  for (let i = 0; i < pageCount; i++) {
    const objNum = 3 + i;
    pages.push(`${objNum} 0 R`);
  }
  // 1 — Catalog
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  // 2 — Pages
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [ ${pages.join(' ')} ] /Count ${pageCount} >>\nendobj\n`);
  // 3..N — 각 Page
  for (let i = 0; i < pageCount; i++) {
    const objNum = 3 + i;
    objects.push(`${objNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << >> /Contents [] >>\nendobj\n`);
  }
  // 문서 구성
  const header = '%PDF-1.4\n%\xFF\xFF\xFF\xFF\n';
  const bodyParts = [];
  const offsets = [0]; // obj 1 의 오프셋부터 기록
  let cursor = Buffer.byteLength(header, 'binary');
  for (const o of objects) {
    offsets.push(cursor);
    bodyParts.push(o);
    cursor += Buffer.byteLength(o, 'binary');
  }
  const body = bodyParts.join('');
  const xrefStart = cursor;
  const n = objects.length + 1; // objects.length 개 + 1 (free entry)
  let xref = `xref\n0 ${n}\n`;
  xref += '0000000000 65535 f \n';
  for (let i = 1; i < n; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(header + body + xref + trailer, 'binary');
}

writeFileSync(OUT('small.pdf'), buildMinimalPdf(1));
writeFileSync(OUT('medium.pdf'), buildMinimalPdf(30));
writeFileSync(OUT('large.pdf'), buildMinimalPdf(120));

// ─── PPTX ───────────────────────────────────────────────────────────────────
// 실제 파싱 가능한 PPTX 는 복잡한 ZIP 구조가 필요해, 본 fixture 는 "PPTX magic(PK\x03\x04)
// 만 가진 최소 ZIP 페이로드" 로 둔다. pptLoader 가 매직 검증을 통과한 뒤 어댑터 미등록
// 분기(MEDIA_UNSUPPORTED_FORMAT)로 떨어지는 경로를 잠근다.
writeFileSync(OUT('deck-small.pptx'), Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
  Buffer.from('payload:fake-pptx-0-slide', 'utf8'),
]));

// ─── PNG 1x1 투명 ───────────────────────────────────────────────────────────
// 67바이트. 헤더(8) + IHDR(25) + IDAT(22) + IEND(12).
writeFileSync(OUT('pixel.png'), Buffer.from([
  // signature
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  // IHDR length=13
  0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, // width=1
  0x00, 0x00, 0x00, 0x01, // height=1
  0x08, 0x06,             // bitDepth=8, colorType=6 (RGBA)
  0x00, 0x00, 0x00,       // compression/filter/interlace
  0x1f, 0x15, 0xc4, 0x89, // CRC
  // IDAT length=10
  0x00, 0x00, 0x00, 0x0a,
  0x49, 0x44, 0x41, 0x54,
  0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01,
  0x0d, 0x0a, 0x2d, 0xb4, // CRC
  // IEND length=0
  0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82, // CRC
]));

// ─── JPEG 1x1 (최소 baseline) ───────────────────────────────────────────────
// 125바이트 공개 도메인 1x1 JPEG. SOI·APP0·DQT·SOF·DHT·SOS·MCU·EOI.
const PIXEL_JPG_HEX =
  'ffd8ffe000104a46494600010100000100010000' +
  'ffdb004300080606070605080707070909080a0c14' +
  '0d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e' +
  '2720222c231c1c2837292c30313434341f273a3d38' +
  '323c2e333432ffc0000b08000100010101110000ff' +
  'c4001f0000010501010101010100000000000000000102030405060708090a0b' +
  'ffc40014100100000000000000000000000000000000' +
  'ffda00080101000000013f10ffd9';
writeFileSync(OUT('pixel.jpg'), Buffer.from(PIXEL_JPG_HEX, 'hex'));

// ─── SVG 텍스트 ─────────────────────────────────────────────────────────────
writeFileSync(
  OUT('pixel.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
);

// ─── WAV 무음 44B ───────────────────────────────────────────────────────────
// RIFF 헤더 44바이트만. 실제 재생 0초. 로더가 매직·포맷을 인식하는 경로 잠금용.
function buildSilenceWav() {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);                // ChunkID
  buf.writeUInt32LE(36, 4);            // ChunkSize = 36 + 0 data
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);               // Subchunk1ID
  buf.writeUInt32LE(16, 16);           // Subchunk1Size = 16(PCM)
  buf.writeUInt16LE(1, 20);            // AudioFormat = 1 PCM
  buf.writeUInt16LE(1, 22);            // NumChannels = 1
  buf.writeUInt32LE(8000, 24);         // SampleRate = 8000
  buf.writeUInt32LE(16000, 28);        // ByteRate = SampleRate * BlockAlign
  buf.writeUInt16LE(2, 32);            // BlockAlign = 2
  buf.writeUInt16LE(16, 34);           // BitsPerSample
  buf.write('data', 36);               // Subchunk2ID
  buf.writeUInt32LE(0, 40);            // Subchunk2Size = 0
  return buf;
}
writeFileSync(OUT('silence.wav'), buildSilenceWav());

// ─── MP3 최소 프레임 헤더 ───────────────────────────────────────────────────
// 재생 가능하지 않은 "헤더만" 바이트(32B). 로더 매직 검증(0xFFFB…) 만 통과하도록.
writeFileSync(OUT('silence.mp3'), Buffer.concat([
  Buffer.from([0xff, 0xfb, 0x90, 0x44]), // MPEG-1 L3 mono 128kbps 44.1kHz
  Buffer.alloc(28, 0x00),                 // padding
]));

// ─── 손상 파일 ──────────────────────────────────────────────────────────────
writeFileSync(OUT('corrupt.bin'), Buffer.from([
  0x00, 0x01, 0x02, 0x03, 0xff, 0xee, 0xdd, 0xcc,
  0xab, 0xcd, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc,
  0x50, 0x4b, 0x03, 0x04, // ZIP 매직을 포함하되 뒤에 쓰레기만 — 스푸핑 재현용
  0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe,
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
  0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
  0x13, 0x37, 0x42, 0x42, 0x00, 0x00, 0x00, 0x00,
  0xde, 0xad, 0x00, 0xbe, 0xef, 0xca, 0xfe, 0x00,
]));

console.log('Fixtures generated under', __dirname);
