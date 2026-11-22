import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { AssetForm } from "@/components/asset-form";
import { getAsset } from "@/lib/assets";
import { requireAdmin } from "@/lib/session";
import { updateAssetAction } from "../../actions";

export const metadata = { title: "자산 수정 - 보안관제 포털" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditAssetPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const a = await getAsset(getDb(), id);
  if (!a) notFound();
  return (
    <div className="max-w-3xl space-y-4">
      <Link href={`/assets/${id}`} className="text-sm underline">
        ← 자산 상세
      </Link>
      <h1 className="text-xl font-bold">자산 수정</h1>
      <p className="text-sm text-gray-600">수정할 때도 점검 허가 확인을 다시 체크해야 저장됩니다.</p>
      <AssetForm
        action={updateAssetAction}
        submitLabel="저장"
        initial={{
          id, name: a.name, target: a.target, owner: a.owner ?? "", department: a.department ?? "",
          importance: a.importance, scanLevel: a.scanLevel, enabled: a.enabled, memo: a.memo ?? "",
        }}
      />
    </div>
  );
}
