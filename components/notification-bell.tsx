"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const INTERVAL_MS = 60_000;

/** 상단 종: 화면을 열어 둔 동안 1분마다 읽지 않은 알림 개수를 확인한다 (탭이 숨겨져 있으면 쉬고, 다시 보이면 바로 확인). */
export function NotificationBell({ initial }: { initial: number }) {
  const [unread, setUnread] = useState(initial);
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch("/notifications/count", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { unread?: number };
        if (!stopped && typeof data.unread === "number") setUnread(data.unread);
      } catch {
        /* 네트워크 오류는 다음 주기에 다시 시도 */
      }
    };
    const timer = setInterval(check, INTERVAL_MS);
    const onVisible = () => !document.hidden && check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return (
    <Link href="/notifications" aria-label={unread > 0 ? `알림 ${unread}건` : "알림"} title="알림" className="relative inline-flex h-10 w-10 items-center justify-center rounded-md text-[var(--ink-soft)] hover:bg-black/5">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
        <path d="M10.3 20a2 2 0 0 0 3.4 0" />
      </svg>
      {unread > 0 && (
        <span className="absolute top-0.5 right-0 min-w-4 rounded-full bg-[var(--bad)] px-1 text-center text-[10px] leading-4 text-white">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
