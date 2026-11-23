import { describe, expect, it } from "vitest";
import { dispatchScan, MAX_MANUAL, REPO } from "../lib/scan-dispatch";

const f = (status: number, cap?: { url?: string; init?: RequestInit }) =>
  (async (u: string, init: RequestInit) => {
    if (cap) {
      cap.url = u;
      cap.init = init;
    }
    return new Response(null, { status });
  }) as unknown as typeof fetch;

const ID = "11111111-1111-4111-8111-111111111111";

describe("수동 점검 요청", () => {
  it("토큰이 없으면 설정 안내", async () => {
    const r = await dispatchScan([ID], undefined, f(204));
    expect(r.ok).toBe(false);
  });
  it("자산 수가 0개이거나 한도를 넘으면 거절", async () => {
    expect((await dispatchScan([], "t", f(204))).ok).toBe(false);
    expect((await dispatchScan(Array(MAX_MANUAL + 1).fill(ID), "t", f(204))).ok).toBe(false);
  });
  it("정상: 고정된 GitHub 주소로, 토큰은 헤더로만, 자산 번호를 입력값으로 보낸다", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const r = await dispatchScan([ID, ID.replace(/1/g, "2")], "SECRET", f(204, cap));
    expect(r).toEqual({ ok: true });
    expect(cap.url).toBe(`https://api.github.com/repos/${REPO}/actions/workflows/scan.yml/dispatches`);
    expect(cap.url).not.toContain("SECRET");
    expect((cap.init!.headers as Record<string, string>).authorization).toBe("Bearer SECRET");
    expect(JSON.parse(String(cap.init!.body))).toEqual({ ref: "main", inputs: { asset_ids: `${ID},${ID.replace(/1/g, "2")}` } });
  });
  it.each([
    [401, "거절"],
    [403, "권한"],
    [404, "권한"],
    [422, "받지"],
    [500, "HTTP 500"],
  ])("HTTP %i 는 알아보기 쉬운 메시지", async (status, word) => {
    const r = await dispatchScan([ID], "t", f(status));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(word);
  });
  it("네트워크 오류도 메시지로", async () => {
    const g = (async () => {
      throw new Error("x");
    }) as unknown as typeof fetch;
    expect((await dispatchScan([ID], "t", g)).ok).toBe(false);
  });
});
