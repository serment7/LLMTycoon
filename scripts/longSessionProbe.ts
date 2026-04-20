#!/usr/bin/env tsx
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 지시 #c9c158aa — 장시간 세션(기본 30분) 시뮬레이션 프로브.
 *
 * 목적
 *   `src/llm/{tokenBudget,client,usageLog}.ts` 가 "장기 이용" 에서 실제로 토큰을
 *   아끼는지 관찰한다. Anthropic SDK 가 붙으면 실제 호출을, API 키가 없으면
 *   결정론적 시뮬레이터를 쓰되 **같은 usage 축** 을 채워 보고서 입력을 동일하게 만든다.
 *
 * 실행
 *   npx tsx scripts/longSessionProbe.ts [옵션]
 *     --cycles=<N>           대화 왕복 수(기본 180 — 약 30분, 턴당 10초 가정)
 *     --minutes=<M>          목표 지속 분(기본 30). 실 대기 없이 가상 시계만 전진.
 *     --threshold=<T>        compactThresholdTokens(기본 60000)
 *     --real                 Anthropic SDK 실 호출(ANTHROPIC_API_KEY 필요)
 *     --out=<path>           보고서 출력(기본 docs/token-budget-report.md)
 *     --dry                  파일 쓰지 않고 stdout 으로만 요약
 *
 * 출력
 *   · docs/token-budget-report.md — 실행 시각·모드·누적 지표·ASCII 추세 그래프
 *   · 표준출력 — 요약 한 줄
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { argv, env, exit, stdout } from 'node:process';

import {
  createBudgetSession,
  recordUsage,
  appendTurn,
  maybeCompact,
  shouldCompact,
  type BudgetSession,
  type ConversationTurn,
} from '../src/llm/tokenBudget.ts';
import {
  buildCacheableConversation,
  invalidateCachePrefix,
  fingerprintCachePrefix,
  type CachePrefixFingerprint,
} from '../src/llm/client.ts';
import { createInMemoryUsageLog, formatUsageLogLine } from '../src/llm/usageLog.ts';
import { cacheHitRate } from '../src/utils/claudeTokenUsageStore.ts';
import type { ClaudeTokenUsage } from '../src/types.ts';
import {
  createInMemorySessionStore,
  createSessionPersistor,
  restoreBudgetSessionFromSnapshot,
  type SessionStoreAdapter,
} from '../src/session/sessionStore.ts';

interface ProbeOptions {
  readonly cycles: number;
  readonly minutes: number;
  readonly thresholdTokens: number;
  readonly real: boolean;
  readonly out: string;
  readonly dry: boolean;
}

