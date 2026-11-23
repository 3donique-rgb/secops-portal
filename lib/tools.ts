/**
 * 환경점검 도구: 포트 체커, DNS 조회, WHOIS 조회, Reverse IP 조회.
 * - 모든 도구는 로그인한 사용자만 쓰고, 사용 기록(감사 로그)과 사용 횟수 제한이 있다.
 * - 서버가 외부로 나가는 요청(포트 연결, WHOIS 서버 접속)은 사설·예약 주소로는 보내지 않는다 (내부망 탐색 방지).
 */
import dns from "node:dns";
import net, { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { isReservedIp } from "./normalize";

export type ToolSection = { title: string; note?: string; rows?: [string, string][]; items?: string[]; text?: string };
export type ToolResult = { ok: boolean; message?: string; sections?: ToolSection[] };

const fail = (message: string): ToolResult => ({ ok: false, message });

// ---------------------------------------------------------------------------
// 입력 확인
// ---------------------------------------------------------------------------
const HOST_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]{2,63}$/;

/** 도메인 또는 IP. 주소(URL)를 붙여 넣어도 호스트만 뽑는다. 올바르지 않으면 null */
export function cleanHost(input: string): { host: string; kind: "ipv4" | "ipv6" | "domain" } | null {
  let s = input.trim();
  if (!s || s.length > 300) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  } else {
    s = s.split(/[/?#]/)[0];
  }
  s = s.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const v = isIP(s);
  if (v === 4) return { host: s, kind: "ipv4" };
  if (v === 6) return { host: s, kind: "ipv6" };
  const ascii = domainToASCII(s);
  if (ascii && HOST_RE.test(ascii)) return { host: ascii, kind: "domain" };
  return null;
}

export const MAX_PORTS = 20;
export const PORT_PRESET = [21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 587, 993, 995, 1433, 3306, 3389, 5432, 8080, 8443];

/** "80, 443, 8000-8005" → [80, 443, 8000..8005]. 잘못되었거나 20개를 넘으면 오류 문구 */
export function parsePorts(input: string): { ports: number[] } | { error: string } {
  const parts = input.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return { error: "포트 번호를 입력하세요. 예: 80, 443, 8000-8005" };
  const set = new Set<number>();
  for (const p of parts) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(p);
    if (!m) return { error: `"${p.slice(0, 20)}"은(는) 올바른 포트가 아닙니다. 예: 80, 443, 8000-8005` };
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || a > b) return { error: "포트는 1~65535 사이여야 하고, 범위는 작은 수부터 적어야 합니다." };
    if (b - a + 1 > MAX_PORTS) return { error: `포트는 한 번에 ${MAX_PORTS}개까지 확인할 수 있습니다.` };
    for (let i = a; i <= b; i++) set.add(i);
    if (set.size > MAX_PORTS) return { error: `포트는 한 번에 ${MAX_PORTS}개까지 확인할 수 있습니다.` };
  }
  return { ports: [...set].sort((x, y) => x - y) };
}

const PORT_NAMES: Record<number, string> = {
  20: "FTP 데이터", 21: "FTP", 22: "SSH", 23: "Telnet", 25: "SMTP", 53: "DNS", 80: "HTTP", 110: "POP3", 111: "RPC", 123: "NTP", 135: "MS RPC", 139: "NetBIOS",
  143: "IMAP", 161: "SNMP", 389: "LDAP", 443: "HTTPS", 445: "SMB", 465: "SMTPS", 514: "Syslog", 587: "SMTP 제출", 636: "LDAPS", 993: "IMAPS", 995: "POP3S",
  1433: "MS SQL", 1521: "Oracle", 2049: "NFS", 3306: "MySQL", 3389: "원격 데스크톱(RDP)", 5432: "PostgreSQL", 5900: "VNC", 6379: "Redis", 8080: "HTTP 대체", 8443: "HTTPS 대체", 9200: "Elasticsearch", 27017: "MongoDB",
};
export const portName = (p: number) => PORT_NAMES[p] ?? "";

// ---------------------------------------------------------------------------
// 1) 포트 체커 - TCP 연결만 시도한다 (데이터를 보내지 않는다)
// ---------------------------------------------------------------------------
export type PortState = "open" | "closed" | "filtered";
export type PortDeps = {
  lookup?: (host: string) => Promise<string>;
  /** 시험용: 사설·예약 주소도 허용 */
  allowPrivate?: boolean;
  timeoutMs?: number;
  concurrency?: number;
};

