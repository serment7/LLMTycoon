// 지시 #6fd99c90 — 프로젝트 관리 메뉴의 "MCP 서버 설정" 패널.
// 지시 #5cda6ae5 — transport(stdio · http · streamable-http) 선택 확장.
//
// 화면 개요
//   · 전송 방식(transport) 라디오 — stdio / http / streamable-http
//   · stdio 에서는 command · args · env 입력을 표시.
//   · http · streamable-http 에서는 url · headers · authToken 입력을 표시.
//   · args 는 공백 구분 문자열로 입력 → 내부에서 배열로 분해(단순 split 이 아니라
//     공백은 기본 구분자로 쓰되 빈 항목은 걸러낸다)
//   · env · headers 는 key=value 한 줄씩 입력 → 파서가 공백 · NUL · 유효하지 않은 키를 차단
//   · 제출 전 validateMcpServerInput 으로 동일 검증을 UI 에서 선수행한다.

import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Server, Globe } from 'lucide-react';
import {
  addProjectMcpServer,
  listProjectMcpServers,
  removeProjectMcpServer,
  subscribeProjectMcpServers,
  validateMcpServerInput,
  MCP_TRANSPORTS,
  type McpServerRecord,
  type McpTransport,
  type McpValidationError,
  type ProjectMcpServersStore,
} from '../stores/projectMcpServersStore';

interface Props {
  projectId: string;
  /** 테스트 주입용. 미지정 시 싱글턴 편의 API 를 사용. */
  store?: ProjectMcpServersStore;
  onLog?: (message: string) => void;
}

const focusRing = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pixel-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black';

