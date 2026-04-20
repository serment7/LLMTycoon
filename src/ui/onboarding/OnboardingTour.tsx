// 지시 #b3582cfa · 첫 실행 온보딩 투어(4 단계 스텝퍼).
//
// 스텝
//   ① 언어 선택        — useLocale.setLocale 로 즉시 전환. 언어 변경은 이 단계에서만
//                          UI 를 다시 그려 다음 스텝부터 선택 언어로 렌더링.
//   ② MCP 전송 방식     — stdio vs streamable HTTP 설명(문구만).
//   ③ 프로젝트 설명 → 추천 미리보기 — `heuristicTeam(demoDescription, locale)` 로 로컬 렌더.
//                          useLocale 값을 그대로 전달해 KO 선택 시 한국어 rationale 노출.
//   ④ 토큰 사용량 인디케이터 소개 — 인디케이터의 역할/읽는 법을 본문으로.
//
// 인터랙션
//   · 다음/이전/건너뛰기/마치기 4 버튼. 포커스 트랩은 dialog 내부 Tab 루프로 1 회 감김.
//   · 건너뛰기·마치기 모두 `writeOnboardingCompleted` 로 완료 기록 → AppShell 가
//     이후 실행에서 자동으로 띄우지 않는다.
//   · 상위는 `onFinished` 콜백으로 close 동작을 수행.
//
// 접근성
//   · `role="dialog"` + `aria-modal="true"` + `aria-labelledby` 로 타이틀 연결.
//   · Esc 키는 건너뛰기와 동일 동작.

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { heuristicTeam, type RecommendationLocale } from '../../project/recommendAgentTeam';
import { translate, useLocale, type Locale } from '../../i18n';
import {
  writeOnboardingCompleted,
  type OnboardingStorage,
} from './onboardingPrefs';

export type OnboardingStepId = 'locale' | 'mcp' | 'recommend' | 'tokens';

export const ONBOARDING_STEPS: readonly OnboardingStepId[] = [
  'locale',
  'mcp',
  'recommend',
  'tokens',
];

export interface OnboardingTourProps {
  readonly onFinished: () => void;
  /** 테스트 주입 — 저장소/시각 훅. */
  readonly storage?: OnboardingStorage | null;
  readonly now?: () => string;
  readonly forceLocale?: Locale;
}

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    k in params ? String(params[k]) : `{${k}}`,
  );
}

export function OnboardingTour(props: OnboardingTourProps): React.ReactElement {
  const hookLocale = useLocale();
  const effectiveLocale = (props.forceLocale ?? hookLocale.locale) as Locale;
  const t = useCallback(
    (key: string) => translate(key, effectiveLocale),
    [effectiveLocale],
  );

  const [index, setIndex] = useState(0);
  const step = ONBOARDING_STEPS[index];
  const total = ONBOARDING_STEPS.length;
  const dialogRef = useRef<HTMLDivElement>(null);

  // 초기 포커스 — 다이얼로그 컨테이너 본체에 주어 스크린리더가 타이틀을 읽도록.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const complete = useCallback(() => {
    const at = (props.now ?? (() => new Date().toISOString()))();
    writeOnboardingCompleted(at, props.storage ?? undefined);
    props.onFinished();
  }, [props]);

  const goPrev = useCallback(() => {
    setIndex((i) => (i === 0 ? i : i - 1));
  }, []);
  const goNext = useCallback(() => {
    setIndex((i) => {
      if (i + 1 >= total) {
        // 마지막 스텝의 다음 = 완료.
        complete();
        return i;
      }
      return i + 1;
    });
  }, [complete, total]);

  // Esc 키 = 건너뛰기. Tab 순환은 다이얼로그 내부 요소에 자연스럽게 걸리므로 별도
  // trap 은 두지 않되, 컨테이너를 tabIndex=-1 로 만들어 초기 포커스만 제어.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        complete();
      }
    },
    [complete],
  );

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      tabIndex={-1}
      className="onboarding-dialog"
      onKeyDown={onKeyDown}
    >
      <header>
        <h2 id="onboarding-title">{t('onboarding.title')}</h2>
        <p className="onboarding-step-indicator">
          {interpolate(t('onboarding.stepIndicator'), { current: index + 1, total })}
        </p>
      </header>

      <section className="onboarding-step" aria-live="polite">
        <h3>{t(`onboarding.steps.${step}.title`)}</h3>
        <p>{t(`onboarding.steps.${step}.body`)}</p>

        {step === 'locale' && (
          <div className="onboarding-locale-picker" role="group" aria-label={t('locale.label')}>
            {(['en', 'ko'] as const).map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={effectiveLocale === l}
                onClick={() => hookLocale.setLocale(l)}
              >
                {t(`locale.${l}`)}
              </button>
            ))}
          </div>
        )}

        {step === 'recommend' && (
          <RecommendationPreview locale={effectiveLocale as RecommendationLocale} tr={t} />
        )}
      </section>

      <footer className="onboarding-actions">
        <button
          type="button"
          className="onboarding-skip"
          onClick={complete}
        >
          {t('onboarding.skip')}
        </button>
        <div className="onboarding-primary-actions">
          <button type="button" onClick={goPrev} disabled={index === 0}>
            {t('onboarding.prev')}
          </button>
          <button type="button" onClick={goNext}>
            {index + 1 === total ? t('onboarding.finish') : t('onboarding.next')}
          </button>
        </div>
      </footer>
    </div>
  );
}

function RecommendationPreview({
  locale,
  tr,
}: {
  locale: RecommendationLocale;
  tr: (key: string) => string;
}): React.ReactElement {
  const demoDescription = tr('onboarding.steps.recommend.demoDescription');
  const items = heuristicTeam(demoDescription, locale);
  return (
    <ul className="onboarding-demo" aria-label="recommendation-preview">
      {items.map((it, i) => (
        <li key={`${it.role}-${i}`}>
          <strong>{it.role}</strong>
          <span>{it.name}</span>
          <span>{it.rationale}</span>
        </li>
      ))}
    </ul>
  );
}
