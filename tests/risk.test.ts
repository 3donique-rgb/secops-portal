import { describe, expect, it } from "vitest";
import { assessRisk, type RiskInput } from "../lib/risk";

const now = new Date("2026-11-24T00:00:00Z");
const base: RiskInput = { status: "success", openPorts: [], exposedPages: [], certExpiresAt: null };
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
const port = (p: number) => ({ port: p, protocol: "tcp" });

describe("자산 위험등급", () => {
  it("점검 결과 없음 → 미점검", () => expect(assessRisk(null, now).level).toBe("none"));
  it("80·443만 열림, 인증서 여유 → 안전", () => {
    expect(assessRisk({ ...base, openPorts: [port(80), port(443)], certExpiresAt: days(90) }, now).level).toBe("safe");
  });
  it("RDP·DB·Telnet 노출 → 위험", () => {
    for (const p of [3389, 23, 3306, 445, 6379]) expect(assessRisk({ ...base, openPorts: [port(p)] }, now).level).toBe("danger");
  });
  it("SSH 열림, 로그인 페이지, 인증서 임박, 응답 없음 → 주의", () => {
    expect(assessRisk({ ...base, openPorts: [port(22)] }, now).level).toBe("caution");
    expect(assessRisk({ ...base, exposedPages: [{ path: "/login", statusCode: 200, kind: "로그인 페이지" }] }, now).level).toBe("caution");
    expect(assessRisk({ ...base, certExpiresAt: days(10) }, now).level).toBe("caution");
    expect(assessRisk({ ...base, status: "fail" }, now).level).toBe("caution");
  });
  it(".env 200 노출, 인증서 만료 → 위험 (403이면 주의)", () => {
    expect(assessRisk({ ...base, exposedPages: [{ path: "/.env", statusCode: 200, kind: "설정 파일 노출" }] }, now).level).toBe("danger");
    expect(assessRisk({ ...base, exposedPages: [{ path: "/.env", statusCode: 403, kind: "설정 파일 노출" }] }, now).level).toBe("caution");
    expect(assessRisk({ ...base, certExpiresAt: days(-3) }, now).level).toBe("danger");
  });
  it("위험이 있으면 주의 사유도 함께", () => {
    const r = assessRisk({ ...base, openPorts: [port(3389), port(22)] }, now);
    expect(r.level).toBe("danger");
    expect(r.reasons).toHaveLength(2);
  });
});
