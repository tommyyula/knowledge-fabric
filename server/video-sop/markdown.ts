import type { SopResult } from "./schemas";
import type { VideoSopJobRecord, VideoSopLanguage } from "./types";

interface Labels {
  ticketId: string;
  ticketInference: string;
  inferenceNote: string;
  sourceVideos: string;
  generatedAt: string;
  category: string;
  summary: string;
  systems: string;
  preconditions: string;
  procedure: string;
  action: string;
  system: string;
  page: string;
  details: string;
  parameters: string;
  name: string;
  value: string;
  source: string;
  description: string;
  required: string;
  yes: string;
  no: string;
  notes: string;
  crossScreen: string;
  notDetected: string;
  provided: string;
  detected: string;
  inferredNone: string;
}

const labels: Record<VideoSopLanguage, Labels> = {
  zh: {
    ticketId: "Ticket ID",
    ticketInference: "Ticket 识别方式",
    inferenceNote: "识别说明",
    sourceVideos: "源视频",
    generatedAt: "生成时间",
    category: "分类",
    summary: "摘要",
    systems: "涉及系统",
    preconditions: "前置条件",
    procedure: "操作步骤",
    action: "操作",
    system: "系统",
    page: "页面",
    details: "详细说明",
    parameters: "参数",
    name: "名称",
    value: "值",
    source: "来源",
    description: "说明",
    required: "必填",
    yes: "是",
    no: "否",
    notes: "注意事项",
    crossScreen: "跨屏操作",
    notDetected: "未识别",
    provided: "用户指定",
    detected: "AI 自动识别",
    inferredNone: "未识别 Ticket，基于完整操作流程生成",
  },
  en: {
    ticketId: "Ticket ID",
    ticketInference: "Ticket identification",
    inferenceNote: "Identification note",
    sourceVideos: "Source videos",
    generatedAt: "Generated at",
    category: "Category",
    summary: "Summary",
    systems: "Systems Involved",
    preconditions: "Preconditions",
    procedure: "Procedure",
    action: "Action",
    system: "System",
    page: "Page",
    details: "Details",
    parameters: "Parameters",
    name: "Name",
    value: "Value",
    source: "Source",
    description: "Description",
    required: "Required",
    yes: "Yes",
    no: "No",
    notes: "Notes",
    crossScreen: "Cross-screen Operations",
    notDetected: "Not detected",
    provided: "Provided by user",
    detected: "Detected by AI",
    inferredNone: "No ticket was detected; generated from the complete workflow",
  },
  ja: {
    ticketId: "Ticket ID",
    ticketInference: "Ticket の識別方法",
    inferenceNote: "識別メモ",
    sourceVideos: "ソース動画",
    generatedAt: "生成日時",
    category: "カテゴリ",
    summary: "概要",
    systems: "関連システム",
    preconditions: "前提条件",
    procedure: "操作手順",
    action: "操作",
    system: "システム",
    page: "ページ",
    details: "詳細",
    parameters: "パラメータ",
    name: "名前",
    value: "値",
    source: "取得元",
    description: "説明",
    required: "必須",
    yes: "はい",
    no: "いいえ",
    notes: "注意事項",
    crossScreen: "画面間操作",
    notDetected: "未検出",
    provided: "ユーザー指定",
    detected: "AI 自動検出",
    inferredNone: "Ticket を検出できなかったため、操作全体から生成",
  },
};

function tableCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

function list(values: string[]): string[] {
  return values.length ? values.map((value) => `- ${value}`) : ["- —"];
}

export function renderVideoSopMarkdown(
  job: VideoSopJobRecord,
  result: SopResult,
  generatedAt: Date,
): string {
  const text = labels[job.language];
  const inference = result.ticketInference === "provided"
    ? text.provided
    : result.ticketInference === "detected"
      ? text.detected
      : text.inferredNone;
  const lines = [
    `# ${result.title}`,
    "",
    `- **${text.ticketId}:** ${result.ticketId || text.notDetected}`,
    `- **${text.ticketInference}:** ${inference}`,
    `- **${text.category}:** ${result.category}`,
    `- **${text.generatedAt}:** ${generatedAt.toISOString()}`,
    `- **${text.sourceVideos}:** ${job.videoNames.map(tableCell).join(", ")}`,
  ];
  if (result.inferenceNote) lines.push(`- **${text.inferenceNote}:** ${result.inferenceNote}`);

  lines.push(
    "",
    `## ${text.summary}`,
    "",
    result.summary,
    "",
    `## ${text.systems}`,
    "",
    ...list(result.systems_involved),
    "",
    `## ${text.preconditions}`,
    "",
    ...list(result.preconditions),
    "",
    `## ${text.procedure}`,
  );

  for (const step of result.steps) {
    lines.push(
      "",
      `### ${step.stepNumber}. ${step.action}`,
      "",
      `- **${text.system}:** ${step.system}`,
      `- **${text.page}:** ${step.page}`,
      `- **${text.details}:** ${step.details}`,
    );
    if (step.parameters.length) {
      lines.push(
        "",
        `#### ${text.parameters}`,
        "",
        `| ${text.name} | ${text.value} | ${text.source} | ${text.description} | ${text.required} |`,
        "| --- | --- | --- | --- | --- |",
        ...step.parameters.map(
          (parameter) =>
            `| ${tableCell(parameter.name)} | ${tableCell(parameter.value)} | ${tableCell(parameter.source)} | ${tableCell(parameter.description)} | ${parameter.required ? text.yes : text.no} |`,
        ),
      );
    }
  }

  lines.push(
    "",
    `## ${text.notes}`,
    "",
    ...list(result.notes),
    "",
    `## ${text.crossScreen}`,
    "",
    ...list(result.cross_screen_operations),
    "",
  );
  return lines.join("\n");
}
