import { getDb } from "@/db";
import { ActionForm } from "@/components/action-form";
import { requireAdmin } from "@/lib/session";
import { listWhitelist } from "@/lib/whitelist";
import { addWhitelistAction, removeWhitelistAction } from "./actions";

export const metadata = { title: "화이트리스트 - 보안관제 포털" };
const TYPE_LABEL = { ip: "IP", cidr: "IP 대역", domain: "도메인" } as const;

export default async function WhitelistPage() {
  await requireAdmin();
  const rows = await listWhitelist(getDb());
  const input = "mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm";

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-bold">화이트리스트</h1>
      <p className="rounded bg-gray-50 p-3 text-sm text-gray-700">
        여기에 등록한 IP·대역·도메인(하위 도메인 포함)과 같은 위협정보는 <b>SIEM으로 내보내는 목록에서만 제외</b>됩니다.
        위협정보 자체는 삭제되지 않고 계속 보관됩니다. 등록·삭제하면 모든 지표를 바로 다시 계산합니다.
        (우리 자산과 사설·예약 IP는 자동으로 제외됩니다.)
      </p>

      <ActionForm action={addWhitelistAction} className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr_1fr_auto]">
        <label className="text-sm">
          종류
          <select name="type" defaultValue="ip" className={input}>
            <option value="ip">IP</option>
            <option value="cidr">IP 대역</option>
            <option value="domain">도메인</option>
          </select>
        </label>
        <label className="text-sm">
          값
          <input name="value" required maxLength={255} placeholder="203.0.113.5 / 10.0.0.0/8 / example.com" className={input} />
        </label>
        <label className="text-sm">
          사유 (선택)
          <input name="reason" maxLength={300} className={input} />
        </label>
        <div className="flex items-end">
          <button type="submit" className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white">
            추가
          </button>
        </div>
      </ActionForm>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-gray-300 text-left">
            <th className="py-2 pr-3">종류</th>
            <th className="pr-3">값</th>
            <th className="pr-3">사유</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => (
            <tr key={w.id} className="border-b border-gray-100 align-top">
              <td className="py-1.5 pr-3">{TYPE_LABEL[w.type]}</td>
              <td className="pr-3 break-all">
                <code>{w.value}</code>
              </td>
              <td className="pr-3 break-all">{w.reason ?? ""}</td>
              <td>
                <ActionForm action={removeWhitelistAction} confirmText={`${w.value} 를 삭제할까요? 일치하던 지표가 다시 SIEM에 제공됩니다.`}>
                  <input type="hidden" name="id" value={w.id} />
                  <button className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">삭제</button>
                </ActionForm>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="py-6 text-center text-gray-500">
                등록된 항목이 없습니다. (처음에는 비어 있습니다)
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
