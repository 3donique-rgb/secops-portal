import Link from "next/link";
import { Suspense } from "react";
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
  return (
    <div className="min-h-screen">
      <header className="border-b border-gray-200">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <Link href="/" className="font-bold">
            보안관제 포털
          </Link>
          <nav className="flex flex-1 flex-wrap items-center gap-4 text-sm">
            {MENU.map((m) => (
              <Link key={m.href} href={m.href} className="hover:underline">
                {m.label}
              </Link>
            ))}
            {user.role === "admin" && (
              <>
                <span className="text-gray-300">|</span>
                {ADMIN_MENU.map((m) => (
                  <Link key={m.href} href={m.href} className="hover:underline">
                    {m.label}
                  </Link>
                ))}
              </>
            )}
          </nav>
          <Link href="/notifications" aria-label="알림" title="알림" className="text-lg">
            🔔
          </Link>
          <span className="text-sm text-gray-600">
            {user.name} ({user.role === "admin" ? "관리자" : "조회"})
          </span>
          <form action={logoutAction}>
            <button type="submit" className="text-sm underline">
              로그아웃
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-gray-500">불러오는 중…</p>}>
      <Shell>{children}</Shell>
    </Suspense>
  );
}
