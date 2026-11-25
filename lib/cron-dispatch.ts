/**
 * 정시 실행 요청: GitHub의 예약(cron)은 늦거나 빠지므로, Supabase(pg_cron)가 정해진 시각에 이 포털로 요청을 보내고
 * 포털이 GitHub Actions 에 "지금 실행" 신호를 보낸다.
 * 필요한 설정: Vercel 환경변수 GITHUB_DISPATCH_TOKEN (수동 점검 버튼과 같은 토큰), DB의 cron_config(secret).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { cronConfig } from "../db/schema";
import type { Db } from "./indicators";
import { REPO } from "./scan-dispatch";

/** 요청으로 실행할 수 있는 작업 (이 목록에 없는 것은 거절) */
export const CRON_WORKFLOWS = {
  collect: "collect.yml",
  enrich: "enrich.yml",
  vt: "vt.yml",
  news: "news.yml",
  scan: "scan.yml",
  cleanup: "cleanup.yml",
} as const;
export type CronWorkflow = keyof typeof CRON_WORKFLOWS;

/** 예약 시각은 UTC 기준(pg_cron). 기존 GitHub 예약과 같은 시각 */
export const CRON_SCHEDULES: Record<CronWorkflow, string> = {
  collect: "17 * * * *",
  enrich: "47 * * * *",
  vt: "40 */3 * * *",
  news: "40 21 * * *",
  scan: "30 17 * * *",
  cleanup: "10 18 * * *",
};

const digest = (s: string) => createHash("sha256").update(s).digest();
export function secretMatches(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!given || !expected) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

export type CronResult = { status: number; body: { ok: boolean; message: string } };

export async function handleCronDispatch(
  db: Db,
  input: { secret: string | null; workflow: unknown },
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<CronResult> {
  const [row] = await db.select({ value: cronConfig.value }).from(cronConfig).where(eq(cronConfig.key, "secret")).limit(1);
  if (!secretMatches(input.secret, row?.value)) return { status: 401, body: { ok: false, message: "인증 실패" } };
  const name = typeof input.workflow === "string" && Object.hasOwn(CRON_WORKFLOWS, input.workflow) ? (input.workflow as CronWorkflow) : null;
  if (!name) return { status: 400, body: { ok: false, message: "알 수 없는 작업" } };
  if (!token) return { status: 500, body: { ok: false, message: "GITHUB_DISPATCH_TOKEN 미설정" } };
  let res: Response;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${REPO}/actions/workflows/${CRON_WORKFLOWS[name]}/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "secops-portal",
      },
      body: JSON.stringify({ ref: "main" }),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
  } catch {
    return { status: 502, body: { ok: false, message: "GitHub 연결 실패" } };
  }
  if (res.status === 204) return { status: 200, body: { ok: true, message: `${name} 실행 요청함` } };
  const why = res.status === 401 ? "토큰 거절(만료/오류)" : res.status === 403 || res.status === 404 ? "토큰 권한 없음" : res.status === 422 ? "워크플로 설정 확인 필요" : `HTTP ${res.status}`;
  return { status: 502, body: { ok: false, message: `GitHub 거절: ${why}` } };
}
