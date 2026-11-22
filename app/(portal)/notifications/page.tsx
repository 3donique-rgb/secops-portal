import Link from "next/link";
import { getDb } from "@/db";
import { NOTIFICATION_LABEL, listNotifications } from "@/lib/notifications";
import { requireUser } from "@/lib/session";
import { markAllReadAction, markReadAction } from "./actions";

export const metadata = { title: "알림 - 보안관제 포털" };
const fmt = (d: Date) => d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ filter?: string; page?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  const unreadOnly = sp.filter === "unread";
  const page = Math.max(Number.parseInt(sp.page ?? "1", 10) || 1, 1);
  const { rows, total, pageSize } = await listNotifications(getDb(), { unreadOnly, page, pageSize: 50 });
  const pages = Math.max(Math.ceil(total / pageSize), 1);
  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">알림</h1>
        <form action={markAllReadAction}>
          <button className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50">모두 읽음</button>
        </form>
      </div>
      <div className="flex gap-3 text-sm">
        <Link href="/notifications" className={unreadOnly ? "underline" : "font-bold"}>
          전체
        </Link>
        <Link href="/notifications?filter=unread" className={unreadOnly ? "font-bold" : "underline"}>
          읽지 않음
        </Link>
        <span className="text-gray-500">총 {total.toLocaleString("ko-KR")}건</span>
      </div>
      <ul className="divide-y divide-gray-100 border-y border-gray-200">
        {rows.map((n) => (
          <li key={n.id} className={`flex items-start justify-between gap-3 py-2 text-sm ${n.read ? "text-gray-500" : ""}`}>
            <div>
              <div>
                <span className={`mr-2 rounded px-1.5 py-0.5 text-xs ${n.read ? "bg-gray-100" : "bg-red-100 text-red-800"}`}>{NOTIFICATION_LABEL[n.kind] ?? n.kind}</span>
                <Link href={`/assets/${n.assetId}`} className="underline">
                  {n.assetName}
                </Link>
              </div>
              <div className="mt-0.5">{n.message}</div>
              <div className="text-xs text-gray-500">{fmt(n.occurredAt)}</div>
            </div>
            {!n.read && (
              <form action={markReadAction}>
                <input type="hidden" name="id" value={n.id} />
                <button className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">읽음</button>
              </form>
            )}
          </li>
        ))}
        {rows.length === 0 && <li className="py-6 text-center text-sm text-gray-500">알림이 없습니다.</li>}
      </ul>
      <div className="flex items-center gap-3 text-sm">
        {page > 1 && <Link href={`?${unreadOnly ? "filter=unread&" : ""}page=${page - 1}`} className="underline">이전</Link>}
        <span>
          {page} / {pages}
        </span>
        {page < pages && <Link href={`?${unreadOnly ? "filter=unread&" : ""}page=${page + 1}`} className="underline">다음</Link>}
      </div>
    </div>
  );
}
