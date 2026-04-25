// buildSystemPrompt 가 프로바이더(claude-cli / ollama / vllm) 에 따라 올바른 도구
// 목록·호출 규약을 렌더링하는지 확인한다. 배경: 로컬 ollama 경로에서 Claude CLI
// 전용 도구 이름(Read/Write/Edit 등)이 프롬프트에 남아 있어 qwen2.5 모델이 본문에
// 파이썬 의사 코드를 흘려 쓰는 회귀가 있었다(실사례: Joker 가 add_file("x","y") 를
// content 로 출력해 실제 호출이 실행되지 않음).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Agent, Task, Project } from '../types';
import { buildSystemPrompt, buildTaskPrompt } from './prompts';

const agent: Agent = {
  id: 'a-1',
  name: 'Joker',
  role: 'Developer',
  status: 'idle',
  persona: '',
} as Agent;

const task: Task = {
  id: '01234567-89ab-cdef-0123-456789abcdef',
  projectId: 'p-1',
  assignedTo: agent.id,
  description: '프로젝트 생성 시 설명 기반 최적 팀 추천 + 바로 추가 기능 구현',
  status: 'in-progress',
} as Task;

const project: Project = {
  id: 'p-1',
  name: 'LLMTycoon',
  description: '에이전트 시뮬레이션',
  workspacePath: '/tmp/ws',
  agents: [agent.id],
  status: 'active',
} as Project;

describe('buildSystemPrompt', () => {
  it('claude-cli 경로는 빌트인 도구(Read/Write/Edit/Bash) 블록을 그대로 포함한다', () => {
    const text = buildSystemPrompt(agent, { provider: 'claude-cli' });
    assert.match(text, /\[빌트인 도구\]/);
    assert.match(text, /Read \/ Glob \/ Grep/);
    assert.match(text, /Write \/ Edit/);
    assert.match(text, /Bash/);
  });

  it('기본값(옵션 생략) 은 claude-cli 동작과 동일하다', () => {
    const a = buildSystemPrompt(agent);
    const b = buildSystemPrompt(agent, { provider: 'claude-cli' });
    assert.equal(a, b);
  });

  it('ollama 경로는 Claude CLI 전용 도구 이름을 노출하지 않는다', () => {
    const text = buildSystemPrompt(agent, { provider: 'ollama' });
    // 빌트인 블록 헤더 자체가 없어야 한다.
    assert.doesNotMatch(text, /\[빌트인 도구\]/);
    // "Read", "Write", "Edit", "Bash" 같은 단독 명칭은 모델을 혼란시키므로 금지.
    // (read_file, write_file 등 로컬 도구 이름은 허용되므로 단어 경계로 검사)
    assert.doesNotMatch(text, /(^|[^_\w])Read(\s|\/|,|:)/);
    assert.doesNotMatch(text, /(^|[^_\w])Write(\s|\/|,|:)/);
    assert.doesNotMatch(text, /(^|[^_\w])Edit(\s|\/|,|:)/);
    assert.doesNotMatch(text, /(^|[^_\w])Bash(\s|\/|,|:)/);
  });

  it('ollama 경로는 실제 tool schema 이름을 포함한다', () => {
    const text = buildSystemPrompt(agent, { provider: 'ollama' });
    for (const name of [
      'read_file', 'write_file', 'edit_file', 'list_files_fs', 'grep_files',
      'update_status', 'list_files', 'add_file', 'add_dependency',
    ]) {
      assert.ok(text.includes(name), `로컬 도구 이름 "${name}" 이 프롬프트에 있어야 함`);
    }
  });

  it('ollama 경로는 tool_calls 규약을 명시적으로 못박는다', () => {
    const text = buildSystemPrompt(agent, { provider: 'ollama' });
    // 본문에 도구 이름/의사 코드 쓰지 말라는 규칙이 있어야 함.
    assert.match(text, /tool_calls/);
    assert.match(text, /본문.*(쓰지|적거나|재출력|금지)/);
  });

  it('ollama 경로는 번호 매긴 체크리스트 서술을 쓰지 않는다', () => {
    // 배경: llama3.1:8b 가 "1) update_status... 2) list_files..." 형식을 받으면
    // 실행 대신 그대로 본문에 재출력하는 회귀가 있었다. 번호 체크리스트를 피하고
    // 명령형·단문으로만 표현해야 한다.
    const text = buildSystemPrompt(agent, { provider: 'ollama' });
    assert.doesNotMatch(text, /^\d\)\s/m);
    assert.doesNotMatch(text, /필수 체크리스트/);
  });

  it('ollama 경로는 narration 금지 지시를 포함한다', () => {
    // 서술형("~합니다 / ~작성합니다") 을 감지해 tool_calls 로 전환하라는 가이드가
    // 있어야 한다. 이 문구가 빠지면 작은 모델이 곧바로 narration 으로 빠진다.
    const text = buildSystemPrompt(agent, { provider: 'ollama' });
    assert.match(text, /서술/);
    assert.match(text, /tool_calls/);
  });

  it('ollama 경로는 빈-인자 호출 방지 가드 지시를 포함한다', () => {
    // 배경: llama3.1:8b 가 write_file 에 content:"" 로, edit_file 에 old_string:"" 로,
    // add_dependency 에 빈 ID 로 호출하는 사례가 관측됐다. 서버측 가드와 짝을
    // 이루는 프롬프트 경고가 있어야 한다.
    const text = buildSystemPrompt(agent, { provider: 'ollama' });
    assert.match(text, /write_file.*content.*(빈 문자열|비우)/);
    assert.match(text, /edit_file.*old_string.*(비우|빈)/);
    assert.match(text, /add_dependency.*ID/s);
  });

  it('ollama 경로는 도구 응답을 요약하지 말라는 규칙을 포함한다', () => {
    // 배경: llama3.1:8b 가 list_files_fs 결과를 받으면 영문으로 "This is a list of..."
    // 같은 설명을 뱉고 후속 도구 호출을 안 하는 회귀. 응답 처리 방식을 명시해야 한다.
    const text = buildSystemPrompt(agent, { provider: 'ollama' });
    assert.match(text, /요약.*(대신|말고|금지)|설명.*(대신|말고|금지)/);
    assert.match(text, /(다음에 필요한 도구|곧바로 호출)/);
  });

  it('vllm 경로도 ollama 와 동일한 로컬 분기를 탄다', () => {
    const ollama = buildSystemPrompt(agent, { provider: 'ollama' });
    const vllm = buildSystemPrompt(agent, { provider: 'vllm' });
    // 분기 자체가 isLocal 하나로 통합돼 있어 두 출력이 동일해야 한다.
    assert.equal(ollama, vllm);
  });
});

