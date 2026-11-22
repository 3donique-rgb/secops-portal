import { describe, expect, it } from "vitest";
import { REPORT_MAX_ROWS, buildReportPdf, wrapText } from "../lib/report-pdf";
import type { IndicatorRow } from "../lib/indicator-query";

/**
 * 시험 사례 표
 *  1. 한글 포함 보고서     → 유효한 PDF(%PDF 로 시작), 1쪽 이상, 글꼴 포함으로 오류 없이 생성
 *  2. 많은 건수            → 여러 쪽으로 나뉘고 쪽 수가 늘어남
 *  3. 0건                  → 오류 없이 "없습니다" 문구가 있는 PDF
 *  4. 아주 긴 값(URL 2000자) → 오류 없이 생성
 *  5. 긴 줄 나누기         → 모든 줄이 폭 안에 들어가고, 합치면 원문과 같음
 */
// 공백·백틱이 들어간 값도 안전하게 그려지는지 확인하기 위해 일부 값에 넣는다.
const row = (i: number, value = i % 3 === 0 ? `a b \`c\` ${i}` : `198.51.100.${i % 250}`): IndicatorRow => ({
  id: String(i), type: "ip", value, hashKind: null, status: "active", excluded: i % 7 === 0,
  firstSeenAt: new Date("2026-11-01"), lastSeenAt: new Date("2026-11-20"), memo: null, sourceNames: ["한국인터넷진흥원", "데모기관 B"],
});
/** 쪽 수: 쪽마다 "/Type /Page" 객체가 하나씩 있다 ("/Type /Pages"는 제외). */
const pageCount = (bytes: Uint8Array) => (Buffer.from(bytes).toString("latin1").match(/\/Type \/Page(?![s\w])/g) ?? []).length;
const base = {
  conditions: ["기간: 2026-11-01 ~ 2026-11-30", "키워드: 피싱"],
  byType: { ip: 3 }, bySource: [{ name: "한국인터넷진흥원", n: 3 }],
  generatedAt: new Date("2026-11-22T03:00:00Z"), generatedBy: "admin1",
};

describe("PDF 보고서", () => {
  it("한글이 들어간 보고서를 만든다", async () => {
    const bytes = await buildReportPdf({ ...base, total: 3, rows: [row(1), row(2), row(3)] });
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    
    expect(pageCount(bytes)).toBeGreaterThanOrEqual(2); // 요약 쪽 + 목록 쪽
    expect(Buffer.from(bytes).toString("latin1")).toContain("/Title");
  });

  it("건수가 많으면 여러 쪽으로 나뉜다", async () => {
    const small = pageCount(await buildReportPdf({ ...base, total: 10, rows: Array.from({ length: 10 }, (_, i) => row(i)) }));
    const big = pageCount(await buildReportPdf({ ...base, total: 400, rows: Array.from({ length: 400 }, (_, i) => row(i)) }));
    expect(big).toBeGreaterThan(small + 3);
  }, 60000);

  it("0건이어도 만들어진다", async () => {
    expect(pageCount(await buildReportPdf({ ...base, total: 0, byType: {}, bySource: [], rows: [] }))).toBe(2);
  });

  it("2000자짜리 값과 상한 초과 안내도 오류 없이 만든다", async () => {
    const long = "http://x.example/" + "a".repeat(1983);
    const bytes = await buildReportPdf({ ...base, total: REPORT_MAX_ROWS + 10, rows: [row(1, long)] });
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("긴 줄은 폭 안에서 나뉘고 내용은 그대로 보존된다", async () => {
    const text = "hxxp://긴주소/" + "abcdef0123456789".repeat(20);
    const width = (t: string) => t.length * 4 + (t.match(/[가-힣]/g)?.length ?? 0) * 4; // 한글은 두 배 폭
    const lines = wrapText(text, width, 100);
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.every((l) => width(l) <= 100)).toBe(true);
    expect(lines.join("")).toBe(text);
  });
});
