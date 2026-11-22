import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { requireAdmin } from "@/lib/session";
import { getSource, listRuns } from "@/lib/sources";

export const metadata = { title: "수집 이력 - 보안관제 포털" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fmt = (d: Date) => d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });

export default async function RunsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = getDb();
  const s = await getSource(db, id);
  if (!s) notFound();
  const runs = await listRuns(db, id, 100);
  return (
    <div className="max-w-3xl space-y-4">
      <Link href="/admin/sources" className="text-sm underline">
        ← 수집 출처
      </Link>
      <h1 className="text-xl font-bold">{s.name} 수집 이력</h1>
      <p className="text-sm text-gray-600">최근 100회까지 표시합니다. 마지막 성공: {s.lastSuccessAt ? fmt(s.lastSuccessAt) : "없음"}</p>
      <div className="table-card"><table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-gray-300 text-left">
            <th className="py-2 pr-3">시작 시각 (KST)</th>
            <th className="pr-3">결과</th>
            <th className="pr-3">새 지표</th>
            <th>오류 내용</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-b border-gray-100 align-top">
              <td className="py-1.5 pr-3 whitespace-nowrap">{fmt(r.startedAt)}</td>
              <td className="pr-3">{r.status === "success" ? "성공" : <span className="text-red-600">실패</span>}</td>
              <td className="pr-3">{r.newCount}</td>
              <td className="break-all text-gray-700">{r.errorMessage ?? ""}</td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr>
              <td colSpan={4} className="py-6 text-center text-gray-500">
                아직 수집 기록이 없습니다.
              </td>
            </tr>
          )}
        </tbody>
      </table></div>
    </div>
  );
}
