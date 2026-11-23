/**
 * 도메인 → IPv4: 여러 공개 DNS 서버에 차례로 물어 IP를 찾는다.
 * 순서: 구글(8.8.8.8, 8.8.4.4) → 클라우드플레어(1.1.1.1) → KT(168.126.63.1, .2) → SK브로드밴드·LG U+ → 마지막으로 이 컴퓨터의 기본 DNS
 *       (기본 DNS 조회는 ping 이 주소를 찾는 방식과 같다. ping 으로 물어도 결과는 DNS 와 동일하다.)
 * - 한 서버가 시간 초과·오류를 내면 바로 다음 서버로 넘어간다.
 * - "없는 도메인(NXDOMAIN)" 답은 서버마다 다를 수 있어, 한 곳의 답만 믿지 않고 여러 곳에 확인한다.
 * - 악성 사이트를 막는 보안 DNS(Quad9, OpenDNS 등)는 일부러 쓰지 않는다. 막힌 도메인은 IP 없이 "없음"으로 답하기 때문이다.
 * - 사설·예약 주소(0.0.0.0, 127.x 등)는 "차단 응답"일 수 있어 공인 IP 를 찾을 때까지 다음 서버로 넘어간다.
 */
import dns from "node:dns";
import { ipv4ToNum } from "./geo";
import { isReservedIp } from "./normalize";

export type PublicResolver = { name: string; server: string };

export const RESOLVERS: PublicResolver[] = [
  { name: "Google", server: "8.8.8.8" },
  { name: "Google-2", server: "8.8.4.4" },
  { name: "Cloudflare", server: "1.1.1.1" },
  { name: "KT", server: "168.126.63.1" },
  { name: "KT-2", server: "168.126.63.2" },
  { name: "SK브로드밴드", server: "210.220.163.82" },
  { name: "LG U+", server: "164.124.101.2" },
];
export const SYSTEM_RESOLVER = "시스템 기본 DNS";

export type ResolveVia = (server: string | null, domain: string) => Promise<string[]>;

const cache = new Map<string, dns.promises.Resolver>();

/** server 가 null 이면 이 컴퓨터의 기본 DNS(getaddrinfo, ping 과 같은 방식)를 쓴다 */
export const defaultResolveVia: ResolveVia = async (server, domain) => {
  if (server === null) {
    const all = await dns.promises.lookup(domain, { family: 4, all: true });
    return all.map((a) => a.address);
  }
  let r = cache.get(server);
  if (!r) {
    r = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
    r.setServers([server]);
    cache.set(server, r);
  }
  return r.resolve4(domain);
};

export type DomainAnswer = { ip: string | null; via: string | null; asked: number };

/** 한 도메인의 IPv4 를 찾는다. 찾지 못하면 ip 는 null */
export async function resolveDomainMulti(domain: string, via: ResolveVia = defaultResolveVia, resolvers: PublicResolver[] = RESOLVERS): Promise<DomainAnswer> {
  let reserved: { ip: string; via: string } | null = null;
  let asked = 0;
  const steps: { name: string; server: string | null }[] = [...resolvers, { name: SYSTEM_RESOLVER, server: null }];
  for (const s of steps) {
    asked++;
    let ips: string[] = [];
    try {
      ips = await via(s.server, domain);
    } catch {
      continue; // 시간 초과·없음·서버 오류: 다음 서버에 물어본다
    }
    const v4 = ips.filter((x) => ipv4ToNum(x) !== null);
    const pub = v4.find((x) => !isReservedIp(x));
    if (pub) return { ip: pub, via: s.name, asked };
    if (v4[0] && !reserved) reserved = { ip: v4[0], via: s.name };
  }
  return reserved ? { ip: reserved.ip, via: reserved.via, asked } : { ip: null, via: null, asked };
}
