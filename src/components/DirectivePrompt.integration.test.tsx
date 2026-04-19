// Run with: npx tsx --test src/components/DirectivePrompt.integration.test.tsx
//
// QA (#DIR-ATTACH 후속): DirectivePrompt 컴포넌트의 드래그·드롭/목록/토스트/
// 제출 계약을 DOM 레벨에서 고정한다. 헬퍼 분류 테스트는 `DirectivePrompt.test.ts`
// 에 남기고, 여기서는 "사용자가 실제로 조작했을 때 화면이 어떻게 바뀌는가"를
// jsdom + React Testing Library 로 검증한다.
//
// 검증 범위 (사용자 문장 → 관찰 가능한 DOM 불변식):
//   (1) PDF / 이미지 / 텍스트 세 종을 한 번에 드롭하면 → 각자 data-kind 가 pdf/image/text
//       로 떨어진 <li> 세 개가 순서대로 렌더된다 (색약 가드·kind 라벨 동시 확인).
//   (2) accept 화이트리스트 밖 MIME 과 maxBytes 초과 파일은 onFilesAdded 에
//       도달하지 못한다 (클라이언트 1차 가드).
//   (3) 부모가 attachments 에 uploading/progress 를 채워 다시 렌더하면 → 진행률 숫자·
//       진행 바·스피너가 동시에 보인다.
//   (4) 업로드 실패 시(부모가 status='error' + errorToast 주입) → "실패" 배지와 토스트
//       role=alert 가 함께 떠 사용자가 놓치지 않는다.
//   (5) sendLeaderCommand 가 전송 성공 후 pendingAttachments 를 비우는 동작을
//       presentational 레벨에서 모방: onSubmit 이 부모 상태를 지우면 목록이 사라진다.
//
// 테스트 기반: global-jsdom 으로 window/document 를 세팅한 뒤 @testing-library/react
// 16 (React 19 호환) 로 마운트한다. IS_REACT_ACT_ENVIRONMENT 를 참으로 두지 않으면
// React 19 가 act 경고를 찍으며 렌더를 보류하므로 파일 로드 시점에 토글한다.
//
// 픽스처: 실제 파일 바이트 대신 File 객체만 만든다 (`new File`). 사이즈 초과
// 시나리오는 File.size 를 Object.defineProperty 로 덮어써 메모리를 건드리지 않는다.

import 'global-jsdom/register';

// React 19 는 act 환경이 아니면 concurrent 렌더를 유예한다. 테스트 전역에 플래그를
// 세운 뒤 RTL 를 import 해야 RTL 내부의 act 호출이 유효해진다.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { useState } from 'react';
import { render, fireEvent, cleanup, act, createEvent } from '@testing-library/react';

import {
  DirectivePrompt,
  type DirectiveAttachment,
} from './DirectivePrompt.tsx';

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// 픽스처 빌더
// ---------------------------------------------------------------------------

// jsdom File 은 실제 메모리를 잡으므로, 대용량 파일은 size 만 덮어써 흉내낸다.
function makeFile(name: string, mime: string, sizeOverride?: number): File {
  const f = new File([''], name, { type: mime });
  if (sizeOverride != null) {
    Object.defineProperty(f, 'size', { value: sizeOverride, configurable: true });
  }
  return f;
}

// fireEvent.drop 에 넘길 DataTransfer 유사 객체. types:['Files']는 브라우저가
// 파일 드롭일 때 세팅하는 표식이라 맞춰 둔다(미래에 컴포넌트가 검사할 때 안전).
function dataTransferOf(files: File[]) {
  return { files, types: ['Files'], items: [] };
}

function makeAttachment(patch: Partial<DirectiveAttachment> = {}): DirectiveAttachment {
  return {
    id: patch.id ?? 'a1',
    name: patch.name ?? 'spec.pdf',
    size: patch.size ?? 2048,
    mime: patch.mime ?? 'application/pdf',
    kind: patch.kind ?? 'pdf',
    status: patch.status ?? 'done',
    progress: patch.progress,
    errorMessage: patch.errorMessage,
  };
}

