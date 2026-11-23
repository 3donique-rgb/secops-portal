"use client";

import { useActionState } from "react";

export type ActionState = { ok: boolean; message: string } | null;
type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/** 서버 동작을 실행하고 결과 메시지를 보여 주는 폼. confirmText가 있으면 실행 전에 확인을 받는다. */
export function ActionForm({
  action,
  children,
  className,
  confirmText,
  id,
}: {
  action: Action;
  children: React.ReactNode;
  className?: string;
  confirmText?: string;
  id?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form
      id={id}
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirmText && !window.confirm(confirmText)) e.preventDefault();
      }}
      aria-busy={pending}
    >
      {children}
      {state && (
        <p role="status" className={`mt-1 text-sm ${state.ok ? "text-green-700" : "text-red-600"}`}>
          {state.message}
        </p>
      )}
    </form>
  );
}
