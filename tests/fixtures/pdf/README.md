# tests/fixtures/pdf — PdfAdapter 회귀 샘플 인벤토리

- 작성: QA · 2026-04-19
- 연결 계약: `docs/qa/pdf-adapter-acceptance.md` §2 ~ §6
- 대상 어댑터: `src/services/multimedia/adapters/PdfAdapter.ts` (Joker 진행 중)
- 생성 스크립트 권고 위치: `tests/fixtures/pdf/generate-pdf-fixtures.mjs` (Joker 배정, P1)

---

## 0. 원칙

1. **모든 샘플은 자작·공용 도메인이어야 한다.** 외부 저작권 있는 PDF 를 커밋하지 않는다.
2. **생성 스크립트가 재현 가능해야 한다.** 바이너리 커밋 없이 CI 가 `node ./generate-pdf-fixtures.mjs` 만으로 동일 파일을 만들 수 있어야 한다.
3. **크기는 최소 필요량만.** 대용량(50MB / 100MB) 샘플은 CI 용으로 정상 커밋하지 않고, 로컬 벤치 시에만 스크립트로 생성·`.gitignore` 처리한다.
4. **보안 샘플은 안전한 페이로드만 사용.** `/JavaScript` 액션에는 `app.alert(1)` 수준의 무해 코드만 작성. 실제 공격 페이로드는 넣지 않는다.

---

## 1. 필수 샘플 인벤토리 (10종 + α)

### 1.1 정상 문서 계열

| 파일 | 쪽수 | 크기(목표) | 생성 방법 | 라이선스 | 사용 시나리오 |
| --- | ---: | ---: | --- | --- | --- |
| `small.pdf` *(기존, `tests/fixtures/`)* | 1 | ~370 B | `generate-fixtures.mjs` 재사용 | 자작(CC0) | P-01, C-03 |
| `medium.pdf` *(기존, `tests/fixtures/`)* | 30 | ~4 KB | 기존 스크립트 | 자작(CC0) | P-02 |
| `large.pdf` *(기존, `tests/fixtures/`)* | 120 | ~16 KB | 기존 스크립트 | 자작(CC0) | C-04, 벤치 보조 |
| `doc-200pages.pdf` | 200 | ~30 KB | pdf-lib 로 페이지 200장 생성, 본문 "Page N" 만 작성 | 자작(CC0) | P-03 |

### 1.2 비정상/경계 문서 계열

| 파일 | 쪽수 | 크기(목표) | 생성 방법 | 라이선스 | 사용 시나리오 |
| --- | ---: | ---: | --- | --- | --- |
| `empty.pdf` | 0 | 0 B | `fs.writeFile('empty.pdf', Buffer.alloc(0))` | 자작 | E-01 |
| `doc-truncated.pdf` | 손상 | 1 KB | `medium.pdf` 앞 1024 B 만 추출 | 자작 | E-03 |
| `doc-scan-image.pdf` | 1 | ~10 KB | pdf-lib + `pixel.png` 로 텍스트 레이어 없는 이미지 1장 PDF 생성 | 자작(CC0) | P-07 |
| `doc-encrypted.pdf` | 1 | ~1 KB | `qpdf --encrypt user owner 128 -- small.pdf doc-encrypted.pdf` | 자작 | E-05 |
| `doc-50mb.pdf` | ≥300 | ≥50 MB | pdf-lib 로 큰 raw 문자열 페이지를 반복 삽입(텍스트 기반) · **.gitignore 처리** | 자작 | E-04, PF-01 ~ PF-04 |
| `doc-100mb.pdf` | ≥600 | ≥100 MB | 동일 방식 · **.gitignore 처리** | 자작 | E-04 보조 |

### 1.3 국제화·레이아웃 계열

| 파일 | 쪽수 | 크기(목표) | 생성 방법 | 라이선스 | 사용 시나리오 |
| --- | ---: | ---: | --- | --- | --- |
| `doc-rtl.pdf` | 2 | ~5 KB | pdf-lib + Noto Naskh Arabic(OFL) 또는 Noto Sans Hebrew(OFL) 임베딩. 본문: "مرحبا بالعالم" / "שלום עולם" | OFL(폰트) + 자작 본문 | P-04 |
| `doc-emoji.pdf` | 1 | ~20 KB | pdf-lib + Noto Color Emoji(OFL) 또는 Segoe UI Emoji 교체. 본문: 😀🎉🚀 | OFL(폰트) | P-05 |
| `doc-nested-table.pdf` | 2 | ~6 KB | pdf-lib 로 표 안에 표를 수동 배치(pdf-lib 은 네이티브 표 미지원 → 셀을 중첩 drawText) | 자작 | P-06 |

