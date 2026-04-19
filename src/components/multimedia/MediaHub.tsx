// 지시 #82bd96f7 — 멀티미디어 진입점 허브.
//
// 현재는 PDF · PPT 두 축을 탭으로 병치해 "어느 입력 경로를 열지" 사용자가 한 화면에서
// 선택할 수 있게 한다. 각 탭의 내부는 기존 PdfImportPanel / PptImportPanel 을 그대로
// 재사용 — 본 허브는 라우팅 껍질만 담당한다.
//
// 확장 포인트
//   · 영상 생성 모듈(VideoGenerationHandler) 이 붙으면 세 번째 탭("영상 생성") 으로
//     추가된다. 탭 배열은 `MediaHubTab[]` 로 정의해 신규 모듈이 한 줄 추가로 편입되게
//     설계했다.
//   · 각 탭은 `onImported` 콜백을 공통 prop 으로 받는다(PDF·PPT 둘 다 outcome 에
//     `originalRecord` 가 있으므로 상위가 동일한 리스트 새로고침 훅을 붙일 수 있다).
//
// 접근성
//   · role="tablist" + 각 버튼 role="tab" / aria-selected 로 ARIA authoring practice
//     를 따른다. 탭 패널에는 role="tabpanel" + tabIndex=0 을 걸어 스크린리더 포커스
//     이동이 자연스럽게 유지되도록 한다.

import React, { useState } from 'react';
import { FileText, Presentation } from 'lucide-react';

import { PdfImportPanel } from './PdfImportPanel';
import { PptImportPanel } from './PptImportPanel';
import type { MultimediaImportOutcome } from '../../lib/multimedia/types';
import type { PptImportOutcome } from '../../services/pptImportService';

export type MediaHubImportOutcome = MultimediaImportOutcome | PptImportOutcome;

export type MediaHubTabId = 'pdf' | 'pptx';

interface MediaHubTab {
  id: MediaHubTabId;
  label: string;
  icon: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
}

const TABS: readonly MediaHubTab[] = [
  { id: 'pdf', label: 'PDF', icon: FileText },
  { id: 'pptx', label: 'PPT', icon: Presentation },
];

export interface MediaHubProps {
  projectId: string | null;
  /** PDF · PPT 어느 쪽이든 import 가 끝나면 상위로 알린다. */
  onImported?: (outcome: MediaHubImportOutcome, source: MediaHubTabId) => void;
  /** 초기 선택 탭. 지정이 없으면 'pdf'. */
  defaultTab?: MediaHubTabId;
  className?: string;
}

export function MediaHub(props: MediaHubProps): React.ReactElement {
  const { projectId, onImported, defaultTab = 'pdf', className } = props;
  const [active, setActive] = useState<MediaHubTabId>(defaultTab);

  return (
    <section
      aria-label="멀티미디어 가져오기"
      className={`media-hub${className ? ` ${className}` : ''}`}
      data-testid="media-hub"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div
        role="tablist"
        aria-label="입력 종류 선택"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: 4,
          background: 'var(--pixel-card-muted, rgba(0,0,0,0.3))',
          border: '2px solid var(--pixel-border)',
          width: 'fit-content',
        }}
      >
        {TABS.map((tab) => {
          const selected = tab.id === active;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              role="tab"
              type="button"
              id={`media-hub-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`media-hub-panel-${tab.id}`}
              data-testid={`media-hub-tab-${tab.id}`}
              onClick={() => setActive(tab.id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                background: selected ? 'var(--pixel-accent)' : 'transparent',
                color: selected ? '#000' : 'rgba(255,255,255,0.8)',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              <Icon size={12} aria-hidden={true} /> {tab.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`media-hub-panel-${active}`}
        aria-labelledby={`media-hub-tab-${active}`}
        tabIndex={0}
        data-testid={`media-hub-panel-${active}`}
      >
        {active === 'pdf' ? (
          <PdfImportPanel
            projectId={projectId}
            onImported={(outcome) => onImported?.(outcome, 'pdf')}
          />
        ) : (
          <PptImportPanel
            projectId={projectId}
            onImported={(outcome) => onImported?.(outcome, 'pptx')}
          />
        )}
      </div>
    </section>
  );
}