/** "foo bar baz" → ["foo","bar","baz"]. 따옴표 파싱은 의도적으로 피한다(검증이 단순해지고 UI 가 예측 가능). */
export function parseArgsInput(raw: string): string[] {
  return raw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

/** "KEY=VAL\nFOO=BAR" → { KEY:"VAL", FOO:"BAR" }. 불완전한 줄은 빈 값을 가진 키로 돌려 검증이 잡게 둔다. */
export function parseEnvInput(raw: string): Record<string, string> {
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
 * HTTP 헤더 입력 파서. env 와 규칙은 같지만 헤더 이름 검증은 스토어 검증기에 위임하고,
 * 여기서는 key 앞뒤 공백만 정리한다. 값은 Bearer 토큰 등 그대로 보존한다.
 */
export const parseHeadersInput = parseEnvInput;

export const MCP_TRANSPORT_LABELS: Record<McpTransport, string> = {
  'stdio': 'stdio (로컬 프로세스)',
  'http': 'HTTP',
  'streamable-http': 'Streamable HTTP',
};

export function ProjectMcpServersPanel({ projectId, store, onLog }: Props) {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<McpTransport>('stdio');
  const [command, setCommand] = useState('');
  const [argsInput, setArgsInput] = useState('');
  const [envInput, setEnvInput] = useState('');
  const [url, setUrl] = useState('');
  const [headersInput, setHeadersInput] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [errors, setErrors] = useState<McpValidationError[]>([]);
  const [items, setItems] = useState<McpServerRecord[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const api = useMemo(() => {
    if (store) {
      return {
        add: store.add.bind(store),
        remove: (pid: string, id: string) => store.remove(pid, id),
        list: (pid: string) => store.list(pid),
        subscribe: (pid: string, l: () => void) => store.subscribe(pid, l),
      };
    }
    return {
      add: addProjectMcpServer,
      remove: removeProjectMcpServer,
      list: listProjectMcpServers,
      subscribe: subscribeProjectMcpServers,
    };
  }, [store]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await api.list(projectId);
        if (!cancelled) setItems(next);
      } catch (err) {
        if (!cancelled) onLog?.(`MCP 서버 목록 로드 실패: ${(err as Error).message}`);
      }
    }
    load();
    const unsub = api.subscribe(projectId, () => { load(); });
    return () => { cancelled = true; unsub(); };
  }, [projectId, api, onLog]);

  const submit = async () => {
    const base = { projectId, name, transport };
    const input = transport === 'stdio'
      ? {
          ...base,
          command,
          args: parseArgsInput(argsInput),
          env: parseEnvInput(envInput),
        }
      : {
          ...base,
          url: url.trim(),
          headers: parseHeadersInput(headersInput),
          ...(authToken ? { authToken } : {}),
        };
    const found = validateMcpServerInput(input);
    setErrors(found);
    if (found.length > 0) return;
    setSubmitting(true);
    try {
      await api.add(input);
      setName(''); setTransport('stdio');
      setCommand(''); setArgsInput(''); setEnvInput('');
      setUrl(''); setHeadersInput(''); setAuthToken('');
      onLog?.(`MCP 서버 추가: ${input.name.trim()}`);
    } catch (err) {
      // 중복 이름 등은 팩토리에서 throw 되므로 토스트 메시지로만 표면화.
      onLog?.(`MCP 서버 추가 실패: ${(err as Error).message}`);
      setErrors([{ field: 'name', message: (err as Error).message }]);
    } finally {
      setSubmitting(false);
    }
  };

  const onRemove = async (rec: McpServerRecord) => {
    if (!confirm(`"${rec.name}" MCP 서버를 삭제할까요?`)) return;
    try {
      await api.remove(projectId, rec.id);
      onLog?.(`MCP 서버 삭제: ${rec.name}`);
    } catch (err) {
      onLog?.(`MCP 서버 삭제 실패: ${(err as Error).message}`);
    }
  };

  return (
    <section aria-labelledby="project-mcp-servers-heading" data-testid="project-mcp-servers-panel">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 id="project-mcp-servers-heading" className="text-lg font-bold text-[var(--pixel-accent)] uppercase tracking-wider flex items-center gap-2">
            <Server size={16} aria-hidden /> MCP 서버 설정
          </h2>
          <span className="text-[10px] text-white/60 uppercase tracking-wider">프로젝트 전용</span>
        </div>
      </div>

      <div className="mb-4 space-y-2">
        <label className="block text-[10px] uppercase tracking-wider text-white/70">이름</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="MCP 서버 이름"
          placeholder="예: llm-tycoon"
          className={`w-full md:w-1/2 bg-black/30 border-2 border-[var(--pixel-border)] px-3 py-2 text-[12px] text-white font-mono ${focusRing}`}
          maxLength={48}
        />
        <fieldset className="pt-2">
          <legend className="block text-[10px] uppercase tracking-wider text-white/70 mb-1">전송 방식(transport)</legend>
          <div role="radiogroup" aria-label="MCP 전송 방식" className="flex flex-wrap gap-3 text-[11px] text-white/80">
            {MCP_TRANSPORTS.map((t) => (
              <label key={t} className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="mcp-transport"
                  value={t}
                  checked={transport === t}
                  onChange={() => setTransport(t)}
                  aria-label={`전송 방식 ${MCP_TRANSPORT_LABELS[t]}`}
                  className="accent-[var(--pixel-accent)]"
                />
                <span>{MCP_TRANSPORT_LABELS[t]}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      {transport === 'stdio' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4" data-testid="mcp-stdio-fields">
          <div className="space-y-2">
            <label className="block text-[10px] uppercase tracking-wider text-white/70">command</label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              aria-label="실행 명령"
              placeholder="예: npx 또는 node"
              className={`w-full bg-black/30 border-2 border-[var(--pixel-border)] px-3 py-2 text-[12px] text-white font-mono ${focusRing}`}
            />
            <label className="block text-[10px] uppercase tracking-wider text-white/70 pt-2">args (공백 구분)</label>
            <input
              value={argsInput}
              onChange={(e) => setArgsInput(e.target.value)}
              aria-label="MCP 서버 args"
              placeholder="예: -y @modelcontextprotocol/server-llm-tycoon"
              className={`w-full bg-black/30 border-2 border-[var(--pixel-border)] px-3 py-2 text-[12px] text-white font-mono ${focusRing}`}
            />
          </div>
          <div className="space-y-2">
            <label className="block text-[10px] uppercase tracking-wider text-white/70">env (한 줄에 KEY=VALUE)</label>
            <textarea
              value={envInput}
              onChange={(e) => setEnvInput(e.target.value)}
              aria-label="MCP 서버 env"
              placeholder={'예:\nAPI_URL=http://localhost:3000\nAGENT_TOKEN=<토큰>'}
              rows={6}
              className={`w-full bg-black/30 border-2 border-[var(--pixel-border)] px-3 py-2 text-[12px] text-white font-mono ${focusRing}`}
            />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4" data-testid="mcp-http-fields">
          <div className="space-y-2">
            <label className="block text-[10px] uppercase tracking-wider text-white/70">url</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="MCP 서버 url"
              placeholder="예: https://mcp.example.com/v1"
              className={`w-full bg-black/30 border-2 border-[var(--pixel-border)] px-3 py-2 text-[12px] text-white font-mono ${focusRing}`}
            />
            <label className="block text-[10px] uppercase tracking-wider text-white/70 pt-2">auth token (Bearer)</label>
            <input
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              aria-label="MCP 서버 인증 토큰"
              placeholder="선택 — 비워 두면 인증 없이 요청"
              type="password"
              autoComplete="new-password"
              className={`w-full bg-black/30 border-2 border-[var(--pixel-border)] px-3 py-2 text-[12px] text-white font-mono ${focusRing}`}
            />
          </div>
          <div className="space-y-2">
            <label className="block text-[10px] uppercase tracking-wider text-white/70">headers (한 줄에 Name=Value)</label>
            <textarea
              value={headersInput}
              onChange={(e) => setHeadersInput(e.target.value)}
              aria-label="MCP 서버 headers"
              placeholder={'예:\nX-Client=llm-tycoon\nAccept=application/json'}
              rows={6}
              className={`w-full bg-black/30 border-2 border-[var(--pixel-border)] px-3 py-2 text-[12px] text-white font-mono ${focusRing}`}
            />
          </div>
        </div>
      )}

      {errors.length > 0 && (
        <ul role="alert" aria-live="polite" className="border-2 border-red-500/70 bg-red-900/30 text-red-200 p-3 text-[11px] space-y-1 mb-4">
          {errors.map((e, i) => (
            <li key={i}>· {e.message}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-end mb-6">
        <button
          onClick={submit}
          disabled={submitting}
          aria-label="MCP 서버 추가"
          className={`px-3 py-2 bg-[var(--pixel-accent)] text-black text-[11px] font-bold uppercase border-b-2 border-[#0099cc] flex items-center gap-2 hover:brightness-110 active:translate-y-px transition disabled:opacity-40 ${focusRing}`}
        >
          <Plus size={14} /> MCP 서버 추가
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {items.length === 0 && (
          <p className="col-span-full text-[11px] text-white/50 italic">
            등록된 MCP 서버가 없습니다.
          </p>
        )}
        {items.map((rec) => {
          const recTransport: McpTransport = rec.transport ?? 'stdio';
          const isHttp = recTransport !== 'stdio';
          return (
            <article key={rec.id} className="bg-[#0f3460] border-2 border-[var(--pixel-border)] p-3 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-bold text-[var(--pixel-accent)] truncate font-mono flex items-center gap-2">
                  {isHttp ? <Globe size={12} aria-hidden /> : <Server size={12} aria-hidden />}
                  <span className="truncate">{rec.name}</span>
                  <span className="text-[9px] font-bold uppercase tracking-wider text-white/50 border border-white/30 px-1 py-px rounded-sm">{recTransport}</span>
                </h4>
                {isHttp ? (
                  <>
                    <p className="text-[11px] text-white/70 mt-1 font-mono break-all">
                      <span className="opacity-80">{rec.url ?? '(url 누락)'}</span>
                    </p>
                    {rec.headers && Object.keys(rec.headers).length > 0 && (
                      <p className="text-[10px] text-white/50 mt-1">
                        headers: {Object.keys(rec.headers).join(', ')}
                      </p>
                    )}
                    {rec.authToken && (
                      <p className="text-[10px] text-white/50 mt-1">auth: bearer 설정됨</p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="text-[11px] text-white/70 mt-1 font-mono break-all">
                      <span className="opacity-80">{rec.command}</span>
                      {rec.args.length > 0 && <span className="opacity-60"> {rec.args.join(' ')}</span>}
                    </p>
                    {Object.keys(rec.env).length > 0 && (
                      <p className="text-[10px] text-white/50 mt-1">
                        env: {Object.keys(rec.env).join(', ')}
                      </p>
                    )}
                  </>
                )}
              </div>
              <button
                onClick={() => onRemove(rec)}
                aria-label={`${rec.name} MCP 서버 삭제`}
                className={`p-1.5 bg-red-900/20 border-2 border-red-900/60 hover:bg-red-900 text-red-300 hover:text-white transition-colors ${focusRing}`}
                title="삭제"
              >
                <Trash2 size={12} />
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
