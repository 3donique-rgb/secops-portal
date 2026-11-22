import Link from "next/link";
import { getDb } from "@/db";
import { AUDIT_ACTIONS, listAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/session";

export const metadata = { title: "감사 로그 - 보안관제 포털" };

const LABEL: Record<string, string> = {
  login_success: "로그인 성공",
  login_fail: "로그인 실패",
  login_locked: "잠긴 계정 시도/잠김",
  login_ip_denied: "허용되지 않은 IP",
  logout: "로그아웃",
  user_create: "사용자 생성",
  user_role_change: "권한 변경",
  user_unlock: "잠금 해제",
  user_otp_reset: "OTP 초기화",
  ip_add: "허용 IP 추가",
  ip_remove: "허용 IP 삭제",
  whitelist_add: "화이트리스트 추가",
  whitelist_remove: "화이트리스트 삭제",
  report_download: "보고서 내려받기",
  apikey_create: "API 키 발급",
  apikey_revoke: "API 키 폐기",
};

type SP = { action?: string; q?: string; from?: string; to?: string; page?: string };

/** "YYYY-MM-DD"(한국 시간 0시)를 시각으로. 형식이 틀리면 undefined. */
function kstDate(v: string | undefined, plusDays = 0): Date | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Date(d.getTime() + plusDays * 86400000);
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireAdmin();
  const sp = await searchParams;
  const page = Math.max(Number.parseInt(sp.page ?? "1", 10) || 1, 1);
  const action = (AUDIT_ACTIONS as readonly string[]).includes(sp.action ?? "") ? sp.action : undefined;
  const { rows, total, pageSize } = await listAudit(getDb(), {
    action,
    keyword: sp.q?.slice(0, 100),
    from: kstDate(sp.from),
    to: kstDate(sp.to, 1), // 종료일 당일 포함
    page,
    pageSize: 50,
  });
  const pages = Math.max(Math.ceil(total / pageSize), 1);
  const qs = (p: number) => {
    const u = new URLSearchParams();
    if (action) u.set("action", action);
    if (sp.q) u.set("q", sp.q);
    if (sp.from) u.set("from", sp.from);
    if (sp.to) u.set("to", sp.to);
    u.set("page", String(p));
    return `?${u.toString()}`;
  };
  const input = "rounded border border-gray-300 px-2 py-1.5 text-sm";

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">감사 로그</h1>
      <form className="flex flex-wrap items-end gap-3" method="get">
        <label className="text-sm">
          종류
          <select name="action" defaultValue={action ?? ""} className={`${input} block`}>
            <option value="">전체</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {LABEL[a]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          키워드 (아이디·대상·IP)
          <input name="q" defaultValue={sp.q ?? ""} maxLength={100} className={`${input} block`} />
        </label>
        <label className="text-sm">
          시작일
          <input name="from" type="date" defaultValue={sp.from ?? ""} className={`${input} block`} />
        </label>
        <label className="text-sm">
          종료일
          <input name="to" type="date" defaultValue={sp.to ?? ""} className={`${input} block`} />
        </label>
        <button className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white">검색</button>
      </form>

      <p className="text-sm text-gray-600">총 {total.toLocaleString("ko-KR")}건</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-300 text-left">
              <th className="py-2 pr-3">시각 (KST)</th>
              <th className="pr-3">종류</th>
              <th className="pr-3">수행자</th>
              <th className="pr-3">대상</th>
              <th className="pr-3">IP</th>
              <th>상세</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-gray-100 align-top">
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  {r.occurredAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false })}
                </td>
                <td className="pr-3">{LABEL[r.action] ?? r.action}</td>
                <td className="pr-3">{r.username ?? "-"}</td>
                <td className="pr-3 break-all">{r.target ?? "-"}</td>
                <td className="pr-3">{r.ip ?? "-"}</td>
                <td className="break-all text-gray-600">{r.detail ? JSON.stringify(r.detail) : ""}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-gray-500">
                  기록이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3 text-sm">
        {page > 1 && <Link href={qs(page - 1)} className="underline">이전</Link>}
        <span>
          {page} / {pages}
        </span>
        {page < pages && <Link href={qs(page + 1)} className="underline">다음</Link>}
      </div>
    </div>
  );
}
