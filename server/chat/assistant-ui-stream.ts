import type { OntologyStreamEvent } from "../../src/contracts/ontology";

export function encodeAssistantUiEvent(event: OntologyStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
