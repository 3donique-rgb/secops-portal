import Link from "next/link";
import { getDb } from "@/db";
import { ActionForm } from "@/components/action-form";
import { listUsers } from "@/lib/users";
import { requireAdmin } from "@/lib/session";
import { SelectAll } from "@/components/select-all";
import { createUserAction, deleteUsersAction, resetOtpAction, setRoleAction, unlockAction } from "./actions";

export const metadata = { title: "사용자 관리 - 보안관제 포털" };

const fmt = (d: Date | null) =>
  d ? d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }) : "-";

export default async function UsersPage() {
  const me = await requireAdmin();
  const rows = await listUsers(getDb());
  const input = "h-[2.4rem] w-full rounded-lg border border-gray-300 px-3 text-sm";
  const lab = "mb-1 block font-medium";
  const btn = "rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50";

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-bold">사용자 관리</h1>

      <section>
        <h2 className="mb-2 font-semibold">새 사용자</h2>
        <ActionForm action={createUserAction} className="plain-form max-w-4xl rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
          <div className="grid grid-cols-1 items-end gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-sm">
              <span className={lab}>아이디</span>
              <input name="username" required minLength={3} maxLength={32} autoComplete="off" className={input} />
            </label>
            <label className="text-sm">
              <span className={lab}>이름</span>
              <input name="name" required maxLength={50} autoComplete="off" className={input} />
            </label>
            <label className="text-sm">
              <span className={lab}>초기 비밀번호 (10자 이상)</span>
              <input name="password" type="password" required minLength={10} maxLength={128} autoComplete="new-password" className={input} />
            </label>
            <label className="text-sm">
              <span className={lab}>권한</span>
              <select name="role" defaultValue="viewer" className={input}>
                <option value="viewer">조회 전용</option>
                <option value="admin">관리자</option>
              </select>
            </label>
            <label className="text-sm">
              <span className={lab}>OTP 인증</span>
              <select name="otpRequired" defaultValue="on" className={input}>
                <option value="on">사용 (권장)</option>
                <option value="off">사용 안 함</option>
              </select>
            </label>
            <div>
              <button type="submit" className="h-[2.4rem] w-full rounded-lg bg-gray-900 px-4 text-sm font-medium text-white sm:w-auto">
                만들기
              </button>
            </div>
          </div>
        </ActionForm>
      </section>

      <section className="space-y-2">
        <ActionForm id="user-bulk" action={deleteUsersAction} confirmText="선택한 계정을 삭제합니다. 되돌릴 수 없습니다. 계속할까요?" className="plain-form flex flex-wrap items-center gap-3">
          <button type="submit" className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50">
            선택한 계정 삭제
          </button>
          <span className="text-xs text-gray-500">본인 계정과 마지막 관리자는 삭제할 수 없습니다. 감사 로그는 남습니다.</span>
        </ActionForm>
      </section>

      <section className="table-card">
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-300 text-left">
              <th className="w-8 py-2 pr-2"><SelectAll name="ids" formId="user-bulk" label="전체 선택" /></th>
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
                <td className="py-2 pr-2">
                  <input type="checkbox" name="ids" value={u.id} form="user-bulk" disabled={u.id === me.id} title={u.id === me.id ? "본인 계정은 삭제할 수 없습니다" : undefined} aria-label={`${u.username} 선택`} className="h-4 w-4" />
                </td>
                <td className="py-2 pr-3 font-medium">{u.username}</td>
                <td className="pr-3 whitespace-nowrap">{u.name}</td>
                <td className="pr-3 whitespace-nowrap">{u.role === "admin" ? "관리자" : "조회 전용"}</td>
                <td className="pr-3 whitespace-nowrap">{!u.otpRequired ? <span className="text-amber-700">사용 안 함</span> : u.otpEnabled ? "등록됨" : "미등록"}</td>
                <td className="pr-3 whitespace-nowrap">
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
                    <Link href={`/admin/users/${u.id}`} className={btn}>수정</Link>
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
