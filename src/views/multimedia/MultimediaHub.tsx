// 지시 #95de334d · 멀티미디어 허브 메인 라우트.
//
// 시안(docs/designs/multimedia-hub.md) 의 카드 그리드 + 작업 영역 구조를 구현하되,
// 본 라운드의 범위는 "어댑터 카탈로그 + 세부 뷰 진입점" 까지다. 각 축의 실제 폼/결과
// 컴포넌트는 PlaceholderAdapterView 로 통일해 두고, 후속 PR 에서 교체한다.
//
// 진입점
//   · /multimedia        — 카드 그리드 + 카테고리 탭 (본 컴포넌트 초기 route='hub')
//   · /multimedia/pdf    — PDF 세부 뷰
//   · /multimedia/ppt    — PPT 세부 뷰
//   · /multimedia/search — 웹 검색 세부 뷰
//   · /multimedia/research       — 리서치 세부 뷰
//   · /multimedia/video          — 영상 생성 세부 뷰
//   · /multimedia/input-automation — 임의 QA 자동화 세부 뷰
//
// 현재 App.tsx 는 URL 라우터 대신 activeTab 문자열 상태를 쓰므로, 본 컴포넌트도
// route 를 React state 로 관리한다. 외부 주소 표시는 MultimediaCardMeta.urlPath 를
// aria-label/부제로 노출해 "어떤 경로로 접근했는지" 사용자에게 전달한다.

import React, { useMemo, useState } from 'react';
import {
  FileText,
  Presentation,
  Search,
  Compass,
  Film,
  FlaskConical,
  Lock,
  CircleAlert,
} from 'lucide-react';

import {
  MULTIMEDIA_CARDS,
  MULTIMEDIA_CATEGORIES,
  parseMultimediaRoute,
  resolveCardByRoute,
  type MultimediaCardMeta,
  type MultimediaCategory,
  type MultimediaRouteKey,
} from './routes';
import { useMultimediaJobs } from './useMultimediaJobs';
import { PlaceholderAdapterView } from './adapterViews/PlaceholderAdapterView';
import { VideoGeneration } from './VideoGeneration';
import type { MultimediaRegistry } from '../../services/multimedia';

const ICONS = {
  FileText,
  Presentation,
  Search,
  Compass,
  Film,
  FlaskConical,
};

export interface MultimediaHubProps {
  /** 레지스트리 주입 — 테스트에서 stub, 앱은 createDefaultRegistry() 결과. */
  readonly registry?: MultimediaRegistry;
  readonly initialRoute?: MultimediaRouteKey;
  readonly initialCategory?: MultimediaCategory;
  /** `InputAutomationAdapterOptions.enabled=false` 같은 사용자 허용 플래그 조회 훅. */
  readonly isAdapterEnabled?: (route: MultimediaRouteKey) => boolean;
  readonly onUnlockRoute?: (route: MultimediaRouteKey) => void;
  /** 외부 링크(라우터 기반) 로 이동할 때 호출. 없으면 내부 state 로만 전환. */
  readonly onNavigate?: (route: MultimediaRouteKey) => void;
  readonly urlPath?: string;
}

