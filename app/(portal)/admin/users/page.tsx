import Link from "next/link";
import { getDb } from "@/db";
import { ActionForm } from "@/components/action-form";
import { listUsers } from "@/lib/users";
import { requireAdmin } from "@/lib/session";
import { createUserAction, resetOtpAction, setRoleAction, unlockAction } from "./actions";

export const metadata = { title: "사용자 관리 - 보안관제 포털" };

const fmt = (d: Date | null) =>
  d ? d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }) : "-";

export default async function UsersPage() {
  const me = await requireAdmin();
  const rows = await listUsers(getDb());
  const input = "mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm";
  const btn = "rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50";

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-bold">사용자 관리</h1>

      <section>
        <h2 className="mb-2 font-semibold">새 사용자</h2>
        <ActionForm action={createUserAction} className="grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-5">
          <label className="text-sm">
            아이디
            <input name="username" required minLength={3} maxLength={32} autoComplete="off" className={input} />
          </label>
          <label className="text-sm">
            이름
            <input name="name" required maxLength={50} autoComplete="off" className={input} />
          </label>
          <label className="text-sm">
            초기 비밀번호 (10자 이상)
            <input name="password" type="password" required minLength={10} maxLength={128} autoComplete="new-password" className={input} />
          </label>
          <label className="text-sm">
            권한
            <select name="role" defaultValue="viewer" className={input}>
              <option value="viewer">조회 전용</option>
              <option value="admin">관리자</option>
            </select>
          </label>
          <div className="flex items-end">
            <button type="submit" className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white">
              만들기
            </button>
          </div>
        </ActionForm>
      </section>

      <section className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-300 text-left">
              <th className="py-2 pr-3">아이디</th>
              <th className="pr-3">이름</th>
              <th className="pr-3">권한</th>
              <th className="pr-3">OTP</th>
              <th className="pr-3">상태</th>
              <th className="pr-3">허용 IP</th>
              <th className="pr-3">마지막 로그인</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className="border-b border-gray-100 align-top">
                <td className="py-2 pr-3 font-medium">{u.username}</td>
                <td className="pr-3">{u.name}</td>
                <td className="pr-3">{u.role === "admin" ? "관리자" : "조회 전용"}</td>
                <td className="pr-3">{u.otpEnabled ? "등록됨" : "미등록"}</td>
                <td className="pr-3">
                  {u.locked ? <span className="text-red-600">잠김</span> : `정상 (실패 ${u.failedCount})`}
                </td>
                <td className="pr-3">
                  <Link href={`/admin/users/${u.id}`} className="underline">
                    {u.role === "admin" ? "관리자는 제한 없음" : u.ipCount === 0 ? "없음 (로그인 불가)" : `${u.ipCount}개`}
                  </Link>
                </td>
                <td className="pr-3">{fmt(u.lastLoginAt)}</td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    <ActionForm action={setRoleAction} confirmText={`${u.username} 의 권한을 바꿉니다. 계속할까요?`}>
                      <input type="hidden" name="userId" value={u.id} />
                      <input type="hidden" name="role" value={u.role === "admin" ? "viewer" : "admin"} />
                      <button className={btn} disabled={u.id === me.id && u.role === "admin"} title={u.id === me.id ? "본인 권한은 바꿀 수 없습니다" : undefined}>
                        {u.role === "admin" ? "조회 전용으로" : "관리자로"}
                      </button>
                    </ActionForm>
                    {u.locked && (
                      <ActionForm action={unlockAction}>
                        <input type="hidden" name="userId" value={u.id} />
                        <button className={btn}>잠금 해제</button>
                      </ActionForm>
                    )}
                    <ActionForm action={resetOtpAction} confirmText={`${u.username} 의 OTP를 초기화합니다. 다음 로그인 때 다시 등록해야 합니다.`}>
                      <input type="hidden" name="userId" value={u.id} />
                      <button className={btn}>OTP 초기화</button>
                    </ActionForm>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
