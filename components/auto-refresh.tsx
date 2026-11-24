"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/** 화면을 보고 있는 동안 일정 간격(기본 10분)마다 서버 데이터를 다시 불러온다. 입력 중인 화면에는 쓰지 않는다. */
export function AutoRefresh({ minutes = 10 }: { minutes?: number }) {
  const router = useRouter();
  const last = useRef(0);
  useEffect(() => {
    const ms = minutes * 60_000;
    last.current = Date.now();
    const run = () => {
      last.current = Date.now();
      router.refresh();
    };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") run();
    }, ms);
    // 탭을 숨겨 둔 사이 시간이 지났다면, 다시 볼 때 바로 갱신
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - last.current >= ms) run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [minutes, router]);
  return null;
}
