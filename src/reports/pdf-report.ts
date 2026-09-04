import PDFDocument from "pdfkit";
import type { ReportService } from "./report-service.js";

type GeneratedReport = Awaited<ReturnType<ReportService["generate"]>>;

const colors = {
  ink: "#142235",
  muted: "#5B6878",
  orange: "#E97825",
  pale: "#FFF0E3",
  line: "#E6E4DD",
};

function ensureRoom(document: PDFKit.PDFDocument, height = 100): void {
  if (document.y + height > document.page.height - 58) document.addPage();
}

export async function generateReportPdf(report: GeneratedReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: "LETTER",
      margin: 54,
      bufferPages: true,
      info: {
        Title: `${report.projectSummary.name} — Authority review`,
        Author: "Root Systems Authority Atlas",
        Subject: "AI-agent contract and insurance attention report",
      },
    });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));

    document.rect(0, 0, document.page.width, 14).fill(colors.orange);
    document
      .fillColor(colors.orange)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text("ROOT SYSTEMS  /  AUTHORITY ATLAS", 54, 48, { characterSpacing: 1.2 });
    document
      .fillColor(colors.ink)
      .font("Helvetica-Bold")
      .fontSize(27)
      .text("Agent authority review", 54, 75);
    document
      .fillColor(colors.muted)
      .font("Helvetica")
      .fontSize(11)
      .text(report.projectSummary.name, 54, 112)
      .text(`Agent: ${report.agentSummary.name}`, 54, 130)
      .text(`Generated: ${formatTimestamp(report.generationTimestamp)}`, 54, 148);

    document.roundedRect(54, 182, 504, 90, 10).fill(colors.pale);
    document
      .fillColor(colors.orange)
      .font("Helvetica-Bold")
      .fontSize(31)
      .text(String(report.overallAttentionScore ?? "—"), 74, 201, { width: 85 });
    document.fillColor(colors.muted).fontSize(8).text("ATTENTION / 100", 74, 239, { width: 90 });
    document
      .fillColor(colors.ink)
      .fontSize(14)
      .text(
        String(report.attentionLabel ?? "not scored")
          .replaceAll("_", " ")
          .toUpperCase(),
        180,
        202,
      );
    document
      .fillColor(colors.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(report.executiveSummary, 180, 226, { width: 350, lineGap: 2 });

    document.y = 300;
    document.fillColor(colors.ink).font("Helvetica-Bold").fontSize(17).text("Priority findings");
    document.moveDown(0.6);
    const findings = Object.values(report.findingsBySeverity).flat();
    for (const finding of findings) {
      ensureRoom(document, 160);
      document.strokeColor(colors.line).moveTo(54, document.y).lineTo(558, document.y).stroke();
      document.moveDown(0.8);
      document
        .fillColor(colors.orange)
        .font("Helvetica-Bold")
        .fontSize(8)
        .text(
          `${finding.severity.toUpperCase()}  /  ${finding.category.replaceAll("_", " ").toUpperCase()}`,
        );
      document.fillColor(colors.ink).fontSize(13).text(finding.title, { lineGap: 2 });
      document
        .fillColor(colors.muted)
        .font("Helvetica")
        .fontSize(9)
        .text(finding.analysisExplanation, { lineGap: 2 });
      document.moveDown(0.3);
      document
        .fillColor(colors.ink)
        .font("Helvetica-Bold")
        .text("Professional review question", { continued: false });
      document
        .fillColor(colors.muted)
        .font("Helvetica")
        .text(finding.recommendedReviewQuestions[0] ?? "Professional review is recommended.", {
          lineGap: 2,
        });
      if (finding.evidence[0]) {
        document.moveDown(0.3);
        document
          .fillColor(colors.ink)
          .font("Helvetica-Bold")
          .text("Evidence excerpt", { continued: false });
        document
          .fillColor(colors.muted)
          .font("Helvetica-Oblique")
          .text(`“${finding.evidence[0].excerpt}”`, { lineGap: 2 });
      }
      document.moveDown(0.9);
    }

    ensureRoom(document, 130);
    document.fillColor(colors.ink).font("Helvetica-Bold").fontSize(14).text("Review context");
    document
      .fillColor(colors.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(`Primary jurisdiction: ${report.jurisdictionSelection.primary}`)
      .text(`Jurisdiction support: ${report.jurisdictionSupportLevel.replaceAll("_", " ")}`)
      .text(`Documents analyzed: ${report.analyzedDocuments.length}`)
      .text(`Engine: ${report.analysisEngineVersion}`);

    ensureRoom(document, 100);
    document.moveDown(1.4);
    document
      .fillColor(colors.orange)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text("IMPORTANT LIMITATION");
    document
      .fillColor(colors.muted)
      .font("Helvetica")
      .fontSize(8)
      .text(report.disclaimer, { lineGap: 2 });

    const pageRange = document.bufferedPageRange();
    for (let index = pageRange.start; index < pageRange.start + pageRange.count; index += 1) {
      document.switchToPage(index);
      document
        .fillColor("#8A939E")
        .font("Helvetica")
        .fontSize(7)
        .text(`Authority Atlas  •  Page ${index + 1} of ${pageRange.count}`, 54, 742, {
          width: 504,
          align: "right",
        });
    }
    document.end();
  });
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" });
}
