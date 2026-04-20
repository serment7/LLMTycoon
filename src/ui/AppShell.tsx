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

import React, { useCallback, useEffect, useState } from 'react';

import { ToastProvider } from '../components/ToastProvider';
import { TokenUsageIndicator, type UsageSource } from './TokenUsageIndicator';
import { OnboardingTour } from './onboarding/OnboardingTour';
import {
  readOnboardingCompleted,
  type OnboardingStorage,
} from './onboarding/onboardingPrefs';
import { I18nProvider, type Locale } from '../i18n';
import { LanguageToggle } from './LanguageToggle';

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

  return (
    <I18nProvider initialLocale={props.initialLocale}>
      <ToastProvider>
        <div className="app-shell">
          <header
            className="app-shell-header"
            style={{ position: 'relative', zIndex: 30, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
          >
            <TokenUsageIndicator usageSource={props.usageSource} />
            <LanguageToggle onPersist={props.onLocalePersist} />
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
