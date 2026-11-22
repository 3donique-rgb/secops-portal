/**
 * IP·CIDR 대역 비교 (IPv4, IPv6 모두 지원).
 * 화이트리스트(제외 판정)와 로그인 허용 IP 판정에서 함께 쓴다.
 */
import { isIP } from "node:net";

// 프로젝트의 TypeScript 목표 버전에서는 큰 정수 리터럴(0n)을 쓸 수 없어 함수 형태로 쓴다.
const B = BigInt;

export type ParsedIp = { version: 4 | 6; value: bigint };
export type ParsedCidr = ParsedIp & { bits: number };

function parseIPv4(ip: string): bigint | null {
  if (isIP(ip) !== 4) return null;
  return ip
    .split(".")
    .reduce((acc, part) => acc * B(256) + BigInt(Number.parseInt(part, 10)), B(0));
}

function parseIPv6(ip: string): bigint | null {
  if (isIP(ip) !== 6) return null;
  let text = ip.toLowerCase();
  // 끝에 IPv4가 붙은 형태(::ffff:1.2.3.4)를 16진수 두 묶음으로 바꾼다
  const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = parseIPv4(v4[1]);
    if (n === null) return null;
    const hi = ((n >> B(16)) & B(0xffff)).toString(16);
    const lo = (n & B(0xffff)).toString(16);
    text = text.slice(0, -v4[1].length) + `${hi}:${lo}`;
  }
  // 존 식별자(%eth0) 제거
  text = text.replace(/%.*$/, "");

  const [head, tail] = text.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (tail === undefined ? headParts.length !== 8 : missing < 0) return null;
  const groups = [
    ...headParts,
    ...(tail === undefined ? [] : Array<string>(missing).fill("0")),
    ...tailParts,
  ];
  if (groups.length !== 8) return null;
  let result = B(0);
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    result = (result << B(16)) + BigInt(Number.parseInt(g, 16));
  }
  return result;
}

export function parseIp(ip: string): ParsedIp | null {
  const v = isIP(ip);
  if (v === 4) {
    const value = parseIPv4(ip);
    return value === null ? null : { version: 4, value };
  }
  if (v === 6) {
    const value = parseIPv6(ip);
    return value === null ? null : { version: 6, value };
  }
  return null;
}

/** "1.2.3.0/24" 또는 단일 IP("1.2.3.4" → /32)를 해석한다. */
export function parseCidr(input: string): ParsedCidr | null {
  const [addr, bitsText, extra] = input.trim().split("/");
  if (extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.version === 4 ? 32 : 128;
  let bits = max;
  if (bitsText !== undefined) {
    if (!/^\d{1,3}$/.test(bitsText)) return null;
    bits = Number.parseInt(bitsText, 10);
    if (bits > max) return null;
  }
  return { ...ip, bits };
}

export function isValidCidr(input: string): boolean {
  return parseCidr(input) !== null;
}

/** 표준 표기로 바꾼다 (예: "1.2.3.4" → "1.2.3.4/32", 호스트 비트는 0으로). */
export function canonicalCidr(input: string): string | null {
  const c = parseCidr(input);
  if (!c) return null;
  const total = c.version === 4 ? 32 : 128;
  const hostBits = BigInt(total - c.bits);
  const network = (c.value >> hostBits) << hostBits;
  return `${formatIp(network, c.version)}/${c.bits}`;
}

function formatIp(value: bigint, version: 4 | 6): string {
  if (version === 4) {
    return [B(24), B(16), B(8), B(0)].map((s) => ((value >> s) & B(0xff)).toString()).join(".");
  }
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) {
    groups.push(((value >> BigInt(i * 16)) & B(0xffff)).toString(16));
  }
  // 가장 긴 0 연속 구간을 ::로 압축
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === "0") j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (bestLen < 2) return groups.join(":");
  const left = groups.slice(0, bestStart).join(":");
  const right = groups.slice(bestStart + bestLen).join(":");
  return `${left}::${right}`;
}

export function ipInParsedCidr(ip: ParsedIp, cidr: ParsedCidr): boolean {
  if (ip.version !== cidr.version) return false;
  const total = ip.version === 4 ? 32 : 128;
  const shift = BigInt(total - cidr.bits);
  return ip.value >> shift === cidr.value >> shift;
}

/** IP가 CIDR 대역(또는 단일 IP)에 속하는지. 형식이 잘못되면 false. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const a = parseIp(ip);
  const c = parseCidr(cidr);
  if (!a || !c) return false;
  return ipInParsedCidr(a, c);
}

/**
 * 접속자 IP 문자열을 비교 가능한 형태로 정리한다.
 * - 포트(1.2.3.4:5678, [::1]:443)와 대괄호 제거
 * - IPv4 주소가 IPv6 형태로 들어온 경우(::ffff:1.2.3.4)는 IPv4로 변환
 * 올바른 IP가 아니면 null.
 */
export function cleanClientIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let text = raw.trim();
  const bracket = text.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) text = bracket[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(text)) text = text.replace(/:\d+$/, "");
  const ip = parseIp(text);
  if (!ip) return null;
  if (ip.version === 6 && ip.value >> B(32) === B(0xffff)) {
    return formatIp(ip.value & B(0xffffffff), 4);
  }
  return formatIp(ip.value, ip.version);
}
