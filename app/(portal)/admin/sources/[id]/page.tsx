import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { SourceForm } from "@/components/source-form";
import { requireAdmin } from "@/lib/session";
import { getSource } from "@/lib/sources";
import { updateSourceAction } from "../actions";

export const metadata = { title: "출처 수정 - 보안관제 포털" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditSourcePage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const s = await getSource(getDb(), id);
  if (!s) notFound();
  return (
    <div className="max-w-3xl space-y-4">
      <Link href="/admin/sources" className="text-sm underline">
        ← 수집 출처
      </Link>
      <h1 className="text-xl font-bold">{s.name}</h1>
      <p className="text-sm">
        <Link href={`/admin/sources/${id}/runs`} className="underline">
          수집 이력 보기
        </Link>
      </p>
      <SourceForm
        action={updateSourceAction}
        submitLabel="저장"
        initial={{ id, name: s.name, kind: s.kind, url: s.url, config: JSON.stringify(s.config, null, 2), enabled: s.enabled, hasKey: s.hasKey }}
      />
    </div>
  );
}