// 부모 역할을 하는 하네스. App.tsx 에서 pendingAttachments / setPendingAttachments
// 로 관리하는 흐름을 최소화해 재현한다. classify 가 필요하면 부모가 수행하고,
// onFilesAdded 스파이는 raw File[] 을 그대로 기록해 테스트가 필터링을 검증할 수 있다.
function Harness(props: {
  accept?: string;
  maxBytes?: number;
  initial?: DirectiveAttachment[];
  onFilesSpy?: (files: File[]) => void;
  withSubmit?: boolean;
  externalAttachments?: DirectiveAttachment[];
  errorToast?: string | null;
}) {
  const [attachments, setAttachments] = useState<DirectiveAttachment[]>(
    props.initial ?? [],
  );
  const [value, setValue] = useState('');
  const effective = props.externalAttachments ?? attachments;
  return (
    <DirectivePrompt
      value={value}
      onChange={setValue}
      attachments={effective}
      accept={props.accept}
      maxBytes={props.maxBytes}
      errorToast={props.errorToast ?? null}
      onFilesAdded={(files) => {
        props.onFilesSpy?.(files);
        // 기본: raw File → 최소 attachment 로 승격해 목록 렌더 확인.
        const asAtt: DirectiveAttachment[] = files.map((f, i) => ({
          id: `${f.name}-${i}`,
          name: f.name,
          size: f.size,
          mime: f.type,
          kind:
            f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
              ? 'pdf'
              : f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name)
                ? 'image'
                : f.type.startsWith('text/') || /\.(txt|md|json|csv|ya?ml|log)$/i.test(f.name)
                  ? 'text'
                  : 'other',
          status: 'done',
        }));
        setAttachments((prev) => [...prev, ...asAtt]);
      }}
      onRemove={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
      onSubmit={
        props.withSubmit
          ? () => {
              // sendLeaderCommand 성공 경로: 전송 후 pendingAttachments 를 비운다.
              setAttachments([]);
              setValue('');
            }
          : undefined
      }
    />
  );
}

function findDropzone(container: HTMLElement): HTMLElement {
  const zone = container.querySelector<HTMLElement>('.directive-prompt__dropzone');
  if (!zone) throw new Error('dropzone not rendered');
  return zone;
}

// ---------------------------------------------------------------------------
// (1) PDF / 이미지 / 텍스트 3종 드롭 → kind 분류 + 목록 렌더
// ---------------------------------------------------------------------------

test('TC-DP-INT-01: PDF/이미지/텍스트 3종 드롭 시 각 kind 로 렌더된다', () => {
  const spy: File[][] = [];
  const { container } = render(
    <Harness onFilesSpy={(f) => spy.push(f)} />,
  );
  const dropzone = findDropzone(container);

  const files = [
    makeFile('spec.pdf', 'application/pdf'),
    makeFile('logo.png', 'image/png'),
    makeFile('note.txt', 'text/plain'),
  ];

  act(() => {
    fireEvent.drop(dropzone, { dataTransfer: dataTransferOf(files) });
  });

  // onFilesAdded 는 원본 File[] 을 그대로 받아야 한다.
  assert.equal(spy.length, 1, 'onFilesAdded 는 드롭 한 번에 한 번만 호출');
  assert.deepEqual(
    spy[0].map((f) => f.name),
    ['spec.pdf', 'logo.png', 'note.txt'],
  );

  // 목록이 세 행으로 렌더되고 각 data-kind 가 pdf/image/text 로 떨어진다.
  const rows = container.querySelectorAll<HTMLElement>('.directive-attachment');
  assert.equal(rows.length, 3, '첨부 3개가 목록에 나열돼야 한다');
  assert.equal(rows[0].getAttribute('data-kind'), 'pdf');
  assert.equal(rows[1].getAttribute('data-kind'), 'image');
  assert.equal(rows[2].getAttribute('data-kind'), 'text');

  // 색·아이콘이 바뀌는 kind 배지의 라벨도 동시에 검증(색약 가드의 2차 신호).
  const labels = Array.from(
    container.querySelectorAll<HTMLElement>('.directive-attachment__kind-label'),
  ).map((el) => el.textContent);
  assert.deepEqual(labels, ['PDF', 'IMG', 'TXT']);
});

// ---------------------------------------------------------------------------
// (2) accept 필터 + maxBytes 초과 파일 거부
// ---------------------------------------------------------------------------