export function MultimediaHub(props: MultimediaHubProps): React.ReactElement {
  const derivedRoute = props.urlPath ? parseMultimediaRoute(props.urlPath) : undefined;
  const [route, setRoute] = useState<MultimediaRouteKey>(
    derivedRoute ?? props.initialRoute ?? 'hub',
  );
  const [category, setCategory] = useState<MultimediaCategory>(
    props.initialCategory ?? 'documents',
  );

  const jobs = useMultimediaJobs();
  const registeredKinds = useMemo<Set<string>>(() => {
    if (!props.registry) return new Set<string>(MULTIMEDIA_CARDS.map((c) => c.kind));
    try {
      return new Set<string>(props.registry.list().map((d) => d.kind));
    } catch {
      return new Set<string>();
    }
  }, [props.registry]);

  const enabled = (r: MultimediaRouteKey): boolean => {
    if (!props.isAdapterEnabled) return true;
    return props.isAdapterEnabled(r);
  };

  const go = (next: MultimediaRouteKey): void => {
    setRoute(next);
    props.onNavigate?.(next);
  };

  const selectedCard = resolveCardByRoute(route);
  const activeCardsByCategory = useMemo<Record<MultimediaCategory, MultimediaCardMeta[]>>(() => {
    const grouped: Record<MultimediaCategory, MultimediaCardMeta[]> = {
      documents: [], research: [], video: [], automation: [],
    };
    for (const c of MULTIMEDIA_CARDS) grouped[c.category].push(c);
    return grouped;
  }, []);

  if (selectedCard) {
    const locked = selectedCard.defaultLocked && !enabled(selectedCard.route);
    const registered = registeredKinds.has(selectedCard.kind);
    return (
      <div data-testid="multimedia-hub-detail" style={{ padding: 16 }}>
        <nav aria-label="멀티미디어 경로" style={{ marginBottom: 12, fontSize: 11, opacity: 0.8 }}>
          <button
            type="button"
            data-testid="multimedia-hub-breadcrumb-back"
            onClick={() => go('hub')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--pixel-accent, #00d2ff)',
              cursor: 'pointer',
              padding: 0,
              font: 'inherit',
              textDecoration: 'underline',
            }}
          >
            멀티미디어 허브
          </button>
          <span aria-hidden={true}> › </span>
          <span>{selectedCard.label}</span>
        </nav>
        {selectedCard.route === 'video' ? (
          <VideoGeneration onClose={() => go('hub')} />
        ) : (
          <PlaceholderAdapterView
            card={selectedCard}
            locked={locked}
            unlockHint={selectedCard.unlockHint}
            onUnlockClick={locked ? () => props.onUnlockRoute?.(selectedCard.route) : undefined}
            registered={registered}
            onClose={() => go('hub')}
          />
        )}
      </div>
    );
  }

  return (
    <section
      aria-labelledby="multimedia-hub-title"
      data-testid="multimedia-hub"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--media-hub-section-gap, 16px)',
        padding: 16,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h1
            id="multimedia-hub-title"
            style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}
          >
            멀티미디어 허브
          </h1>
          <p style={{ margin: '4px 0 0 0', fontSize: 12, opacity: 0.75 }}>
            등록된 어댑터 {MULTIMEDIA_CARDS.filter((c) => registeredKinds.has(c.kind)).length} 종 · /multimedia
          </p>
        </div>
      </header>

      <CategoryTabs
        value={category}
        onChange={setCategory}
      />

      <div
        role="grid"
        aria-label="멀티미디어 어댑터 카드"
        aria-rowcount={1}
        data-testid="multimedia-hub-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(var(--media-hub-card-w, 240px), 1fr))',
          gap: 'var(--media-hub-card-gap, 24px)',
        }}
      >
        {activeCardsByCategory[category].length === 0 ? (
          <EmptyCategory />
        ) : null}
        {activeCardsByCategory[category].map((card: MultimediaCardMeta) => {
          const running = jobs.byKind(card.kind).filter((j) => j.status === 'running' || j.status === 'queued');
          const locked: boolean = card.defaultLocked && !enabled(card.route);
          const registered: boolean = registeredKinds.has(card.kind);
          return (
            <HubCard
              key={card.route}
              card={card}
              runningCount={running.length}
              locked={locked}
              registered={registered}
              onOpen={() => go(card.route)}
            />
          );
        })}
      </div>
    </section>
  );
}

