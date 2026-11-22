"use client";

import { useActionState } from "react";
import { otpAction, type OtpState } from "./actions";

const initial: OtpState = { error: null };

export function OtpForm() {
  const [state, formAction, pending] = useActionState(otpAction, initial);
  return (
    <form action={formAction} className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium">OTP 6자리 코드</span>
        <input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          maxLength={7}
          required
          autoFocus
          className="mt-1 w-full rounded border border-gray-300 px-3 py-2 tracking-widest"
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
        {pending ? "확인 중…" : "확인"}
      </button>
      <a href="/login" className="block text-center text-sm text-gray-500 underline">
        처음으로
      </a>
    </form>
  );
}
