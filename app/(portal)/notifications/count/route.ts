import { getDb } from "@/db";
import { unreadCount } from "@/lib/notifications";
import { getCurrentUser } from "@/lib/session";

/** 상단 종 알림이 1분마다 부르는 주소: 읽지 않은 알림 개수. 로그인한 사용자만. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ unread: await unreadCount(getDb()) }, { headers: { "Cache-Control": "no-store" } });
}
