import { RISK_COLOR, RISK_LABEL, type Risk } from "@/lib/risk";

/** 위험등급: 글자 앞에 색깔 원(안전 녹색·주의 황색·위험 적색) */
export function RiskBadge({ risk }: { risk: Risk }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-medium" title={risk.reasons.join("\n")}>
      <span aria-hidden="true" className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ background: RISK_COLOR[risk.level] }} />
      {RISK_LABEL[risk.level]}
    </span>
  );
}
