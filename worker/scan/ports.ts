/**
 * 포트 점검 (7.1, 7.2): TCP 연결이 되는지만 확인하고, 3단계부터 배너를 읽어 서비스·버전을 식별한다.
 * 비침투 원칙 [고정]: 로그인 시도·입력값 주입·취약점 공격 코드는 쓰지 않는다.
 * 배너를 얻기 위해 보내는 것은 웹 포트에 대한 `HEAD /` 한 줄뿐이다.
 */
import net from "node:net";
import type { OpenPort } from "../../db/schema";

/** 주요 포트 100개 (1단계) */
export const TOP_100 = [
  7, 9, 13, 21, 22, 23, 25, 26, 37, 53, 79, 80, 81, 88, 106, 110, 111, 113, 119, 135, 139, 143, 144, 179, 199, 389, 427, 443, 444, 445, 465, 513, 514, 515,
  543, 544, 548, 554, 587, 631, 646, 873, 990, 993, 995, 1025, 1026, 1027, 1028, 1029, 1110, 1433, 1720, 1723, 1755, 1900, 2000, 2001, 2049, 2121, 2717,
  3000, 3128, 3306, 3389, 3986, 4899, 5000, 5009, 5051, 5060, 5101, 5190, 5357, 5432, 5631, 5666, 5800, 5900, 6000, 6001, 6646, 7070, 8000, 8008, 8009,
  8080, 8081, 8443, 8888, 9100, 9999, 10000, 32768, 49152, 49153, 49154, 69, 161, 2222,
];

/** 관리·데이터베이스·원격 접속 등 높은 번호에 흔히 열리는 포트 (2단계에 추가) */
const COMMON_HIGH = [
  1194, 1521, 1883, 2181, 2375, 2376, 2379, 3000, 3333, 4000, 4443, 4848, 5001, 5044, 5432, 5601, 5672, 5984, 5985, 5986, 6379, 6443, 7001, 7002, 7443,
  8082, 8083, 8086, 8088, 8090, 8091, 8161, 8180, 8200, 8300, 8500, 8545, 8761, 8800, 8880, 8983, 9000, 9042, 9043, 9090, 9092, 9200, 9300, 9418, 9443,
  9600, 9870, 10250, 11211, 15672, 27017, 27018, 28017, 50000, 50070,
];

/** 주요 포트 약 1,000개 (2단계): 1~1024 전체 + 주요 포트 + 자주 쓰는 높은 포트 */
export const TOP_1000 = Array.from(new Set([...Array.from({ length: 1024 }, (_, i) => i + 1), ...TOP_100, ...COMMON_HIGH])).sort((a, b) => a - b);

export const ALL_PORTS = Array.from({ length: 65535 }, (_, i) => i + 1);

export function portsForLevel(level: number): number[] {
  if (level <= 1) return TOP_100;
  if (level <= 4) return TOP_1000;
  return ALL_PORTS;
}

export type PortScanOptions = {
  /** 동시에 시도하는 연결 수 */
  concurrency?: number;
  /** 연결 한 번의 제한 시간(ms) */
  connectTimeoutMs?: number;
  /** 초당 새 연결 수 상한 (대상에 부하를 주지 않기 위함) */
  ratePerSec?: number;
  /** 서비스·배너 식별 여부 (3단계부터) */
  identify?: boolean;
  /** 이 시각이 지나면 중단하고 일부만 점검됨으로 표시 */
  deadline?: number;
};

export type PortScanResult = {
  open: OpenPort[];
  /** 연결이 거부(RST)된 포트 수 — 호스트가 살아 있다는 신호 */
  refused: number;
  /** 시간 초과·도달 불가 */
  silent: number;
  /** 시간 제한으로 시도하지 못한 포트가 있음 */
  incomplete: boolean;
  /** 한 번이라도 응답(연결 성공·거부)이 있었음 */
  alive: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Probe = { kind: "open"; banner: string } | { kind: "refused" } | { kind: "silent" };

function probe(host: string, port: number, timeoutMs: number, identify: boolean): Promise<Probe> {
  return new Promise((resolve) => {
    let settled = false;
    let banner = "";
    const sock = net.connect({ host, port });
    const done = (p: Probe) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(p);
    };
    sock.setTimeout(timeoutMs, () => done({ kind: "silent" }));
    sock.on("error", (e: NodeJS.ErrnoException) => done(e.code === "ECONNREFUSED" ? { kind: "refused" } : { kind: "silent" }));
    sock.on("connect", () => {
      if (!identify) return done({ kind: "open", banner: "" });
      // 먼저 말을 거는 서비스(SSH·FTP·SMTP 등)는 잠깐 기다려 배너를 읽고, 웹 포트는 HEAD 한 줄만 보낸다.
      const web = [80, 81, 3000, 5000, 8000, 8008, 8080, 8081, 8088, 8888, 9000, 9090].includes(port);
      if (web) sock.write(`HEAD / HTTP/1.0\r\nHost: ${host}\r\nUser-Agent: secops-portal-scan\r\nConnection: close\r\n\r\n`);
      sock.setTimeout(0);
      const t = setTimeout(() => done({ kind: "open", banner }), 1500);
      sock.on("data", (d) => {
        banner += d.toString("latin1").slice(0, 512);
        if (banner.length >= 256 || /\r?\n\r?\n/.test(banner)) {
          clearTimeout(t);
          done({ kind: "open", banner });
        }
      });
      sock.on("close", () => {
        clearTimeout(t);
        done({ kind: "open", banner });
      });
    });
  });
}

