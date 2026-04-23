// buildSystemPrompt 가 프로바이더(claude-cli / ollama / vllm) 에 따라 올바른 도구
// 목록·호출 규약을 렌더링하는지 확인한다. 배경: 로컬 ollama 경로에서 Claude CLI
// 전용 도구 이름(Read/Write/Edit 등)이 프롬프트에 남아 있어 qwen2.5 모델이 본문에
// 파이썬 의사 코드를 흘려 쓰는 회귀가 있었다(실사례: Joker 가 add_file("x","y") 를
// content 로 출력해 실제 호출이 실행되지 않음).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Agent } from '../types';
import { buildSystemPrompt } from './prompts';

const agent: Agent = {
  id: 'a-1',
  name: 'Joker',
  role: 'Developer',
  status: 'idle',
  persona: '',
} as Agent;

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

  it('ollama 경로는 function-call 규약을 명시적으로 못박는다', () => {
    const text = buildSystemPrompt(agent, { provider: 'ollama' });
    // 본문 텍스트에 의사 코드 금지 규칙이 포함돼야 함.
    assert.match(text, /function-call/);
    assert.match(text, /본문.*(출력하지|쓰지|금지)/);
  });

  it('vllm 경로도 ollama 와 동일한 로컬 분기를 탄다', () => {
    const ollama = buildSystemPrompt(agent, { provider: 'ollama' });
    const vllm = buildSystemPrompt(agent, { provider: 'vllm' });
    // 분기 자체가 isLocal 하나로 통합돼 있어 두 출력이 동일해야 한다.
    assert.equal(ollama, vllm);
  });
});
