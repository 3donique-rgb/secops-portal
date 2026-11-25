import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { handleCronDispatch } from "@/lib/cron-dispatch";

/** Supabase(pg_cron)가 정시에 호출하는 주소. 비밀 값 헤더가 맞을 때만 GitHub Actions 실행을 요청한다. */
export async function POST(req: NextRequest) {
  let workflow: unknown = null;
  try {
    workflow = ((await req.json()) as { workflow?: unknown }).workflow;
  } catch {
    /* 본문이 없으면 알 수 없는 작업으로 처리 */
  }
  const r = await handleCronDispatch(getDb(), { secret: req.headers.get("x-cron-secret"), workflow }, process.env.GITHUB_DISPATCH_TOKEN);
  if (r.status !== 200) console.error("[cron-dispatch]", r.status, r.body.message);
  return NextResponse.json(r.body, { status: r.status });
}
