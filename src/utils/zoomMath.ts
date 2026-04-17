// 캔버스 줌·팬 수학 헬퍼.
// App.tsx 의 onWheel/onPan 핸들러는 React 이벤트와 얽혀 있어 직접 단위 테스트가 어렵다.
// 휠 델타→줌 배율 계산, 커서 고정 줌 보정 팬 계산 같은 "순수 산수" 부분만 떼어
// 여기 모아두면 QA 가 경계값·라운드트립·핀치 호환성 같은 회귀 조건을
// 별도 테스트 파일에서 잡을 수 있다.
//
// 좌표 계약:
//   App.tsx 의 게임 월드 컨테이너는 transformOrigin='0 0' 기준
//   `translate(pan) scale(zoom)` 으로 렌더된다. 이 모듈의 공식은
//   origin={x:0,y:0} 일 때 `newPan = cursor - (cursor - pan) * (next/prev)`
//   로 축약되며 이는 휠 핸들러가 실제로 사용하는 형태다.
//   배경 그리드의 `background-position:pan`, `background-size:32*zoom` 도
//   같은 좌상단 기준이므로 월드/그리드가 포인터에 함께 고정된다.

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;
export const WHEEL_ZOOM_STEP = 0.1;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return MIN_ZOOM;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

// 휠 한 노치 입력에 따른 줌 갱신.
// deltaY > 0 (사용자가 아래로 굴림 = 축소) → 줌 감소.
// deltaY < 0 (위로 굴림 = 확대) → 줌 증가.
export function applyWheelZoom(currentZoom: number, deltaY: number): number {
  const step = deltaY > 0 ? -WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP;
  return clampZoom(currentZoom + step);
}

// 터치패드 핀치 제스처: 브라우저는 ctrlKey=true + deltaY(작은 실수)로 전달한다.
// 휠과 달리 노치 단위가 아니라 비율 변화에 가깝다. 동일 클램프를 적용해
// 휠 줌과 결과 범위가 일치하도록 맞춘다.
export function applyPinchZoom(currentZoom: number, scaleFactor: number): number {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return currentZoom;
  return clampZoom(currentZoom * scaleFactor);
}

export interface Point {
  x: number;
  y: number;
}

// "마우스 포인터 아래 월드 좌표가 줌 전후로 동일한 화면 좌표에 머문다"는 계약을
// 만족시키는 다음 팬 값. transformOrigin 이 컨테이너 중심(center center)이라는
// App.tsx 현재 구현을 전제한다.
//
// 유도:
//   screen = origin + pan + (world - origin) * zoom
//   world  = origin + (screen - origin - pan) / zoom
// 줌이 prev → next 로 변할 때 같은 screen 점을 유지하려면
//   nextPan = screen - origin - (world - origin) * next
//           = pan + (screen - origin - pan) * (1 - next/prev)
export function computeCursorAnchoredPan(
  prevZoom: number,
  nextZoom: number,
  prevPan: Point,
  cursor: Point,
  origin: Point,
): Point {
  if (prevZoom === 0) return prevPan;
  const ratio = 1 - nextZoom / prevZoom;
  return {
    x: prevPan.x + (cursor.x - origin.x - prevPan.x) * ratio,
    y: prevPan.y + (cursor.y - origin.y - prevPan.y) * ratio,
  };
}

// 화면 좌표 → 월드 좌표 변환. QA 에서 "포인터 아래 요소가 고정되었는지"를
// 줌 전/후 월드 좌표 일치로 확인할 때 사용.
export function screenToWorld(
  screen: Point,
  pan: Point,
  zoom: number,
  origin: Point,
): Point {
  return {
    x: origin.x + (screen.x - origin.x - pan.x) / zoom,
    y: origin.y + (screen.y - origin.y - pan.y) / zoom,
  };
}

// clientX/clientY (뷰포트 기준) → 캔버스 내부 좌상단 기준 좌표.
// DOMRect 는 스크롤·사이드바 폭 변경에도 정확한 경계를 주므로 offsetX/Y 를
// 직접 쓰는 것보다 안전하다 (React SyntheticEvent 의 offset 은 일부 타겟에서
// 이벤트 위임 대상 기준이라 편차가 난다).
export function clientToCanvas(
  rect: { left: number; top: number },
  clientX: number,
  clientY: number,
): Point {
  return { x: clientX - rect.left, y: clientY - rect.top };
}

// transformOrigin='0 0' 전용 간이 커서 고정 팬 공식.
// origin 을 명시적으로 넘기지 않아도 되도록 둔 편의 래퍼이며,
// computeCursorAnchoredPan(prevZoom, nextZoom, prevPan, cursor, {x:0,y:0}) 와 동치.
//   newPan = cursor - (cursor - pan) * (nextZoom / prevZoom)
export function computeCursorAnchoredPanTopLeft(
  prevZoom: number,
  nextZoom: number,
  prevPan: Point,
  cursor: Point,
): Point {
  if (prevZoom === 0) return prevPan;
  const ratio = nextZoom / prevZoom;
  return {
    x: cursor.x - (cursor.x - prevPan.x) * ratio,
    y: cursor.y - (cursor.y - prevPan.y) * ratio,
  };
}