test('TC-DP-INT-02: accept 밖 MIME / maxBytes 초과 파일은 onFilesAdded 에 도달하지 않는다', () => {
  const spy: File[][] = [];
  const { container } = render(
    <Harness
      accept=".pdf,.txt"
      maxBytes={1024}
      onFilesSpy={(f) => spy.push(f)}
    />,
  );
  const dropzone = findDropzone(container);

  const files = [
    makeFile('small.pdf', 'application/pdf', 512),         // 통과
    makeFile('script.exe', 'application/x-msdownload', 10), // accept 차단
    makeFile('huge.pdf', 'application/pdf', 10 * 1024 * 1024), // size 차단
    makeFile('note.txt', 'text/plain', 800),                // 통과
  ];

  act(() => {
    fireEvent.drop(dropzone, { dataTransfer: dataTransferOf(files) });
  });

  assert.equal(spy.length, 1, '한 번의 드롭 → 한 번의 onFilesAdded (필터 후 비지 않을 때만)');
  assert.deepEqual(
    spy[0].map((f) => f.name),
    ['small.pdf', 'note.txt'],
    'accept 화이트리스트를 통과하고 maxBytes 이하인 파일만 부모로 전달',
  );

  // 전원 거부 시에는 onFilesAdded 자체가 호출되지 않아야 한다 (불필요 리렌더 방지).
  act(() => {
    fireEvent.drop(dropzone, {
      dataTransfer: dataTransferOf([
        makeFile('malware.exe', 'application/x-msdownload', 10),
      ]),
    });
  });
  assert.equal(spy.length, 1, '모두 거부된 경우 onFilesAdded 는 추가로 호출되지 않는다');
});

// ---------------------------------------------------------------------------
// (3) onFilesAdded 후 목록 렌더링 + progress 표시
// ---------------------------------------------------------------------------

test('TC-DP-INT-03: uploading 상태 첨부는 진행률 숫자·바·스피너를 동시에 표시한다', () => {
  const uploading = makeAttachment({
    id: 'u1',
    name: 'movie.mov',
    size: 5 * 1024 * 1024,
    mime: 'video/quicktime',
    kind: 'other',
    status: 'uploading',
    progress: 42,
  });
  const { container } = render(
    <Harness externalAttachments={[uploading]} />,
  );

  const row = container.querySelector<HTMLElement>('.directive-attachment');
  assert.ok(row, '행이 렌더돼야 한다');
  assert.equal(row!.getAttribute('data-status'), 'uploading');

  // 퍼센트 라벨
  const progressText = container.querySelector('.directive-attachment__progress')?.textContent ?? '';
  assert.match(progressText, /42\s*%/, '퍼센트 숫자가 노출돼야 한다');

  // 진행 바 width 가 progress 로 세팅된다.
  const bar = container.querySelector<HTMLElement>('.directive-attachment__bar');
  assert.ok(bar, '진행 바가 렌더돼야 한다');
  assert.equal(bar!.style.width, '42%');

  // 스피너 아이콘 — lucide-react Loader2 가 directive-attachment__spinner 클래스로 붙는다.
  assert.ok(
    container.querySelector('.directive-attachment__spinner'),
    '업로드 중에는 스피너가 함께 떠야 한다',
  );
});

// ---------------------------------------------------------------------------
// (4) 업로드 실패 시 errorToast + status='error'
// ---------------------------------------------------------------------------

test('TC-DP-INT-04: status="error" 행과 errorToast 가 함께 렌더된다', () => {
  const failed = makeAttachment({
    id: 'e1',
    name: 'broken.pdf',
    size: 1234,
    mime: 'application/pdf',
    kind: 'pdf',
    status: 'error',
    errorMessage: '서버가 413 을 돌려줬습니다',
  });
  const { container } = render(
    <Harness
      externalAttachments={[failed]}
      errorToast="broken.pdf 업로드 실패: 413 Payload Too Large"
    />,
  );

  // 행에 "실패" 배지가 뜨고 data-status 가 error.
  const row = container.querySelector<HTMLElement>('.directive-attachment');
  assert.ok(row);
  assert.equal(row!.getAttribute('data-status'), 'error');
  const errBadge = container.querySelector('.directive-attachment__error');
  assert.ok(errBadge, '"실패" 배지가 있어야 한다');
  assert.match(errBadge!.textContent ?? '', /실패/);

  // 토스트는 role=alert 로 떠 스크린리더가 즉시 읽도록 한다.
  const toast = container.querySelector('.directive-prompt__toast');
  assert.ok(toast, 'errorToast 문자열이 있으면 토스트 요소가 나타나야 한다');
  assert.equal(toast!.getAttribute('role'), 'alert');
  assert.match(
    toast!.textContent ?? '',
    /413 Payload Too Large/,
    '서버 메시지가 사용자에게 전달돼야 한다',
  );

  // 진행 중이 아니므로 진행 바·스피너는 없어야 한다 (실패 후 혼돈 금지).
  assert.equal(
    container.querySelector('.directive-attachment__bar'),
    null,
    '에러 상태에서는 진행 바를 그리지 않는다',
  );
  assert.equal(
    container.querySelector('.directive-attachment__spinner'),
    null,
    '에러 상태에서는 스피너를 그리지 않는다',
  );
});

