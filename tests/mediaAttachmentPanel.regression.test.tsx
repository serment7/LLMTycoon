// Run with: npx tsx --test tests/mediaAttachmentPanel.regression.test.tsx
//
// QA 1차 회귀(#154cb987) — MediaAttachmentPanel 접근성·키보드·상태 분기.
//
// 지시 본문이 "드래그앤드롭 빈 상태·업로드 진행·EmptyState/ErrorState 재활용" 을
// 언급하나, 현재 컴포넌트는 아직 드래그앤드롭/진행 UI/EmptyState 재활용을
// 구현하지 않았다(src/components/MediaAttachmentPanel.tsx 는 버튼 기반 파일 선택
// + `<p role="status">` 단순 안내). 따라서 본 회귀는 **현재 구현의 접근성 계약과
// 상태 분기**를 잠그는 1차 안전망이며, 이후 드래그앤드롭/진행 상태가 추가되면
// 같은 testId 패턴을 유지한 채로 시나리오를 확장할 수 있도록 selector 를
// `[data-testid]` 로만 고정했다.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { MediaAttachmentPanel } from '../src/components/MediaAttachmentPanel.tsx';
import type { MediaAsset } from '../src/types.ts';

function sampleAsset(
  id: string,
  kind: MediaAsset['kind'],
  name: string,
  over: Partial<MediaAsset> = {},
): MediaAsset {
  return {
    id,
    projectId: 'p1',
    kind,
    name,
    mimeType: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'application/pdf',
    sizeBytes: 1024,
    createdAt: '2026-04-19T10:00:00.000Z',
    ...over,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 1. 빈 상태 — role="status" + 한국어 안내
// ────────────────────────────────────────────────────────────────────────────

test('빈 상태에서는 role="status" 안내 단락이 노출되고, 리스트는 렌더되지 않는다', () => {
  const handle = render(
    React.createElement(MediaAttachmentPanel, {
      assets: [],
      onFilesAdded: () => {},
      onRemove: () => {},
    }),
  );
  const empty = document.querySelector('[data-testid="media-attachment-empty"]');
  assert.ok(empty, '빈 상태 노드가 있어야 한다');
  assert.equal(empty!.getAttribute('role'), 'status', '스크린리더가 즉시 감지');
  assert.match(empty!.textContent ?? '', /아직 첨부된 미디어가 없습니다/);
  assert.equal(
    document.querySelector('[data-testid="media-attachment-list"]'),
    null,
    '빈 상태에서는 리스트가 없어야 한다',
  );
  handle.unmount();
  cleanup();
});

// ────────────────────────────────────────────────────────────────────────────
// 2. 파일 선택 버튼 — aria-describedby + disabled 조합
// ────────────────────────────────────────────────────────────────────────────

test('파일 선택 버튼은 제목과 aria-describedby 로 연결되고 disabled 가 버튼·textarea 에 전파된다', () => {
  const handle = render(
    React.createElement(MediaAttachmentPanel, {
      assets: [],
      onFilesAdded: () => {},
      onRemove: () => {},
      onGenerate: () => {},
      disabled: true,
    }),
  );
  const title = document.getElementById('media-attachment-title');
  const chooseBtn = document.querySelector('[data-testid="media-attachment-choose"]') as HTMLButtonElement;
  assert.ok(title, '접근 가능한 제목이 존재');
  assert.equal(chooseBtn.getAttribute('aria-describedby'), 'media-attachment-title');
  assert.equal(chooseBtn.disabled, true, 'disabled prop 은 파일 선택 버튼에 전파');
  // 생성 패널도 disabled 전파되어야 한다.
  const promptEl = document.querySelector('[data-testid="media-generate-prompt"]') as HTMLTextAreaElement;
  const kindEl = document.querySelector('[data-testid="media-generate-kind"]') as HTMLSelectElement;
  const submitEl = document.querySelector('[data-testid="media-generate-submit"]') as HTMLButtonElement;
  assert.equal(promptEl.disabled, true);
  assert.equal(kindEl.disabled, true);
  assert.equal(submitEl.disabled, true);
  handle.unmount();
  cleanup();
});

// ────────────────────────────────────────────────────────────────────────────
// 3. 파일 input — aria-hidden + 같은 파일 재선택 가능(value 초기화)
// ────────────────────────────────────────────────────────────────────────────

test('파일 change 이벤트가 발생하면 onFilesAdded 에 File 배열이 전달되고 input.value 가 초기화된다', () => {
  const added: File[][] = [];
  const handle = render(
    React.createElement(MediaAttachmentPanel, {
      assets: [],
      onFilesAdded: (f: File[]) => {
        added.push(f);
      },
      onRemove: () => {},
    }),
  );
  const input = document.querySelector('[data-testid="media-attachment-input"]') as HTMLInputElement;
  assert.equal(input.getAttribute('aria-hidden'), 'true', 'file input 은 스크린리더에서 숨김');
  assert.equal(input.multiple, true, '다중 선택 허용');
  assert.equal(input.accept, '.pdf,.pptx,.ppt,video/*,image/*', '기본 accept 계약 고정');

  const file = new File(['x'], 'note.pdf', { type: 'application/pdf' });
  act(() => {
    Object.defineProperty(input, 'files', {
      value: [file],
      configurable: true,
    });
    fireEvent.change(input);
  });
  assert.equal(added.length, 1, 'onFilesAdded 호출 1회');
  assert.equal(added[0][0].name, 'note.pdf');
  assert.equal(input.value, '', '같은 파일 재선택 가능하도록 value 가 초기화');
  handle.unmount();
  cleanup();
});

// ────────────────────────────────────────────────────────────────────────────
// 4. 자산 리스트 — data-kind + 제거 버튼의 한국어 aria-label
// ────────────────────────────────────────────────────────────────────────────

test('자산이 있을 때 리스트가 렌더되고 제거 버튼은 "{이름} 제거" aria-label 을 갖는다', () => {
  const assets: MediaAsset[] = [
    sampleAsset('a1', 'pdf', '명세서.pdf'),
    sampleAsset('a2', 'video', '데모.mp4'),
  ];
  const removed: string[] = [];
  const handle = render(
    React.createElement(MediaAttachmentPanel, {
      assets,
      onFilesAdded: () => {},
      onRemove: (id: string) => {
        removed.push(id);
      },
    }),
  );
  const list = document.querySelector('[data-testid="media-attachment-list"]');
  assert.ok(list, '리스트 렌더');
  assert.equal(
    document.querySelector('[data-testid="media-attachment-empty"]'),
    null,
    '자산 존재 시 빈 상태는 숨김',
  );
  const pdfLi = document.querySelector('[data-testid="media-asset-a1"]') as HTMLElement;
  const videoLi = document.querySelector('[data-testid="media-asset-a2"]') as HTMLElement;
  assert.equal(pdfLi.getAttribute('data-kind'), 'pdf');
  assert.equal(videoLi.getAttribute('data-kind'), 'video');
  const pdfRemove = document.querySelector('[data-testid="media-asset-remove-a1"]') as HTMLButtonElement;
  assert.equal(pdfRemove.getAttribute('aria-label'), '명세서.pdf 제거');
  act(() => {
    fireEvent.click(pdfRemove);
  });
  assert.deepEqual(removed, ['a1']);
  handle.unmount();
  cleanup();
});

// ────────────────────────────────────────────────────────────────────────────
// 5. onGenerate 미전달 → 생성 패널 자체가 렌더되지 않음
// ────────────────────────────────────────────────────────────────────────────

test('onGenerate 가 주어지지 않으면 생성 패널과 그 카운트가 모두 DOM 에 존재하지 않는다', () => {
  const handle = render(
    React.createElement(MediaAttachmentPanel, {
      assets: [],
      onFilesAdded: () => {},
      onRemove: () => {},
    }),
  );
  assert.equal(document.querySelector('[data-testid="media-generate-panel"]'), null);
  assert.equal(document.querySelector('[data-testid="media-generate-counts"]'), null);
  handle.unmount();
  cleanup();
});

// ────────────────────────────────────────────────────────────────────────────
// 6. 생성 제출 — 빈/공백 프롬프트는 차단, 유효 입력 시 trim 후 콜백 + 초기화
// ────────────────────────────────────────────────────────────────────────────

test('생성 버튼은 공백 프롬프트에서 비활성화되고, 유효 입력 시 trim·kind 로 콜백 후 프롬프트가 초기화된다', () => {
  const generated: Array<{ kind: MediaAsset['kind']; prompt: string }> = [];
  const handle = render(
    React.createElement(MediaAttachmentPanel, {
      assets: [],
      onFilesAdded: () => {},
      onRemove: () => {},
      onGenerate: (params: { kind: MediaAsset['kind']; prompt: string }) => {
        generated.push(params);
      },
    }),
  );
  const prompt = document.querySelector('[data-testid="media-generate-prompt"]') as HTMLTextAreaElement;
  const kind = document.querySelector('[data-testid="media-generate-kind"]') as HTMLSelectElement;
  const submit = document.querySelector('[data-testid="media-generate-submit"]') as HTMLButtonElement;
  assert.equal(submit.disabled, true, '초기 빈 프롬프트 → 비활성');

  act(() => {
    fireEvent.change(prompt, { target: { value: '   ' } });
  });
  assert.equal(submit.disabled, true, '공백만 있으면 여전히 비활성');

  act(() => {
    fireEvent.change(prompt, { target: { value: '  결제 흐름 데모 영상  ' } });
    fireEvent.change(kind, { target: { value: 'video' } });
  });
  assert.equal(submit.disabled, false, '유효 입력 → 활성');
  act(() => {
    fireEvent.click(submit);
  });
  assert.deepEqual(generated, [{ kind: 'video', prompt: '결제 흐름 데모 영상' }], 'trim 된 프롬프트가 전달');
  assert.equal(prompt.value, '', '제출 후 프롬프트 초기화');
  handle.unmount();
  cleanup();
});

// ────────────────────────────────────────────────────────────────────────────
// 7. 종류별 카운트 — 4종 라벨이 고정 순서로 렌더되고 숫자가 일치
// ────────────────────────────────────────────────────────────────────────────

test('종류별 카운트 4종(video/pdf/pptx/image) 이 정확한 수치를 돌려준다', () => {
  const assets: MediaAsset[] = [
    sampleAsset('a1', 'pdf', 'a.pdf'),
    sampleAsset('a2', 'pdf', 'b.pdf'),
    sampleAsset('a3', 'video', 'v.mp4'),
    sampleAsset('a4', 'image', 'i.png'),
    sampleAsset('a5', 'pptx', 'd.pptx'),
  ];
  const handle = render(
    React.createElement(MediaAttachmentPanel, {
      assets,
      onFilesAdded: () => {},
      onRemove: () => {},
      onGenerate: () => {},
    }),
  );
  assert.equal(
    document.querySelector('[data-testid="media-generate-count-video"]')?.textContent,
    '1',
  );
  assert.equal(
    document.querySelector('[data-testid="media-generate-count-pdf"]')?.textContent,
    '2',
  );
  assert.equal(
    document.querySelector('[data-testid="media-generate-count-pptx"]')?.textContent,
    '1',
  );
  assert.equal(
    document.querySelector('[data-testid="media-generate-count-image"]')?.textContent,
    '1',
  );
  handle.unmount();
  cleanup();
});

// ────────────────────────────────────────────────────────────────────────────
// 8. 키보드 — 파일 선택 버튼은 기본 button 으로 포커스 가능하고 click 경로가 input 을 연다
// ────────────────────────────────────────────────────────────────────────────

test('파일 선택 버튼은 포커스 가능하고 click 이 input.click() 을 호출한다(키보드 접근성 대리)', () => {
  let inputClicked = 0;
  // HTMLInputElement.prototype.click 을 스파이로 대체해 버튼 → 숨김 input 경로가
  // 실제로 트리거되는지 관찰한다. jsdom 은 file picker 를 열 수 없지만 click()
  // 자체는 호출되므로 이 경로만 잠그면 충분하다.
  const origClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function patched() {
    if (this.getAttribute('type') === 'file') inputClicked += 1;
    return origClick.call(this);
  };
  const handle = render(
    React.createElement(MediaAttachmentPanel, {
      assets: [],
      onFilesAdded: () => {},
      onRemove: () => {},
    }),
  );
  const chooseBtn = document.querySelector('[data-testid="media-attachment-choose"]') as HTMLButtonElement;
  chooseBtn.focus();
  assert.equal(document.activeElement, chooseBtn, '파일 선택 버튼에 포커스 가능');
  act(() => {
    fireEvent.click(chooseBtn);
  });
  assert.equal(inputClicked, 1, '버튼 클릭이 숨김 input.click 으로 위임된다');

  HTMLInputElement.prototype.click = origClick;
  handle.unmount();
  cleanup();
});
