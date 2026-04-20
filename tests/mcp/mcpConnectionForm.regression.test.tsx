// Run with: npx tsx --test tests/mcp/mcpConnectionForm.regression.test.tsx
//
// 지시 #49b5de65 — `src/ui/McpConnectionForm.tsx` 의 조건부 필드 · 유효성 배선 ·
// 연결 테스트 경로 회귀 잠금.
//
// 축
//   U1. 기본 transport=stdio — stdio 필드가 보이고 HTTP 필드는 DOM 에 없다.
//   U2. 라디오 전환 — http 를 고르면 URL/headers/authToken 폼이 나타난다.
//   U3. 검증 실패 — 필드별 role="alert" 오류가 뜨고 onSubmit 은 호출되지 않는다.
//   U4. 정상 제출(stdio) — onSubmit 에 검증된 McpServerInput 이 전달된다.
//   U5. 정상 제출(http) — URL · headers · authToken 이 onSubmit 페이로드에 실린다.
//   U6. 연결 테스트 성공 — status 영역에 serverInfo 가 렌더된다.
//   U7. 연결 테스트 실패 — code · message 가 렌더된다.
//   U8. 순수 파서/빌더 유틸 — parseArgsInput · parseKeyValueBlock · buildMcpServerInput.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, render, cleanup, fireEvent, waitFor } from '@testing-library/react';

import {
  McpConnectionForm,
  buildMcpServerInput,
  parseArgsInput,
  parseKeyValueBlock,
  type McpConnectionFormProps,
} from '../../src/ui/McpConnectionForm.tsx';

function mount(props: Partial<McpConnectionFormProps> & Pick<McpConnectionFormProps, 'onSubmit'>) {
  return render(
    React.createElement(McpConnectionForm, {
      projectId: 'P1',
      ...props,
    } as McpConnectionFormProps),
  );
}

test('U1. 기본 transport=stdio — stdio 필드가 보이고 HTTP 필드는 DOM 에 없다', () => {
  try {
    const onSubmit = async () => {};
    mount({ onSubmit });
    assert.ok(document.querySelector('[data-testid="mcp-stdio-fields"]'), 'stdio 필드가 렌더되어야');
    assert.equal(document.querySelector('[data-testid="mcp-http-fields"]'), null, 'HTTP 필드는 숨겨져야');
  } finally {
    cleanup();
  }
});

test('U2. 라디오 전환 — http 를 고르면 URL/headers/authToken 폼이 나타난다', () => {
  try {
    const onSubmit = async () => {};
    mount({ onSubmit });
    const httpRadio = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
      .find((el) => el.value === 'http');
    assert.ok(httpRadio, 'http 라디오 존재');
    act(() => { fireEvent.click(httpRadio!); });
    assert.ok(document.querySelector('[data-testid="mcp-http-fields"]'));
    assert.equal(document.querySelector('[data-testid="mcp-stdio-fields"]'), null);
  } finally {
    cleanup();
  }
});

test('U3. 검증 실패 — 빈 이름·빈 command 에 대해 alert 가 뜨고 onSubmit 은 호출되지 않는다', () => {
  try {
    let called = false;
    const onSubmit = async () => { called = true; };
    mount({ onSubmit });
    const form = document.querySelector('[data-testid="mcp-connection-form"]') as HTMLFormElement;
    act(() => { fireEvent.submit(form); });
    const alerts = document.querySelectorAll('[role="alert"]');
    assert.ok(alerts.length >= 2, '이름·command 에 대해 각각 alert 가 있어야');
    assert.equal(called, false, 'onSubmit 은 호출되면 안 됨');
  } finally {
    cleanup();
  }
});

test('U4. 정상 제출(stdio) — onSubmit 에 정규화된 입력이 전달된다', async () => {
  try {
    let captured: unknown = null;
    const onSubmit = async (input: unknown) => { captured = input; };
    mount({
      onSubmit,
      initialValues: {
        name: 'srv1',
        transport: 'stdio',
        command: 'npx',
        argsInput: '-y @mcp/tools',
        envInput: 'API_URL=http://x\nTOKEN=abc',
      },
    });
    const form = document.querySelector('[data-testid="mcp-connection-form"]') as HTMLFormElement;
    await act(async () => { fireEvent.submit(form); });
    await waitFor(() => { assert.ok(captured, 'onSubmit 이 호출되어야'); });
    const input = captured as {
      projectId: string; name: string; transport: string;
      command: string; args: string[]; env: Record<string, string>;
    };
    assert.equal(input.projectId, 'P1');
    assert.equal(input.transport, 'stdio');
    assert.equal(input.command, 'npx');
    assert.deepEqual(input.args, ['-y', '@mcp/tools']);
    assert.deepEqual(input.env, { API_URL: 'http://x', TOKEN: 'abc' });
  } finally {
    cleanup();
  }
});

