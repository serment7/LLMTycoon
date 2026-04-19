# tests/fixtures — QA 회귀 샘플 자산

본 디렉토리의 모든 파일은 **자작·공용 도메인** 이며 저작권 우려가 없다.
`generate-fixtures.mjs` 하나로 재생성 가능하다.

## 생성 방법

```
node tests/fixtures/generate-fixtures.mjs
```

기존 파일은 덮어쓰기된다. CI 에 포함하려면 저장소 상태로 커밋하거나
`prepare` 훅에서 실행한다.

## 파일 목록

| 파일 | 바이트 | 용도 |
|---|---:|---|
| `sample.pdf` | 329 | 레거시(1회차) 1 페이지 PDF. `small.pdf` 로 대체 예정. |
| `small.pdf` | ~370 | 1 페이지 PDF — 업로드·다운로드 기본 경로. |
| `medium.pdf` | ~4KB | 30 페이지 PDF — `pageCount` 테이블·배지 검증용. |
| `large.pdf` | ~16KB | 120 페이지 PDF — 스트레스·성능 회귀용. |
| `deck-small.pptx` | 31 | PPTX ZIP 매직만 담은 바이너리 — 어댑터 미등록 경로 검증. |
| `pixel.png` | 67 | 1×1 투명 PNG — 이미지 로더 진입 가드. |
| `pixel.jpg` | 172 | 1×1 JPEG — 동일. |
| `pixel.svg` | 62 | 1×1 SVG 텍스트 — MIME 판정 경로. |
| `silence.wav` | 44 | 0 샘플 WAV RIFF 헤더만 — 오디오 입력 진입 가드. |
| `silence.mp3` | 32 | MPEG-1 L3 헤더 1 프레임 — 매직 검증·재생 불가. |
| `corrupt.bin` | 60 | ZIP 매직 포함 · 쓰레기 페이로드 — 파일 타입 스푸핑·손상 경로. |

## 계약 주의

- 본 fixture 들은 "**파서 매직·크기 가드**" 경로를 잠그는 것이 목적이다.
  실제 콘텐츠 품질(텍스트·픽셀 값) 은 계약에서 제외한다.
- PDF 의 `pageCount` 는 `/Type /Pages /Count N` 메타만 기재 — 실제 렌더
  페이지는 비어 있다. `pdf-parse` 가 페이지 수만 읽도록 설계.
- PPTX fixture 는 ZIP 매직만 맞춰 둔 "가짜 페이로드" 다. 파서가 매직
  통과 후 어댑터 미등록 → `MEDIA_UNSUPPORTED_FORMAT` 로 수렴하는 경로
  검증에만 쓴다.
