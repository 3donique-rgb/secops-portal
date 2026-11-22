import Link from "next/link";
import { AssetForm } from "@/components/asset-form";
import { requireAdmin } from "@/lib/session";
import { createAssetAction } from "../actions";

export const metadata = { title: "자산 등록 - 보안관제 포털" };

export default async function NewAssetPage() {
  await requireAdmin();
  return (
    <div className="max-w-3xl space-y-4">
      <Link href="/assets" className="text-sm underline">
        ← 자산 목록
      </Link>
      <h1 className="text-xl font-bold">자산 등록</h1>
      <AssetForm
        action={createAssetAction}
        submitLabel="등록"
        initial={{ name: "", target: "", owner: "", department: "", importance: 3, scanLevel: 3, enabled: true, memo: "" }}
      />
    </div>
  );
}
