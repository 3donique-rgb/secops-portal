"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "./actions";

const initial: LoginState = { error: null };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initial);
  return (
    <form action={formAction} className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium">아이디</span>
        <input
          name="username"
          autoComplete="username"
          required
          maxLength={64}
          className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium">비밀번호</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={256}
          className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
        />
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded bg-gray-900 px-3 py-2 text-white disabled:opacity-50"
      >
        {pending ? "확인 중…" : "로그인"}
      </button>
    </form>
  );
}
