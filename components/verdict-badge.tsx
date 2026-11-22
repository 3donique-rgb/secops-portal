import { VERDICT_LABEL, type Verdict } from "@/lib/reputation";

const TONE: Record<Verdict, { bg: string; fg: string }> = {
  malicious: { bg: "var(--bad-soft)", fg: "var(--bad)" },
  suspicious: { bg: "var(--warn-soft)", fg: "var(--warn)" },
  harmless: { bg: "var(--ok-soft)", fg: "var(--ok)" },
  unknown: { bg: "#eef1f3", fg: "var(--ink-soft)" },
};

/** 평판 판정 표시. 색만으로 구분하지 않도록 글자를 함께 쓴다. */
export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const t = TONE[verdict];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap" style={{ background: t.bg, color: t.fg }}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: t.fg }} />
      {VERDICT_LABEL[verdict]}
    </span>
  );
}