test('U5. 정상 제출(http) — URL · headers · authToken 이 onSubmit 페이로드에 실린다', async () => {
  try {
    let captured: unknown = null;
    const onSubmit = async (input: unknown) => { captured = input; };
    mount({
      onSubmit,
      initialValues: {
        name: 'remote',
        transport: 'http',
        url: 'https://mcp.example.com/v1',
        headersInput: 'X-Tenant=acme',
        authToken: 'secret',
      },
    });
    const form = document.querySelector('[data-testid="mcp-connection-form"]') as HTMLFormElement;
    await act(async () => { fireEvent.submit(form); });
    await waitFor(() => { assert.ok(captured); });
    const input = captured as {
      transport: string; url: string; headers: Record<string, string>; authToken?: string;
    };
    assert.equal(input.transport, 'http');
    assert.equal(input.url, 'https://mcp.example.com/v1');
    assert.deepEqual(input.headers, { 'X-Tenant': 'acme' });
    assert.equal(input.authToken, 'secret');
  } finally {
    cleanup();
  }
});

test('U6. 연결 테스트 성공 — status 영역에 serverInfo 가 표시된다', async () => {
  try {
    const onTestConnection = async () => ({ ok: true, serverInfo: { name: 'echo', version: '1.0' } });
    mount({
      onSubmit: async () => {},
      onTestConnection,
      initialValues: { name: 'remote', transport: 'http', url: 'https://x.example' },
    });
    const testBtn = document.querySelector('[aria-label="MCP 연결 테스트"]') as HTMLButtonElement;
    assert.ok(testBtn, '연결 테스트 버튼이 있어야');
    await act(async () => { fireEvent.click(testBtn); });
    await waitFor(() => {
      const outcome = document.querySelector('[data-testid="mcp-test-outcome"]');
      assert.ok(outcome, '결과 영역 발현');
      assert.match(outcome!.textContent ?? '', /연결 성공/);
      assert.match(outcome!.textContent ?? '', /echo/);
    });
  } finally {
    cleanup();
  }
});

test('U7. 연결 테스트 실패 — code·message 가 결과 영역에 렌더된다', async () => {
  try {
    const onTestConnection = async () => ({ ok: false, code: 'MCP_CLIENT_NETWORK', message: 'HTTP 502' });
    mount({
      onSubmit: async () => {},
      onTestConnection,
      initialValues: { name: 'remote', transport: 'http', url: 'https://x.example' },
    });
    const testBtn = document.querySelector('[aria-label="MCP 연결 테스트"]') as HTMLButtonElement;
    await act(async () => { fireEvent.click(testBtn); });
    await waitFor(() => {
      const outcome = document.querySelector('[data-testid="mcp-test-outcome"]');
      assert.ok(outcome);
      assert.match(outcome!.textContent ?? '', /연결 실패/);
      assert.match(outcome!.textContent ?? '', /MCP_CLIENT_NETWORK/);
      assert.match(outcome!.textContent ?? '', /HTTP 502/);
    });
  } finally {
    cleanup();
  }
});

test('U8. 순수 파서/빌더 유틸 — parseArgsInput · parseKeyValueBlock · buildMcpServerInput', () => {
  assert.deepEqual(parseArgsInput('  a   b  c '), ['a', 'b', 'c']);
  assert.deepEqual(parseArgsInput(''), []);
  assert.deepEqual(parseKeyValueBlock('X=1\nY=2'), { X: '1', Y: '2' });
  assert.deepEqual(parseKeyValueBlock('FLAG\nX=1'), { FLAG: '', X: '1' });

  const stdioInput = buildMcpServerInput('P1', {
    name: 's', transport: 'stdio', command: 'node', argsInput: 'a b', envInput: 'A=1',
    url: '', headersInput: '', authToken: '',
  });
  assert.equal(stdioInput.command, 'node');
  assert.deepEqual(stdioInput.args, ['a', 'b']);
  assert.deepEqual(stdioInput.env, { A: '1' });
  assert.equal('url' in stdioInput, false, 'stdio 에서는 url 이 입력에 포함되지 않아야');

  const httpInput = buildMcpServerInput('P1', {
    name: 's', transport: 'http', command: '', argsInput: '', envInput: '',
    url: '  https://x  ', headersInput: 'K=v', authToken: 't',
  });
  assert.equal(httpInput.transport, 'http');
  assert.equal(httpInput.url, 'https://x', 'url 은 trim 되어야');
  assert.deepEqual(httpInput.headers, { K: 'v' });
  assert.equal(httpInput.authToken, 't');
  assert.equal('command' in httpInput, false, 'http 에서는 command 가 입력에 포함되지 않아야');

  const httpNoToken = buildMcpServerInput('P1', {
    name: 's', transport: 'streamable-http', command: '', argsInput: '', envInput: '',
    url: 'https://x', headersInput: '', authToken: '',
  });
  assert.equal('authToken' in httpNoToken, false, '빈 authToken 은 생략되어야');
});
