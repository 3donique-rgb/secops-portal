import { describe, expect, it } from "vitest";
import { kstDate, parseIndicatorParams } from "../lib/indicator-params";

/**
 * 시험 사례 표
 *  1. 정상 값              → 종류 여러 개, 상태, 기관, 키워드, 기간, 쪽 번호가 그대로 조건이 됨
 *  2. 잘못된 값            → 모르는 종류·상태·제외값, 잘못된 날짜(2월 30일)·형식은 무시, 쪽 번호는 1 이상
 *  3. 종료일               → 당일 포함(다음 날 0시 미만)
 */
describe("검색 조건 해석", () => {
  it("정상 값을 조건으로 바꾼다", () => {
    const { filter, page } = parseIndicatorParams({
      type: ["ip", "hash"], status: "inactive", source: "A기관", q: "evil", from: "2026-11-01", to: "2026-11-30", excluded: "none", page: "3",
    });
    expect(filter.types).toEqual(["ip", "hash"]);
    expect(filter.status).toBe("inactive");
    expect(filter.sourceName).toBe("A기관");
    expect(filter.keyword).toBe("evil");
    expect(filter.excluded).toBe("none");
    expect(filter.from?.toISOString()).toBe("2026-10-31T15:00:00.000Z"); // 한국 시간 11/1 0시
    expect(page).toBe(3);
  });

  it("잘못된 값은 무시한다", () => {
    const { filter, page } = parseIndicatorParams({
      type: ["bogus", "ip", "ip"], status: "x", excluded: "all", from: "2026-02-30", to: "yesterday", page: "-5",
    });
    expect(filter.types).toEqual(["ip"]);
    expect(filter.status).toBeUndefined();
    expect(filter.excluded).toBeUndefined();
    expect(filter.from).toBeUndefined();
    expect(filter.to).toBeUndefined();
    expect(page).toBe(1);
    expect(parseIndicatorParams({ type: "zzz", page: "abc" })).toEqual({ filter: expect.objectContaining({ types: undefined }), page: 1 });
  });

  it("종료일은 당일을 포함한다", () => {
    const to = parseIndicatorParams({ to: "2026-11-30" }).filter.to!;
    expect(to.toISOString()).toBe("2026-11-30T15:00:00.000Z"); // 한국 시간 12/1 0시 미만까지
    expect(kstDate("2026-11-30", 0)?.toISOString()).toBe("2026-11-29T15:00:00.000Z");
  });
});

describe("국가코드 조건", () => {
  it("두 글자 영문만 받고 대문자로 바꾼다", () => {
    expect(parseIndicatorParams({ country: "kr" }).filter.country).toBe("KR");
    expect(parseIndicatorParams({ country: "KOR" }).filter.country).toBeUndefined();
    expect(parseIndicatorParams({ country: "1;" }).filter.country).toBeUndefined();
  });
});
