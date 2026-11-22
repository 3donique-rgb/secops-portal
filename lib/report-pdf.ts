/**
 * PDF 보고서 생성 (pdfkit + 나눔고딕). 서버에서 만들어 내려받게 한다.
 * 글꼴 파일은 저장소(assets/fonts)에 포함되어 있어 Vercel에서도 그대로 동작한다.
 */
import PDFDocument from "pdfkit";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IndicatorRow } from "./indicator-query";
import { TYPE_LABEL } from "./labels";

export const REPORT_MAX_ROWS = 5000;

export type ReportInput = {
  /** 화면에 보여 줄 조건 요약 (예: ["기간: 2026-11-01 ~ 2026-11-30", "종류: IP, 도메인"]) */
  conditions: string[];
  total: number;
  byType: Record<string, number>;
  bySource: { name: string; n: number }[];
  rows: IndicatorRow[];
  generatedAt: Date;
  generatedBy: string;
};

const M = 40;
const FONT_DIR = path.join(process.cwd(), "assets", "fonts");

let fontCache: Promise<[Buffer, Buffer]> | null = null;
function loadFonts() {
  fontCache ??= Promise.all([
    readFile(path.join(FONT_DIR, "NanumGothic_400Regular.ttf")),
    readFile(path.join(FONT_DIR, "NanumGothic_700Bold.ttf")),
  ]);
  return fontCache;
}

/** 글자 폭을 재서 maxWidth 안에 들어가도록 줄을 나눈다. 띄어쓰기 없는 긴 값(URL·해시)은 글자 단위로 자른다. */
export function wrapText(text: string, width: (s: string) => number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    for (const ch of Array.from(para)) {
      const next = line + ch;
      if (line && width(next) > maxWidth) {
        lines.push(line);
        line = ch;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

const kst = (d: Date, withTime = false) =>
  d.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  });

export async function buildReportPdf(input: ReportInput): Promise<Uint8Array> {
  const [regular, bold] = await loadFonts();
  const doc = new PDFDocument({
    size: "A4",
    margin: M,
    // 기본 글꼴 파일(Helvetica)을 읽지 않도록 처음부터 한글 글꼴 지정 (타입은 경로 문자열만 허용하지만 Buffer도 동작한다)
    font: regular as unknown as string,
    bufferPages: true,
    info: { Title: "위협정보 보고서", Producer: "보안관제 포털", CreationDate: input.generatedAt },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const finished = new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve());
    doc.on("error", reject);
  });

  const gray = "#666666";
  const black = "#1a1a1a";
  const width = doc.page.width - M * 2;
  const bottom = () => doc.page.height - M - 14;
  const font = (b: boolean, size: number) => doc.font(b ? bold : regular).fontSize(size);
  const W = (s: string, b = false, size = 10) => font(b, size).widthOfString(s);

  /** 한 줄(필요하면 여러 줄)을 현재 위치에 쓰고 아래로 내려간다. */
  const line = (s: string, size = 10, b = false, color = black, gap = 4) => {
    for (const l of wrapText(s, (x) => W(x, b, size), width)) {
      if (doc.y > bottom() - size) doc.addPage();
      font(b, size).fillColor(color).text(l, M, doc.y, { lineBreak: false });
      doc.y += size + gap;
      doc.x = M;
    }
  };

  // ---- 표지 요약 ----
  line("위협정보 보고서", 20, true, black, 8);
  line(`작성: ${kst(input.generatedAt, true)}  |  작성자: ${input.generatedBy}`, 9, false, gray, 10);
  doc.y += 6;
  line("조건", 12, true, black, 6);
  for (const c of input.conditions.length > 0 ? input.conditions : ["조건 없음 (전체)"]) line(`• ${c}`, 10);
  doc.y += 8;
  const shown = input.rows.length;
  line("요약", 12, true, black, 6);
  line(`조건에 맞는 위협정보: ${input.total.toLocaleString("ko-KR")}건`, 10);
  if (input.total > shown) {
    line(`※ 한 번에 최대 ${REPORT_MAX_ROWS.toLocaleString("ko-KR")}건까지만 수록합니다. 최근 확인된 ${shown.toLocaleString("ko-KR")}건만 아래에 있습니다. 조건을 좁혀 다시 만드세요.`, 9, false, "#b33a1a");
  }
  doc.y += 4;
  line("종류별 건수", 10, true, black, 4);
  for (const [t, n] of Object.entries(input.byType)) line(`   ${TYPE_LABEL[t] ?? t}: ${n.toLocaleString("ko-KR")}건`, 10);
  doc.y += 4;
  line("제공 기관별 건수 (한 건을 여러 기관이 보냈으면 기관마다 셈)", 10, true, black, 4);
  for (const s of input.bySource.slice(0, 40)) line(`   ${s.name}: ${s.n.toLocaleString("ko-KR")}건`, 10);
  if (input.bySource.length > 40) line(`   … 외 ${input.bySource.length - 40}개 기관`, 9, false, gray);

  // ---- 목록 표 ----
  const cols = [
    { title: "종류", w: 52 },
    { title: "값", w: 218 },
    { title: "제공 기관", w: 135 },
    { title: "최종 확인", w: 62 },
    { title: "상태", w: width - 52 - 218 - 135 - 62 },
  ];
  const size = 8;
  const lh = size + 3;
  const header = () => {
    let x = M;
    for (const c of cols) {
      font(true, size).fillColor(black).text(c.title, x, doc.y, { lineBreak: false });
      x += c.w;
    }
    doc.y += lh;
    doc.moveTo(M, doc.y).lineTo(M + width, doc.y).lineWidth(0.7).strokeColor(gray).stroke();
    doc.y += 4;
  };
  doc.addPage();
  line("위협정보 목록", 12, true, black, 8);
  header();
  for (const r of input.rows) {
    const cells = [
      TYPE_LABEL[r.type] + (r.hashKind ? ` (${r.hashKind})` : ""),
      r.value,
      r.sourceNames.join(", "),
      kst(r.lastSeenAt),
      (r.status === "active" ? "활성" : "비활성") + (r.excluded ? " / SIEM 제외" : ""),
    ].map((t, i) => wrapText(t, (x) => W(x, false, size), cols[i].w - 6));
    const height = Math.max(...cells.map((c) => c.length)) * lh;
    if (doc.y + height > bottom()) {
      doc.addPage();
      header();
    }
    const top = doc.y;
    let x = M;
    cells.forEach((lines, i) => {
      lines.forEach((l, k) => font(false, size).fillColor(black).text(l, x, top + k * lh, { lineBreak: false }));
      x += cols[i].w;
    });
    doc.y = top + height + 1;
    doc.moveTo(M, doc.y).lineTo(M + width, doc.y).lineWidth(0.3).strokeColor("#d9d9d9").stroke();
    doc.y += 3;
  }
  if (input.rows.length === 0) line("조건에 맞는 위협정보가 없습니다.", 10, false, gray);

  // 쪽 번호
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const label = `${i + 1} / ${range.count}`;
    // 아래 여백 안쪽에 쓰면 쪽이 넘어가므로 여백을 잠시 0으로 둔다
    doc.page.margins.bottom = 0;
    font(false, 8).fillColor(gray).text(label, 0, doc.page.height - 28, { width: doc.page.width, align: "center", lineBreak: false });
  }
  doc.end();
  await finished;
  return new Uint8Array(Buffer.concat(chunks));
}
