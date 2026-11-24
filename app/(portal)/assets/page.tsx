import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/components/icons";
import { SelectAll } from "@/components/select-all";
import { ACTIONS_URL, MAX_MANUAL } from "@/lib/scan-dispatch";
import { requestScanAction } from "./actions";
import { getDb } from "@/db";
import { Pagination } from "@/components/pagination";
import { RiskBadge } from "@/components/risk-badge";
import { listAssetsPage } from "@/lib/assets";
import { assessRisk } from "@/lib/risk";
import { latestScans } from "@/lib/scan-history";
import { parsePage, parsePageSize, totalPages } from "@/lib/pagination";
import { requireUser } from "@/lib/session";

export const metadata = { title: "자산 - 보안관제 포털" };

export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ q?: string; state?: string; page?: string; size?: string }> }) {
  const user = await requireUser();
  const admin = user.role === "admin";
  const sp = await searchParams;
  const enabled = sp.state === "on" ? true : sp.state === "off" ? false : undefined;
  const db = getDb();
  const filter = { keyword: sp.q?.slice(0, 100), enabled };
  const size = parsePageSize(sp.size, 10);
  const page = parsePage(sp.page);
  const first = await listAssetsPage(db, filter, { page, pageSize: size });
  const pages = totalPages(first.total, size);
  // 마지막 쪽보다 큰 번호를 입력하면 마지막 쪽을 보여 준다
  const { rows, total } = page > pages ? await listAssetsPage(db, filter, { page: pages, pageSize: size }) : first;
  const curPage = Math.min(page, pages);
  const scans = await latestScans(db, rows.map((r) => r.id));
  const now = new Date();
  const baseParams: [string, string][] = [];
  if (filter.keyword) baseParams.push(["q", filter.keyword]);
  if (sp.state === "on" || sp.state === "off") baseParams.push(["state", sp.state]);
  const input = "rounded border border-gray-300 px-2 py-1.5 text-sm";
  const tableEl = (
      <div className="table-card">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-300 text-left">
              {admin && (
                <th className="w-10">
                  <SelectAll name="ids" label="전체 선택" />
                </th>
              )}
              <th className="py-2 pr-3">자산명</th>
              <th className="pr-3">위험등급</th>
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
                {admin && (
                  <td>
                    <input type="checkbox" name="ids" value={a.id} disabled={!a.enabled} aria-label={`${a.name} 선택`} className="h-4 w-4" />
                  </td>
                )}
                <td className="py-1.5 pr-3">
                  <Link href={`/assets/${a.id}`} className="underline">
                    {a.name}
                  </Link>
                </td>
                <td className="pr-3"><RiskBadge risk={assessRisk(scans.get(a.id) ?? null, now)} /></td>
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
                <td colSpan={admin ? 9 : 8} className="py-6 text-center text-gray-500">
                  등록된 자산이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
  );
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
        <input type="hidden" name="size" value={size} />
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
      {admin ? (
        <ActionForm action={requestScanAction} className="plain-form space-y-3" confirmText="선택한 자산을 지금 점검합니다. 점검은 GitHub 서버에서 실행되며 대상 장비에 접속 시도가 발생합니다. 진행할까요?">
          <div className="flex flex-wrap items-center gap-3">
            <button className="bg-gray-900 inline-flex items-center gap-2 text-sm">
              <Icon name="trend" size={16} />
              선택한 자산 지금 점검
            </button>
            <p className="text-sm text-gray-600">
              체크한 자산을 바로 점검합니다 (한 번에 최대 {MAX_MANUAL}개, 점검 사용 중인 자산만. 전체 선택은 지금 보이는 쪽만 선택합니다)
            </p>
          </div>
          <p className="text-xs text-gray-500">
            결과는 보통 2~10분 뒤 각 자산 화면에 나타납니다. 진행 상황은{" "}
            <a href={ACTIONS_URL} target="_blank" rel="noopener noreferrer">
              GitHub 점검 실행 기록
            </a>
            에서 볼 수 있습니다.
            {!process.env.GITHUB_DISPATCH_TOKEN && " (버튼을 쓰려면 먼저 docs/usage.md의 '수동 점검 설정'을 따라 GITHUB_DISPATCH_TOKEN을 등록하세요.)"}
          </p>
      {tableEl}
        </ActionForm>
      ) : (
        <>
          {tableEl}
        </>
      )}
      <Pagination page={curPage} total={total} size={size} baseParams={baseParams} />
    </div>
  );
}
