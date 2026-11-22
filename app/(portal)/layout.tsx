import Link from "next/link";
import { Suspense } from "react";
import { Icon, type IconName } from "@/components/icons";
import { NotificationBell } from "@/components/notification-bell";
import { CloseButton, MenuButton, SideNav, type NavItem } from "@/components/side-nav";
import { getDb } from "@/db";
import { unreadCount } from "@/lib/notifications";
import { requireUser } from "@/lib/session";
import { logoutAction } from "./actions";

const item = (href: string, label: string, icon: IconName): NavItem => ({ href, label, icon });

const MENU = [
  item("/", "대시보드", "dashboard"),
  item("/indicators", "위협정보", "shield"),
  item("/reports", "보고서", "report"),
  item("/assets", "자산 점검", "server"),
];

const ADMIN_MENU = [
  item("/admin/users", "사용자", "users"),
  item("/admin/sources", "수집 출처", "rss"),
  item("/admin/whitelist", "화이트리스트", "check"),
  item("/admin/siem", "SIEM 연동", "plug"),
  item("/admin/audit", "감사 로그", "log"),
];

async function Shell({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const unread = await unreadCount(getDb());
  const groups = [{ title: "관제", items: MENU }, ...(user.role === "admin" ? [{ title: "관리", items: ADMIN_MENU }] : [])];
  const initial = (user.name.trim()[0] ?? "?").toUpperCase();
  return (
    <div className="min-h-dvh">
      <input id="nav-toggle" type="checkbox" className="peer sr-only" tabIndex={-1} aria-hidden="true" />
      <label htmlFor="nav-toggle" aria-hidden="true" className="fixed inset-0 z-30 hidden bg-black/50 peer-checked:block lg:hidden" />
      <aside
        id="side-drawer"
        className="fixed inset-y-0 left-0 z-40 flex w-64 -translate-x-full flex-col overflow-y-auto bg-[var(--nav-bg)] px-3 py-4 transition-transform duration-200 peer-checked:translate-x-0 lg:translate-x-0 lg:py-5"
      >
        <div className="mb-6 flex items-center justify-between px-2">
          <Link href="/" className="flex items-center gap-2.5 text-white">
            <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--signal)] text-white shadow-[0_0_0_1px_rgb(255_255_255/0.12)_inset]">
              <Icon name="shield" size={20} />
            </span>
            <span className="leading-tight">
              <span className="block font-semibold tracking-tight">보안관제 포털</span>
              <span className="block text-[11px] text-[var(--nav-muted)]">Threat Intel · Asset Scan</span>
            </span>
          </Link>
          <CloseButton />
        </div>
        <SideNav groups={groups} />
        <p className="mt-auto px-3 pt-8 text-[11px] text-[var(--nav-muted)]">v0.3 · 시간은 한국시간(KST)</p>
      </aside>

      <div className="min-w-0 lg:pl-64">
        <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-[var(--line)] bg-[var(--surface)]/90 px-3 py-2 backdrop-blur sm:gap-3 sm:px-6">
          <MenuButton />
          <form action="/indicators" method="get" role="search" className="relative ml-auto hidden max-w-sm flex-1 sm:block">
            <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--ink-soft)]" />
            <input
              name="q"
              type="search"
              maxLength={200}
              placeholder="IP · 도메인 · 해시 검색"
              aria-label="위협정보 검색"
              className="header-search w-full rounded-lg py-2 pr-3 pl-9 text-sm"
            />
          </form>
          <Link href="/indicators" aria-label="위협정보 검색" className="ml-auto inline-flex h-10 w-10 items-center justify-center rounded-lg text-[var(--ink-soft)] hover:bg-black/5 sm:hidden">
            <Icon name="search" size={20} />
          </Link>
          <NotificationBell initial={unread} />
          <div className="flex items-center gap-2 pl-1">
            <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-full bg-[var(--signal-soft)] text-sm font-semibold text-[var(--signal)]">
              {initial}
            </span>
            <span className="hidden text-sm leading-tight md:block">
              <span className="block font-medium">{user.name}</span>
              <span className="block text-xs text-[var(--ink-soft)]">{user.role === "admin" ? "관리자" : "조회 전용"}</span>
            </span>
          </div>
          <form action={logoutAction}>
            <button type="submit" aria-label="로그아웃" title="로그아웃" className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm text-[var(--ink-soft)] hover:bg-black/5">
              <Icon name="logout" size={18} />
              <span className="hidden lg:inline">로그아웃</span>
            </button>
          </form>
        </header>
        <main className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-7">{children}</main>
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