// ---------------------------------------------------------------------------
// (5) sendLeaderCommand 후 pendingAttachments 가 비워지는지
// ---------------------------------------------------------------------------

test('TC-DP-INT-05: 제출(onSubmit) 후 부모가 attachments 를 비우면 목록이 사라진다', () => {
  const existing = makeAttachment({
    id: 'ready-1',
    name: 'brief.pdf',
    size: 2048,
    mime: 'application/pdf',
    kind: 'pdf',
    status: 'done',
  });

  const { container } = render(
    <Harness withSubmit initial={[existing]} />,
  );

  // 제출 전: 행 1개 + 제출 버튼.
  assert.equal(container.querySelectorAll('.directive-attachment').length, 1);
  const submit = container.querySelector<HTMLButtonElement>('.directive-prompt__submit');
  assert.ok(submit, '제출 버튼이 렌더돼야 한다');
  assert.equal(submit!.disabled, false, 'done 상태 첨부만 있으면 제출 버튼은 활성');

  // sendLeaderCommand 를 흉내내 클릭 → 하네스가 setAttachments([]) 를 부른다.
  act(() => {
    fireEvent.click(submit!);
  });

  // 제출 후: 목록 자체가 사라지고 footer 카운터도 "첨부 0개" 로 바뀐다.
  assert.equal(
    container.querySelectorAll('.directive-attachment').length,
    0,
    'pendingAttachments 가 비워졌으니 행이 남아있으면 안 된다',
  );
  const hint = container.querySelector('.directive-prompt__footer-hint');
  assert.ok(hint);
  assert.match(hint!.textContent ?? '', /첨부\s*0\s*개/);
});

// ---------------------------------------------------------------------------
// 관찰 API: data-uploading 속성 (지시 #0a55dfba)
// ---------------------------------------------------------------------------

test('data-uploading 속성이 업로드 중 여부를 boolean 으로 반영한다', () => {
  // 초기(빈 첨부) → false.
  const idle = render(<Harness />);
  const idleRoot = idle.container.querySelector<HTMLElement>('.directive-prompt');
  assert.ok(idleRoot);
  assert.equal(idleRoot!.getAttribute('data-uploading'), 'false',
    '첨부가 없거나 전부 done/error 이면 false');

  // 업로드 중 첨부를 `externalAttachments` 로 주입 → true.
  const uploadingAttachment = makeAttachment({
    id: 'up-1', name: '업로드중.pdf', kind: 'pdf', size: 10_000,
    status: 'uploading', progress: 0.3,
  });
  const busy = render(<Harness externalAttachments={[uploadingAttachment]} />);
  const busyRoot = busy.container.querySelector<HTMLElement>('.directive-prompt');
  assert.ok(busyRoot);
  assert.equal(busyRoot!.getAttribute('data-uploading'), 'true',
    'uploading 상태 첨부가 하나라도 있으면 true');
});

// ---------------------------------------------------------------------------
// 키보드: Enter 제출 / Shift+Enter 개행 / IME / 가드 / Cmd·Ctrl+Enter 하위 호환
// ---------------------------------------------------------------------------
//
// Slack/Discord 같은 채팅 UI 관례를 따른다:
//   · Enter 단독      → 전송 (preventDefault 로 textarea newline 막음)
//   · Shift+Enter     → 개행 (preventDefault 하지 않고 브라우저 기본 동작 유지)
//   · IME 조합 중     → 한글·일본어·중국어 입력기 조합 확정을 전송으로 오인하면
//                       사용자가 "안녕" 을 치다가 ㄴ 확정 순간 메시지가 날아간다.
//   · disabled        → 상위가 명시적으로 잠근 상태 — 키보드 경로도 잠근다.
//   · uploading > 0   → 첨부가 올라가는 중이라 서버로 보낼 payload 가 아직 미완.
//                       버튼이 disabled 이니 키보드도 같이 막아 UX 일관성 유지.
//   · Cmd/Ctrl+Enter  → 기존 사용자 머슬메모리 보호용으로 계속 전송 트리거.
//
// fireEvent.keyDown 의 반환값은 "이벤트가 취소되지 않았는지" (true = preventDefault 미호출).
// 이를 이용해 "Enter 는 막았고 Shift+Enter 는 흘려보냈다" 를 동일 API 로 검증한다.

