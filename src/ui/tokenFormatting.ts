// 지시 #17e58c0f · 토큰 사용량 UI 의 숫자 포매팅·공용 타입.
//
// 포매팅 정책(디자이너 합의 · `docs/design/` 시안 기준)
//   · 1,000 미만: 구분자 포함한 정수(예: en-US "942", ko-KR "942").
//   · 1,000 이상: K/M 축약(예: en-US "1.2K", ko-KR "1.2천" 은 지양 — 영문 축약을 공통
//     표기로 유지해 고정폭 정렬을 깨지 않는다). 소수점 1자리 고정.
//   · 로캘 구분자는 `Intl.NumberFormat(locale).format(value)` 로 얻는다. 즉 천 단위
//     구분자만 로캘별이며, 축약 단위 자체는 공통(K/M).
//   · 고정폭 정렬을 위해 뷰에서 `font-variant-numeric: tabular-nums` 토큰을 클래스
//     `tw-numeric` 로 제공(CSS 는 다른 PR 이 담당 — 본 파일은 className 만 내보냄).

export type TokenFormatterLocale = 'en' | 'ko';

export interface TokenUsageSnapshot {
  readonly input: number;
  readonly output: number;
  readonly cacheHit: number;
  /** 세션 한도(선택). 인디케이터의 진행률 바가 이 값 대비 비율로 채워진다. */
  readonly sessionLimit?: number;
}

export interface UsageSessionPoint {
  /** ISO 문자열 또는 라벨. 스파크라인은 순서만 보므로 고유값이면 족하다. */
  readonly at: string;
  readonly total: number;
}

export interface AgentUsageShare {
  readonly agent: string;
  readonly total: number;
}

export interface CompactionEvent {
  readonly at: string;
  readonly agent?: string;
  /** 압축으로 절감된 토큰 수. 음수가 들어오면 0 으로 클램프(비정상 로그 방어). */
  readonly savedTokens: number;
}

/** 인디케이터·패널이 공통으로 받는 스냅샷 + 집계 데이터 봉투. */
export interface TokenUsageViewModel {
  readonly current: TokenUsageSnapshot;
  readonly sessions?: readonly UsageSessionPoint[];
  readonly topAgents?: readonly AgentUsageShare[];
  readonly compactions?: readonly CompactionEvent[];
}

// ────────────────────────────────────────────────────────────────────────────
// 포매팅 유틸
// ────────────────────────────────────────────────────────────────────────────

const UNIT_THRESHOLDS: ReadonlyArray<{ readonly value: number; readonly unit: string }> = [
  { value: 1_000_000_000, unit: 'B' },
  { value: 1_000_000, unit: 'M' },
  { value: 1_000, unit: 'K' },
];

function resolveIntlLocale(locale: TokenFormatterLocale): string {
  return locale === 'ko' ? 'ko-KR' : 'en-US';
}

/** 정수 → 로캘 포맷 문자열(예: 12345 → "12,345" / "12,345"). 음수는 0 클램프. */
export function formatInteger(value: number, locale: TokenFormatterLocale): string {
  const safe = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return new Intl.NumberFormat(resolveIntlLocale(locale), { maximumFractionDigits: 0 }).format(safe);
}

/** 축약 단위(K/M/B) 포함 정수 포맷. 1000 미만은 formatInteger 와 동일. */
export function formatCompactTokens(value: number, locale: TokenFormatterLocale): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  for (const { value: threshold, unit } of UNIT_THRESHOLDS) {
    if (safe >= threshold) {
      const scaled = safe / threshold;
      // 소수 1자리 고정. 10.0 이상은 정수로(칼럼 폭 확보).
      const digits = scaled >= 10 ? 0 : 1;
      const n = new Intl.NumberFormat(resolveIntlLocale(locale), {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(scaled);
      return `${n}${unit}`;
    }
  }
  return formatInteger(safe, locale);
}

/** 0~1 비율 → "xx%" 로캘 포맷. NaN·무한·음수는 0%. */
export function formatPercent(ratio: number, locale: TokenFormatterLocale): string {
  const safe = Number.isFinite(ratio) && ratio >= 0 ? Math.min(ratio, 1) : 0;
  return new Intl.NumberFormat(resolveIntlLocale(locale), { style: 'percent', maximumFractionDigits: 0 }).format(safe);
}

/** 스냅샷 → 세션 한도 대비 소진율(0~1). 한도 미지정 시 null. */
export function computeUsageRatio(snapshot: TokenUsageSnapshot): number | null {
  if (!snapshot.sessionLimit || snapshot.sessionLimit <= 0) return null;
  const used = Math.max(0, snapshot.input) + Math.max(0, snapshot.output);
  return Math.min(1, used / snapshot.sessionLimit);
}

/**
 * 3색 비율 — 인디케이터의 세그먼트 바에서 input/output/cacheHit 가 차지하는 구간.
 * 전체가 0 이면 0/0/0 반환(분할 에러 방지).
 */
export function computeSegmentRatios(snapshot: TokenUsageSnapshot): {
  readonly input: number;
  readonly output: number;
  readonly cacheHit: number;
} {
  const i = Math.max(0, snapshot.input);
  const o = Math.max(0, snapshot.output);
  const c = Math.max(0, snapshot.cacheHit);
  const total = i + o + c;
  if (total <= 0) return { input: 0, output: 0, cacheHit: 0 };
  return { input: i / total, output: o / total, cacheHit: c / total };
}

/** 스파크라인(0..1 정규화) — 최솟값=0, 최댓값=1. 모든 값 같으면 0.5 수평선. */
export function normalizeSparkline(points: readonly UsageSessionPoint[]): readonly number[] {
  if (points.length === 0) return [];
  const values = points.map((p) => Math.max(0, p.total));
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}
