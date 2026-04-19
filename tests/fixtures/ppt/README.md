# tests/fixtures/ppt — PptAdapter 회귀 샘플 인벤토리

- 작성: QA · 2026-04-19
- 연결 계약: `docs/qa/ppt-adapter-acceptance.md` §2 · §5
- 대상 어댑터: `src/services/multimedia/adapters/PptAdapter.ts`
- 생성 스크립트 권고 위치: `tests/fixtures/ppt/generate-ppt-fixtures.mjs`(Joker 배정, P1)

---

## 0. 원칙

1. **모든 샘플은 자작·공용 도메인.** 외부 저작권 있는 PPT 를 커밋하지 않는다.
2. **생성 스크립트 재현 가능.** 대부분은 `pptxgenjs` + `pizzip` 으로 합성 가능. 레거시 `.ppt`·암호·매크로·OLE 임베딩은 `libreoffice --headless` 또는 OS 별 수동 절차(README 표기).
3. **크기는 필요 최소량.** 50MB·60MB 대용량은 `.gitignore` 처리, 로컬 벤치에서만 생성.
4. **보안 샘플은 무해 페이로드만.** 매크로 샘플은 `app.alert(1)` 수준의 무해 VBA, 외부 링크는 `example.invalid` 도메인으로 고정해 실제 요청이 불가능하게.

---

## 1. 필수 샘플 인벤토리 (14종)

### 1.1 정상 문서 계열

| 파일 | 쪽수 | 크기(목표) | 생성 방법 | 라이선스 | 시나리오 |
| --- | ---: | ---: | --- | --- | --- |
| `sample-basic.pptx` | 3 | ~20 KB | pptxgenjs 합성(타이틀·본문 불릿·노트 각 1개) | 자작(CC0) | P-02, X-01 |
| `doc-100slides.pptx` | 100 | ~500 KB | pptxgenjs 루프 생성 | 자작 | PF-01 · PF-02 · RT-07 |
| `doc-120slides.pptx` | 120 | ~600 KB | 위 + 20장 | 자작 | P-03 |
| `doc-widescreen.pptx` | 1 | ~15 KB | pptxgenjs `layout: 'LAYOUT_WIDE'` (16:9) | 자작 | P-08 |
| `doc-standard.pptx` | 1 | ~15 KB | pptxgenjs `layout: 'LAYOUT_4x3'` | 자작 | P-09 |

### 1.2 국제화·레이아웃 계열

| 파일 | 쪽수 | 크기(목표) | 생성 방법 | 라이선스 | 시나리오 |
| --- | ---: | ---: | --- | --- | --- |
| `doc-multilang-rtl.pptx` | 3 | ~30 KB | pptxgenjs + Noto Sans Hebrew/Naskh Arabic(OFL). 본문: "안녕하세요" / "こんにちは" / "مرحبا" / "שלום" | OFL + 자작 | P-04 |
| `doc-nested-table.pptx` | 2 | ~25 KB | pptxgenjs 로 표 안에 표 수동 배치(`addTable` 중첩) | 자작 | P-05 |
| `doc-animations.pptx` | 3 | ~30 KB | `libreoffice --headless` 로 직접 XML 편집(pptxgenjs 는 애니메이션 미지원 → 수동) | 자작 | P-06 |

### 1.3 경계/비정상 문서 계열

| 파일 | 쪽수 | 크기(목표) | 생성 방법 | 라이선스 | 시나리오 |
| --- | ---: | ---: | --- | --- | --- |
| `empty.pptx` | 0 B | 0 B | `fs.writeFile('empty.pptx', Buffer.alloc(0))` | 자작 | E-01 |
| `doc-empty.pptx` | 0 | ~10 KB | pptxgenjs 로 프레젠테이션만 생성 후 XML 에서 `sldIdLst` 비움 | 자작 | E-06, X-02 |
| `doc-legacy.ppt` | 3 | ~30 KB | `libreoffice --headless --convert-to ppt sample-basic.pptx` | 자작 | E-03 |
| `doc-encrypted.pptx` | 1 | ~20 KB | `msoffice-crypto-tool` 또는 `libreoffice --convert-to pptx --outdir . --infilter "impress_MS_PowerPoint_2007_XML:password"` | 자작 | E-05 |
| `doc-50mb.pptx` / `doc-60mb.pptx` | ≥200 | ≥50/60 MB | 큰 이미지(1MB JPEG) 200+ 장 삽입 · **.gitignore 처리** | 자작 | E-04, PF-01 |

### 1.4 보안 계열

