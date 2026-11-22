import Link from "next/link";
import { getDb } from "@/db";
import { ActionForm } from "@/components/action-form";
import { SourceForm } from "@/components/source-form";
import { requireAdmin } from "@/lib/session";
import { SOURCE_PRESETS, listSources } from "@/lib/sources";
import { addPresetAction, createSourceAction, toggleSourceAction } from "./actions";

export const metadata = { title: "수집 출처 - 보안관제 포털" };
const KIND = { api: "API/목록", html: "게시판", pdf: "PDF" } as const;
const fmt = (d: Date | null) => (d ? d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }) : "-");

export default async function SourcesPage() {
  await requireAdmin();
  const rows = await listSources(getDb());
  return (
    <div className="space-y-8">
      <h1 className="text-xl font-bold">수집 출처</h1>
      <p className="rounded bg-gray-50 p-3 text-sm text-gray-700">
        여기에 등록한 기관의 정보를 GitHub Actions가 <b>매시간</b> 가져옵니다. 가져온 모든 위협정보에는 아래의 <b>제공 기관명</b>이 기록됩니다.
        바로 수집해 보려면 GitHub → Actions → “위협정보 수집” → Run workflow 를 누르세요.
      </p>

      <section className="table-card">
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-300 text-left">
              <th className="py-2 pr-3">기관명</th>
              <th className="pr-3">방식</th>
              <th className="pr-3">마지막 성공</th>
              <th className="pr-3">최근 결과</th>
              <th className="pr-3">사용</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-b border-gray-100 align-top">
                <td className="py-1.5 pr-3">
                  <div className="font-medium">{s.name}</div>
                  <div className="max-w-xs break-all text-xs text-gray-500">{s.url}</div>
                </td>
                <td className="pr-3">{KIND[s.kind]}</td>
                <td className="pr-3 whitespace-nowrap">{fmt(s.lastSuccessAt)}</td>
                <td className="pr-3">
                  {s.lastStatus === null ? "-" : s.lastStatus === "success" ? "성공" : <span className="text-red-600">실패: {s.lastError}</span>}
                </td>
                <td className="pr-3">{s.enabled ? "사용" : <span className="text-gray-500">안 함</span>}</td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    <Link href={`/admin/sources/${s.id}`} className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">
                      수정
                    </Link>
                    <Link href={`/admin/sources/${s.id}/runs`} className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">
                      수집 이력
                    </Link>
                    <ActionForm action={toggleSourceAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <input type="hidden" name="name" value={s.name} />
                      <input type="hidden" name="enabled" value={String(!s.enabled)} />
                      <button className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">{s.enabled ? "사용 안 함으로" : "사용으로"}</button>
                    </ActionForm>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-gray-500">
                  등록된 출처가 없습니다. 아래에서 추가하세요.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="max-w-3xl space-y-3">
        <h2 className="font-semibold">새 출처 등록</h2>
        <SourceForm
          action={createSourceAction}
          submitLabel="등록"
          initial={{ name: "", kind: "api", url: "", config: '{\n  "format": "text",\n  "mode": "lines"\n}', enabled: true, hasKey: false }}
        />
      </section>

      <section className="max-w-3xl space-y-2">
        <h2 className="font-semibold">예시로 시작하기</h2>
        <p className="text-sm text-gray-600">
          자주 쓰이는 공개 목록의 예시입니다. 접속 가능 여부와 이용 조건은 직접 확인하세요. 추가하면 “사용 안 함” 상태로 들어갑니다.
        </p>
        {SOURCE_PRESETS.map((p) => (
          <ActionForm key={p.name} action={addPresetAction} className="flex flex-wrap items-center gap-3 text-sm">
            <input type="hidden" name="preset" value={p.name} />
            <span className="font-medium">{p.name}</span>
            <span className="break-all text-xs text-gray-500">{p.url}</span>
            <button className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">추가</button>
          </ActionForm>
        ))}
      </section>
    </div>
  );
}