const defaultLookup4 = async (host: string) => (await dns.promises.lookup(host, { family: 4 })).address;

function probePort(ip: string, port: number, timeoutMs: number): Promise<PortState> {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port });
    let done = false;
    const end = (st: PortState) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(st);
    };
    s.setTimeout(timeoutMs, () => end("filtered"));
    s.once("connect", () => end("open"));
    s.once("error", (e: NodeJS.ErrnoException) => end(e.code === "ECONNREFUSED" ? "closed" : "filtered"));
  });
}

export async function checkPorts(hostInput: string, ports: number[], deps: PortDeps = {}): Promise<ToolResult> {
  const h = cleanHost(hostInput);
  if (!h) return fail("올바른 도메인 또는 IP 주소를 입력하세요.");
  if (h.kind === "ipv6") return fail("포트 체커는 IPv4 주소만 지원합니다.");
  let ip: string;
  try {
    ip = h.kind === "ipv4" ? h.host : await (deps.lookup ?? defaultLookup4)(h.host);
  } catch {
    return fail("이 도메인의 IPv4 주소를 찾지 못했습니다.");
  }
  if (!deps.allowPrivate && isReservedIp(ip)) return fail("사설·예약 주소(내부망, 127.0.0.1 등)는 점검할 수 없습니다.");
  const timeout = deps.timeoutMs ?? 2500;
  const results = new Map<number, PortState>();
  let next = 0;
  const worker = async () => {
    while (next < ports.length) {
      const p = ports[next++];
      results.set(p, await probePort(ip, p, timeout));
    }
  };
  await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? 10, ports.length) }, worker));
  const label: Record<PortState, string> = { open: "열림", closed: "닫힘 (연결 거부)", filtered: "응답 없음 (방화벽 차단 또는 서버 꺼짐)" };
  const open = ports.filter((p) => results.get(p) === "open");
  return {
    ok: true,
    sections: [
      {
        title: `${h.host}${h.kind === "domain" ? ` (${ip})` : ""} 포트 점검 결과`,
        note: `열림 ${open.length}개 / 확인 ${ports.length}개. 연결만 시도했고 어떤 데이터도 보내지 않았습니다.`,
        rows: ports.map((p) => [`${p}${portName(p) ? ` · ${portName(p)}` : ""}`, label[results.get(p) ?? "filtered"]] as [string, string]),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 2) DNS 조회
// ---------------------------------------------------------------------------
export const DNS_SERVERS = [
  { id: "google", label: "구글 (8.8.8.8)", server: "8.8.8.8" },
  { id: "cloudflare", label: "클라우드플레어 (1.1.1.1)", server: "1.1.1.1" },
  { id: "kt", label: "KT (168.126.63.1)", server: "168.126.63.1" },
  { id: "system", label: "서버 기본 DNS", server: null },
] as const;

export type DnsQuery = (type: "A" | "AAAA" | "CNAME" | "MX" | "NS" | "TXT" | "SOA" | "PTR", name: string) => Promise<unknown>;

export function makeDnsQuery(server: string | null): DnsQuery {
  const r = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
  if (server) r.setServers([server]);
  return async (type, name) => {
    switch (type) {
      case "A":
        return r.resolve4(name, { ttl: true });
      case "AAAA":
        return r.resolve6(name, { ttl: true });
      case "CNAME":
        return r.resolveCname(name);
      case "MX":
        return r.resolveMx(name);
      case "NS":
        return r.resolveNs(name);
      case "TXT":
        return r.resolveTxt(name);
      case "SOA":
        return r.resolveSoa(name);
      case "PTR":
        return r.reverse(name);
    }
  };
}

const NO_DATA = new Set(["ENODATA", "ENOTFOUND", "ENOTIMP", "ENOENT"]);

export async function dnsLookup(input: string, serverId: string, q?: DnsQuery): Promise<ToolResult> {
  const h = cleanHost(input);
  if (!h) return fail("올바른 도메인 또는 IP 주소를 입력하세요.");
  const srv = DNS_SERVERS.find((s) => s.id === serverId) ?? DNS_SERVERS[0];
  const query = q ?? makeDnsQuery(srv.server);
  const serverText = `조회한 DNS 서버: ${srv.label}`;

  if (h.kind !== "domain") {
    try {
      const names = (await query("PTR", h.host)) as string[];
      return { ok: true, sections: [{ title: `${h.host} 역방향(PTR) 조회`, note: serverText, items: names.length ? names : ["PTR 기록 없음"] }] };
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      return { ok: true, sections: [{ title: `${h.host} 역방향(PTR) 조회`, note: serverText, items: [NO_DATA.has(code) ? "PTR 기록 없음" : `조회 실패 (${code || "오류"})`] }] };
    }
  }

  const types = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA"] as const;
  const out = await Promise.all(
    types.map(async (t) => {
      try {
        return { t, v: await query(t, h.host), code: "" };
      } catch (e) {
        return { t, v: null as unknown, code: (e as { code?: string }).code ?? "ERR" };
      }
    }),
  );
  const nxdomain = out.every((o) => o.v === null && o.code === "ENOTFOUND");
  if (nxdomain) return fail(`${h.host}: 존재하지 않는 도메인입니다 (${srv.label} 응답).`);
  const sections: ToolSection[] = [];
  for (const o of out) {
    let rows: [string, string][] | undefined;
    let items: string[] | undefined;
    if (o.v === null) {
      items = [NO_DATA.has(o.code) ? "기록 없음" : `조회 실패 (${o.code})`];
    } else if (o.t === "A" || o.t === "AAAA") {
      rows = (o.v as { address: string; ttl: number }[]).map((x) => [x.address, `TTL ${x.ttl}초`]);
    } else if (o.t === "MX") {
      rows = (o.v as { exchange: string; priority: number }[]).sort((a, b) => a.priority - b.priority).map((x) => [x.exchange, `우선순위 ${x.priority}`]);
    } else if (o.t === "TXT") {
      items = (o.v as string[][]).map((x) => x.join(""));
    } else if (o.t === "SOA") {
      const s = o.v as { nsname: string; hostmaster: string; serial: number; refresh: number; retry: number; expire: number; minttl: number };
      rows = [["주 네임서버", s.nsname], ["관리자", s.hostmaster], ["시리얼", String(s.serial)], ["갱신/재시도/만료/최소TTL", `${s.refresh} / ${s.retry} / ${s.expire} / ${s.minttl}`]];
    } else {
      items = o.v as string[];
    }
    if ((rows && rows.length === 0) || (items && items.length === 0)) {
      items = ["기록 없음"];
      rows = undefined;
    }
    sections.push({ title: `${o.t} 기록`, rows, items });
  }
  sections[0].note = serverText;
  return { ok: true, sections };
}

// ---------------------------------------------------------------------------
// 3) WHOIS 조회 - 표준 whois(TCP 43)로 IANA 안내를 따라간다
// ---------------------------------------------------------------------------
export type WhoisIO = (server: string, query: string) => Promise<string>;

const HOST_ONLY = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;

/** 응답 안에 적힌 다음 WHOIS 서버 이름 (iana 의 refer, 등록기관 안내 등) */
export function nextWhoisServer(text: string, current: string): string | null {
  const pats = [/^\s*refer:\s*(\S+)/im, /^\s*whois:\s*(\S+)/im, /Registrar WHOIS Server:\s*(\S+)/i, /ReferralServer:\s*(?:r?whois:\/\/)?([^\s:/]+)/i];
  for (const p of pats) {
    const m = p.exec(text);
    const h = m?.[1]?.toLowerCase().replace(/^(r?whois:\/\/)/, "");
    if (h && HOST_ONLY.test(h) && h !== current && h.includes(".")) return h;
  }
  return null;
}

export const defaultWhoisIO: WhoisIO = async (server, query) => {
  // 서버 이름은 응답에서 얻은 값이므로, 사설·예약 주소로 연결되지 않게 확인한다
  const all = await dns.promises.lookup(server, { all: true });
  const ip = all.map((a) => a.address).find((a) => !isReservedIp(a));
  if (!ip) throw new Error("WHOIS 서버 주소가 올바르지 않습니다.");
  return new Promise<string>((resolve, reject) => {
    const s = net.connect({ host: ip, port: 43 });
    const chunks: Buffer[] = [];
    let size = 0;
    s.setTimeout(10_000, () => {
      s.destroy();
      reject(new Error("WHOIS 서버 응답 시간 초과"));
    });
    s.once("connect", () => s.write(`${query}\r\n`));
    s.on("data", (d: Buffer) => {
      size += d.length;
      if (size > 100_000) s.destroy();
      else chunks.push(d);
    });
    s.once("error", reject);
    s.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
};

export async function whoisLookup(input: string, io: WhoisIO = defaultWhoisIO): Promise<ToolResult> {
  const h = cleanHost(input);
  if (!h) return fail("올바른 도메인 또는 IP 주소를 입력하세요.");
  const hops: { server: string; text: string }[] = [];
  let server: string | null = "whois.iana.org";
  const seen = new Set<string>();
  try {
    for (let i = 0; i < 4 && server && !seen.has(server); i++) {
      seen.add(server);
      const text = (await io(server, h.host)).replace(/\r/g, "").trim();
      hops.push({ server, text });
      server = nextWhoisServer(text, server);
    }
  } catch (e) {
    if (hops.length === 0) return fail(`WHOIS 조회에 실패했습니다: ${e instanceof Error ? e.message : "오류"}`);
  }
  // IANA 는 어느 서버로 가야 하는지만 알려 주므로, 실제 등록 정보가 있으면 그 뒤의 응답을 보여 준다
  const shown = hops.length > 1 ? hops.slice(1) : hops;
  return {
    ok: true,
    sections: shown.map((x, i) => ({
      title: `WHOIS 서버: ${x.server}`,
      note: i === 0 && hops.length > 1 ? `조회 경로: ${hops.map((y) => y.server).join(" → ")}` : undefined,
      text: x.text.slice(0, 20_000) || "(빈 응답)",
    })),
  };
}

// ---------------------------------------------------------------------------
// 4) Reverse IP - 같은 IP 에서 운영되는 도메인
// ---------------------------------------------------------------------------
/** HackerTarget 응답(줄마다 도메인)을 읽는다. 한도 초과·오류 문구는 error 로 돌려준다 */
export function parseHackerTarget(text: string): { domains: string[] } | { error: string } {
  const t = text.trim();
  if (/api count exceeded/i.test(t)) return { error: "외부 서비스(HackerTarget)의 하루 무료 조회 한도를 넘었습니다. 내일 다시 시도하세요." };
  if (/^error/i.test(t)) return { error: "외부 서비스(HackerTarget)가 오류를 돌려줬습니다." };
  if (/^no (dns a records|records) found/i.test(t)) return { domains: [] };
  const domains = [...new Set(t.split("\n").map((x) => x.trim().toLowerCase()).filter((x) => HOST_RE.test(x)))];
  return { domains };
}

export async function fetchReverseIpExternal(ip: string, fetchImpl: typeof fetch = fetch): Promise<{ domains: string[] } | { error: string }> {
  if (isIP(ip) !== 4) return { error: "외부 조회는 IPv4 주소만 지원합니다." };
  try {
    const res = await fetchImpl(`https://api.hackertarget.com/reverseiplookup/?q=${ip}`, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!res.ok) return { error: `외부 서비스가 오류를 돌려줬습니다 (HTTP ${res.status}).` };
    return parseHackerTarget((await res.text()).slice(0, 200_000));
  } catch {
    return { error: "외부 서비스에 연결하지 못했습니다." };
  }
}

/** 도메인이면 IPv4 로 바꾸고, IP 면 그대로. 실패하면 오류 문구 */
export async function resolveToIp(input: string, lookup: (h: string) => Promise<string> = defaultLookup4): Promise<{ ip: string; host: string; fromDomain: boolean } | { error: string }> {
  const h = cleanHost(input);
  if (!h) return { error: "올바른 도메인 또는 IP 주소를 입력하세요." };
  if (h.kind === "ipv6") return { error: "Reverse IP 조회는 IPv4 주소만 지원합니다." };
  if (h.kind === "ipv4") return { ip: h.host, host: h.host, fromDomain: false };
  try {
    return { ip: await lookup(h.host), host: h.host, fromDomain: true };
  } catch {
    return { error: "이 도메인의 IPv4 주소를 찾지 못했습니다." };
  }
}