interface KeyHarnessRefs {
  onSubmitCalls: number;
  onChangeCalls: Array<string>;
}

function KeyboardHarness(props: {
  refs: KeyHarnessRefs;
  initialValue?: string;
  uploadingCount?: number;
  disabled?: boolean;
  withSubmit?: boolean;
}) {
  const [value, setValue] = useState(props.initialValue ?? '');
  // uploadingCount 를 흉내내기 위해 status='uploading' 첨부를 n 개 삽입.
  const attachments: DirectiveAttachment[] = Array.from(
    { length: props.uploadingCount ?? 0 },
    (_, i) => makeAttachment({
      id: `up-${i}`,
      name: `file-${i}.pdf`,
      status: 'uploading',
      progress: 10,
    }),
  );
  return (
    <DirectivePrompt
      value={value}
      onChange={(next) => { props.refs.onChangeCalls.push(next); setValue(next); }}
      attachments={attachments}
      onFilesAdded={() => {}}
      onRemove={() => {}}
      onSubmit={
        props.withSubmit === false
          ? undefined
          : () => { props.refs.onSubmitCalls += 1; }
      }
      disabled={props.disabled}
    />
  );
}

function findTextarea(container: HTMLElement): HTMLTextAreaElement {
  const ta = container.querySelector<HTMLTextAreaElement>('.directive-prompt__textarea');
  if (!ta) throw new Error('textarea 가 렌더되지 않았다');
  return ta;
}

test('TC-DP-INT-06: Enter 단독 → onSubmit 1 회 호출 + preventDefault 로 newline 삽입 차단', () => {
  const refs: KeyHarnessRefs = { onSubmitCalls: 0, onChangeCalls: [] };
  const { container } = render(<KeyboardHarness refs={refs} initialValue="hello" />);
  const ta = findTextarea(container);
  ta.focus();

  let notCanceled = true;
  act(() => {
    notCanceled = fireEvent.keyDown(ta, { key: 'Enter' });
  });

  assert.equal(refs.onSubmitCalls, 1, 'Enter 한 번 = 전송 한 번');
  assert.equal(notCanceled, false, 'preventDefault 가 호출돼 기본 newline 삽입이 막혀야 한다');
  // onChange 도 호출되지 않았다 — React 는 preventDefault 된 keyDown 뒤로 input 이벤트를
  // 더 이상 발사하지 않으므로 value 가 "hello\n" 이 되지 않는다.
  assert.equal(refs.onChangeCalls.length, 0, 'Enter 로는 textarea value 가 바뀌지 않는다');
});

test('TC-DP-INT-07: Shift+Enter → onSubmit 호출 없음 + 브라우저 기본 newline 허용', () => {
  const refs: KeyHarnessRefs = { onSubmitCalls: 0, onChangeCalls: [] };
  const { container } = render(<KeyboardHarness refs={refs} initialValue="hello" />);
  const ta = findTextarea(container);
  ta.focus();

  let notCanceled = true;
  act(() => {
    notCanceled = fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
  });

  assert.equal(refs.onSubmitCalls, 0, 'Shift+Enter 는 전송 트리거가 아니다');
  assert.equal(
    notCanceled,
    true,
    'preventDefault 를 호출하지 않아야 한다 — 브라우저가 textarea 에 \\n 을 자연스럽게 삽입',
  );
  // jsdom 은 keyDown 뒤 자동으로 textarea 에 \n 을 넣어 주지 않는다.
  // 그래서 "브라우저 기본 동작을 방해하지 않았다" 는 것을 defaultPrevented=false 로 증명한다.
  // (실제 브라우저에서 \n 이 들어가는 동작은 jsdom 이 시뮬하지 않는 영역.)
});

