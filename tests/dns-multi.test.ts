import { describe, expect, it } from "vitest";
import { RESOLVERS, resolveDomainMulti, SYSTEM_RESOLVER, type ResolveVia } from "../lib/dns-multi";

const fail = () => Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" }));

describe("여러 DNS 서버로 IP 찾기", () => {
  it("구글·KT 등 공개 DNS 가 목록에 있고 보안 차단 DNS 는 없다", () => {
    const servers = RESOLVERS.map((r) => r.server);
    expect(servers).toContain("8.8.8.8");
    expect(servers).toContain("168.126.63.1");
    expect(servers).toContain("1.1.1.1");
    expect(servers).not.toContain("9.9.9.9"); // Quad9: 악성 도메인을 막아 "없음"으로 답함
    expect(servers).not.toContain("208.67.222.222"); // OpenDNS
    expect(RESOLVERS[0].server).toBe("8.8.8.8"); // 구글이 가장 먼저
  });

  it("첫 서버가 답하면 거기서 끝낸다", async () => {
    const asked: (string | null)[] = [];
    const via: ResolveVia = async (s) => (asked.push(s), ["203.0.113.5"]);
    expect(await resolveDomainMulti("a.example", via)).toEqual({ ip: "203.0.113.5", via: "Google", asked: 1 });
    expect(asked).toEqual(["8.8.8.8"]);
  });

  it("앞 서버가 실패하면 다음 서버, 그래도 안 되면 KT 로 넘어간다", async () => {
    const via: ResolveVia = async (s) => (s === "168.126.63.1" ? ["58.1.2.3"] : fail());
    const r = await resolveDomainMulti("a.example", via);
    expect(r).toMatchObject({ ip: "58.1.2.3", via: "KT" });
    expect(r.asked).toBe(4); // 8.8.8.8, 8.8.4.4, 1.1.1.1, 168.126.63.1
  });

  it("없는 도메인은 모든 서버와 시스템 기본 DNS 까지 확인한 뒤 '없음'", async () => {
    const asked: (string | null)[] = [];
    const via: ResolveVia = (s) => (asked.push(s), fail());
    const r = await resolveDomainMulti("gone.example", via);
    expect(r).toEqual({ ip: null, via: null, asked: RESOLVERS.length + 1 });
    expect(asked.at(-1)).toBeNull(); // 마지막은 시스템 기본 DNS (ping 과 같은 방식)
  });

  it("시스템 기본 DNS 만 답해도 IP 를 얻는다", async () => {
    const via: ResolveVia = async (s) => (s === null ? ["198.51.100.7"] : fail());
    expect(await resolveDomainMulti("a.example", via)).toMatchObject({ ip: "198.51.100.7", via: SYSTEM_RESOLVER });
  });

  it("사설·차단 응답(0.0.0.0, 127.x)은 공인 IP 를 찾을 때까지 다음 서버에 묻는다", async () => {
    const via: ResolveVia = async (s) => (s === "8.8.8.8" ? ["0.0.0.0"] : s === "8.8.4.4" ? ["127.0.0.1"] : ["58.9.9.9"]);
    expect(await resolveDomainMulti("a.example", via)).toMatchObject({ ip: "58.9.9.9", via: "Cloudflare" });
  });

  it("끝까지 공인 IP 가 없으면 처음 받은 사설 주소를 돌려준다", async () => {
    const via: ResolveVia = async (s) => (s === "8.8.8.8" ? ["10.1.1.1"] : fail());
    expect(await resolveDomainMulti("a.example", via)).toMatchObject({ ip: "10.1.1.1", via: "Google" });
  });

  it("IPv6 주소만 오면 IP 없음으로 본다", async () => {
    const via: ResolveVia = async () => ["2001:db8::1"];
    expect((await resolveDomainMulti("a.example", via)).ip).toBeNull();
  });
});
