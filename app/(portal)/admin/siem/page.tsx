import { getDb } from "@/db";
import { ActionForm } from "@/components/action-form";
import { listApiKeys } from "@/lib/api-keys";
import { SIEM_DEFAULT_LIMIT, SIEM_MAX_LIMIT } from "@/lib/siem";
import { requireAdmin } from "@/lib/session";
import { createKeyAction, revokeKeyAction } from "./actions";

export const metadata = { title: "SIEM 연동 - 보안관제 포털" };
const fmt = (d: Date | null) => (d ? d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }) : "사용 기록 없음");

export default async function SiemPage() {
  await requireAdmin();
  const keys = await listApiKeys(getDb());
  const input = "mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm";

  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-xl font-bold">SIEM 연동</h1>

      <section className="space-y-2">
        <h2 className="font-semibold">API 키 발급</h2>
        <p className="text-sm text-gray-600">
          키는 발급 직후 <b>한 번만</b> 화면에 표시되며, 서버에는 암호화된 해시만 저장됩니다. 잃어버리면 새로 발급하세요.
        </p>
        <ActionForm action={createKeyAction} className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            이름 (어디에 쓰는 키인지)
            <input name="name" required maxLength={100} placeholder="예: 운영 SIEM" className={`${input} w-64`} />
          </label>
          <button type="submit" className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white">
            발급
          </button>
        </ActionForm>
      </section>

      <section>
        <h2 className="mb-2 font-semibold">발급된 키</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-300 text-left">
              <th className="py-2 pr-3">이름</th>
              <th className="pr-3">발급일</th>
              <th className="pr-3">마지막 사용</th>
              <th className="pr-3">상태</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className="border-b border-gray-100 align-top">
                <td className="py-1.5 pr-3">{k.name}</td>
                <td className="pr-3">{fmt(k.createdAt)}</td>
                <td className="pr-3">{fmt(k.lastUsedAt)}</td>
                <td className="pr-3">{k.revoked ? <span className="text-gray-500">폐기됨</span> : "사용 중"}</td>
                <td>
                  {!k.revoked && (
                    <ActionForm action={revokeKeyAction} confirmText={`"${k.name}" 키를 폐기할까요? 이 키를 쓰는 SIEM 연동이 즉시 끊깁니다.`}>
                      <input type="hidden" name="id" value={k.id} />
                      <button className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">폐기</button>
                    </ActionForm>
                  )}
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-gray-500">
                  발급된 키가 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="space-y-2 text-sm">
        <h2 className="font-semibold">사용 방법</h2>
        <p>SIEM에서 아래 주소를 주기적으로 호출하도록 설정합니다. 화이트리스트·자산·예약 IP와 일치해 “제외”된 지표는 응답에 포함되지 않습니다.</p>
        <pre className="overflow-x-auto rounded bg-gray-50 p-3 text-xs">{`GET /api/siem/indicators
Authorization: Bearer <API 키>

예: curl -H "Authorization: Bearer <API 키>" \\
  "https://<포털 주소>/api/siem/indicators?type=ip,domain&format=csv"`}</pre>
        <table className="w-full border-collapse text-xs">
          <tbody>
            {[
              ["type", "ip, domain, url, hash, email (쉼표로 여러 개). 생략하면 전체"],
              ["status", "active(기본) / inactive / all"],
              ["since", "이 시각 이후 확인된 것만 (ISO 8601, 예: 2026-11-22T00:00:00Z)"],
              ["format", "json(기본) / csv / txt(값만 한 줄에 하나)"],
              ["limit", `최대 건수 (기본 ${SIEM_DEFAULT_LIMIT.toLocaleString("ko-KR")}, 최대 ${SIEM_MAX_LIMIT.toLocaleString("ko-KR")})`],
            ].map(([k, v]) => (
              <tr key={k} className="border-b border-gray-100">
                <td className="py-1 pr-3 font-mono">{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
