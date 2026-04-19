// 지시 #ed6ac142 §2 — 클립보드 붙여넣기 → 멀티미디어 파이프라인 진입 훅.
//
// `UploadDropzone`(Joker #25c6969c) 과 같은 입력 컴포넌트가 window 전역의 `paste`
// 이벤트에서 이미지/파일을 꺼내 `onFiles(files)` 콜백으로 흘려 보내도록 돕는 훅이다.
// 두 가지 바인딩 경로를 제공한다:
//   1) `onPaste(e)` — React 의 `onPaste` 핸들러에 그대로 연결. 폼 입력 요소에 포커스
//      가 있을 때 Ctrl+V 로 파일을 떨어뜨리는 경로.
//   2) `bindToWindow()` — window 전역 'paste' 이벤트를 수신하고, 정리용 cleanup
//      함수를 돌려준다. 드롭존에 포커스가 없는 상태에서도 전체 앱이 이미지를 받게
//      할 때 유용.
//
// 실제 파일 추출은 `mediaLoaders.extractFilesFromClipboard` 순수 함수에 위임한다.
// 본 훅은 React 의존만 담당한다 — Node 에서도 `extractFilesFromClipboard` 는 직접
// 호출 가능하므로 테스트 표면이 분리된다.

import { useCallback, useEffect, useRef } from 'react';
import type { ClipboardEvent as ReactClipboardEvent } from 'react';
import { extractFilesFromClipboard } from './mediaLoaders';

export interface UseMediaPasteCaptureOptions {
  /** 추출된 파일들이 전달되는 콜백. 빈 배열이면 호출되지 않는다. */
  onFiles: (files: File[]) => void;
  /** 기본 true. false 면 핸들러가 no-op 이 되어 훅 호출부가 조건부 마운트를 안 해도 된다. */
  enabled?: boolean;
  /** 'image/' 접두만 허용하려면 'image/' 를 넘긴다. 기본은 모든 파일. */
  acceptPrefix?: string;
  /**
   * true 이면 파일이 추출되었을 때 `event.preventDefault()` 를 호출해 기본 붙여넣기
   * 처리(편집창에 텍스트 삽입 등)를 막는다. onPaste 경로에서만 의미 있다. 기본 true.
   */
  preventDefaultOnFiles?: boolean;
}

export interface UseMediaPasteCaptureApi {
  /** React 요소의 `onPaste` 에 그대로 꽂는 핸들러. */
  onPaste: (event: ReactClipboardEvent) => void;
  /**
   * window 전역 'paste' 리스너를 등록하고 cleanup 함수를 돌려준다. 한 번 호출하면
   * 여러 번 호출해도 동일 리스너가 중복되지 않는다. `enabled=false` 면 no-op.
   */
  bindToWindow: () => () => void;
}

/**
 * 클립보드에서 파일(주로 이미지) 을 잡아 onFiles 콜백으로 흘려 보낸다. 본 훅은
 * React 의존만 감싼 얇은 어댑터이며, 실제 추출 로직은 `extractFilesFromClipboard`
 * 순수 함수에 있다.
 */
export function useMediaPasteCapture(options: UseMediaPasteCaptureOptions): UseMediaPasteCaptureApi {
  const enabled = options.enabled !== false;
  const preventDefault = options.preventDefaultOnFiles !== false;
  const onFilesRef = useRef(options.onFiles);
  const prefixRef = useRef(options.acceptPrefix);
  const preventRef = useRef(preventDefault);

  // 최신 콜백/옵션을 ref 로 보관해 bindToWindow 가 등록한 리스너가 재등록 없이
  // 최신 값을 읽도록 한다. useEffect 의존성을 단순화하는 표준 패턴.
  useEffect(() => { onFilesRef.current = options.onFiles; }, [options.onFiles]);
  useEffect(() => { prefixRef.current = options.acceptPrefix; }, [options.acceptPrefix]);
  useEffect(() => { preventRef.current = preventDefault; }, [preventDefault]);

  const onPaste = useCallback((event: ReactClipboardEvent) => {
    if (!enabled) return;
    const files = extractFilesFromClipboard(
      { clipboardData: event.clipboardData as unknown as { items?: unknown; files?: unknown } },
      { acceptPrefix: prefixRef.current },
    );
    if (files.length === 0) return;
    if (preventRef.current) {
      try { event.preventDefault(); } catch { /* jsdom/안전 폴백 */ }
    }
    onFilesRef.current(files);
  }, [enabled]);

  const bindToWindow = useCallback((): (() => void) => {
    if (!enabled) return () => { /* no-op */ };
    const target = (globalThis as { window?: Window }).window;
    if (!target || typeof target.addEventListener !== 'function') {
      return () => { /* SSR/Node */ };
    }
    const handler = (event: Event) => {
      const clip = event as unknown as { clipboardData?: unknown };
      const files = extractFilesFromClipboard(
        { clipboardData: clip.clipboardData as { items?: unknown; files?: unknown } | null },
        { acceptPrefix: prefixRef.current },
      );
      if (files.length === 0) return;
      if (preventRef.current) {
        try { (event as Event).preventDefault(); } catch { /* safe */ }
      }
      onFilesRef.current(files);
    };
    target.addEventListener('paste', handler as EventListener);
    return () => target.removeEventListener('paste', handler as EventListener);
  }, [enabled]);

  return { onPaste, bindToWindow };
}
