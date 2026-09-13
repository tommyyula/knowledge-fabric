export const slashCommandIds = [
  "query",
  "operate",
  "ingest",
  "ontology-distill",
] as const;

export type SlashCommandId = typeof slashCommandIds[number];

export interface SlashCommandDefinition {
  id: SlashCommandId;
  command: string;
  labelKey: string;
  descriptionKey: string;
  triggerExample: string;
  explicitPattern: RegExp;
}

export const slashCommandDefinitions: readonly SlashCommandDefinition[] = [
  {
    id: "query",
    command: "query",
    labelKey: "slash.query.label",
    descriptionKey: "slash.query.description",
    triggerExample: "query:",
    explicitPattern: /^\s*query\s*:/i,
  },
  {
    id: "operate",
    command: "operate",
    labelKey: "slash.operate.label",
    descriptionKey: "slash.operate.description",
    triggerExample: "operate:",
    explicitPattern: /^\s*operate\s*:/i,
  },
  {
    id: "ingest",
    command: "ingest",
    labelKey: "slash.ingest.label",
    descriptionKey: "slash.ingest.description",
    triggerExample: "ingest:",
    explicitPattern: /^\s*ingest\s*:/i,
  },
  {
    id: "ontology-distill",
    command: "ontology-distill",
    labelKey: "slash.ontology.label",
    descriptionKey: "slash.ontology.description",
    triggerExample: "ontology distill:",
    explicitPattern: /^\s*ontology\s+distill\s*:/i,
  },
];

export function slashCommandById(id: SlashCommandId | null | undefined): SlashCommandDefinition | undefined {
  return id ? slashCommandDefinitions.find((command) => command.id === id) : undefined;
}

export function applySlashCommandTriggerPrefix(message: string, commandId: SlashCommandId | null | undefined): string {
  const trimmed = message.trim();
  const command = slashCommandById(commandId);
  if (!trimmed || !command) return trimmed;
  if (command.explicitPattern.test(trimmed)) return trimmed;
  return `${command.triggerExample} ${trimmed}`;
}
