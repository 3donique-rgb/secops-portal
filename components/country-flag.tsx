import { countryName } from "@/lib/geo";

/** 국기 아이콘 (flag-icons 의 SVG). 이모지 국기는 Windows 에서 글자로 보이므로 쓰지 않는다. */
export function CountryFlag({ code }: { code: string }) {
  const lower = code.toLowerCase();
  if (!/^[a-z]{2}$/.test(lower)) return null;
  return <span className={`fi fi-${lower} rounded-[2px] shadow-[0_0_0_1px_rgb(0_0_0/0.12)]`} role="img" aria-label={countryName(code) || code} title={countryName(code) || code} style={{ width: "1.5em", height: "1.1em", display: "inline-block", verticalAlign: "middle" }} />;
}
