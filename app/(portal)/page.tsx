import Link from "next/link";
import { getDb } from "@/db";
import { getDashboard } from "@/lib/dashboard";
import { TYPE_LABEL } from "@/lib/labels";
import { NOTIFICATION_LABEL } from "@/lib/notifications";
import { requireUser } from "@/lib/session";

export const metadata = { title: "대시보드 - 보안관제 포털" };
const fmt = (d: Date | null) => (d ? d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }) : "-");
const n = (v: number) => v.toLocaleString("ko-KR");

function Card({ title, value, sub, href }: { title: string; value: string; sub?: string; href?: string }) {
  const body = (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{title}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      {sub && <div className="mt-1 text-xs text-gray-500">{sub}</div>}
    </div>
  );
  return href ? (
    <Link href={href} className="block hover:bg-gray-50">
      {body}
    </Link>
  ) : (
    body
  );
}

export default async function DashboardPage() {
  await requireUser();
  const d = await getDashboard(getDb());
  const problems = d.sources.filter((s) => s.enabled && (s.stale || s.lastStatus === "fail"));
  return (
    <div className="space-y-8">
      <h1 className="text-xl font-bold">대시보드</h1>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="신규 위협정보 (최근 24시간)" value={n(d.indicators.new24h)} sub={`최근 7일 ${n(d.indicators.new7d)}건`} href="/indicators" />
        <Card title="활성 위협정보" value={n(d.indicators.active)} sub={`전체 ${n(d.indicators.total)}건 · SIEM 제외 ${n(d.indicators.excluded)}건`} href="/indicators?status=active" />
        <Card title="등록 자산" value={n(d.assets.total)} sub={`점검 사용 ${n(d.assets.enabled)}개`} href="/assets" />
        <Card title="읽지 않은 알림" value={n(d.notifications.unread)} href="/notifications?filter=unread" />
      </section>

      <section>
        <h2 className="mb-2 font-semibold">활성 위협정보 종류별</h2>
        <div className="flex flex-wrap gap-3 text-sm">
          {Object.entries(TYPE_LABEL).map(([t, label]) => (
            <Link key={t} href={`/indicators?type=${t}&status=active`} className="rounded border border-gray-200 px-3 py-1.5 hover:bg-gray-50">
              {label} <b>{n(d.indicators.byType[t] ?? 0)}</b>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 font-semibold">수집 상태</h2>
        {problems.length > 0 && (
          <p className="mb-2 rounded bg-red-50 p-3 text-sm text-red-800">
            확인이 필요한 출처 {problems.length}곳: {problems.map((s) => s.name).join(", ")}
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-300 text-left">
                <th className="py-2 pr-3">제공 기관</th>
                <th className="pr-3">마지막 성공</th>
                <th className="pr-3">최근 결과</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {d.sources.map((s) => (
                <tr key={s.id} className="border-b border-gray-100 align-top">
                  <td className="py-1.5 pr-3">{s.name}</td>
                  <td className="pr-3 whitespace-nowrap">{fmt(s.lastSuccessAt)}</td>
                  <td className="pr-3">{s.lastStatus === null ? "-" : s.lastStatus === "success" ? "성공" : <span className="text-red-600">실패: {s.lastError}</span>}</td>
                  <td>{!s.enabled ? <span className="text-gray-500">사용 안 함</span> : s.stale ? <span className="text-red-600">지연</span> : "정상"}</td>
                </tr>
              ))}
              {d.sources.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-gray-500">
                    등록된 수집 출처가 없습니다. 관리자 메뉴의 “수집 출처”에서 추가하세요.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 font-semibold">최근 알림</h2>
        <ul className="divide-y divide-gray-100 border-y border-gray-200 text-sm">
          {d.notifications.recent.map((x) => (
            <li key={x.id} className={`py-2 ${x.read ? "text-gray-500" : ""}`}>
              <span className="mr-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs">{NOTIFICATION_LABEL[x.kind] ?? x.kind}</span>
              <Link href={`/assets/${x.assetId}`} className="underline">
                {x.assetName}
              </Link>{" "}
              — {x.message} <span className="text-xs text-gray-500">({fmt(x.occurredAt)})</span>
            </li>
          ))}
          {d.notifications.recent.length === 0 && <li className="py-4 text-center text-gray-500">최근 7일간 알림이 없습니다.</li>}
        </ul>
      </section>
    </div>
  );
}
