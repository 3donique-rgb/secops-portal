"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = { href: string; label: string };

/** 왼쪽 메뉴. 지금 보고 있는 화면을 표시한다. */
export function SideNav({ groups }: { groups: { title: string; items: NavItem[] }[] }) {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(href + "/"));
  return (
    <nav aria-label="주 메뉴" className="flex flex-col gap-5">
      {groups.map((g) => (
        <div key={g.title}>
          <p className="mb-1.5 px-3 text-xs font-medium text-[var(--nav-muted)]">{g.title}</p>
          <ul className="flex flex-col gap-0.5">
            {g.items.map((m) => (
              <li key={m.href}>
                <Link
                  href={m.href}
                  aria-current={isActive(m.href) ? "page" : undefined}
                  className="block rounded-md border-l-2 border-transparent px-3 py-2 text-sm text-[var(--nav-text)] hover:bg-white/5 aria-[current=page]:border-[var(--signal)] aria-[current=page]:bg-white/10 aria-[current=page]:font-semibold aria-[current=page]:text-white"
                >
                  {m.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
