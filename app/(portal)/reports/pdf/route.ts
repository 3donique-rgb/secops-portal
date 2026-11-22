import { headers } from "next/headers";
import { getDb } from "@/db";
import { getClientIp } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { describeFilter, parseIndicatorParams } from "@/lib/indicator-params";
import { countByType, countBySource, countIndicators, listIndicators } from "@/lib/indicator-query";
import { REPORT_MAX_ROWS, buildReportPdf } from "@/lib/report-pdf";
import { getCurrentUser } from "@/lib/session";

/** PDF 보고서 내려받기. 로그인한 모든 사용자(조회 전용 포함)가 쓸 수 있다. */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new Response("로그인이 필요합니다.", { status: 401 });

  const sp = Object.fromEntries(
    [...new Set(new URL(request.url).searchParams.keys())].map((k) => [k, new URL(request.url).searchParams.getAll(k)]),
  );
  const { filter } = parseIndicatorParams(sp);
  const db = getDb();
  const [total, byType, bySource, rows] = await Promise.all([
    countIndicators(db, filter),
    countByType(db, filter),
    countBySource(db, filter),
    listIndicators(db, filter, REPORT_MAX_ROWS),
  ]);
  const now = new Date();
  const pdf = await buildReportPdf({
    conditions: describeFilter(sp, filter),
    total,
    byType,
    bySource,
    rows,
    generatedAt: now,
    generatedBy: user.username,
  });
  await writeAudit(db, {
    userId: user.id,
    action: "report_download",
    target: `${total}건`,
    detail: { conditions: describeFilter(sp, filter) },
    ip: getClientIp(await headers()),
  });
  const stamp = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).replaceAll("-", "");
  return new Response(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="threat-report-${stamp}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
