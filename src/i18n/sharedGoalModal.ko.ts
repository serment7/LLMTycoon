// SharedGoalModal 한국어 카피 리소스.
//
// 시안 `tests/shared-goal-modal-mockup.md` §2A.1 의 카피 고정 테이블과 §2A.3 의
// 플레이스홀더/힌트 구분, §4.3 단축키 설명, §7.1 검증 에러 카피를 한 곳에 모은다.
// 레이블·플레이스홀더·힌트를 분리한 이유: 외주 번역이 레이블만 수정해도
// 힌트·플레이스홀더가 그대로 유지되도록. 또한 구현자가 우발적으로 빈 문자열로
// 대체해 "폼이 없는 것처럼 보이는" 과거 회귀(`tests/auto-dev-toggle-shared-goal-modal-regression-20260419.md`)
// 를 재발시키지 않도록, 카피를 런타임 상수로 동결한다.

export const sharedGoalModalKo = {
  header: {
    title: '공동 목표 등록이 필요합니다',
    subtitle: '자동 개발 ON 은 리더가 동료들에게 분배할 목표가 있어야 시작됩니다.',
    closeAriaLabel: '닫기',
  },
  banner: {
    title: '아직 공동 목표가 없습니다',
    body: '아래 4개 항목을 채우면 저장 + 자동 개발 시작 준비가 완료됩니다.',
  },
  title: {
    label: '목표 제목',
    placeholder: '예: 결제 모듈 보안 강화',
    hint: '리더가 동료들에게 1문장으로 분배할 핵심 제목',
  },
  description: {
    label: '상세 설명',
    placeholder: '예: 토큰 검증·AES 암호화·PCI 감사로그 추가. 범위·완료 기준을 적어주세요.',
    hint: (min: number, max: number) => `${min}–${max}자. 범위와 '완료 판단 기준' 을 함께 써주세요.`,
  },
  priority: {
    label: '우선순위',
    options: {
      high: 'P1-긴급',
      normal: 'P2-중요',
      low: 'P3-일반',
    },
  },
  deadline: {
    label: '기한',
  },
  validation: {
    rangeError: (min: number, max: number) => `${min}자 이상 ${max}자 이하로 입력해주세요.`,
  },
  footer: {
    hint: '💡 저장 직후 자동 개발이 ON 으로 전환되고 리더가 즉시 분배를 시작합니다.',
    cancel: '취소',
    // 시안 §5.3: "저장" 이 아니라 "시작" 으로 결과를 약속한다.
    confirm: '목표 저장 후 시작',
    // 시안 §5.2 로딩: 저장 중에 primary 의 라벨만 교체 + aria-busy 동반.
    saving: '저장 중…',
  },
  // 시안 §4.3 dirty 가드 확인 다이얼로그 — window.confirm 축약 카피.
  confirmClose: '작성 중인 내용이 있습니다. 닫으면 입력이 사라집니다. 그래도 닫을까요?',
} as const;

export type SharedGoalModalCopy = typeof sharedGoalModalKo;
