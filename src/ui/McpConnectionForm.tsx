// 지시 #49b5de65 — 재사용 가능한 MCP 연결 폼.
//
// 기존 ProjectMcpServersPanel 은 목록/삭제를 포함한 큰 컨테이너지만, 본 컴포넌트는
// "연결 한 건" 의 입력·유효성·연결 테스트 버튼만 담당하는 순수 폼이다. 디자이너
// 와이어프레임상 다음 조건을 만족한다.
//   · transport 라디오(stdio / http / streamable-http) — 선택에 따라 하단 필드가
//     조건부 노출.
//   · stdio: command · args · env.
//   · http · streamable-http: url · headers · authToken(비밀번호 필드).
//   · 제출 전 스토어 검증기(validateMcpServerInput) 를 재사용해 필드별 오류 표시.
//   · 선택적으로 `onTestConnection` 이 주입되면 "연결 테스트" 버튼을 보여 주고,
//     performHandshake 와 호환되는 결과(ok/실패 · serverInfo · 코드·메시지) 를
//     인라인으로 표시한다.
//
// 본 컴포넌트는 상태 보관 API(projectMcpServersStore) 와 직접 엮지 않는다 — 상위
// 컨테이너(예: ProjectMcpServersPanel, 새 설정 페이지) 가 onSubmit 으로 최종
// 입력을 받아 자신의 스토어에 기록한다.

import React, { useMemo, useState } from 'react';
import {
  MCP_TRANSPORTS,
  validateMcpServerInput,
  type McpServerInput,
  type McpTransport,
  type McpValidationError,
} from '../stores/projectMcpServersStore';

export interface McpConnectionFormValues {
  name: string;
  transport: McpTransport;
  // stdio
  command: string;
  argsInput: string;
  envInput: string;
  // http · streamable-http
  url: string;
  headersInput: string;
  authToken: string;
}

export interface McpConnectionFormHandshakeOutcome {
  ok: boolean;
  serverInfo?: { name?: string; version?: string };
  code?: string;
  message?: string;
}

export interface McpConnectionFormProps {
  projectId: string;
  initialValues?: Partial<McpConnectionFormValues>;
  onSubmit: (input: McpServerInput) => Promise<void> | void;
  onCancel?: () => void;
  /** 연결 테스트 — 주입 시 "연결 테스트" 버튼이 노출된다. */
  onTestConnection?: (input: McpServerInput) => Promise<McpConnectionFormHandshakeOutcome>;
  /** 버튼 라벨 오버라이드. 기본 "저장". */
  submitLabel?: string;
  /** 폼 테스트/재사용을 위한 고유 id. 라벨 for/aria 관계에 씀. */
  idPrefix?: string;
}

const TRANSPORT_LABELS: Record<McpTransport, string> = {
  'stdio': 'stdio (로컬 프로세스)',
  'http': 'HTTP',
  'streamable-http': 'Streamable HTTP',
};

export function parseArgsInput(raw: string): string[] {
  return raw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

export function parseKeyValueBlock(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) { out[trimmed] = ''; continue; }
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1);
    out[k] = v;
  }
  return out;
}

/**
 * 현재 폼 값을 정규화된 `McpServerInput` 으로 변환. 전송 방식에 따라 필드를 선택해
 * 비관련 필드가 입력에 포함되지 않도록 한다(검증 오탐 방지).
 */
export function buildMcpServerInput(
  projectId: string,
  values: McpConnectionFormValues,
): McpServerInput {
  const base: McpServerInput = {
    projectId,
    name: values.name,
    transport: values.transport,
  };
  if (values.transport === 'stdio') {
    return {
      ...base,
      command: values.command,
      args: parseArgsInput(values.argsInput),
      env: parseKeyValueBlock(values.envInput),
    };
  }
  return {
    ...base,
    url: values.url.trim(),
    headers: parseKeyValueBlock(values.headersInput),
    ...(values.authToken ? { authToken: values.authToken } : {}),
  };
}

function defaultValues(partial?: Partial<McpConnectionFormValues>): McpConnectionFormValues {
  return {
    name: partial?.name ?? '',
    transport: partial?.transport ?? 'stdio',
    command: partial?.command ?? '',
    argsInput: partial?.argsInput ?? '',
    envInput: partial?.envInput ?? '',
    url: partial?.url ?? '',
    headersInput: partial?.headersInput ?? '',
    authToken: partial?.authToken ?? '',
  };
}