function CategoryTabs({
  value,
  onChange,
}: {
  value: MultimediaCategory;
  onChange: (next: MultimediaCategory) => void;
}): React.ReactElement {
  return (
    <div
      role="tablist"
      aria-label="멀티미디어 카테고리"
      data-testid="multimedia-hub-categories"
      style={{
        display: 'inline-flex',
        gap: 4,
        padding: 4,
        background: 'var(--pixel-card-muted, rgba(0,0,0,0.3))',
        border: '2px solid var(--pixel-border)',
        width: 'fit-content',
      }}
    >
      {MULTIMEDIA_CATEGORIES.map((cat) => {
        const active = cat.id === value;
        return (
          <button
            key={cat.id}
            role="tab"
            type="button"
            aria-selected={active}
            data-testid={`multimedia-hub-category-${cat.id}`}
            onClick={() => onChange(cat.id)}
            style={{
              display: 'inline-flex',
              flexDirection: 'column',
              gap: 1,
              padding: '6px 12px',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              background: active ? 'var(--pixel-accent)' : 'transparent',
              color: active ? '#000' : 'rgba(255,255,255,0.8)',
              border: 'none',
              cursor: 'pointer',
              minWidth: 120,
              textAlign: 'left',
            }}
          >
            <span>{cat.label}</span>
            <span style={{ fontSize: 9, letterSpacing: '0.02em', opacity: active ? 0.9 : 0.65 }}>
              {cat.subtitle}
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface HubCardProps {
  readonly card: MultimediaCardMeta;
  readonly runningCount: number;
  readonly locked: boolean;
  readonly registered: boolean;
  readonly onOpen: () => void;
}

const HubCard: React.FC<HubCardProps> = ({
  card,
  runningCount,
  locked,
  registered,
  onOpen,
}) => {
  const Icon = ICONS[card.iconName];
  const disabled = locked || !registered;
  return (
    <article
      role="gridcell"
      data-testid={`multimedia-hub-card-${card.route}`}
      data-locked={locked || undefined}
      data-registered={registered}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 12,
        background: 'var(--media-asset-surface-bg)',
        border: `1px solid ${disabled ? 'var(--shared-goal-modal-subtle-fg, rgba(255,255,255,0.24))' : 'var(--attachment-preview-border)'}`,
        borderRadius: 8,
        opacity: disabled ? 0.72 : 1,
        minHeight: 'var(--media-hub-card-h, 156px)',
        position: 'relative',
      }}
    >
      {locked ? (
        <span
          aria-hidden={true}
          title="활성화 필요"
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            fontSize: 10,
            padding: '2px 6px',
            background: 'var(--token-usage-caution-bg, rgba(251,191,36,0.12))',
            border: '1px solid var(--token-usage-caution-border, rgba(251,191,36,0.45))',
          }}
        >
          <Lock size={10} /> 잠김
        </span>
      ) : null}
      <header style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon size={14} aria-hidden={true} />
        <h3
          style={{
            margin: 0,
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}
        >
          {card.label}
        </h3>
      </header>
      <p style={{ margin: 0, fontSize: 11, opacity: 0.85 }}>
        {card.subtitle}
      </p>
      <p style={{ margin: 0, fontSize: 10, opacity: 0.65 }}>
        {card.urlPath}
      </p>
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span
          data-testid={`multimedia-hub-card-${card.route}-cost`}
          style={{
            fontSize: 10,
            padding: '2px 6px',
            background: card.costAccent === 'heavy'
              ? 'var(--token-usage-caution-bg, rgba(251,191,36,0.12))'
              : 'rgba(255,255,255,0.04)',
            border: `1px solid ${
              card.costAccent === 'heavy'
                ? 'var(--token-usage-caution-border, rgba(251,191,36,0.45))'
                : 'rgba(255,255,255,0.18)'
            }`,
          }}
        >
          ⚡~{Math.round(card.expectedTokens / 1000)}k
        </span>
        {runningCount > 0 ? (
          <span
            data-testid={`multimedia-hub-card-${card.route}-running`}
            style={{
              fontSize: 10,
              color: 'var(--shared-goal-modal-field-focus, #7fd4ff)',
            }}
          >
            {runningCount}건 진행 중
          </span>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        data-testid={`multimedia-hub-card-${card.route}-cta`}
        style={{
          marginTop: 4,
          padding: '6px 10px',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          background: disabled
            ? 'transparent'
            : 'var(--shared-goal-modal-confirm-bg, #34d399)',
          color: disabled
            ? 'var(--shared-goal-modal-subtle-fg, rgba(255,255,255,0.65))'
            : 'var(--shared-goal-modal-confirm-fg, #052e1b)',
          border: '1px solid var(--attachment-preview-border)',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {locked ? '활성화 필요' : registered ? '열기 →' : '미등록'}
      </button>
    </article>
  );
}

function EmptyCategory(): React.ReactElement {
  return (
    <div
      role="status"
      data-testid="multimedia-hub-empty-category"
      style={{
        gridColumn: '1 / -1',
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        color: 'var(--empty-state-subtle-fg, rgba(255,255,255,0.6))',
        border: '1px dashed var(--attachment-preview-border)',
      }}
    >
      <CircleAlert size={16} aria-hidden={true} />
      <p style={{ margin: 0, fontSize: 12 }}>
        이 카테고리에 등록된 어댑터가 없어요.
      </p>
    </div>
  );
}

export default MultimediaHub;
