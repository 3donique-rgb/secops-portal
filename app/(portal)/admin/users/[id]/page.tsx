import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { ActionForm } from "@/components/action-form";
import { requireAdmin } from "@/lib/session";
import { listAllowedIps } from "@/lib/users";
import { addIpAction, removeIpAction } from "../actions";

export const metadata = { title: "허용 IP - 보안관제 포털" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function UserIpPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!user) notFound();
  const ips = await listAllowedIps(db, id);
  const input = "mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm";

  return (
    <div className="max-w-2xl space-y-6">
      <Link href="/admin/users" className="text-sm underline">
        ← 사용자 목록
      </Link>
      <h1 className="text-xl font-bold">
        {user.username} ({user.name}) 로그인 허용 IP
      </h1>
      {user.role === "admin" ? (
        <p className="rounded bg-gray-50 p-3 text-sm text-gray-700">
          관리자 계정은 IP 제한을 받지 않습니다(OTP는 항상 필요). 아래 목록은 조회 전용으로 바뀔 때를 위해 미리 등록해 둘 수 있습니다.
        </p>
      ) : (
        ips.length === 0 && (
          <p className="rounded bg-yellow-50 p-3 text-sm text-yellow-800">
            등록된 IP가 없어 이 계정은 현재 로그인할 수 없습니다.
          </p>
        )
      )}

      <ActionForm action={addIpAction} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <input type="hidden" name="userId" value={id} />
        <label className="text-sm">
          IP 또는 대역
          <input name="cidr" required placeholder="203.0.113.5 또는 203.0.113.0/24" className={input} />
        </label>
        <label className="text-sm">
          메모 (선택)
          <input name="memo" maxLength={200} placeholder="예: 본사 사무실" className={input} />
        </label>
        <div className="flex items-end">
          <button type="submit" className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white">
            추가
          </button>
        </div>
      </ActionForm>

      <ul className="divide-y divide-gray-100 border-y border-gray-200">
        {ips.map((ip) => (
          <li key={ip.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span>
              <code>{ip.cidr}</code>
              {ip.memo && <span className="ml-2 text-gray-500">{ip.memo}</span>}
            </span>
            <ActionForm action={removeIpAction} confirmText={`${ip.cidr} 를 삭제할까요?`}>
              <input type="hidden" name="userId" value={id} />
              <input type="hidden" name="ipId" value={ip.id} />
              <button className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">삭제</button>
            </ActionForm>
          </li>
        ))}
        {ips.length === 0 && <li className="py-3 text-sm text-gray-500">등록된 IP가 없습니다.</li>}
      </ul>
    </div>
  );
}
