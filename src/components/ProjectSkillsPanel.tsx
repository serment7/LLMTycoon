// 지시 #6fd99c90 — 프로젝트 관리 메뉴의 "스킬 설정" 패널.
//
// 화면 개요
//   · 상단 scope 토글: local(이 프로젝트) / global(모든 프로젝트 공통)
//   · 신규 스킬 입력 폼(이름·설명·프롬프트) + 검증 메시지
//   · 현재 scope 의 스킬 목록 + 삭제 버튼
//
// 스토어는 singleton(addProjectSkill 등) 을 기본 경로로 쓰되, 테스트는 prop 으로
// 독립 인스턴스를 주입할 수 있게 열어 둔다.

import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Sparkles, Globe2, FolderGit2 } from 'lucide-react';
import {
  addProjectSkill,
  listProjectSkills,
  listGlobalSkills,
  removeProjectSkill,
  subscribeProjectSkills,
  validateSkillInput,
  type SkillRecord,
  type SkillScope,
  type SkillValidationError,
  type ProjectSkillsStore,
} from '../stores/projectSkillsStore';

interface Props {
  projectId: string;
  /** 테스트 주입용. 미지정 시 싱글턴 편의 API 를 사용. */
  store?: ProjectSkillsStore;
  onLog?: (message: string) => void;
}

const focusRing = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pixel-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black';