// 배경: llama3.1:8b 가 list_files_fs 결과를 받으면 후속 도구 호출 대신
// "This is a text file containing a list of files..." 같은 영문 풀어쓰기로 빠지는
// 회귀가 실제로 관측됐다(taskId=cb6fdf69, korean ratio 0.00). 시스템 프롬프트의
// localChecklist 에 같은 규칙이 이미 있지만 8B 모델이 무시해 한 번 더 task 프롬프트
// 말미에 못박는다. 본 테스트는 그 블록의 존재·내용·프로바이더 분기를 보장한다.
describe('buildTaskPrompt — 도구 응답 풀어쓰기 금지 블록', () => {
  it('ollama 경로는 "도구 응답 처리 — 절대 규칙" 블록을 포함한다', () => {
    const text = buildTaskPrompt({ agent, task, project, provider: 'ollama' });
    assert.match(text, /\[도구 응답 처리 — 절대 규칙\]/);
    // 실제 회귀 phrase 가 명시돼 있어야 한다(샘플 매칭으로 모델 attention 강화).
    assert.match(text, /This is a/);
    assert.match(text, /Here's a breakdown/);
    // 후속 도구 호출 강제 문구.
    assert.match(text, /(곧바로|즉시).*(read_file|edit_file|write_file)/);
    // content 비우고 tool_calls 만 돌려주라는 지시.
    assert.match(text, /content.*비우고.*tool_calls/);
  });

  it('vllm 경로도 동일하게 절대 규칙 블록을 포함한다', () => {
    const text = buildTaskPrompt({ agent, task, project, provider: 'vllm' });
    assert.match(text, /\[도구 응답 처리 — 절대 규칙\]/);
  });

  it('claude-cli 경로는 절대 규칙 블록을 추가하지 않는다(CLI 는 회귀 없음)', () => {
    const text = buildTaskPrompt({ agent, task, project, provider: 'claude-cli' });
    assert.doesNotMatch(text, /\[도구 응답 처리 — 절대 규칙\]/);
  });

  it('provider 미지정시 claude-cli 와 동일하게 절대 규칙 블록을 넣지 않는다', () => {
    const text = buildTaskPrompt({ agent, task, project });
    assert.doesNotMatch(text, /\[도구 응답 처리 — 절대 규칙\]/);
  });

  it('블록은 체크리스트 안내 문구 직전(말미) 에 위치해 모델 attention 끝쪽에 놓인다', () => {
    const text = buildTaskPrompt({ agent, task, project, provider: 'ollama' });
    const blockIdx = text.indexOf('[도구 응답 처리 — 절대 규칙]');
    const checklistIdx = text.indexOf('체크리스트 1~7');
    assert.ok(blockIdx >= 0 && checklistIdx >= 0, '두 블록 모두 존재해야 함');
    assert.ok(blockIdx < checklistIdx, '절대 규칙 블록이 체크리스트 안내 앞에 있어야 함');
    // 그리고 절대 규칙 블록은 [새 지시 #...] 보다는 뒤에 와야 한다.
    const directiveIdx = text.indexOf('[새 지시 #');
    assert.ok(directiveIdx < blockIdx, '절대 규칙 블록은 새 지시 블록 뒤에 와야 함');
  });
});
