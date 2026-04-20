// 지시 #8de1a1c8 — AppShell 헤더용 언어 토글 드롭다운.
//
// 목적
//   현재 locale 을 EN / KO 로 즉시 전환한다. 토글 즉시 `useI18n` Context 가 전파해
//   전체 UI 가 재렌더링되고, localStorage + (선택적으로) 서버 세션에 저장된다.
//
// 접근성
//   · <select> 원본을 사용해 키보드 네비게이션·ARIA 라벨을 기본 제공.
//   · aria-label 은 i18n 의 `locale.label` 키로 번역되어 스크린리더가 현재 언어 컨텍스트에
//     맞춰 읽어 준다.
//   · 선택 시 onChange → setLocale → Context 전파. 추가 "저장됨" 토스트는 상위(토스트
//     프로바이더) 가 이미 구독 중이라면 별도 호출 없이 동작.

import React from 'react';

import { SUPPORTED_LOCALES, useI18n, type Locale } from '../i18n';

export interface LanguageToggleProps {
  /** 선택 시 Locale 을 서버 세션에 동기화하는 훅(옵션). */
  readonly onPersist?: (locale: Locale) => void;
  readonly className?: string;
}

const LABEL_KEY: Record<Locale, string> = { en: 'locale.en', ko: 'locale.ko' };

export function LanguageToggle(props: LanguageToggleProps): React.ReactElement {
  const { locale, setLocale, t } = useI18n();

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as Locale;
    if (!SUPPORTED_LOCALES.includes(next)) return;
    setLocale(next);
    props.onPersist?.(next);
  };

  return (
    <label
      data-testid="language-toggle"
      className={props.className ?? 'language-toggle'}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}
    >
      <span className="language-toggle-label" style={{ color: 'var(--pixel-accent, #7fd4ff)' }}>
        {t('locale.label')}
      </span>
      <select
        aria-label={t('locale.label')}
        value={locale}
        onChange={handleChange}
        className="language-toggle-select"
      >
        {SUPPORTED_LOCALES.map((code) => (
          <option key={code} value={code}>
            {t(LABEL_KEY[code])} ({code.toUpperCase()})
          </option>
        ))}
      </select>
    </label>
  );
}