test('TC-DP-INT-08: IME 조합 중(isComposing=true) Enter 는 onSubmit 을 호출하지 않는다', () => {
  const refs: KeyHarnessRefs = { onSubmitCalls: 0, onChangeCalls: [] };
  const { container } = render(<KeyboardHarness refs={refs} initialValue="안" />);
  const ta = findTextarea(container);
  ta.focus();

  // fireEvent.keyDown 의 init 은 isComposing 을 인식하지 않으므로 직접 native event 를
  // 만든 뒤 읽기 전용 프로퍼티 getter 로 덮어쓴다. React 는 e.nativeEvent.isComposing 을
  // 그대로 읽으므로 이 방식으로도 핸들러의 분기를 정확히 맞춘다.
  const event = createEvent.keyDown(ta, { key: 'Enter' });
  Object.defineProperty(event, 'isComposing', { get: () => true });
  let notCanceled = true;
  act(() => {
    notCanceled = fireEvent(ta, event);
  });

  assert.equal(refs.onSubmitCalls, 0, 'IME 조합 확정 Enter 는 전송이 아니다');
  assert.equal(
    notCanceled,
    true,
    '조합 확정 Enter 는 preventDefault 하지 않아야 한다 (브라우저가 조합을 확정)',
  );
});

test('TC-DP-INT-09a: disabled 상태에서는 Enter 가 onSubmit 을 호출하지 않는다', () => {
  const refs: KeyHarnessRefs = { onSubmitCalls: 0, onChangeCalls: [] };
  const { container } = render(<KeyboardHarness refs={refs} initialValue="hi" disabled />);
  const ta = findTextarea(container);

  act(() => { fireEvent.keyDown(ta, { key: 'Enter' }); });
  assert.equal(refs.onSubmitCalls, 0);

  // Cmd/Ctrl+Enter 도 disabled 이면 호출되지 않아야 한다 (submit() 내부 가드).
  act(() => { fireEvent.keyDown(ta, { key: 'Enter', metaKey: true }); });
  act(() => { fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true }); });
  assert.equal(refs.onSubmitCalls, 0, 'disabled 면 모디파이어 조합도 차단');
});

test('TC-DP-INT-09b: uploading>0 상태에서는 Enter 가 onSubmit 을 호출하지 않는다', () => {
  const refs: KeyHarnessRefs = { onSubmitCalls: 0, onChangeCalls: [] };
  const { container } = render(
    <KeyboardHarness refs={refs} initialValue="업로드 중에 전송 시도" uploadingCount={2} />,
  );
  const ta = findTextarea(container);

  let notCanceled = true;
  act(() => {
    notCanceled = fireEvent.keyDown(ta, { key: 'Enter' });
  });

  assert.equal(refs.onSubmitCalls, 0, '업로드 중에는 전송이 막혀야 한다 (버튼 disabled 와 일관)');
  assert.equal(
    notCanceled,
    true,
    'uploading 가드는 preventDefault 를 하지 않아 사용자의 타이핑 흐름을 끊지 않는다',
  );

  // 제출 버튼도 동시에 disabled 여야 UX 일관성이 유지된다.
  const submit = container.querySelector<HTMLButtonElement>('.directive-prompt__submit');
  assert.ok(submit);
  assert.equal(submit!.disabled, true, 'uploading>0 이면 제출 버튼도 비활성');
});

test('TC-DP-INT-10: Cmd/Ctrl+Enter 는 하위 호환 — 평상 상태에서 계속 submit 을 트리거', () => {
  const refs: KeyHarnessRefs = { onSubmitCalls: 0, onChangeCalls: [] };
  const { container } = render(<KeyboardHarness refs={refs} initialValue="ok" />);
  const ta = findTextarea(container);
  ta.focus();

  // macOS 사용자 — Cmd+Enter.
  let notCanceled = true;
  act(() => {
    notCanceled = fireEvent.keyDown(ta, { key: 'Enter', metaKey: true });
  });
  assert.equal(refs.onSubmitCalls, 1, 'Cmd+Enter 로도 전송');
  assert.equal(notCanceled, false, 'preventDefault 가 걸려 기본 newline 이 추가되지 않는다');

  // Windows/Linux 사용자 — Ctrl+Enter.
  act(() => {
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true });
  });
  assert.equal(refs.onSubmitCalls, 2, 'Ctrl+Enter 도 동일하게 전송 트리거');
});
