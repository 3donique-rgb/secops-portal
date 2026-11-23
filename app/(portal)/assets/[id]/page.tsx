import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { ActionForm } from "@/components/action-form";
import { SCAN_LEVELS, getAsset } from "@/lib/assets";
import { compareScans, getScan, listScanHistory } from "@/lib/scan-history";
import { requireUser } from "@/lib/session";
import { deleteAssetAction } from "../actions";

export const metadata = { title: "자산 상세 - 보안관제 포털" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fmt = (d: Date) => d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });

const STATUS = {
  success: { label: "정상", color: "var(--ok)", bg: "var(--ok-soft)" },
  partial: { label: "일부만 점검", color: "var(--warn)", bg: "var(--warn-soft)" },
  fail: { label: "실패", color: "var(--bad)", bg: "var(--bad-soft)" },
} as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function Badge({ status }: { status: keyof typeof STATUS }) {
  const s = STATUS[status];
  return (
    <span className="rounded px-1.5 py-0.5 text-xs font-medium" style={{ color: s.color, background: s.bg }}>
      {s.label}
    </span>
  );
}

export default async function AssetDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ date?: string; from?: string; to?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = getDb();
  const a = await getAsset(db, id);
  if (!a) notFound();
  const sp = await searchParams;
  const history = await listScanHistory(db, id);
  const shownDate = sp.date && DATE.test(sp.date) ? sp.date : history[0]?.scanDate;
  const shown = shownDate ? await getScan(db, id, shownDate) : null;
  const fromRow = sp.from && DATE.test(sp.from) ? await getScan(db, id, sp.from) : null;
  const toRow = sp.to && DATE.test(sp.to) ? await getScan(db, id, sp.to) : null;
  const cmp = fromRow && toRow ? compareScans(fromRow, toRow) : null;
  const now = new Date();
  const daysLeft = shown?.certExpiresAt ? Math.floor((shown.certExpiresAt.getTime() - now.getTime()) / 86400000) : null;
  return (
    <div className="max-w-4xl space-y-6">
      <Link href="/assets" className="text-sm underline">
        ← 자산 목록
      </Link>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{a.name}</h1>
        {user.role === "admin" && (
          <div className="flex items-start gap-2">
            <Link href={`/assets/${id}/edit`} className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50">
              수정
            </Link>
            <ActionForm action={deleteAssetAction} confirmText={`"${a.name}" 자산을 삭제할까요? 점검 결과와 알림도 함께 삭제되며 되돌릴 수 없습니다.`}>
              <input type="hidden" name="id" value={id} />
              <button className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50">삭제</button>
            </ActionForm>
          </div>
        )}
      </div>
      <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
        <dt className="text-gray-500">점검 대상</dt>
        <dd className="break-all">{a.target}</dd>
        <dt className="text-gray-500">담당자</dt>
        <dd>{a.owner ?? "-"}</dd>
        <dt className="text-gray-500">부서</dt>
        <dd>{a.department ?? "-"}</dd>
        <dt className="text-gray-500">중요도</dt>
        <dd>{a.importance} / 5</dd>
        <dt className="text-gray-500">점검 강도</dt>
        <dd>{SCAN_LEVELS[a.scanLevel]}</dd>
        <dt className="text-gray-500">상태</dt>
        <dd>{a.enabled ? "점검 사용" : "점검 안 함"}</dd>
        <dt className="text-gray-500">점검 허가</dt>
        <dd>확인됨</dd>
        <dt className="text-gray-500">등록일</dt>
        <dd>{fmt(a.createdAt)}</dd>
        {a.memo && (
          <>
            <dt className="text-gray-500">메모</dt>
            <dd className="whitespace-pre-wrap">{a.memo}</dd>
          </>
        )}
      </dl>
      <section className="rounded-xl border border-[var(--line)] bg-[var(--surface)]">
        <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-3">
          <h2 className="text-sm font-semibold">점검 결과{shown ? ` · ${shown.scanDate}` : ""}</h2>
          {shown && <Badge status={shown.status} />}
        </div>
        {!shown ? (
          <p className="px-5 py-8 text-center text-sm text-[var(--ink-soft)]">
            아직 점검 결과가 없습니다. 점검은 매일 새벽에 자동으로 실행되며, “자산점검” 작업을 수동으로 실행할 수도 있습니다.
          </p>
        ) : (
          <div className="space-y-5 px-5 py-4 text-sm">
            {shown.errorMessage && <p className="rounded-md px-3 py-2" style={{ background: STATUS[shown.status].bg, color: STATUS[shown.status].color }}>{shown.errorMessage}</p>}
            <div className="grid gap-x-8 gap-y-1 sm:grid-cols-3">
              <p><span className="text-[var(--ink-soft)]">점검 강도 </span>{shown.scanLevel}단계</p>
              <p><span className="text-[var(--ink-soft)]">소요 시간 </span>{shown.durationSec ?? 0}초</p>
              <p>
                <span className="text-[var(--ink-soft)]">인증서 만료 </span>
                {shown.certExpiresAt ? (
                  <span style={daysLeft !== null && daysLeft <= 30 ? { color: "var(--bad)", fontWeight: 600 } : undefined}>
                    {shown.certExpiresAt.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })} ({daysLeft! < 0 ? `${-daysLeft!}일 지남` : `${daysLeft}일 남음`})
                  </span>
                ) : (
                  "-"
                )}
              </p>
            </div>
            <div>
              <h3 className="mb-1.5 font-medium">열린 포트 {shown.openPorts.length}개</h3>
              {shown.openPorts.length === 0 ? (
                <p className="text-[var(--ink-soft)]">열린 포트가 없습니다.</p>
              ) : (
                <div className="table-card"><table className="w-full text-sm">
                  <thead><tr className="text-left"><th>포트</th><th>서비스</th><th>버전·배너</th></tr></thead>
                  <tbody>
                    {shown.openPorts.map((p) => (
                      <tr key={`${p.protocol}${p.port}`}>
                        <td className="font-medium">{p.port}/{p.protocol}</td>
                        <td>{p.service ?? "-"}</td>
                        <td className="break-all text-[var(--ink-soft)]">{p.version ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </div>
            {shown.scanLevel >= 4 && (
              <div>
                <h3 className="mb-1.5 font-medium">노출 페이지 {shown.exposedPages.length}개</h3>
                {shown.exposedPages.length === 0 ? (
                  <p className="text-[var(--ink-soft)]">확인된 노출 페이지가 없습니다.</p>
                ) : (
                  <div className="table-card"><table className="w-full text-sm">
                    <thead><tr className="text-left"><th>경로</th><th>종류</th><th>응답</th></tr></thead>
                    <tbody>
                      {shown.exposedPages.map((p) => (
                        <tr key={p.path}><td className="break-all font-medium">{p.path}</td><td>{p.kind}</td><td>{p.statusCode}</td></tr>
                      ))}
                    </tbody>
                  </table></div>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {history.length > 0 && (
        <section className="rounded-xl border border-[var(--line)] bg-[var(--surface)]">
          <div className="border-b border-[var(--line)] px-5 py-3">
            <h2 className="text-sm font-semibold">점검 이력 (최근 {history.length}회)</h2>
          </div>
          <div className="px-5 py-4 text-sm">
            <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[var(--ink-soft)]">이전 날짜</span>
                <select name="from" defaultValue={sp.from ?? history[Math.min(1, history.length - 1)].scanDate}>
                  {history.map((h) => <option key={h.scanDate} value={h.scanDate}>{h.scanDate}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[var(--ink-soft)]">이후 날짜</span>
                <select name="to" defaultValue={sp.to ?? history[0].scanDate}>
                  {history.map((h) => <option key={h.scanDate} value={h.scanDate}>{h.scanDate}</option>)}
                </select>
              </label>
              <button className="rounded-md bg-[var(--nav-bg)] px-3 py-2 text-white hover:opacity-90">날짜 비교</button>
            </form>
            {sp.from && sp.to && !cmp && <p className="mb-3 text-[var(--ink-soft)]">선택한 날짜의 점검 결과를 찾을 수 없습니다.</p>}
            {cmp && (
              <div className="mb-4 rounded-md bg-[var(--background)] px-4 py-3">
                <p className="mb-2 font-medium">{sp.from} → {sp.to} 변화</p>
                <ul className="space-y-1">
                  {cmp.portsOpened.map((p) => <li key={`o${p.port}`}>새로 열린 포트: <b>{p.port}/{p.protocol}</b>{p.service ? ` (${p.service})` : ""}</li>)}
                  {cmp.portsClosed.map((p) => <li key={`c${p.port}`}>닫힌 포트: <b>{p.port}/{p.protocol}</b></li>)}
                  {cmp.pagesAdded.map((p) => <li key={`a${p.path}`}>새로 노출된 페이지: <b>{p.path}</b> ({p.kind})</li>)}
                  {cmp.pagesRemoved.map((p) => <li key={`r${p.path}`}>더 이상 노출되지 않는 페이지: <b>{p.path}</b></li>)}
                  {cmp.certChanged && <li>인증서 만료일이 바뀌었습니다.</li>}
                  {!cmp.portsOpened.length && !cmp.portsClosed.length && !cmp.pagesAdded.length && !cmp.pagesRemoved.length && !cmp.certChanged && <li className="text-[var(--ink-soft)]">변화가 없습니다.</li>}
                </ul>
              </div>
            )}
            <div className="table-card"><table className="w-full text-sm">
              <thead><tr className="text-left"><th>점검일</th><th>상태</th><th>강도</th><th>열린 포트</th><th>노출 페이지</th></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.scanDate}>
                    <td><Link href={`/assets/${id}?date=${h.scanDate}`}>{h.scanDate}</Link></td>
                    <td><Badge status={h.status} /></td>
                    <td>{h.scanLevel}단계</td>
                    <td>{h.openPorts.length}개</td>
                    <td>{h.exposedPages.length}개</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        </section>
      )}
    </div>
  );
}