| 파일 | 내용 | 크기(목표) | 생성 방법 | 라이선스 | 시나리오 |
| --- | --- | ---: | --- | --- | --- |
| `doc-external-link.pptx` | `<Relationship Target="http://example.invalid/track">` 1 개 | ~15 KB | pptxgenjs + pizzip 으로 직접 rel 삽입 | 자작 | SEC-01 |
| `doc-macro-pptm.pptx` | `ppt/vbaProject.bin`(무해 `Sub AutoOpen: MsgBox "x"`) 포함, `.pptx` 로 리네임 | ~25 KB | `libreoffice --headless` 로 `.pptm` 저장 후 확장자만 변경 | 자작(무해) | SEC-02 |
| `doc-ole-embed.pptx` | `ppt/embeddings/oleObject1.bin` 포함(빈 바이너리) | ~15 KB | pizzip 으로 bin 엔트리 추가 | 자작 | P-07, SEC-03 |
| `doc-hyperlinks.pptx` | `<a:hlinkClick Action="ppaction://program">`·`<a:hlinkClick r:id="rId1">` 각 1 | ~15 KB | pptxgenjs `addText` + `hyperlink` 옵션 | 자작 | SEC-04 |
| `doc-meta-abuse.pptx` | `dc:creator` 에 16 KB 문자열 | ~25 KB | pptxgenjs 후 `docProps/core.xml` 수동 편집 | 자작 | SEC-05 |

> **기존 `tests/fixtures/deck-small.pptx`**(31 B, ZIP 매직만) 는 "어댑터 미등록/매직 통과 후 parse 실패" 경로 검증에만 사용. 본 인벤토리에서는 `sample-basic.pptx` 로 대체하되 삭제 없이 병행 유지.

---

## 2. 생성 스크립트 요구사항

`tests/fixtures/ppt/generate-ppt-fixtures.mjs` (Joker 배정) 이 다음을 충족해야 한다.

1. Node 18+ 에서 `pptxgenjs` · `pizzip` 만으로 10/14 파일 생성 가능(레거시·암호·매크로·OLE 는 별도 플래그 옵트인).
2. 각 파일별 멱등 — 재실행 시 바이트 동일(생성기가 타임스탬프를 박지 않도록 `created`/`modified` 를 고정값 `2026-04-19T00:00:00Z` 로 세팅).
3. `--only=basic,i18n,sec` 같은 필터 플래그로 부분 재생성.
4. `checksums.json` 에 각 파일의 SHA-256 기재 — CI 가 일치 여부 검증.
5. 50MB/60MB 대용량은 생성 직후 콘솔에 경로만 안내 + `.gitignore` 처리.

---

## 3. `.gitignore` 권고

```
# tests/fixtures/ppt/.gitignore (신규)
doc-50mb.pptx
doc-60mb.pptx
*.tmp.pptx
```

---

## 4. 라이선스 요약

- **자작(CC0)** — 본 저장소가 직접 작성한 텍스트·메타·합성 PPTX. 재배포·수정 제한 없음.
- **OFL(폰트)** — Noto Naskh Arabic / Noto Sans Hebrew / Noto Color Emoji. PPTX 자체에는 폰트 파일을 포함하지 않고 폰트 스택만 지정(뷰어 로컬 폰트 의존).
- **libreoffice / msoffice-crypto-tool** — 생성 도구로만 사용. 산출물 자체의 라이선스에는 영향 없음.

---

## 5. 체크리스트(Joker 합류 시점)

- [ ] `generate-ppt-fixtures.mjs` 작성 및 멱등 확인(SHA-256 고정)
- [ ] `checksums.json` 커밋
- [ ] `.gitignore` 에 대용량 샘플 추가
- [ ] `doc-multilang-rtl.pptx` 의 폰트 대체 정책을 README 하단에 명시(뷰어 의존성 고지)
- [ ] 보안 샘플 5 종이 실제로 의도한 구조를 담았는지 `unzip -l` + `xmlstarlet` 로 교차 검증
- [ ] `docs/qa/ppt-adapter-acceptance.md` §5 테이블과 개수·이름 일치

---

## 6. PDF 축과의 대응 표

| PPT 샘플 | 대응 PDF 샘플(`tests/fixtures/pdf/README.md`) | 교차 변환 시나리오 |
| --- | --- | --- |
| `sample-basic.pptx` | `small.pdf` | X-01 |
| `doc-multilang-rtl.pptx` | `doc-rtl.pdf` | 잠재적 확장(X-시리즈 다국어) |
| `doc-empty.pptx` | `empty.pdf` | X-02 |
| `doc-50mb.pptx` | `doc-50mb.pdf` | 벤치 대칭 |

두 축이 동일한 "정상 / 경계 / 성능 / 보안" 4 구도를 공유하므로, 회귀 테스트도 동일 계층으로 편성 가능하다.
