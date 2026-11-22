/**
 * 지표 정규화 [고정] - design.md 4.1
 * 입력: 문자열 한 개 (예: "HXXP://Evil[.]com/a")
 * 출력: 종류와 정규화된 값, 판별 불가면 null
 */
import { domainToASCII } from "node:url";
import { isIP } from "node:net";

export type IndicatorType = "ip" | "domain" | "url" | "hash" | "email";
export type HashKind = "md5" | "sha1" | "sha256";

export type NormalizedIndicator = {
  type: IndicatorType;
  value: string;
  hashKind: HashKind | null;
  /** 사설·예약 대역 IP이면 true (제외 후보) */
  reserved: boolean;
};

const MAX_LEN = 2000;
const HASH_BY_LENGTH: Record<number, HashKind> = {
  32: "md5",
  40: "sha1",
  64: "sha256",
};
const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9-]{1,62}$/;
const EMAIL_RE = /^[a-z0-9._%+'-]{1,64}@(.+)$/;

/** 방어 표기(defang)를 원래 모양으로 되돌린다. */
export function refang(input: string): string {
  return input
    .replace(/\[\s*(?:\.|dot)\s*\]|\(\s*(?:\.|dot)\s*\)|\{\s*(?:\.|dot)\s*\}/gi, ".")
    .replace(/\[\s*(?:@|at)\s*\]|\(\s*(?:@|at)\s*\)|\{\s*(?:@|at)\s*\}/gi, "@")
    .replace(/\[\s*:\s*\]/g, ":")
    .replace(/\[\s*\/\s*\]/g, "/")
    .replace(/^(?:hxxp|h\*\*p)(s?)(?=:)/i, "http$1")
    .replace(/^fxp(s?)(?=:)/i, "ftp$1");
}

function ipv4ToInt(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, part) => acc * 256 + Number.parseInt(part, 10), 0);
}

/** 사설·루프백·링크로컬·멀티캐스트 등 외부 위협정보로 쓸 수 없는 대역인지 */
export function isReservedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const n = ipv4ToInt(ip);
    const inRange = (base: string, bits: number) => {
      const size = 2 ** (32 - bits);
      const start = ipv4ToInt(base);
      return n >= start && n < start + size;
    };
    return (
      inRange("0.0.0.0", 8) ||
      inRange("10.0.0.0", 8) ||
      inRange("100.64.0.0", 10) ||
      inRange("127.0.0.0", 8) ||
      inRange("169.254.0.0", 16) ||
      inRange("172.16.0.0", 12) ||
      inRange("192.0.0.0", 24) ||
      inRange("192.168.0.0", 16) ||
      inRange("198.18.0.0", 15) ||
      inRange("224.0.0.0", 4) ||
      inRange("240.0.0.0", 4)
    );
  }
  if (version === 6) {
    const v = ip.toLowerCase();
    return (
      v === "::" ||
      v === "::1" ||
      /^f[cd]/.test(v) || // fc00::/7
      /^fe[89ab]/.test(v) || // fe80::/10
      /^ff/.test(v) // 멀티캐스트
    );
  }
  return false;
}

function result(
  type: IndicatorType,
  value: string,
  extra: Partial<Pick<NormalizedIndicator, "hashKind" | "reserved">> = {},
): NormalizedIndicator {
  return { type, value, hashKind: extra.hashKind ?? null, reserved: extra.reserved ?? false };
}

function normalizeIp(raw: string): NormalizedIndicator | null {
  // [::1] 형태의 대괄호 제거
  const bare = raw.replace(/^\[(.*)\]$/, "$1");
  const version = isIP(bare);
  if (version === 0) return null;
  let value = bare.toLowerCase();
  if (version === 6) {
    // URL 파서로 압축된 표준 표기를 얻는다
    try {
      value = new URL(`http://[${value}]`).hostname.slice(1, -1);
    } catch {
      return null;
    }
  }
  return result("ip", value, { reserved: isReservedIp(value) });
}

function normalizeDomain(raw: string): string | null {
  const host = raw.toLowerCase().replace(/\.+$/, "");
  if (!host || /[\s/@:?#]/.test(host)) return null;
  const ascii = domainToASCII(host);
  if (!ascii || !DOMAIN_RE.test(ascii)) return null;
  return ascii;
}

function normalizeUrl(raw: string): NormalizedIndicator | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:", "ftp:"].includes(parsed.protocol)) return null;
  if (!parsed.hostname) return null;
  // 주소 부분은 소문자(URL 파서가 처리), 경로·쿼리는 그대로. 조각(#...)은 버린다.
  parsed.hash = "";
  const value = parsed.href;
  if (value.length > MAX_LEN) return null;
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  const reserved = isIP(host) !== 0 && isReservedIp(host);
  return result("url", value, { reserved });
}

export function normalize(raw: string): NormalizedIndicator | null {
  if (typeof raw !== "string") return null;
  // 앞뒤 공백 제거. 중간에 공백이 있으면 하나의 지표가 아니므로 판별 불가 처리
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_LEN || /\s/.test(trimmed)) return null;

  const text = refang(trimmed);

  // 1) 해시: 16진수 32/40/64자리
  if (/^[a-f0-9]+$/i.test(text) && HASH_BY_LENGTH[text.length]) {
    return result("hash", text.toLowerCase(), {
      hashKind: HASH_BY_LENGTH[text.length],
    });
  }

  // 2) URL: 스킴이 있는 경우
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return normalizeUrl(text);
  }

  // 3) 이메일
  const email = text.toLowerCase().match(EMAIL_RE);
  if (email) {
    const domain = normalizeDomain(email[1]);
    return domain ? result("email", `${text.toLowerCase().split("@")[0]}@${domain}`) : null;
  }

  // 4) IP
  const ip = normalizeIp(text);
  if (ip) return ip;

  // 5) 도메인
  const domain = normalizeDomain(text);
  if (domain) return result("domain", domain);

  return null;
}
