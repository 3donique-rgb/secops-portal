import Link from "next/link";
import { Suspense } from "react";
import { NotificationBell } from "@/components/notification-bell";
import { SideNav } from "@/components/side-nav";
import { getDb } from "@/db";
import { unreadCount } from "@/lib/notifications";
import { requireUser } from "@/lib/session";
import { logoutAction } from "./actions";

const MENU = [
  { href: "/", label: "대시보드" },
  { href: "/indicators", label: "위협정보" },
  { href: "/reports", label: "보고서" },
  { href: "/assets", label: "자산" },
];

const ADMIN_MENU = [
  { href: "/admin/users", label: "사용자" },
  { href: "/admin/sources", label: "수집 출처" },
  { href: "/admin/whitelist", label: "화이트리스트" },
  { href: "/admin/siem", label: "SIEM 연동" },
  { href: "/admin/audit", label: "감사 로그" },
];

async function Shell({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const unread = await unreadCount(getDb());
  const groups = [{ title: "관제", items: MENU }, ...(user.role === "admin" ? [{ title: "관리", items: ADMIN_MENU }] : [])];
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[232px_1fr]">
      <aside className="bg-[var(--nav-bg)] px-3 py-4 lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto lg:py-6">
        <Link href="/" className="mb-4 flex items-center gap-2.5 px-3 text-white lg:mb-8">
          <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-md bg-[var(--signal)] text-sm font-bold">
            S
          </span>
          <span className="font-semibold tracking-tight">보안관제 포털</span>
        </Link>
        <SideNav groups={groups} />
      </aside>
      <div className="min-w-0">
        <header className="flex items-center justify-end gap-3 border-b border-[var(--line)] bg-[var(--surface)] px-6 py-2.5">
          <NotificationBell initial={unread} />
          <span className="text-sm text-[var(--ink-soft)]">
            {user.name}
            <span className="ml-1.5 rounded bg-[var(--signal-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--signal)]">
              {user.role === "admin" ? "관리자" : "조회"}
            </span>
          </span>
          <form action={logoutAction}>
            <button type="submit" className="rounded-md px-2.5 py-1.5 text-sm text-[var(--ink-soft)] hover:bg-black/5">
              로그아웃
            </button>
          </form>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-7">{children}</main>
      </div>
    </div>
  );
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-[var(--ink-soft)]">불러오는 중…</p>}>
      <Shell>{children}</Shell>
    </Suspense>
  );
}
