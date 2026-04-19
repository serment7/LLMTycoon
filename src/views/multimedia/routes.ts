// 지시 #95de334d · 멀티미디어 허브 라우트 키 + 카드 메타.
//
// 본 파일은 "어떤 어댑터가 어떤 카드/카테고리/URL 슬러그에 매핑되는가" 를 한 곳에
// 모아 놓은 정적 매니페스트다. 실제 어댑터 구현체는 MultimediaRegistry 가 소유하고
// 본 모듈은 UI 쪽의 분류·아이콘·라벨·비용 배지 힌트만 담당한다.

import type { MediaAdapterKind } from '../../services/multimedia';

export type MultimediaRouteKey =
  | 'hub'
  | 'pdf'
  | 'ppt'
  | 'search'
  | 'research'
  | 'video'
  | 'input-automation';

export type MultimediaCategory = 'documents' | 'research' | 'video' | 'automation';

export interface MultimediaCardMeta {
  readonly route: MultimediaRouteKey;
  readonly urlPath: `/multimedia${string}`;
  readonly kind: MediaAdapterKind;
  readonly category: MultimediaCategory;
  readonly label: string;
  readonly subtitle: string;
  readonly iconName: 'FileText' | 'Presentation' | 'Search' | 'Compass' | 'Film' | 'FlaskConical';
  /** 예상 토큰 비용 규모(수천 단위). amber 경고 배지는 heavy 일 때 상시. */
  readonly expectedTokens: number;
  readonly costAccent: 'neutral' | 'heavy';
  /** 기본 비활성(사용자 허용 전) 여부. UI 는 잠금 배지를 노출. */
  readonly defaultLocked: boolean;
  /** 잠금 해제 경로 안내 카피. */
  readonly unlockHint?: string;
}

export const MULTIMEDIA_CARDS: readonly MultimediaCardMeta[] = [
  {
    route: 'pdf',
    urlPath: '/multimedia/pdf',
    kind: 'pdf',
    category: 'documents',
    label: 'PDF 입출력',
    subtitle: '최대 100MB · 300쪽',
    iconName: 'FileText',
    expectedTokens: 2000,
    costAccent: 'neutral',
    defaultLocked: false,
  },
  {
    route: 'ppt',
    urlPath: '/multimedia/ppt',
    kind: 'pptx',
    category: 'documents',
    label: 'PPT 입출력',
    subtitle: '24슬 표준 · 마스터 유지',
    iconName: 'Presentation',
    expectedTokens: 3000,
    costAccent: 'neutral',
    defaultLocked: false,
  },
  {
    route: 'search',
    urlPath: '/multimedia/search',
    kind: 'web-search',
    category: 'research',
    label: '웹 검색',
    subtitle: '상위 5 결과 + 출처',
    iconName: 'Search',
    expectedTokens: 1000,
    costAccent: 'neutral',
    defaultLocked: false,
  },
  {
    route: 'research',
    urlPath: '/multimedia/research',
    kind: 'research',
    category: 'research',
    label: '리서치',
    subtitle: '다단계 요약 + 인용',
    iconName: 'Compass',
    expectedTokens: 8000,
    costAccent: 'heavy',
    defaultLocked: false,
  },
  {
    route: 'video',
    urlPath: '/multimedia/video',
    kind: 'video',
    category: 'video',
    label: '영상 생성',
    subtitle: '10초 · 1080p · Sora/Veo',
    iconName: 'Film',
    expectedTokens: 12000,
    costAccent: 'heavy',
    defaultLocked: false,
  },
  {
    route: 'input-automation',
    urlPath: '/multimedia/input-automation',
    kind: 'input-automation',
    category: 'automation',
    label: '임의 QA 자동화',
    subtitle: '시나리오 실행 · 회귀 대시보드',
    iconName: 'FlaskConical',
    expectedTokens: 5000,
    costAccent: 'heavy',
    defaultLocked: true,
    unlockHint: '설정 › 보안 › 입력 자동화에서 활성화하세요.',
  },
];

export const MULTIMEDIA_CATEGORIES: readonly {
  readonly id: MultimediaCategory;
  readonly label: string;
  readonly subtitle: string;
}[] = [
  { id: 'documents', label: '문서 처리', subtitle: 'PDF · PPT' },
  { id: 'research', label: '웹 · 리서치', subtitle: '검색 · 심층 조사' },
  { id: 'video', label: '영상 생성', subtitle: 'Sora · Veo' },
  { id: 'automation', label: '임의 QA 자동화', subtitle: '권한 위임' },
];

/** URL slug 또는 route key 로 카드 메타를 찾는다. 테스트·App.tsx 가 재사용. */
export function resolveCardByRoute(route: MultimediaRouteKey): MultimediaCardMeta | null {
  if (route === 'hub') return null;
  return MULTIMEDIA_CARDS.find((c) => c.route === route) ?? null;
}

export function resolveCardByUrlPath(urlPath: string): MultimediaCardMeta | null {
  return MULTIMEDIA_CARDS.find((c) => c.urlPath === urlPath) ?? null;
}

export function parseMultimediaRoute(urlPath: string): MultimediaRouteKey {
  if (urlPath === '/multimedia' || urlPath === '/multimedia/') return 'hub';
  const match = MULTIMEDIA_CARDS.find((c) => c.urlPath === urlPath);
  return match?.route ?? 'hub';
}
