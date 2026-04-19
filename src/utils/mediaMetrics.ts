// 지시 #ed6ac142 §4 — 성능 관측 훅(링 버퍼) + DevTools 노출.
//
// 배경 — 업로드(네트워크) · 파싱(서버) · 변환(Claude 블록 빌드) · 내보내기(exporter
// 호출) 네 축의 소요 시간을 한 곳에 모아 "느린 경로" 를 재현 가능한 수치로 잡아 두는
// 최소 관측 훅이다. 서버 로그에 보내지 않고 브라우저 메모리에만 링 버퍼로 유지해
// 개인정보·네트워크 비용 걱정 없이 DevTools 콘솔(`window.__mediaMetrics`)에서 바로
// 조회·초기화·익스포트할 수 있다.
//
// 설계:
//   · 링 버퍼 크기는 기본 200. 한계에 닿으면 가장 오래된 항목을 덮어쓴다(FIFO).
//   · `observeMediaMetric(kind, label, fn, meta?)` — 비동기 함수 러닝 타임을 자동
//     측정해 링 버퍼에 적재한다. 실패도 `ok:false` + `errorCode` 로 기록한다.
//   · `recordMediaMetric(entry)` — 이미 측정한 값을 직접 밀어 넣을 때 쓴다.
//   · `exposeMediaMetricsOnWindow(win?)` — `window.__mediaMetrics` 에 조회·초기화·
//     덤프 API 를 매달아 DevTools 에서 즉시 사용 가능하게 한다. 테스트는 임의 객체를
//     주입해 SSR/Node 에서도 계약을 잠근다.

export type MediaMetricKind = 'upload' | 'parse' | 'transform' | 'export';

export interface MediaMetricEntry {
  kind: MediaMetricKind;
  /** 사람 친화 라벨 — 'pdf-upload', 'claude-attachment-build' 등. */
  label: string;
  /** epoch ms. 측정 시작 시각. */
  startedAtMs: number;
  /** 측정 경과 시간(ms). */
  durationMs: number;
  /** 관측 대상 자산 id(있으면). */
  assetId?: string;
  /** 데이터 크기(바이트). 네트워크 경로에서 유용. */
  bytes?: number;
  ok: boolean;
  /** 실패 시 MediaLoaderError/MediaExporterError 의 code 등. */
  errorCode?: string;
}

export interface MediaMetricsOptions {
  /** 링 버퍼 용량. 기본 200. 1 이상 정수. */
  capacity?: number;
  /** Date.now 대체 주입. 테스트에서 결정적 타임라인을 만들기 위해 사용. */
  now?: () => number;
}

interface MediaMetricsStore {
  capacity: number;
  buffer: MediaMetricEntry[];
  /** 다음 삽입 위치(원형 포인터). */
  cursor: number;
  /** 전체 누적 수. capacity 를 넘어가면 래핑. */
  size: number;
  now: () => number;
}

function createStore(options: MediaMetricsOptions = {}): MediaMetricsStore {
  const capacity = Math.max(1, Math.floor(options.capacity ?? 200));
  return {
    capacity,
    buffer: [],
    cursor: 0,
    size: 0,
    now: options.now ?? Date.now,
  };
}

// 프로세스 싱글톤 — 브라우저에선 탭별 하나, Node 테스트에선 import 당 하나.
let defaultStore = createStore();

/** 테스트 전용 — 저장소 교체·리셋. 프로덕션 코드는 호출하지 않는다. */
export function __resetMediaMetricsForTests(options?: MediaMetricsOptions): void {
  defaultStore = createStore(options);
}

export function configureMediaMetrics(options: MediaMetricsOptions): void {
  defaultStore = createStore({
    capacity: options.capacity ?? defaultStore.capacity,
    now: options.now ?? defaultStore.now,
  });
}

export function recordMediaMetric(entry: MediaMetricEntry): void {
  const slot = defaultStore.cursor;
  defaultStore.buffer[slot] = entry;
  defaultStore.cursor = (slot + 1) % defaultStore.capacity;
  if (defaultStore.size < defaultStore.capacity) defaultStore.size += 1;
}

/**
 * 비동기 함수의 경과 시간을 측정해 링 버퍼에 쌓는다. 함수가 throw 하면 다시 throw
 * 하되, ok:false · errorCode 를 기록한 뒤 전파한다. 성공 시 반환값을 그대로 돌려준다.
 */
export async function observeMediaMetric<T>(
  kind: MediaMetricKind,
  label: string,
  fn: () => Promise<T>,
  meta?: Omit<Partial<MediaMetricEntry>, 'kind' | 'label' | 'startedAtMs' | 'durationMs' | 'ok'>,
): Promise<T> {
  const startedAtMs = defaultStore.now();
  try {
    const value = await fn();
    recordMediaMetric({
      kind,
      label,
      startedAtMs,
      durationMs: defaultStore.now() - startedAtMs,
      ok: true,
      assetId: meta?.assetId,
      bytes: meta?.bytes,
    });
    return value;
  } catch (err) {
    const errorCode = typeof (err as { code?: unknown })?.code === 'string'
      ? (err as { code: string }).code
      : undefined;
    recordMediaMetric({
      kind,
      label,
      startedAtMs,
      durationMs: defaultStore.now() - startedAtMs,
      ok: false,
      assetId: meta?.assetId,
      bytes: meta?.bytes,
      errorCode,
    });
    throw err;
  }
}

/** 현재 링 버퍼 내용을 삽입 순서대로 복사해 돌려준다(오래된 → 최신). */
export function getMediaMetrics(): MediaMetricEntry[] {
  const { buffer, cursor, size, capacity } = defaultStore;
  if (size === 0) return [];
  if (size < capacity) {
    // 버퍼가 아직 다 안 찼으므로 0..size 구간이 유효하고 삽입 순서와 일치한다.
    return buffer.slice(0, size);
  }
  // 링이 한 번 이상 래핑됨 — cursor 가 "다음 덮어쓸 위치" 이므로 그곳이 가장 오래된
  // 항목 인덱스가 된다.
  return [...buffer.slice(cursor), ...buffer.slice(0, cursor)];
}

export function getMediaMetricsSize(): number {
  return defaultStore.size;
}

export function clearMediaMetrics(): void {
  defaultStore.buffer = [];
  defaultStore.cursor = 0;
  defaultStore.size = 0;
}

export interface MediaMetricsWindowApi {
  get: () => MediaMetricEntry[];
  clear: () => void;
  size: () => number;
  dump: () => string;
}

/**
 * 글로벌 객체(window)에 조회·초기화 API 를 매단다. 반환값은 `globalThis` 에 연결된
 * 객체 본체로, 테스트가 직접 조회할 수 있다. 호출자가 `win` 을 주입하면 그 객체에
 * 매달고(SSR/Node 테스트), 생략하면 전역 window 에 매단다.
 */
export function exposeMediaMetricsOnWindow(
  win?: { __mediaMetrics?: MediaMetricsWindowApi },
): MediaMetricsWindowApi {
  const api: MediaMetricsWindowApi = {
    get: () => getMediaMetrics(),
    clear: () => clearMediaMetrics(),
    size: () => getMediaMetricsSize(),
    dump: () => JSON.stringify(getMediaMetrics(), null, 2),
  };
  const target = win ?? (globalThis as { __mediaMetrics?: MediaMetricsWindowApi });
  target.__mediaMetrics = api;
  return api;
}
