"use client";

import { useActionState } from "react";
import type { ToolResult } from "@/lib/tools";

type Action = (prev: ToolResult | null, fd: FormData) => Promise<ToolResult | null>;
export type ToolFormProps = {
  action: Action;
  tool: string;
  targetLabel: string;
  placeholder: string;
  ports?: { preset: string };
  servers?: { id: string; label: string }[];
};

export function ToolForm({ action, tool, targetLabel, placeholder, ports, servers }: ToolFormProps) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <div className="space-y-4">
      <form action={formAction} className="plain-form flex flex-wrap items-end gap-3" aria-busy={pending}>
        <input type="hidden" name="tool" value={tool} />
        <label className="min-w-[14rem] flex-1 text-sm">
          <span className="mb-1 block font-medium">{targetLabel}</span>
          <input name="target" required maxLength={300} placeholder={placeholder} className="w-full rounded-lg border px-3 py-2" autoComplete="off" />
        </label>
        {ports && (
          <label className="min-w-[12rem] flex-1 text-sm">
            <span className="mb-1 block font-medium">포트 (최대 20개)</span>
            <input name="ports" required defaultValue={ports.preset} maxLength={200} className="w-full rounded-lg border px-3 py-2" />
          </label>
        )}
        {servers && (
          <label className="text-sm">
            <span className="mb-1 block font-medium">DNS 서버</span>
            <select name="server" className="rounded-lg border px-3 py-2">
              {servers.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" disabled={pending} className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
          {pending ? "조회 중…" : "조회"}
        </button>
        {ports && (
          <label className="flex basis-full items-start gap-2 text-sm">
            <input type="checkbox" name="confirm" className="mt-1" />
            <span>점검 권한이 있는 대상(우리 조직 자산 또는 허가받은 대상)임을 확인합니다. 연결 시도만 하며 데이터는 보내지 않습니다.</span>
          </label>
        )}
      </form>
      {state && !state.ok && <p role="alert" className="text-sm text-red-600">{state.message}</p>}
      {state?.ok && <Result result={state} />}
    </div>
  );
}

export function Result({ result }: { result: ToolResult }) {
  return (
    <div className="space-y-4">
      {result.sections?.map((s, i) => (
        <section key={i} className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
          <h3 className="font-semibold">{s.title}</h3>
          {s.note && <p className="mt-0.5 text-xs text-[var(--ink-soft)]">{s.note}</p>}
          {s.rows && (
            <dl className="mt-3 grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              {s.rows.map(([k, v], j) => (
                <div key={j} className="contents">
                  <dt className="break-all text-[var(--ink-soft)]">{k}</dt>
                  <dd className="break-all font-mono">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          {s.items && (
            <ul className="mt-3 space-y-1 text-sm">
              {s.items.map((t, j) => (
                <li key={j} className="break-all font-mono">{t}</li>
              ))}
            </ul>
          )}
          {s.text && <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{s.text}</pre>}
        </section>
      ))}
    </div>
  );
}
