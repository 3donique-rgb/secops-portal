import { requireAdmin } from "@/lib/session";

// 관리자 화면 전체의 문지기: 조회 전용 계정은 403.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return <>{children}</>;
}
