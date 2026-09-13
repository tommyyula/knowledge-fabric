import { useCallback, useState } from "react";
import type { OntologyStreamEvent } from "@/contracts/ontology";
import { sendOntologyChatStream } from "@/services/api/ontology-chat";

export function useOntologyAssistantRuntime() {
  const [isStreaming, setIsStreaming] = useState(false);

  const send = useCallback(async ({ ontologyId, sessionId, message, onEvent, signal }: {
    ontologyId: string;
    sessionId: string;
    message: string;
    onEvent: (event: OntologyStreamEvent) => void;
    signal?: AbortSignal;
  }) => {
    setIsStreaming(true);
    try {
      await sendOntologyChatStream(ontologyId, sessionId, message, (event) => {
        onEvent(event);
      }, signal);
    } finally {
      setIsStreaming(false);
    }
  }, []);

  return { send, isStreaming };
}