export function ProjectSkillsPanel({ projectId, store, onLog }: Props) {
  const [scope, setScope] = useState<SkillScope>('local');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [errors, setErrors] = useState<SkillValidationError[]>([]);
  const [items, setItems] = useState<SkillRecord[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // 싱글턴 편의 API 의 기본 구독 경로. store prop 이 들어오면 그걸 우선 사용.
  const api = useMemo(() => {
    if (store) {
      return {
        add: store.add.bind(store),
        remove: (id: string) => store.remove(id),
        list: (pid: string, s: SkillScope) => s === 'global' ? store.listGlobal() : store.list(pid),
        subscribe: (pid: string, l: () => void) => store.subscribe(pid, l),
      };
    }
    return {
      add: addProjectSkill,
      remove: removeProjectSkill,
      list: (pid: string, s: SkillScope) => s === 'global' ? listGlobalSkills() : listProjectSkills(pid),
      subscribe: (pid: string, l: () => void) => subscribeProjectSkills(pid, l),
    };
  }, [store]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await api.list(projectId, scope);
        if (!cancelled) setItems(next);
      } catch (err) {
        if (!cancelled) onLog?.(`스킬 목록 로드 실패: ${(err as Error).message}`);
      }
    }
    load();
    // local 구독은 프로젝트 기반, global 구독은 빈 키 기반(store 내부에서 __global__ 로 승격).
    const subKey = scope === 'global' ? '' : projectId;
    const unsub = api.subscribe(subKey, () => { load(); });
    return () => { cancelled = true; unsub(); };
  }, [projectId, scope, api, onLog]);

  const submit = async () => {
    const input = { scope, projectId, name, description, prompt };
    const found = validateSkillInput(input);
    setErrors(found);
    if (found.length > 0) return;
    setSubmitting(true);
    try {
      await api.add(input);
      setName(''); setDescription(''); setPrompt('');
      onLog?.(`스킬 추가: [${scope}] ${input.name.trim()}`);
    } catch (err) {
      onLog?.(`스킬 추가 실패: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const onRemove = async (rec: SkillRecord) => {
    if (!confirm(`"${rec.name}" 스킬을 삭제할까요?`)) return;
    try {
      await api.remove(rec.id);
      onLog?.(`스킬 삭제: [${rec.scope}] ${rec.name}`);
    } catch (err) {
      onLog?.(`스킬 삭제 실패: ${(err as Error).message}`);
    }
  };

  return (
    <section aria-labelledby="project-skills-heading" data-testid="project-skills-panel">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 id="project-skills-heading" className="text-lg font-bold text-[var(--pixel-accent)] uppercase tracking-wider flex items-center gap-2">
            <Sparkles size={16} aria-hidden /> 스킬 설정
          </h2>
          <span className="text-[10px] text-white/60 uppercase tracking-wider">
            {scope === 'local' ? '프로젝트 전용' : '모든 프로젝트 공통'}
          </span>
        </div>
        <div role="tablist" aria-label="스킬 스코프 선택" className="flex items-center gap-1 bg-black/30 border-2 border-[var(--pixel-border)] p-1">
          <button
            role="tab"
            aria-selected={scope === 'local'}
            onClick={() => setScope('local')}
            className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider flex items-center gap-1 transition ${scope === 'local' ? 'bg-[var(--pixel-accent)] text-black' : 'text-white/70 hover:text-white'} ${focusRing}`}
          >
            <FolderGit2 size={12} aria-hidden /> 로컬
          </button>
          <button
            role="tab"
            aria-selected={scope === 'global'}
            onClick={() => setScope('global')}
            className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider flex items-center gap-1 transition ${scope === 'global' ? 'bg-[var(--pixel-accent)] text-black' : 'text-white/70 hover:text-white'} ${focusRing}`}
          >
            <Globe2 size={12} aria-hidden /> 전역
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="space-y-2">
          <label className="block text-[10px] uppercase tracking-wider text-white/70">이름</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="스킬 이름"
            placeholder="예: 리팩터 전문가"
            className={`w-full bg-black/30 border-2 border-[var(--pixel-border)] px-3 py-2 text-[12px] text-white ${focusRing}`}
            maxLength={64}
          />
          <label className="block text-[10px] uppercase tracking-wider text-white/70 pt-2">설명</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-label="스킬 설명"
            placeholder="간단한 용도 한 줄"
            className={`w-full bg-black/30 border-2 border-[var(--pixel-border)] px-3 py-2 text-[12px] text-white ${focusRing}`}
            maxLength={200}
          />
        </div>
        <div className="space-y-2">
          <label className="block text-[10px] uppercase tracking-wider text-white/70">프롬프트 본문</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            aria-label="스킬 프롬프트"
            placeholder="에이전트 시스템 프롬프트에 주입될 본문"
            rows={6}
            className={`w-full bg-black/30 border-2 border-[var(--pixel-border)] px-3 py-2 text-[12px] text-white font-mono ${focusRing}`}
          />
        </div>
      </div>

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
          aria-label="스킬 추가"
          className={`px-3 py-2 bg-[var(--pixel-accent)] text-black text-[11px] font-bold uppercase border-b-2 border-[#0099cc] flex items-center gap-2 hover:brightness-110 active:translate-y-px transition disabled:opacity-40 ${focusRing}`}
        >
          <Plus size={14} /> 스킬 추가
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {items.length === 0 && (
          <p className="col-span-full text-[11px] text-white/50 italic">
            {scope === 'local' ? '이 프로젝트의 로컬 스킬이 없습니다.' : '등록된 전역 스킬이 없습니다.'}
          </p>
        )}
        {items.map((rec) => (
          <article key={rec.id} className="bg-[#0f3460] border-2 border-[var(--pixel-border)] p-3 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-bold text-[var(--pixel-accent)] truncate">{rec.name}</h4>
              <p className="text-[11px] text-white/70 mt-1">{rec.description || '(설명 없음)'}</p>
              <pre className="text-[10px] text-white/60 mt-2 whitespace-pre-wrap break-words font-mono max-h-24 overflow-auto">
                {rec.prompt}
              </pre>
            </div>
            <button
              onClick={() => onRemove(rec)}
              aria-label={`${rec.name} 스킬 삭제`}
              className={`p-1.5 bg-red-900/20 border-2 border-red-900/60 hover:bg-red-900 text-red-300 hover:text-white transition-colors ${focusRing}`}
              title="삭제"
            >
              <Trash2 size={12} />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
