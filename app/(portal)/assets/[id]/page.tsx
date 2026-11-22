import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { ActionForm } from "@/components/action-form";
import { SCAN_LEVELS, getAsset } from "@/lib/assets";
import { requireUser } from "@/lib/session";
import { deleteAssetAction } from "../actions";

export const metadata = { title: "자산 상세 - 보안관제 포털" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fmt = (d: Date) => d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });

export default async function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const a = await getAsset(getDb(), id);
  if (!a) notFound();
  return (
    <div className="max-w-3xl space-y-6">
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
      <section>
        <h2 className="mb-2 font-semibold">점검 결과</h2>
        <p className="rounded bg-gray-50 p-3 text-sm text-gray-600">
          아직 점검 결과가 없습니다. 자산 점검 기능(2차 개발)이 완료되면 매일 점검한 포트·서비스·인증서·노출 페이지가 여기에 기록됩니다.
        </p>
      </section>
    </div>
  );
}