### 1.4 보안 계열

| 파일 | 내용 | 크기(목표) | 생성 방법 | 라이선스 | 사용 시나리오 |
| --- | --- | ---: | --- | --- | --- |
| `doc-uri-action.pdf` | `/URI` 액션 `http://example.invalid/qa-bait` 포함 | ~2 KB | qpdf + 직접 스트림 편집(`qpdf --qdf` 후 `/URI` 추가) | 자작 | SEC-01 |
| `doc-js-action.pdf` | `/S /JavaScript` `/JS (app.alert(1);)` 포함 | ~2 KB | qpdf + 스트림 편집 | 자작(무해) | SEC-02 |
| `doc-launch.pdf` | `/S /Launch` `/F /etc/hostname`(존재 안 해도 됨) | ~2 KB | qpdf + 스트림 편집 | 자작 | SEC-03 |
| `doc-meta-abuse.pdf` | `/Producer` 필드에 16KB 쓰레기 문자열 | ~20 KB | pdf-lib + 메타 수동 주입 | 자작 | SEC-05 |
| `corrupt.bin` *(기존, `tests/fixtures/`)* | ZIP 매직 + 쓰레기 페이로드 | ~60 B | 기존 | 자작 | E-02 |

> 참고: `pixel.png`/`pixel.jpg`(기존) 는 `tests/fixtures/` 에 이미 있으며 이미지 노드 왕복 테스트(RT-04)에 재사용. 별도 복제 불필요.

---

## 2. 생성 스크립트 요구사항

`tests/fixtures/pdf/generate-pdf-fixtures.mjs` (Joker 배정) 이 다음을 충족해야 한다.

1. Node 18+ 에서 추가 의존성 없이 실행(`pdf-lib`·`qpdf` 는 개발자 로컬에 설치 가정 — CI 는 `pdf-lib` 만 쓰고, `qpdf` 의존 샘플은 별도 플래그로 옵트인).
2. 각 파일별 멱등: 재실행 시 바이트 레벨 동일(`Date.now()` 같은 가변 소스 배제).
3. 크기가 커 커밋하지 않을 파일은 생성 직후 상대경로를 콘솔에 안내(`.gitignore` 가 이미 커버).
4. `--only=rtl,emoji,sec` 같은 필터 플래그로 부분 재생성 지원.
5. 체크섬 목록을 `tests/fixtures/pdf/checksums.json` 에 출력 — CI 가 일치 여부 검증.

---

## 3. .gitignore 권고

```
# tests/fixtures/pdf/.gitignore (신규)
doc-50mb.pdf
doc-100mb.pdf
*.tmp.pdf
```

`doc-50mb.pdf`/`doc-100mb.pdf` 는 로컬 벤치 전용. CI 벤치 잡에서는 생성 스크립트가 먼저 돌아 파일이 존재하게 된다(artifact 로 보관하지 않음).

---

## 4. 라이선스 요약

- **자작(CC0)**: 본 저장소가 직접 작성한 텍스트·메타·합성 PDF. 재배포·수정 제한 없음.
- **OFL(폰트)**: Noto Naskh Arabic, Noto Sans Hebrew, Noto Color Emoji 등 Google Fonts 배포본. 임베딩 시 OFL 조항에 따라 폰트 파일 자체를 재배포하지 않고 PDF 내부 서브셋만 포함.
- **qpdf**: 생성 도구로서만 사용. 산출물 자체의 라이선스에는 영향 없음(CC0 유지).

---

## 5. 체크리스트(Joker 합류 시점)

- [ ] `generate-pdf-fixtures.mjs` 작성 및 멱등 확인
- [ ] `checksums.json` 커밋
- [ ] `.gitignore` 에 대용량 샘플 추가
- [ ] `doc-rtl.pdf`·`doc-emoji.pdf` 의 폰트 서브셋이 10KB 이내로 유지되는지
- [ ] 보안 샘플 4종(`-uri-action`·`-js-action`·`-launch`·`-meta-abuse`)이 실제로 원하는 액션을 담았는지 `pdfinfo`·`qpdf --check` 로 교차 검증
- [ ] `tests/fixtures/pdf/README.md`(본 파일) 의 샘플 개수 = 생성 스크립트 출력 개수 일치
