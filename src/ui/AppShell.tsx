// 지시 #b3582cfa · 루트 레이아웃 스캐폴딩.
//
// 목적
//   · 기존 `App.tsx` 와 독립된 "새 디자인 시스템" 경로(src/ui/*) 의 상단 껍데기.
//   · 상단 헤더에 `TokenUsageIndicator` 를 마운트해 어느 화면에서도 토큰 사용량이
//     보이도록 한다. 자동 압축 토스트는 `toastBus` 로 이미 인디케이터 내부에서 발화
//     하므로 본 파일에서 별도 핸들러를 두지 않고 `ToastProvider` 만 감싼다.
//   · 온보딩이 완료되지 않았다면 첫 렌더에 `OnboardingTour` 를 모달로 띄운다.
//     완료 후에는 z-index 제약을 해제해 본문(`children`) 이 정상 포커스 순회.
//
// z-index 정책
//   · 헤더(인디케이터): z-index: 30. 항상 본문 위.
//   · 온보딩 다이얼로그: z-index: 60. 헤더 보다 위, 토스트(z-index: 80) 보다 아래.
//     → 토스트는 온보딩 중에도 읽힌다(자동 압축 안내가 막히지 않도록).
//
// 포커스 트랩
//   · 다이얼로그 오픈 시 `inert` 속성을 shell 의 형제 컨테이너에 부여해 Tab 키가
//     다이얼로그 밖으로 빠져나가지 않는다. 다이얼로그 닫히면 inert 제거.

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { ToastProvider } from '../components/ToastProvider';
import { TokenUsageIndicator, type UsageSource } from './TokenUsageIndicator';
import { OnboardingTour } from './onboarding/OnboardingTour';
import {
  readOnboardingCompleted,
  type OnboardingStorage,
} from './onboarding/onboardingPrefs';
import { I18nProvider, useLocale, type Locale } from '../i18n';
import { LanguageToggle } from './LanguageToggle';
import { useOverflowMenu, type OverflowMenuItem } from '../hooks/useOverflowMenu';

export interface AppShellProps {
  readonly children?: React.ReactNode;
  /** 테스트 주입 — 온보딩 저장소/재표시 강제. */
  readonly storage?: OnboardingStorage | null;
  /** true 면 저장된 완료 기록과 무관하게 온보딩을 강제 표시(설정 > 다시 보기 경로). */
  readonly forceOnboarding?: boolean;
  /** 인디케이터 데이터 소스. 미주입 시 인디케이터는 정적 0 스냅샷으로 렌더. */
  readonly usageSource?: UsageSource;
  /** 부팅 시 서버 세션에서 받아온 언어 설정. I18nProvider 가 마운트 직후 반영. */
  readonly initialLocale?: Locale;
  /** 언어 선택 → 서버 세션 동기화 훅. */
  readonly onLocalePersist?: (locale: Locale) => void;
}

export function AppShell(props: AppShellProps): React.ReactElement {
  const [showTour, setShowTour] = useState<boolean>(() => {
    if (props.forceOnboarding) return true;
    return readOnboardingCompleted(props.storage ?? undefined) === null;
  });

  // forceOnboarding prop 변화 반영 — 설정 > 다시 보기에서 true 로 토글되면 재표시.
  useEffect(() => {
    if (props.forceOnboarding) setShowTour(true);
  }, [props.forceOnboarding]);

  const onFinished = useCallback(() => {
    setShowTour(false);
  }, []);

  // 반응형 액션 바(#0c066697). 디자이너 가이드:
  //   · flex 컨테이너에 min-width:0 + 자식 flex-shrink 적용 → 라벨이 절대 wrap 되지 않음.
  //   · 라벨은 white-space:nowrap + text-overflow:ellipsis 로 한 줄 유지.
  //   · 보조 액션(언어 토글)은 컨테이너 폭 < 720 일 때 useOverflowMenu 가 더보기로 분류.
  //   · 1280/960/720 브레이크포인트는 CSS 미디어 쿼리와 동일 축으로 className 토글에 사용.
  // 측정-너비는 ResizeObserver 가 채우므로 호출자는 추정 너비만 잡아 두면 된다.
  // i18n 은 Provider 외부에서도 안전한 useLocale() 로 직접 구독한다 — Provider 는
  // 자식 트리용이고, 여기 본문은 그 외부이므로 Context 가 비어 있다.
  const { t } = useLocale();
  const overflowItems = useMemo<OverflowMenuItem[]>(() => [
    { id: 'language', label: t('header.actions.language'), width: 132, hideBelowPx: 720 },
  ], [t]);
  const {
    containerRef: actionBarRef,
    visibleItems,
    overflowItems: hiddenActions,
    activeBreakpoint,
  } = useOverflowMenu({ items: overflowItems, overflowTriggerWidth: 40 });
  const isLanguageVisible = visibleItems.some(it => it.id === 'language');
  const hasHiddenActions = hiddenActions.length > 0;

  return (
    <I18nProvider initialLocale={props.initialLocale}>
      <ToastProvider>
        <div className="app-shell">
          <header
            ref={actionBarRef as React.RefObject<HTMLElement>}
            className={`app-shell-header app-shell-header--bp-${activeBreakpoint}`}
          >
            <div className="app-shell-header__primary">
              <TokenUsageIndicator usageSource={props.usageSource} />
            </div>
            <div className="app-shell-header__actions">
              {isLanguageVisible && (
                <span className="app-shell-header__action" data-action-id="language">
                  <LanguageToggle onPersist={props.onLocalePersist} />
                </span>
              )}
              {hasHiddenActions && (
                // 좁은 폭에서 보조 액션을 모아 두는 더보기 트리거. 펼침 UI 는 후속
                // 배선이지만 a11y 계약(aria-haspopup·aria-label) 은 지금부터 잠궈
                // 외부 회귀가 위치만 바꿔도 깨지지 않게 한다.
                <button
                  type="button"
                  className="app-shell-header__more"
                  aria-haspopup="menu"
                  aria-label={t('header.actions.moreAria').replace('{count}', String(hiddenActions.length))}
                  data-testid="app-shell-header-more"
                >
                  {t('header.actions.more')}
                </button>
              )}
            </div>
          </header>
          <main className="app-shell-main" aria-hidden={showTour || undefined}>
            {props.children}
          </main>
          {showTour && (
            <div
              className="onboarding-overlay"
              style={{ position: 'fixed', inset: 0, zIndex: 60 }}
            >
              <OnboardingTour
                onFinished={onFinished}
                storage={props.storage}
              />
            </div>
          )}
        </div>
      </ToastProvider>
    </I18nProvider>
  );
}
