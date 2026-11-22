import Link from "next/link";
import { getDb } from "@/db";
import { listAssets } from "@/lib/assets";
import { requireUser } from "@/lib/session";

export const metadata = { title: "자산 - 보안관제 포털" };

export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ q?: string; state?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const enabled = sp.state === "on" ? true : sp.state === "off" ? false : undefined;
  const rows = await listAssets(getDb(), { keyword: sp.q?.slice(0, 100), enabled });
  const input = "rounded border border-gray-300 px-2 py-1.5 text-sm";
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">자산</h1>
        {user.role === "admin" && (
          <Link href="/assets/new" className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white">
            자산 등록
          </Link>
        )}
      </div>
      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          검색 (이름·대상·담당자·부서)
          <input name="q" defaultValue={sp.q ?? ""} maxLength={100} className={`${input} block`} />
        </label>
        <label className="text-sm">
          상태
          <select name="state" defaultValue={sp.state ?? ""} className={`${input} block`}>
            <option value="">전체</option>
            <option value="on">점검 사용</option>
            <option value="off">점검 안 함</option>
          </select>
        </label>
        <button className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white">검색</button>
      </form>
      <p className="text-sm text-gray-600">총 {rows.length.toLocaleString("ko-KR")}개</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-300 text-left">
              <th className="py-2 pr-3">자산명</th>
              <th className="pr-3">점검 대상</th>
              <th className="pr-3">담당자</th>
              <th className="pr-3">부서</th>
              <th className="pr-3">중요도</th>
              <th className="pr-3">점검 강도</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="border-b border-gray-100">
                <td className="py-1.5 pr-3">
                  <Link href={`/assets/${a.id}`} className="underline">
                    {a.name}
                  </Link>
                </td>
                <td className="pr-3 break-all">{a.target}</td>
                <td className="pr-3">{a.owner ?? ""}</td>
                <td className="pr-3">{a.department ?? ""}</td>
                <td className="pr-3">{a.importance}</td>
                <td className="pr-3">{a.scanLevel}단계</td>
                <td>{a.enabled ? "사용" : <span className="text-gray-500">안 함</span>}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-gray-500">
                  등록된 자산이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
