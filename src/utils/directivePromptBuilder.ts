/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 리더 지시(prompt) 를 LLM 에게 전달하기 직전에, 사용자가 첨부한 파일의
 * 추출 텍스트와 이미지(base64) 를 시스템 프롬프트 / 이미지 컨텐츠 블록에
 * 주입하는 순수 함수. 서버 워커가 /api/tasks payload.attachments 를 받아
 * 그대로 호출한다. 파일 I/O · 네트워크 없음 — 호출 측이 이미 fileId 로
 * 본문·이미지를 역참조해 주입한다.
 */

import type { DirectiveAttachment } from '../types';

export interface BuildDirectivePromptOptions {
  instruction: string;
  attachments?: ReadonlyArray<DirectiveAttachment>;
  systemPrompt?: string;
}

export interface BuiltDirectivePrompt {
  system: string;
  user: string;
  images: string[];
}

// 추출 텍스트를 "첨부 <이름>" 헤더로 구분해 한 덩어리로 이어붙인다. 추출본이
// 전혀 없으면 systemPrompt 를 그대로 돌려주어 "첨부 없음" 경로에서 시스템
// 프롬프트가 오염되지 않도록 한다. 이미지 base64 는 순서를 보존해 누적한다
// (멀티 이미지 프롬프트에서 사용자가 첨부한 순서가 LLM 해석 순서와 일치).
export function buildDirectivePrompt(opts: BuildDirectivePromptOptions): BuiltDirectivePrompt {
  const attachments = opts.attachments ?? [];
  const baseSystem = (opts.systemPrompt ?? '').trim();
  const textBlocks: string[] = [];
  const images: string[] = [];

  for (const att of attachments) {
    const extracted = (att.extractedText ?? '').trim();
    if (extracted.length > 0) {
      const header = `[첨부 ${att.name || att.fileId}${att.type ? ` · ${att.type}` : ''}]`;
      textBlocks.push(`${header}\n${extracted}`);
    }
    if (Array.isArray(att.images)) {
      for (const img of att.images) {
        if (typeof img === 'string' && img.length > 0) images.push(img);
      }
    }
  }

  let system = baseSystem;
  if (textBlocks.length > 0) {
    const attachedSection = `첨부파일 본문:\n${textBlocks.join('\n\n')}`;
    system = baseSystem ? `${baseSystem}\n\n---\n${attachedSection}` : attachedSection;
  }

  return {
    system,
    user: opts.instruction,
    images,
  };
}
