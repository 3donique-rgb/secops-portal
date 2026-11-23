/**
 * 지역 인터넷 등록기관(RIR) 5곳이 매일 공개하는 "IP 대역 → 국가" 목록(delegated-*-latest)을 해석한다.
 * whois 에 등록된 국가의 원본 데이터라서, IP 하나씩 조회하지 않고도 모든 IPv4 대역의 국가를 알 수 있다.
 * 줄 형식: registry|CC|ipv4|시작주소|개수|날짜|상태
 */
import { cleanCountry, ipv4ToNum } from "./geo";

export const DELEGATED_FILES: { registry: string; label: string; url: string }[] = [
  { registry: "apnic", label: "APNIC", url: "https://ftp.apnic.net/pub/stats/apnic/delegated-apnic-latest" },
  { registry: "ripencc", label: "RIPE NCC", url: "https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-latest" },
  { registry: "arin", label: "ARIN", url: "https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest" },
  { registry: "lacnic", label: "LACNIC", url: "https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-latest" },
  { registry: "afrinic", label: "AFRINIC", url: "https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-latest" },
];

export type DelegatedRange = { startNum: number; endNum: number; countryCode: string };

/** 파일 내용에서 IPv4 할당 대역만 뽑는다 (주석·요약·IPv6·ASN·미할당 줄은 건너뜀) */
export function parseDelegated(text: string): DelegatedRange[] {
  const out: DelegatedRange[] = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const f = line.trim().split("|");
    if (f.length < 7 || f[2] !== "ipv4") continue;
    const status = f[6];
    if (status !== "allocated" && status !== "assigned") continue;
    const cc = cleanCountry(f[1]);
    const start = ipv4ToNum(f[3]);
    const count = Number(f[4]);
    if (!cc || start === null || !Number.isInteger(count) || count < 1) continue;
    const end = start + count - 1;
    if (end > 4294967295) continue;
    out.push({ startNum: start, endNum: end, countryCode: cc });
  }
  return out;
}