function errorsByField(errors: readonly McpValidationError[]): Partial<Record<McpValidationError['field'], string[]>> {
  const out: Partial<Record<McpValidationError['field'], string[]>> = {};
  for (const e of errors) {
    if (!out[e.field]) out[e.field] = [];
    out[e.field]!.push(e.message);
  }
  return out;
}

export function McpConnectionForm(props: McpConnectionFormProps): React.ReactElement {
  const { projectId, onSubmit, onCancel, onTestConnection, submitLabel = '저장', idPrefix = 'mcp-conn' } = props;
  const [values, setValues] = useState<McpConnectionFormValues>(() => defaultValues(props.initialValues));
  const [errors, setErrors] = useState<McpValidationError[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testOutcome, setTestOutcome] = useState<McpConnectionFormHandshakeOutcome | null>(null);

  const update = <K extends keyof McpConnectionFormValues>(key: K, v: McpConnectionFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: v }));
    // 필드가 바뀌면 기존 연결 테스트 결과는 무효화 — 잘못된 확신 방지.
    if (testOutcome) setTestOutcome(null);
  };

  const byField = useMemo(() => errorsByField(errors), [errors]);
  const isHttp = values.transport !== 'stdio';

  const collectInput = (): McpServerInput => buildMcpServerInput(projectId, values);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const input = collectInput();
    const found = validateMcpServerInput(input);
    setErrors(found);
    if (found.length > 0) return;
    setSubmitting(true);
    try {
      await onSubmit(input);
    } finally {
      setSubmitting(false);
    }
  };

  const handleTest = async () => {
    if (!onTestConnection) return;
    const input = collectInput();
    const found = validateMcpServerInput(input);
    setErrors(found);
    if (found.length > 0) return;
    setTesting(true);
    try {
      const outcome = await onTestConnection(input);
      setTestOutcome(outcome);
    } catch (err) {
      setTestOutcome({ ok: false, message: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const fieldId = (suffix: string) => `${idPrefix}-${suffix}`;

  return (
    <form
      aria-labelledby={fieldId('heading')}
      data-testid="mcp-connection-form"
      onSubmit={handleSubmit}
      className="space-y-4"
    >
      <h3 id={fieldId('heading')} className="text-sm font-bold uppercase tracking-wider">
        MCP 서버 연결
      </h3>

      <div className="space-y-1">
        <label htmlFor={fieldId('name')} className="block text-[10px] uppercase tracking-wider text-white/70">
          이름
        </label>
        <input
          id={fieldId('name')}
          value={values.name}
          onChange={(e) => update('name', e.target.value)}
          maxLength={48}
          aria-invalid={!!byField.name}
          className="w-full bg-black/30 border-2 px-3 py-2 text-[12px] text-white font-mono"
        />
        {byField.name?.map((msg, i) => (
          <p key={i} className="text-[11px] text-red-300" role="alert">· {msg}</p>
        ))}
      </div>

      <fieldset>
        <legend className="block text-[10px] uppercase tracking-wider text-white/70 mb-1">
          전송 방식(transport)
        </legend>
        <div role="radiogroup" aria-label="MCP 전송 방식" className="flex flex-wrap gap-3 text-[11px] text-white/80">
          {MCP_TRANSPORTS.map((t) => (
            <label key={t} className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name={fieldId('transport')}
                value={t}
                checked={values.transport === t}
                onChange={() => update('transport', t)}
              />
              <span>{TRANSPORT_LABELS[t]}</span>
            </label>
          ))}
        </div>
        {byField.transport?.map((msg, i) => (
          <p key={i} className="text-[11px] text-red-300" role="alert">· {msg}</p>
        ))}
      </fieldset>

      {!isHttp ? (
        <div data-testid="mcp-stdio-fields" className="space-y-3">
          <div className="space-y-1">
            <label htmlFor={fieldId('command')} className="block text-[10px] uppercase tracking-wider text-white/70">
              command
            </label>
            <input
              id={fieldId('command')}
              value={values.command}
              onChange={(e) => update('command', e.target.value)}
              aria-invalid={!!byField.command}
              placeholder="예: npx 또는 node"
              className="w-full bg-black/30 border-2 px-3 py-2 text-[12px] text-white font-mono"
            />
            {byField.command?.map((msg, i) => (
              <p key={i} className="text-[11px] text-red-300" role="alert">· {msg}</p>
            ))}
          </div>
          <div className="space-y-1">
            <label htmlFor={fieldId('args')} className="block text-[10px] uppercase tracking-wider text-white/70">
              args (공백 구분)
            </label>
            <input
              id={fieldId('args')}
              value={values.argsInput}
              onChange={(e) => update('argsInput', e.target.value)}
              aria-invalid={!!byField.args}
              placeholder="예: -y @modelcontextprotocol/server-llm-tycoon"
              className="w-full bg-black/30 border-2 px-3 py-2 text-[12px] text-white font-mono"
            />
            {byField.args?.map((msg, i) => (
              <p key={i} className="text-[11px] text-red-300" role="alert">· {msg}</p>
            ))}
          </div>
          <div className="space-y-1">
            <label htmlFor={fieldId('env')} className="block text-[10px] uppercase tracking-wider text-white/70">
              env (한 줄에 KEY=VALUE)
            </label>
            <textarea
              id={fieldId('env')}
              value={values.envInput}
              onChange={(e) => update('envInput', e.target.value)}
              aria-invalid={!!byField.env}
              rows={4}
              className="w-full bg-black/30 border-2 px-3 py-2 text-[12px] text-white font-mono"
            />
            {byField.env?.map((msg, i) => (
              <p key={i} className="text-[11px] text-red-300" role="alert">· {msg}</p>
            ))}
          </div>
        </div>
      ) : (
        <div data-testid="mcp-http-fields" className="space-y-3">
          <div className="space-y-1">
            <label htmlFor={fieldId('url')} className="block text-[10px] uppercase tracking-wider text-white/70">
              url
            </label>
            <input
              id={fieldId('url')}
              value={values.url}
              onChange={(e) => update('url', e.target.value)}
              aria-invalid={!!byField.url}
              placeholder="예: https://mcp.example.com/v1"
              className="w-full bg-black/30 border-2 px-3 py-2 text-[12px] text-white font-mono"
            />
            {byField.url?.map((msg, i) => (
              <p key={i} className="text-[11px] text-red-300" role="alert">· {msg}</p>
            ))}
          </div>
          <div className="space-y-1">
            <label htmlFor={fieldId('headers')} className="block text-[10px] uppercase tracking-wider text-white/70">
              headers (한 줄에 Name=Value)
            </label>
            <textarea
              id={fieldId('headers')}
              value={values.headersInput}
              onChange={(e) => update('headersInput', e.target.value)}
              aria-invalid={!!byField.headers}
              rows={4}
              className="w-full bg-black/30 border-2 px-3 py-2 text-[12px] text-white font-mono"
            />
            {byField.headers?.map((msg, i) => (
              <p key={i} className="text-[11px] text-red-300" role="alert">· {msg}</p>
            ))}
          </div>
          <div className="space-y-1">
            <label htmlFor={fieldId('authToken')} className="block text-[10px] uppercase tracking-wider text-white/70">
              auth token (Bearer)
            </label>
            <input
              id={fieldId('authToken')}
              type="password"
              autoComplete="new-password"
              value={values.authToken}
              onChange={(e) => update('authToken', e.target.value)}
              aria-invalid={!!byField.authToken}
              placeholder="선택 — 비워 두면 인증 없이 요청"
              className="w-full bg-black/30 border-2 px-3 py-2 text-[12px] text-white font-mono"
            />
            {byField.authToken?.map((msg, i) => (
              <p key={i} className="text-[11px] text-red-300" role="alert">· {msg}</p>
            ))}
          </div>
        </div>
      )}

      {testOutcome && (
        <div
          data-testid="mcp-test-outcome"
          role="status"
          aria-live="polite"
          className={`text-[11px] border-2 px-3 py-2 ${testOutcome.ok ? 'border-green-400/60 text-green-200' : 'border-red-400/60 text-red-200'}`}
        >
          {testOutcome.ok
            ? `연결 성공 — 서버: ${testOutcome.serverInfo?.name ?? '(이름 없음)'}${testOutcome.serverInfo?.version ? ` · v${testOutcome.serverInfo.version}` : ''}`
            : `연결 실패${testOutcome.code ? ` [${testOutcome.code}]` : ''}: ${testOutcome.message ?? '알 수 없는 오류'}`}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-2 text-[11px] uppercase border-2 border-white/30"
          >
            취소
          </button>
        )}
        {onTestConnection && (
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            aria-label="MCP 연결 테스트"
            className="px-3 py-2 text-[11px] uppercase border-2 disabled:opacity-40"
          >
            {testing ? '연결 테스트 중…' : '연결 테스트'}
          </button>
        )}
        <button
          type="submit"
          disabled={submitting}
          aria-label={submitLabel}
          className="px-3 py-2 text-[11px] uppercase font-bold border-b-2 disabled:opacity-40"
        >
          {submitting ? '저장 중…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
