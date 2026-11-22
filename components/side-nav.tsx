"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { Icon, type IconName } from "@/components/icons";

export type NavItem = { href: string; label: string; icon: IconName };

const TOGGLE_ID = "nav-toggle";

/** 왼쪽 메뉴. 지금 보는 화면을 표시하고, 좁은 화면에서는 메뉴를 고르면 서랍이 닫힌다. */
export function SideNav({ groups }: { groups: { title: string; items: NavItem[] }[] }) {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(href + "/"));

  // 화면 이동 시, 또는 Esc를 누르면 모바일 서랍을 닫는다
  useEffect(() => {
    const box = document.getElementById(TOGGLE_ID) as HTMLInputElement | null;
    if (box) box.checked = false;
  }, [path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const box = document.getElementById(TOGGLE_ID) as HTMLInputElement | null;
      if (box?.checked) box.checked = false;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <nav aria-label="주 메뉴" className="flex flex-col gap-6">
      {groups.map((g) => (
        <div key={g.title}>
          <p className="mb-2 px-3 text-xs font-medium tracking-wide text-[var(--nav-muted)]">{g.title}</p>
          <ul className="flex flex-col gap-1">
            {g.items.map((m) => (
              <li key={m.href}>
                <Link
                  href={m.href}
                  aria-current={isActive(m.href) ? "page" : undefined}
                  className="group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-[var(--nav-text)] transition-colors hover:bg-white/5 hover:text-white aria-[current=page]:bg-[var(--signal)]/15 aria-[current=page]:font-semibold aria-[current=page]:text-white"
                >
                  <span
                    aria-hidden="true"
                    className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r bg-transparent group-aria-[current=page]:bg-[var(--signal-bright)]"
                  />
                  <Icon name={m.icon} className="shrink-0 opacity-80 group-aria-[current=page]:text-[var(--signal-bright)] group-aria-[current=page]:opacity-100" />
                  <span className="truncate">{m.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** 좁은 화면의 메뉴 열기 버튼 */
export function MenuButton() {
  return (
    <button
      type="button"
      aria-label="메뉴 열기"
      aria-controls="side-drawer"
      onClick={() => document.getElementById(TOGGLE_ID)?.click()}
      className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-[var(--ink-soft)] hover:bg-black/5 lg:hidden"
    >
      <Icon name="menu" size={22} />
    </button>
  );
}

/** 서랍 안의 닫기 버튼 */
export function CloseButton() {
  return (
    <button
      type="button"
      aria-label="메뉴 닫기"
      onClick={() => document.getElementById(TOGGLE_ID)?.click()}
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--nav-text)] hover:bg-white/10 lg:hidden"
    >
      <Icon name="close" size={20} />
    </button>
  );
}
