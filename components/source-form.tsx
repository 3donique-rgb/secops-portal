"use client";

import { useState } from "react";
import { ActionForm, type ActionState } from "./action-form";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;
type Initial = { id?: string; name: string; kind: string; url: string; config: string; enabled: boolean; hasKey: boolean };

const HELP: Record<string, string> = {
  api: "API/목록 파일: format 은 text(한 줄에 값 하나) · json · csv. json 은 itemsPath·valueFields, csv 는 columns 가 필요합니다.",
  html: "게시판: linkSelector(목록에서 글 링크를 고르는 CSS 선택자), contentSelector(본문 영역)를 적습니다.",
  pdf: "보고서 PDF: 목록 페이지 주소(또는 PDF 주소 하나)를 넣고 필요하면 linkSelector 를 적습니다.",
};
const TEMPLATES: Record<string, string> = {
  api: '{\n  "format": "text",\n  "mode": "lines"\n}',
  html: '{\n  "linkSelector": "a.post-link",\n  "contentSelector": ".post-content",\n  "maxPosts": 20\n}',
  pdf: '{\n  "linkSelector": "a[href]",\n  "maxPdfs": 5\n}',
};

export function SourceForm({ action, initial, submitLabel }: { action: Action; initial: Initial; submitLabel: string }) {
  const [kind, setKind] = useState(initial.kind);
  const [config, setConfig] = useState(initial.config);
  const input = "mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm";
  return (
    <ActionForm action={action} className="space-y-3">
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          제공 기관명 (필수)
          <input name="name" required maxLength={100} defaultValue={initial.name} className={input} />
        </label>
        <label className="text-sm">
          수집 방식
          <select
            name="kind"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              if (!initial.id) setConfig(TEMPLATES[e.target.value]);
            }}
            className={input}
          >
            <option value="api">API / 목록 파일</option>
            <option value="html">게시판(웹 페이지)</option>
            <option value="pdf">보고서(PDF)</option>
          </select>
        </label>
      </div>
      <label className="block text-sm">
        주소
        <input name="url" required maxLength={2000} defaultValue={initial.url} placeholder="https://..." className={input} />
      </label>
      <label className="block text-sm">
        설정 (JSON)
        <textarea name="config" rows={6} value={config} onChange={(e) => setConfig(e.target.value)} className={`${input} font-mono`} spellCheck={false} />
      </label>
      <p className="text-xs text-gray-500">{HELP[kind]}</p>
      <label className="block text-sm">
        API 키 (필요한 기관만)
        <input name="apiKey" type="password" autoComplete="new-password" maxLength={2000} placeholder={initial.hasKey ? "등록됨 — 바꿀 때만 입력" : "없음"} className={input} />
      </label>
      {initial.hasKey && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="clearApiKey" /> 저장된 API 키 삭제
        </label>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="enabled" defaultChecked={initial.enabled} /> 사용 (체크하면 매시간 수집)
      </label>
      <button type="submit" className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white">
        {submitLabel}
      </button>
    </ActionForm>
  );
}