function parseOptions(): ProbeOptions {
  const args = argv.slice(2);
  const get = (name: string): string | undefined => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const flag = (name: string): boolean => args.includes(`--${name}`);
  return {
    cycles: Number.parseInt(get('cycles') ?? '180', 10),
    minutes: Number.parseInt(get('minutes') ?? '30', 10),
    thresholdTokens: Number.parseInt(get('threshold') ?? '60000', 10),
    real: flag('real'),
    out: get('out') ?? 'docs/token-budget-report.md',
    dry: flag('dry'),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 실제 호출 어댑터 — Anthropic SDK 가 있으면 사용, 없으면 시뮬레이터로 폴백
// ────────────────────────────────────────────────────────────────────────────

interface ClaudeCallResult {
  readonly usage: ClaudeTokenUsage;
  readonly assistantText: string;
}

type ClaudeCall = (
  system: string,
  agentDefinition: string,
  toolsSchema: string,
  history: readonly ConversationTurn[],
  user: string,
  cycleIndex: number,
) => Promise<ClaudeCallResult>;

/** 결정론적 시뮬레이터 — 웜업 2턴은 cache_creation 지배, 이후 cache_read 지배. */
function createSimulatedCall(): ClaudeCall {
  let baseAt = Date.UTC(2026, 3, 21, 10, 0, 0);
  return async (_system, _agent, _tools, history, user, cycleIndex) => {
    const isWarm = cycleIndex < 2;
    const input = isWarm ? 800 : 200;
    const output = 400;
    const cacheRead = isWarm ? 0 : 4_000;
    const cacheCreation = isWarm ? 4_000 : 0;
    baseAt += 10_000;
    return {
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        model: 'claude-opus-4-7',
        at: new Date(baseAt).toISOString(),
      },
      assistantText: `[sim #${cycleIndex}] 응답: ${user.slice(0, 40)} (히스토리 ${history.length}턴)`,
    };
  };
}

/**
 * 실 SDK 호출 — API 키가 있고 `--real` 일 때만. 네트워크 실패 시 시뮬레이터로 폴백하고
 * 보고서에 모드 전환을 표시한다. 본 프로브는 저장소 레벨에서 실행 가능해야 하므로
 * `@anthropic-ai/sdk` 는 이미 devDependency/dependency 로 포함돼 있다고 가정한다.
 */
async function createRealClaudeCall(): Promise<ClaudeCall> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    stdout.write('⚠︎ ANTHROPIC_API_KEY 미설정 — 시뮬레이터로 폴백합니다.\n');
    return createSimulatedCall();
  }
  try {
    // 타입 선언이 프로젝트 tsconfig 외부에 있어 TS 가 경로 해석을 못 할 수 있다 —
    // 런타임에서만 필요한 동적 import 이므로 expect-error 로 완화한다.
    // @ts-expect-error — 설치된 패키지지만 타입 경로가 tsconfig 에 연결되지 않음.
    const mod = await import('@anthropic-ai/sdk');
    const Anthropic = (mod as { default?: new (opts: { apiKey: string }) => unknown }).default
      ?? (mod as unknown as { Anthropic: new (opts: { apiKey: string }) => unknown }).Anthropic;
    if (!Anthropic) throw new Error('Anthropic SDK 기본 export 를 찾지 못했습니다.');
    const client = new Anthropic({ apiKey }) as {
      messages: {
        create(params: unknown): Promise<{
          content?: Array<{ type: string; text?: string }>;
          model?: string;
          usage?: {
            input_tokens?: number; output_tokens?: number;
            cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
          };
        }>;
      };
    };
    return async (system, agent, tools, history, user) => {
      const conv = buildCacheableConversation({
        systemPrompt: system, agentDefinition: agent, toolsSchema: tools,
        history, user,
      });
      const res = await client.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 512,
        system: conv.system,
        messages: conv.messages,
      });
      const usage: ClaudeTokenUsage = {
        input_tokens: res.usage?.input_tokens ?? 0,
        output_tokens: res.usage?.output_tokens ?? 0,
        cache_read_input_tokens: res.usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: res.usage?.cache_creation_input_tokens ?? 0,
        model: res.model ?? 'claude-opus-4-7',
        at: new Date().toISOString(),
      };
      const assistantText = res.content?.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('') ?? '';
      return { usage, assistantText };
    };
  } catch (err) {
    stdout.write(`⚠︎ Anthropic SDK 로드 실패 — 시뮬레이터로 폴백: ${(err as Error).message}\n`);
    return createSimulatedCall();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 프로브 본체
// ────────────────────────────────────────────────────────────────────────────

interface Sample {
  readonly cycle: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheHit: number;
  readonly compactTriggered: boolean;
}

/** 지시 #c50309c3 · 언어 토글·추천 반복 스트레스 스텝 측정 결과. */
interface StressSummary {
  readonly atCycle: number;
  readonly localeToggles: number;
  readonly recommendCalls: number;
  readonly toggleDurationMs: number;
  readonly recommendDurationMs: number;
  readonly inputDelta: number;
  readonly cacheReadDelta: number;
  readonly heapUsedBeforeMb: number;
  readonly heapUsedAfterMb: number;
  readonly heapLeakMb: number; // 경험적 누수 경계 — 1MB 초과 시 플래그.
}

interface ReconnectCheck {
  readonly cycle: number;
  readonly cacheReadBefore: number;
  readonly cacheReadAfter: number;
  readonly historyBefore: number;
  readonly historyAfter: number;
  readonly passed: boolean;
}

async function runProbe(opts: ProbeOptions): Promise<{
  samples: Sample[];
  logLines: readonly string[];
  finalSession: BudgetSession;
  mode: 'real' | 'simulated';
  invalidations: number;
  reconnect: ReconnectCheck | null;
  stress: StressSummary | null;
}> {
  const call = opts.real ? await createRealClaudeCall() : createSimulatedCall();
  const mode: 'real' | 'simulated' = opts.real ? 'real' : 'simulated';
  const sink = createInMemoryUsageLog();
  const samples: Sample[] = [];
  // 세션 저장소와 영속기 — 재접속 시뮬에서 복원용.
  const sessionAdapter: SessionStoreAdapter = createInMemorySessionStore();
  const persistor = createSessionPersistor({
    adapter: sessionAdapter,
    sessionId: 'probe-session',
    userId: 'probe-user',
  });

  const systemPrompt = '당신은 LLMTycoon 팀의 장기 이용 프로브입니다. 짧고 결정적으로 답합니다.';
  let agentDefinition = '[Agents] Leader · Developer · QA · Designer';
  let toolsSchema = JSON.stringify({ tools: [{ name: 'noop' }] });
  let fingerprint: CachePrefixFingerprint | null = null;
  let invalidations = 0;

  let session = createBudgetSession('probe-session');
  let reconnect: ReconnectCheck | null = null;
  // 30분 중간 지점 재접속 모사 — cycles 의 절반 지점에서 한 번만 발동.
  const reconnectAt = Math.floor(opts.cycles / 2);
  // 지시 #c50309c3 — 언어 토글 10회 + 추천 요청 5회 스트레스 스텝을 3/4 지점에 주입.
  const stressAt = Math.floor(opts.cycles * 3 / 4);
  let stress: StressSummary | null = null;

  for (let i = 0; i < opts.cycles; i += 1) {
    // 50 번째 사이클에 도구 하나 추가, 100 번째에 에이전트 1명 추가 — 캐시 무효화 이벤트.
    if (i === 50) {
      toolsSchema = JSON.stringify({ tools: [{ name: 'noop' }, { name: 'search' }] });
    }
    if (i === 100) {
      agentDefinition += ' · Researcher';
    }
    const inv = invalidateCachePrefix({
      systemPrompt,
      agentDefinition,
      toolsSchema,
      previousFingerprint: fingerprint,
      user: `cycle-${i}`,
    });
    fingerprint = inv.decision.nextFingerprint;
    if (inv.decision.invalidated && inv.decision.reasons[0] !== 'initial-build') invalidations += 1;

    const userText = `장기 세션 질문 #${i}: 무엇을 점검해야 할까요?`;
    const res = await call(systemPrompt, agentDefinition, toolsSchema, session.history, userText, i);
    session = recordUsage(session, res.usage);
    session = appendTurn(session, { role: 'user', content: userText, tokens: 150 });
    session = appendTurn(session, { role: 'assistant', content: res.assistantText, tokens: 300 });

    // 저장 트리거 #1 — recordUsage 직후.
    await persistor.onRecordUsage(session, { transport: 'stdio', name: 'probe-mcp' });

    const triggered = shouldCompact(session.history, opts.thresholdTokens);
    if (triggered) {
      session = maybeCompact(session, {
        compactThresholdTokens: opts.thresholdTokens,
        keepLatestTurns: 6,
      });
      // 저장 트리거 #2 — 압축 직후.
      await persistor.onCompact(session, { transport: 'stdio', name: 'probe-mcp' });
    }

    await sink.append(res.usage, `probe-${i}`);
    samples.push({
      cycle: i,
      inputTokens: session.totals.inputTokens,
      outputTokens: session.totals.outputTokens,
      cacheReadTokens: session.totals.cacheReadTokens,
      cacheCreationTokens: session.totals.cacheCreationTokens,
      cacheHit: cacheHitRate(session.totals),
      compactTriggered: triggered,
    });

    // 지시 #c50309c3 — 3/4 지점에서 "언어 토글 10회 연속 + 추천 5회" 스트레스 스텝.
    if (i === stressAt && stress === null) {
      const inputBefore = session.totals.inputTokens;
      const cacheReadBefore = session.totals.cacheReadTokens;
      const heapBefore = process.memoryUsage().heapUsed;

      // (1) 언어 토글 10회 — 각 토글을 "비동기 호출 1건 + usageLog 기록" 으로 시뮬.
      //     실 호출과 달리 프롬프트 본문이 짧아 input_tokens 가 최소, cache_read 가 지배.
      const toggleStart = Date.now();
      for (let t = 0; t < 10; t += 1) {
        const locale = t % 2 === 0 ? 'ko' : 'en';
        const res = await call(
          systemPrompt, agentDefinition, toolsSchema, session.history,
          `[locale-toggle #${t}] 언어를 ${locale} 로 전환합니다.`,
          i,
        );
        session = recordUsage(session, res.usage);
        await sink.append(res.usage, `probe-${i}-toggle-${t}`);
      }
      const toggleDurationMs = Date.now() - toggleStart;

      // (2) 추천 요청 5회 반복 — 동일 설명을 반복 호출해 프롬프트 캐시 재사용 효과를 관찰.
      const recommendStart = Date.now();
      const recommendDesc = '장기 세션 스트레스 — 대시보드 + 알림 + 권한 관리 모듈 추가';
      for (let r = 0; r < 5; r += 1) {
        const res = await call(
          systemPrompt, agentDefinition, toolsSchema, session.history,
          `[recommend #${r}] ${recommendDesc}`,
          i,
        );
        session = recordUsage(session, res.usage);
        await sink.append(res.usage, `probe-${i}-recommend-${r}`);
      }
      const recommendDurationMs = Date.now() - recommendStart;

      const heapAfter = process.memoryUsage().heapUsed;
      const heapLeakMb = Math.max(0, (heapAfter - heapBefore) / (1024 * 1024));
      stress = {
        atCycle: i,
        localeToggles: 10,
        recommendCalls: 5,
        toggleDurationMs,
        recommendDurationMs,
        inputDelta: session.totals.inputTokens - inputBefore,
        cacheReadDelta: session.totals.cacheReadTokens - cacheReadBefore,
        heapUsedBeforeMb: heapBefore / (1024 * 1024),
        heapUsedAfterMb: heapAfter / (1024 * 1024),
        heapLeakMb,
      };
    }

    // 중간 지점에서 강제 재접속: (a) 저장소에서 로드, (b) 세션 객체를 버리고 (c) 복원,
    // (d) cache_read·히스토리 길이가 손실되지 않았는지 확인한다.
    if (i === reconnectAt) {
      const cacheReadBefore = session.totals.cacheReadTokens;
      const historyBefore = session.history.length;
      const snapshot = await sessionAdapter.get('probe-user', 'probe-session');
      if (!snapshot) {
        reconnect = {
          cycle: i, cacheReadBefore, cacheReadAfter: 0,
          historyBefore, historyAfter: 0, passed: false,
        };
      } else {
        session = restoreBudgetSessionFromSnapshot(snapshot);
        reconnect = {
          cycle: i,
          cacheReadBefore,
          cacheReadAfter: session.totals.cacheReadTokens,
          historyBefore,
          historyAfter: session.history.length,
          passed: session.totals.cacheReadTokens === cacheReadBefore
            && session.history.length === historyBefore,
        };
      }
    }
  }

  return {
    samples,
    logLines: sink.snapshot(),
    finalSession: session,
    mode,
    invalidations,
    reconnect,
    stress,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// ASCII 추세 그래프 — 의존성 없이 Markdown 에 실리도록
// ────────────────────────────────────────────────────────────────────────────

function renderAsciiTrend(samples: readonly Sample[], title: string, pick: (s: Sample) => number, width = 60, height = 8): string {
  if (samples.length === 0) return `### ${title}\n(데이터 없음)`;
  const values = samples.map(pick);
  const max = Math.max(...values, 1);
  const step = Math.max(1, Math.floor(samples.length / width));
  const cols: number[] = [];
  for (let i = 0; i < samples.length; i += step) cols.push(values[i]);
  const lines: string[] = [`### ${title}`, '```'];
  for (let row = height; row >= 0; row -= 1) {
    const threshold = (row / height) * max;
    const line = cols.map((v) => (v >= threshold ? '█' : ' ')).join('');
    lines.push(`${String(Math.round(threshold)).padStart(7)} | ${line}`);
  }
  lines.push(`${' '.repeat(7)} +${'-'.repeat(cols.length)}`);
  lines.push(`${' '.repeat(9)}cycle 0${' '.repeat(Math.max(0, cols.length - 14))}${samples.length - 1}`);
  lines.push('```');
  lines.push(`· 최종값: ${values[values.length - 1]} / 최댓값: ${max}`);
  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// 보고서 렌더 · 기록
// ────────────────────────────────────────────────────────────────────────────

function renderReport(opts: ProbeOptions, result: Awaited<ReturnType<typeof runProbe>>): string {
  const last = result.samples[result.samples.length - 1];
  const lines: string[] = [];
  lines.push('# 토큰 예산 · 장기 세션 리포트');
  lines.push('');
  lines.push(`- 실행 시각: ${new Date().toISOString()}`);
  lines.push(`- 모드: ${result.mode === 'real' ? '실 Anthropic SDK' : '결정론 시뮬레이터'}`);
  lines.push(`- 사이클 수: ${opts.cycles} (목표 ${opts.minutes}분 시뮬)`);
  lines.push(`- 압축 임계치(tokens): ${opts.thresholdTokens}`);
  lines.push(`- 캐시 무효화 이벤트 수: ${result.invalidations}`);
  lines.push('');
  lines.push('## 최종 누적 지표');
  lines.push(`- 호출 횟수: ${result.finalSession.totals.callCount}`);
  lines.push(`- input: ${result.finalSession.totals.inputTokens.toLocaleString()} / output: ${result.finalSession.totals.outputTokens.toLocaleString()}`);
  lines.push(`- cache_read: ${result.finalSession.totals.cacheReadTokens.toLocaleString()} / cache_creation: ${result.finalSession.totals.cacheCreationTokens.toLocaleString()}`);
  lines.push(`- cacheHitRate: ${last ? last.cacheHit.toFixed(3) : 'N/A'}`);
  lines.push(`- 압축 트리거 발생: ${result.samples.filter((s) => s.compactTriggered).length}회`);
  lines.push('');
  lines.push(renderAsciiTrend(result.samples, 'cache_read 누적 추세', (s) => s.cacheReadTokens));
  lines.push('');
  lines.push(renderAsciiTrend(result.samples, 'input_tokens 누적 추세', (s) => s.inputTokens));
  lines.push('');
  lines.push(renderAsciiTrend(result.samples, 'cacheHitRate 추세(×1000)', (s) => Math.round(s.cacheHit * 1_000)));
  lines.push('');
  lines.push('## 재접속(세션 지속성) 검증');
  if (result.reconnect) {
    const rc = result.reconnect;
    lines.push(`- 재접속 지점: cycle ${rc.cycle}`);
    lines.push(`- cache_read 전/후: ${rc.cacheReadBefore.toLocaleString()} → ${rc.cacheReadAfter.toLocaleString()}`);
    lines.push(`- 히스토리 길이 전/후: ${rc.historyBefore} → ${rc.historyAfter}`);
    lines.push(`- 판정: ${rc.passed ? '✅ 유지됨(끊김 없는 개발 목표 충족)' : '⚠︎ 손실 감지 — 회귀 의심'}`);
  } else {
    lines.push('- (재접속 시뮬이 실행되지 않았습니다. 기본 cycles 값이 2 미만일 때 생략.)');
  }
  lines.push('');
  lines.push('## 스트레스 스텝(언어 토글 10회 + 추천 5회)');
  if (result.stress) {
    const s = result.stress;
    lines.push(`- 주입 지점: cycle ${s.atCycle}`);
    lines.push(`- 언어 토글 ${s.localeToggles}회 소요: ${s.toggleDurationMs}ms`);
    lines.push(`- 추천 요청 ${s.recommendCalls}회 소요: ${s.recommendDurationMs}ms`);
    lines.push(`- input Δ: ${s.inputDelta.toLocaleString()} / cache_read Δ: ${s.cacheReadDelta.toLocaleString()}`);
    lines.push(`- heapUsed 전/후: ${s.heapUsedBeforeMb.toFixed(1)}MB → ${s.heapUsedAfterMb.toFixed(1)}MB (Δ ${s.heapLeakMb.toFixed(2)}MB)`);
    lines.push(`- 판정: ${s.heapLeakMb < 1 ? '✅ 힙 누수 없음(<1MB)' : '⚠︎ 힙 증가 감지 — 재현 후 조사 필요'}`);
  } else {
    lines.push('- (cycles 가 적어 스트레스 스텝이 발동되지 않았습니다.)');
  }
  lines.push('');
  lines.push('## usage 로그 샘플(앞 3줄)');
  lines.push('```');
  for (const l of result.logLines.slice(0, 3)) lines.push(l);
  lines.push('```');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const opts = parseOptions();
  const result = await runProbe(opts);
  const body = renderReport(opts, result);
  if (opts.dry) {
    stdout.write(body);
    return;
  }
  const target = resolve(process.cwd(), opts.out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body, 'utf8');
  const last = result.samples[result.samples.length - 1];
  stdout.write(
    `장기 세션 리포트 기록: ${opts.out} · 모드=${result.mode} · 사이클=${opts.cycles} · hitRate=${last ? last.cacheHit.toFixed(3) : 'N/A'} · 무효화=${result.invalidations}\n`,
  );
}

// `tsx` 로 직접 실행될 때만 main 호출. `import` 로 접근 시(테스트) 부작용 없음.
const isDirect = import.meta.url === `file://${argv[1] ?? ''}` || argv[1]?.endsWith('longSessionProbe.ts');
if (isDirect) {
  main().catch((err) => {
    stdout.write(`[probe 실패] ${(err as Error).message}\n`);
    exit(1);
  });
}

export { runProbe, renderReport, renderAsciiTrend, formatUsageLogLine, fingerprintCachePrefix };
export type { ProbeOptions, Sample };