const WELL_KNOWN: Record<number, string> = {
  21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "dns", 80: "http", 110: "pop3", 111: "rpcbind", 135: "msrpc", 139: "netbios", 143: "imap", 389: "ldap",
  443: "https", 445: "smb", 465: "smtps", 587: "submission", 993: "imaps", 995: "pop3s", 1433: "mssql", 1521: "oracle", 2049: "nfs", 3306: "mysql", 3389: "rdp",
  5432: "postgresql", 5900: "vnc", 5985: "winrm", 6379: "redis", 8080: "http-alt", 8443: "https-alt", 9200: "elasticsearch", 11211: "memcached", 27017: "mongodb",
};

/** 배너와 포트 번호로 서비스 이름·버전을 추정한다. 알 수 없으면 이름만(또는 빈 값). */
export function identifyService(port: number, banner: string): { service?: string; version?: string } {
  const first = banner.split(/\r?\n/)[0] ?? "";
  let m = /^SSH-\d\.\d+-(\S+)/.exec(first);
  if (m) return { service: "ssh", version: m[1] };
  if (/^HTTP\/\d/.test(first)) {
    const server = /^server:\s*(.+)$/im.exec(banner)?.[1]?.trim();
    return { service: port === 443 || port === 8443 ? "https" : "http", version: server?.slice(0, 80) };
  }
  m = /^220[ -](.+)/.exec(first);
  if (m) {
    const text = m[1].trim();
    const svc = /ftp/i.test(text) ? "ftp" : /smtp|esmtp|mail/i.test(text) ? "smtp" : (WELL_KNOWN[port] ?? "banner-220");
    return { service: svc, version: text.slice(0, 80) };
  }
  m = /^\+OK\s*(.*)/.exec(first);
  if (m) return { service: "pop3", version: m[1].slice(0, 80) || undefined };
  if (/^\* OK/.test(first)) return { service: "imap", version: first.slice(4, 84) };
  if (/^-ERR|^-DENIED|^\$\d|^\+PONG/.test(first)) return { service: "redis" };
  return { service: WELL_KNOWN[port] };
}

export async function scanPorts(host: string, ports: number[], opts: PortScanOptions = {}): Promise<PortScanResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 100);
  const timeout = opts.connectTimeoutMs ?? 1500;
  const rate = Math.max(1, opts.ratePerSec ?? 400);
  const identify = opts.identify ?? false;
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;

  const open: OpenPort[] = [];
  let refused = 0;
  let silent = 0;
  let next = 0;
  let attempted = 0;
  const started = Date.now();

  const worker = async () => {
    while (true) {
      if (Date.now() > deadline) return;
      const i = next++;
      if (i >= ports.length) return;
      // 초당 연결 수 제한: 시작 후 지금까지 허용된 개수보다 앞서 나가지 않게 기다린다.
      const allowedAt = started + (i / rate) * 1000;
      if (allowedAt > deadline) return; // 허용 시각이 시간 제한 뒤라면 더 기다리지 않고 멈춘다
      const wait = allowedAt - Date.now();
      if (wait > 0) await sleep(wait);
      const port = ports[i];
      const r = await probe(host, port, timeout, identify);
      attempted++;
      if (r.kind === "open") {
        const info = identify ? identifyService(port, r.banner) : {};
        open.push({ port, protocol: "tcp", ...(info.service ? { service: info.service } : {}), ...(info.version ? { version: info.version } : {}) });
      } else if (r.kind === "refused") refused++;
      else silent++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, worker));
  open.sort((a, b) => a.port - b.port);
  return { open, refused, silent, incomplete: attempted < ports.length, alive: open.length > 0 || refused > 0 };
}
