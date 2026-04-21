// 지시 #8de1a1c8 · 보강 #b9552a14 — AppShell 헤더용 언어 토글.
//
// 목적
//   현재 locale 을 EN / KO 로 즉시 전환한다. 토글 즉시 `useI18n` Context 가 전파해
//   전체 UI 가 재렌더링되고, localStorage + (선택적으로) 서버 세션에 저장된다.
//
// 구성
//   · "세그먼트 버튼(EN | KO)" 을 헤더 우측에 전면 노출한다 — 드롭다운이 작은
//     글자로 배경에 묻히는 가시성 회귀를 막기 위함.
//   · 기존 `<select>` 는 DOM 에 그대로 유지하되 `sr-only` 로 시각적으로 숨긴다.
//     (a) 스크린리더 / 키보드 자동화에 접근 경로를 유지하고, (b) `select.value`
//     기반 회귀 스펙이 깨지지 않도록 한다.
//   · 두 경로(버튼 · 드롭다운) 모두 동일한 `setLocale` → Context 재전파 → localStorage
//     저장 → `onPersist` 훅 순서를 따른다.
//
// 접근성
//   · 세그먼트 버튼 그룹은 `role="group"` + `aria-label={t('locale.label')}`.
//   · 각 버튼은 `type="button"` · `aria-pressed` · `data-locale` 제공.
//   · 숨김 `<select>` 는 `aria-hidden` 을 쓰지 않는다 — 보조 기술이 라벨을
//     읽도록 유지하되 tabindex=-1 로 포커스 순회에서 뺀다.

import React from 'react';

import { SUPPORTED_LOCALES, useI18n, type Locale } from '../i18n';

export interface LanguageToggleProps {
  /** 선택 시 Locale 을 서버 세션에 동기화하는 훅(옵션). */
  readonly onPersist?: (locale: Locale) => void;
  readonly className?: string;
}

const LABEL_KEY: Record<Locale, string> = { en: 'locale.en', ko: 'locale.ko' };

// 시각적으로만 숨기는 표준 기법(화면 외 영역으로 이동). 포커스는 유지되므로
// `<select>` 를 보조 경로로 쓰면서도 보이지 않게 할 수 있다.
const SR_ONLY_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

export function LanguageToggle(props: LanguageToggleProps): React.ReactElement {
  const { locale, setLocale, t } = useI18n();

  const commit = (next: Locale) => {
    if (!SUPPORTED_LOCALES.includes(next)) return;
    if (next !== locale) setLocale(next);
    // 서버 세션 동기화는 같은 locale 재선택에도 호출한다 — 복원 직후 persistor 가
    // 첫 쓰기를 보장받는 축이기 때문.
    props.onPersist?.(next);
  };

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    commit(e.target.value as Locale);
  };

  return (
    <label
      data-testid="language-toggle"
      className={props.className ?? 'language-toggle'}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12 }}
    >
      <span className="language-toggle-label" style={{ color: 'var(--pixel-accent, #7fd4ff)' }}>
        {t('locale.label')}
      </span>
      <div
        role="group"
        aria-label={t('locale.label')}
        className="language-toggle-buttons"
        style={{ display: 'inline-flex', borderRadius: 4, overflow: 'hidden', border: '1px solid var(--pixel-accent, #7fd4ff)' }}
      >
        {SUPPORTED_LOCALES.map((code) => {
          const active = code === locale;
          return (
            <button
              key={code}
              type="button"
              data-testid={`language-toggle-${code}`}
              data-locale={code}
              aria-pressed={active}
              onClick={() => commit(code)}
              className={active ? 'language-toggle-btn is-active' : 'language-toggle-btn'}
              title={t(LABEL_KEY[code])}
              style={{
                padding: '2px 8px',
                minWidth: 32,
                background: active ? 'var(--pixel-accent, #7fd4ff)' : 'transparent',
                color: active ? 'var(--pixel-bg, #0b1320)' : 'var(--pixel-accent, #7fd4ff)',
                border: 'none',
                cursor: 'pointer',
                fontWeight: active ? 700 : 500,
                fontSize: 12,
                letterSpacing: 0.5,
              }}
            >
              {code.toUpperCase()}
            </button>
          );
        })}
      </div>
      <select
        aria-label={t('locale.label')}
        value={locale}
        onChange={handleSelectChange}
        className="language-toggle-select"
        tabIndex={-1}
        style={SR_ONLY_STYLE}
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
