import { useState, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Project, journeyConversation, ChatMessage } from "../mocks/data";
import { useCreateOntologySession, useOntologyMessages } from "@/hooks/useOntologies";
import { useOntologyAssistantRuntime } from "@/hooks/useOntologyAssistantRuntime";
import { Attachment } from "@/components/assistant-ui/attachment";
import { OntologyThread, type OntologyThreadMessage } from "@/components/assistant-ui/thread";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { uploadOntologyFile } from "@/services/api/ontology";

interface ChatPanelProps {
  project: Project | null;
  projects: Project[];
  currentSessionId: string | null;
  onSessionReady: (sessionId: string) => void;
  onSelectProject: (project: Project) => void;
  onNewOntology: () => void;
  backendUnavailable?: boolean;
  onToggleKnowledge: () => void;
  knowledgeOpen: boolean;
  isBuilding: boolean;
  autoStartJourney: boolean;
  onPhaseUpdate: (msg: ChatMessage) => void;
}

type Message = OntologyThreadMessage;
type AttachedFile = { id: string; name: string; path?: string; status: "uploading" | "ready" | "error"; error?: string };

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function createTypewriter({ ensureMessage, appendText }: { ensureMessage: () => void; appendText: (text: string) => void }) {
  let buffer = "";
  let timer: number | null = null;
  const waiters = new Set<() => void>();

  const resolveWaiters = () => {
    if (buffer || timer !== null) return;
    for (const resolve of waiters) resolve();
    waiters.clear();
  };

  const flushTick = () => {
    if (!buffer) {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      resolveWaiters();
      return;
    }
    ensureMessage();
    const chunkSize = buffer.length > 240 ? 18 : buffer.length > 80 ? 10 : 4;
    const chunk = buffer.slice(0, chunkSize);
    buffer = buffer.slice(chunk.length);
    appendText(chunk);
  };

  const start = () => {
    if (timer !== null) return;
    timer = window.setInterval(flushTick, 18);
  };

  return {
    push(text: string) {
      if (!text) return;
      buffer += text;
      start();
    },
    flushNow() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      if (!buffer) return;
      ensureMessage();
      const rest = buffer;
      buffer = "";
      appendText(rest);
      resolveWaiters();
    },
    drain() {
      if (!buffer && timer === null) return Promise.resolve();
      start();
      return new Promise<void>((resolve) => waiters.add(resolve));
    },
  };
}

export default function ChatPanel({ project, projects, currentSessionId, onSessionReady, onSelectProject, onNewOntology, backendUnavailable = false, onToggleKnowledge, knowledgeOpen, isBuilding, autoStartJourney, onPhaseUpdate }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [journeyIdx, setJourneyIdx] = useState(0);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [commandChips, setCommandChips] = useState<string[]>([]);
  const [inSession, setInSession] = useState(false);
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null);
  const [enteredFromHub, setEnteredFromHub] = useState(false);
  const [showResourcePicker, setShowResourcePicker] = useState(false);
  const [activityOpen, setActivityOpen] = useState<Record<number, boolean>>({});
  const [showConnectorPopover, setShowConnectorPopover] = useState(false);
  const [connectorStates, setConnectorStates] = useState<Record<string, boolean>>({
    github: true, gmail: true, outlook: false, slack: false, jira: true, notion: false, "google-calendar": false, "google-drive": false,
  });

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const historyQuery = useOntologyMessages(project?.id, currentSessionId);
  const createSession = useCreateOntologySession();
  const runtime = useOntologyAssistantRuntime();
  const queryClient = useQueryClient();
  const allowMockFallback = import.meta.env.VITE_ENABLE_MOCK_FALLBACK === "true";
  const abortRef = useRef<AbortController | null>(null);
  const autoStartedRef = useRef(false);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);
  useEffect(() => {
    if (!currentSessionId) {
      setMessages([]);
      return;
    }
    if (!historyQuery.isSuccess || loading) return;
    setMessages((historyQuery.data ?? []).map((m) => ({ role: m.role === "user" ? "user" : "agent", content: m.content })));
  }, [currentSessionId, historyQuery.data, historyQuery.isSuccess, loading]);
  useEffect(() => {
    if (!autoStartJourney) {
      autoStartedRef.current = false;
      return;
    }
    if (autoStartedRef.current || messages.length !== 0 || journeyIdx !== 0 || loading) return;
    if (!project && !allowMockFallback) return;
    autoStartedRef.current = true;
    startJourneyInternal();
  }, [autoStartJourney, allowMockFallback, journeyIdx, loading, messages.length, project?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.filename) {
        setAttachedFiles((prev) => prev.includes(detail.filename) ? prev : [...prev, detail.filename]);
        inputRef.current?.focus();
      }
    };
    window.addEventListener("insertFileReference", onReference);
    return () => window.removeEventListener("insertFileReference", onReference);
  }, []);

  const startJourneyInternal = () => {
    if (!project && !allowMockFallback) {
      return;
    }
    if (project) {
      setMessages((prev) => prev.length ? prev : [{ role: "agent", content: "Ontology workspace is ready. The initial wiki is seeded from the Claude agent skills directory; send a task to run it through the managed backend." }]);
      onPhaseUpdate({ role: "agent", content: "ready", phaseTransition: "ready" });
      return;
    }
    setLoading(true);
    const first = journeyConversation[0];
    setTimeout(() => { setMessages([{ role: "agent", content: first.content }]); onPhaseUpdate(first); setJourneyIdx(1); setLoading(false); }, 500);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Backspace" && !input) {
      const el = inputRef.current;
      if (el && el.offsetHeight > 38) {
        el.style.height = "auto";
        return;
      }
      if (attachedFiles.length > 0) {
        e.preventDefault();
        setAttachedFiles((prev) => prev.slice(0, -1));
      } else if (commandChips.length > 0) {
        e.preventDefault();
        setCommandChips((prev) => prev.slice(0, -1));
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
  };

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files?.length) return;
    const selected = Array.from(files);
    if (!project || project.id.startsWith("proj-")) {
      setAttachedFiles((prev) => [...prev, ...selected.map((file) => ({ id: `${file.name}-${file.lastModified}-${Math.random()}`, name: file.name, status: "ready" as const }))]);
      return;
    }

    for (const file of selected) {
      const id = `${file.name}-${file.lastModified}-${Math.random()}`;
      setAttachedFiles((prev) => [...prev, { id, name: file.name, status: "uploading" }]);
      try {
        if (file.size > 5 * 1024 * 1024) throw new Error("File is larger than 5 MB");
        const uploaded = await uploadOntologyFile(project.id, { name: file.name, contentBase64: await fileToBase64(file), contentType: file.type || undefined, targetDir: "raw" });
        setAttachedFiles((prev) => prev.map((item) => item.id === id ? { ...item, path: uploaded.path, status: "ready" } : item));
        void queryClient.invalidateQueries({ queryKey: ["ontology-tree", project.id] });
      } catch (err) {
        setAttachedFiles((prev) => prev.map((item) => item.id === id ? { ...item, status: "error", error: err instanceof Error ? err.message : String(err) } : item));
      }
    }
  };

  const advanceJourney = (fromIdx: number) => {
    let idx = fromIdx;
    const playNext = () => {
      if (idx >= journeyConversation.length) { setLoading(false); return; }
      const msg = journeyConversation[idx];
      if (msg.role === "agent") {
        setTimeout(() => {
          setMessages((prev) => [...prev, { role: "agent", content: msg.content }]);
          onPhaseUpdate(msg);
          idx++;
          if (idx < journeyConversation.length && journeyConversation[idx].role === "agent") playNext();
          else { setLoading(false); setJourneyIdx(idx); }
        }, 700);
      } else { setLoading(false); setJourneyIdx(idx); }
    };
    playNext();
  };

  const send = () => {
    const prompt = input.trim();
    if (!prompt && attachedFiles.length === 0 && commandChips.length === 0) return;
    if (loading) return;

    const currentAttachments = attachedFiles.length > 0 ? [...attachedFiles] : undefined;
    const fullPrompt = commandChips.length > 0 ? `${commandChips.join(" ")} ${prompt}`.trim() : prompt;
    setInput("");
    setAttachedFiles([]);
    setCommandChips([]);
    if (inputRef.current) inputRef.current.style.height = "auto";

    // Enter session mode if not already
    if (!inSession) {
      setInSession(true);
      if (project && projectSessions.length > 0) {
        setEnteredFromHub(true);
      }
      onNewSession(prompt || (currentAttachments ? `已上传 ${currentAttachments.join(", ")}` : ""));
    }

    // Add user message
    setMessages((prev) => [...prev, { role: "user", content: prompt, attachments: currentAttachments }]);
    setLoading(true);

    if (project && !project.id.startsWith("proj-")) {
      try {
        const sessionId = currentSessionId ?? (await createSession.mutateAsync(project.id)).id;
        if (!currentSessionId) onSessionReady(sessionId);
        const assistantIndexRef = { current: -1 };
        const sawTextDeltaRef = { current: false };
        const typewriter = createTypewriter({
          ensureMessage: () => {
            if (assistantIndexRef.current >= 0) return;
            setMessages((prev) => {
              if (assistantIndexRef.current >= 0) return prev;
              assistantIndexRef.current = prev.length;
              return [...prev, { role: "agent", content: "" }];
            });
          },
          appendText: (text) => {
            setMessages((prev) => prev.map((msg, idx) => idx === assistantIndexRef.current ? { ...msg, content: msg.content + text } : msg));
          },
        });
        const controller = new AbortController();
        abortRef.current = controller;

        await runtime.send({
          ontologyId: project.id,
          sessionId,
          message: backendPrompt,
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === "text-delta") {
              sawTextDeltaRef.current = true;
              typewriter.push(event.delta);
            }
            if (event.type === "tool") {
              typewriter.flushNow();
              setMessages((prev) => [...prev, { role: "tool", toolName: event.tool, content: JSON.stringify(event.input ?? {}, null, 2) }]);
              assistantIndexRef.current = -1;
            }
            if (event.type === "message" && !sawTextDeltaRef.current) {
              typewriter.push(event.message.content);
            }
            if (event.type === "journey-state") {
              const content = assistantIndexRef.current >= 0 ? "Journey updated from Claude run." : "Claude run updated journey state.";
              onPhaseUpdate({ role: "agent", content, phaseTransition: event.state.phase, phaseData: { type: "bootstrap", state: event.state.bootstrap } });
              onPhaseUpdate({ role: "agent", content, phaseData: { type: "ingest", state: event.state.ingest } });
              onPhaseUpdate({ role: "agent", content, phaseData: { type: "verify", state: event.state.verify } });
            }
            if (event.type === "error") {
              typewriter.flushNow();
              setMessages((prev) => [...prev, { role: "agent", content: `Backend chat failed: ${event.error}` }]);
            }
          },
        });
        await typewriter.drain();
        void queryClient.invalidateQueries({ queryKey: ["ontology-sessions", project.id] });
        void queryClient.invalidateQueries({ queryKey: ["ontology-tree", project.id] });
        void queryClient.invalidateQueries({ queryKey: ["journey", project.id] });
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setMessages((prev) => [...prev, { role: "agent", content: `Backend chat failed: ${err instanceof Error ? err.message : String(err)}` }]);
        }
      } finally {
        abortRef.current = null;
        setAttachedFiles([]);
        setLoading(false);
      }
      return;
    }

    if (!allowMockFallback) {
      setMessages((prev) => [...prev, { role: "agent", content: backendUnavailable ? "Backend is unavailable. Start `pnpm dev:server` and retry, or enable `VITE_ENABLE_MOCK_FALLBACK=true` for fixture mode." : "Create or select a backend ontology first." }]);
      setLoading(false);
      return;
    }

    if (journeyIdx < journeyConversation.length) {
      let nextIdx = journeyIdx;
      if (nextIdx < journeyConversation.length && journeyConversation[nextIdx].role === "user") nextIdx++;
      advanceJourney(nextIdx);
    } else {
      // Free chat mode - simple mock response
      const isUntitled = !project;
      setTimeout(() => {
        // Auto-generate title from first user message when no project selected
        if (isUntitled && messages.length === 0) {
          const title = fullPrompt.length > 20 ? fullPrompt.slice(0, 20) + "..." : fullPrompt;
          onAutoTitle(title);
        }
        setMessages((prev) => [...prev, {
          role: "agent",
          content: `已收到指令: "${fullPrompt}"。操作已模拟完成。`,
        }]);
        setLoading(false);
      }, 1000);
    }
  };

  const showWelcome = messages.length === 0 && journeyIdx === 0;

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-header-info">
          {showBackBtn && (
            <button className="chat-back-btn" onClick={onBackToHub} aria-label="Back to conversations">
              <svg viewBox="0 0 24 24" width="14" height="14"><path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          )}
          {project ? (
            <span className="chat-project-name">{project.emoji} {project.name}</span>
          ) : inSession ? (
            <span className="chat-project-name">📝 {buildingName || t("plus.untitledOntology")}</span>
          ) : null}
        </div>
        <div className="chat-header-actions">
          {!knowledgeOpen && (
            <button
              className="chat-knowledge-toggle"
              onClick={onToggleKnowledge}
              aria-label={isBuilding ? "Toggle design artifacts" : "Toggle ontology artifacts"}
            >
              {isBuilding ? (
                <>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>
                  {t("chat.designArtifacts")}
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9.5 8h5"/><path d="M9.5 12H16"/><path d="M9.5 16H14"/></svg>
                  {t("chat.ontologyArtifacts")}
                </>
              )}
            </button>
          )}
        </div>
      </div>

      <div className="chat-messages">
        {showHub && (
          <div className="chat-hub">
            <div className={`chat-hub-header${hubSearchOpen ? " search-open" : ""}`}>
              {hubSearchOpen ? (
                <div className="search-expansion-layer chat-hub-search-layer">
                  <div className="search-expansion-field chat-hub-search-field">
                    <svg viewBox="0 0 24 24" width="18" height="18"><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" strokeWidth="2"/><path d="M21 21l-4.35-4.35" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                    <input
                      type="text"
                      value={hubSearch}
                      onChange={(e) => setHubSearch(e.target.value)}
                      placeholder={t("common.search")}
                      autoFocus
                    />
                  </div>
                  <button className="search-expansion-cancel chat-hub-search-cancel" onClick={() => { setHubSearchOpen(false); setHubSearch(""); }} type="button">{t("common.cancel")}</button>
                </div>
              ) : (
                <>
                  <h2>{t("chat.conversations")}</h2>
                  <button
                    className="chat-hub-search-btn"
                    onClick={() => setHubSearchOpen(true)}
                    aria-label="Search conversations"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16"><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" strokeWidth="2"/><path d="M21 21l-4.35-4.35" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  </button>
                </>
              )}
            </div>
            <div className="chat-hub-list-container">
              {filteredSessions.length === 0 ? (
                <div className="chat-hub-empty">
                  <p>{projectSessions.length === 0 ? "No conversations yet. Start typing below to begin." : "No matching conversations."}</p>
                </div>
              ) : (
                <div className="chat-hub-list">
                  {filteredSessions.map((s) => (
                    <div
                      key={s.id}
                      className="chat-hub-item"
                      onClick={() => { setEnteredFromHub(true); onSelectSession(s.id); }}
                    >
                      <div className="chat-hub-item-icon">
                        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      </div>
                      <span className="chat-hub-item-title">{s.preview}</span>
                      <span className="chat-hub-item-time">{s.timeAgo}</span>
                      <div className="chat-hub-item-actions">
                        <button
                          className="chat-hub-item-more"
                          onClick={(e) => { e.stopPropagation(); setSessionMenuId(sessionMenuId === s.id ? null : s.id); }}
                          aria-label="More options"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <circle cx="5" cy="12" r="1.5"/>
                            <circle cx="12" cy="12" r="1.5"/>
                            <circle cx="19" cy="12" r="1.5"/>
                          </svg>
                        </button>
                        {sessionMenuId === s.id && (
                          <>
                            <div className="chat-hub-menu-backdrop" onClick={(e) => { e.stopPropagation(); setSessionMenuId(null); }} />
                            <div className="chat-hub-menu">
                              <button className="chat-hub-menu-item" onClick={(e) => { e.stopPropagation(); setSessionMenuId(null); const name = prompt("Rename:", s.preview); if (name) { /* TODO */ } }}>
                                <svg viewBox="0 0 24 24" width="15" height="15"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                <span>Rename</span>
                              </button>
                              <button className="chat-hub-menu-item" onClick={(e) => { e.stopPropagation(); setSessionMenuId(null); /* TODO: pin */ }}>
                                <svg viewBox="0 0 24 24" width="15" height="15"><path d="M15 4.5l-4 4L7 10l-1.5 1.5 7 7L14 17l1.5-4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M9 15l-4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                <span>Pin to top</span>
                              </button>
                              <div className="chat-hub-menu-divider" />
                              <button className="chat-hub-menu-item chat-hub-menu-item-danger" onClick={(e) => { e.stopPropagation(); setSessionMenuId(null); /* TODO: delete */ }}>
                                <svg viewBox="0 0 24 24" width="15" height="15"><path d="M3 6h18M8 6V4h8v2M5 6v14a2 2 0 002 2h10a2 2 0 002-2V6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                <span>Delete</span>
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {showWelcome && (
          <div className="chat-welcome">
            <h1>{project ? t("chat.welcome.titleWithProject", { name: project.name }) : t("chat.welcome.title")}</h1>
            <p>{project ? t("chat.welcome.subtitleWithProject") : t("chat.welcome.subtitle")}</p>
            <div className="chat-suggestions">
              {!project && (
                <button className="chat-suggestion" onClick={startJourney}>
                  {t("chat.createNew")}
                </button>
              )}
              {!project && (
                <button className="chat-suggestion" onClick={() => { setPickerAction("ask"); setShowOntologyPicker(true); }}>
                  {t("chat.askAboutOntology")}
                </button>
              )}
              {!project && (
                <button className="chat-suggestion" onClick={() => { setPickerAction("ingest"); setShowOntologyPicker(true); }}>
                  {t("chat.ingestResources")}
                </button>
              )}
              {project && (
                <>
                  <button className="chat-suggestion" onClick={() => setCommandChips((prev) => prev.includes("query") ? prev : [...prev, "query"])}>
                    {t("chat.askQuestion")}
                  </button>
                  <button className="chat-suggestion" onClick={() => setCommandChips((prev) => prev.includes("ingest") ? prev : [...prev, "ingest"])}>
                    {t("chat.ingestDocument")}
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`chat-msg chat-msg-${msg.role}`}>
            {msg.role === "user" ? (
              <div className="chat-msg-user-bubble">
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="chat-msg-attachments">
                    {msg.attachments.map((f, j) => (
                      <div key={j} className="chat-msg-attachment-chip">
                        <svg viewBox="0 0 24 24" width="12" height="12"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M13 2v7h7" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>
                        <span>{f}</span>
                      </div>
                    ))}
                  </div>
                )}
                {msg.content}
              </div>
            ) : (
              <div className="chat-msg-agent-content">
                {msg.steps && msg.steps.length > 0 && (
                  <div className="chat-activity">
                    <button className="chat-activity-toggle" onClick={() => setActivityOpen((prev) => ({ ...prev, [i]: !prev[i] }))}>
                      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      <span>{msg.steps.length} steps</span>
                      <svg className={`chat-activity-chevron${activityOpen[i] ? " open" : ""}`} viewBox="0 0 24 24" width="12" height="12"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                    {activityOpen[i] && (
                      <div className="chat-activity-items">
                        {msg.steps.map((step, j) => (
                          <div key={j} className="chat-activity-item">
                            <span className="chat-activity-item-icon">{step.icon}</span>
                            <span className="chat-activity-item-text">{step.text}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="loading-dots">
            <span className="loading-dot" />
            <span className="loading-dot" />
            <span className="loading-dot" />
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {showHub && (
        <div className="chat-hub-suggestions">
          <button className="chat-suggestion" onClick={() => setCommandChips((prev) => prev.includes("query") ? prev : [...prev, "query"])}>
            {t("chat.askQuestion")}
          </button>
          <button className="chat-suggestion" onClick={() => setCommandChips((prev) => prev.includes("ingest") ? prev : [...prev, "ingest"])}>
            {t("chat.ingestDocument")}
          </button>
        </div>
      )}

      <div className="chat-input-area">
        <div className="chat-input-bar">
          {(commandChips.length > 0 || attachedFiles.length > 0) && (
            <div className="chat-attached-files">
              {commandChips.map((cmd, i) => (
                <div key={`cmd-${i}`} className="chat-attached-chip chat-command-chip">
                  <span className="chat-attached-icon">
                    <svg viewBox="0 0 24 24" width="12" height="12"><path d="M4 17l6-6-6-6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M12 19h8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
                  </span>
                  <span className="chat-attached-name">{cmd}</span>
                  <button className="chat-attached-remove" onClick={() => setCommandChips((prev) => prev.filter((_, idx) => idx !== i))}>&times;</button>
                </div>
              ))}
              {attachedFiles.map((f, i) => {
                const { icon } = getFileIcon(f, folders);
                return (
                  <div key={`file-${i}`} className="chat-attached-chip">
                    <span className="chat-attached-icon">{icon}</span>
                    <span className="chat-attached-name">{f}</span>
                    <button className="chat-attached-remove" onClick={() => setAttachedFiles((prev) => prev.filter((_, idx) => idx !== i))}>&times;</button>
                  </div>
                );
              })}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={project ? t("chat.placeholderWithProject") : t("chat.placeholder")}
            rows={1}
          />
          <div className="chat-input-toolbar">
            <div className="chat-input-toolbar-left">
              <div className="chat-plus-wrapper">
                <button className="chat-input-action" onClick={() => { setShowPlusMenu(!showPlusMenu); setShowOntologyPicker(false); }} aria-label="Add">
                  <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                </button>
                {(showPlusMenu || showOntologyPicker) && (
                  <div className="chat-plus-backdrop" onClick={() => { setShowPlusMenu(false); setShowOntologyPicker(false); setPickerAction(null); }} />
                )}
                {showPlusMenu && (
                  <div className="chat-plus-menu">
                    <div className="chat-plus-menu-item" onClick={() => { fileInputRef.current?.click(); setShowPlusMenu(false); setShowOntologyPicker(false); }}>
                      <svg viewBox="0 0 24 24" width="16" height="16"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      <span>{t("plus.uploadFile")}</span>
                    </div>
                    <div className="chat-plus-menu-item" onClick={() => { setShowResourcePicker(true); setShowPlusMenu(false); setShowOntologyPicker(false); }}>
                      <svg viewBox="0 0 24 24" width="16" height="16"><rect width="20" height="5" x="2" y="3" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 8v11a2 2 0 002 2h2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M20 8v11a2 2 0 01-2 2h-2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M9 15l3-3 3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M12 12v9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      <span>{t("plus.fromResourceLib")}</span>
                    </div>
                    <div className="chat-plus-menu-divider" />
                    <div className="chat-plus-menu-item" onClick={() => { setShowOntologyPicker(!showOntologyPicker); }}>
                      <svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 19.5A2.5 2.5 0 016.5 17H20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      <span>{t("plus.ontology")}</span>
                      <svg className="chat-plus-menu-arrow" viewBox="0 0 24 24" width="12" height="12"><path d="M9 18l6-6-6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </div>
                  </div>
                )}
                {showOntologyPicker && (
                  <div className={`chat-plus-submenu${showPlusMenu ? "" : " standalone"}`}>
                    {mockProjects.map((p) => (
                      <div
                        key={p.id}
                        className={`chat-plus-menu-item${project?.id === p.id ? " active" : ""}`}
                        onClick={() => {
                          if (pickerAction) {
                            onSelectProject(p);
                            setCommandChips((prev) => {
                              const cmd = pickerAction === "ask" ? "query" : "ingest";
                              return prev.includes(cmd) ? prev : [...prev, cmd];
                            });
                            setPickerAction(null);
                          } else {
                            onSelectProject(p);
                          }
                          setShowPlusMenu(false);
                          setShowOntologyPicker(false);
                        }}
                      >
                        <span className="chat-plus-project-emoji">{p.emoji}</span>
                        <span>{p.name}</span>
                        {project?.id === p.id && <span className="chat-plus-check">&#10003;</span>}
                      </div>
                    ))}
                    <div className="chat-plus-menu-divider" />
                    <div className="chat-plus-menu-item" onClick={() => { onNewOntologyDirect(); setShowPlusMenu(false); setShowOntologyPicker(false); }}>
                      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                      <span>{t("plus.newOntology")}</span>
                    </div>
                  </div>
                )}
              </div>
              <div className="chat-connector-wrapper">
                <button className="chat-input-action" onClick={() => setShowConnectorPopover(!showConnectorPopover)} aria-label="Connectors">
                  <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 22v-5M9 8V2M15 8V2M7 8h10v4a5 5 0 01-10 0V8z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
                {showConnectorPopover && (
                  <>
                    <div className="chat-connector-backdrop" onClick={() => setShowConnectorPopover(false)} />
                    <div className="chat-connector-popover">
                      {[
                        { id: "github", name: "GitHub", icon: <svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg> },
                        { id: "gmail", name: "Gmail", icon: <svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M22 6l-10 7L2 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg> },
                        { id: "outlook", name: "Outlook", icon: <svg viewBox="0 0 24 24" width="16" height="16"><rect x="2" y="4" width="20" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M8 2v4M16 2v4M2 10h20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg> },
                        { id: "jira", name: "Jira", icon: <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2L2 12l10 10 10-10L12 2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M12 8v8M8 12h8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg> },
                        { id: "notion", name: "Notion", icon: <svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 4h16v16H4z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M8 8h4v4H8zM14 8h2M14 12h2M8 16h8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg> },
                        { id: "slack", name: "Slack", icon: <svg viewBox="0 0 24 24" width="16" height="16"><path d="M14.5 10c-.83 0-1.5-.67-1.5-1.5v-5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5z" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg> },
                      ].map((svc) => (
                        <div key={svc.id} className="chat-connector-item">
                          <span className="chat-connector-item-icon">{svc.icon}</span>
                          <span className="chat-connector-item-name">{svc.name}</span>
                          <label className="chat-connector-toggle">
                            <input
                              type="checkbox"
                              checked={connectorStates[svc.id] || false}
                              onChange={() => setConnectorStates((prev) => ({ ...prev, [svc.id]: !prev[svc.id] }))}
                            />
                            <span className="chat-connector-toggle-track" />
                          </label>
                        </div>
                      ))}
                      <div className="chat-connector-divider" />
                      <div className="chat-connector-manage" onClick={() => { setShowConnectorPopover(false); if (onOpenConnectors) onOpenConnectors(); }}>
                        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" fill="none" stroke="currentColor" strokeWidth="1.5"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>
                        <span>{t("connector.manage")}</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
              {project ? (
                <div className="chat-project-chip" onClick={() => { setShowOntologyPicker(!showOntologyPicker); setShowPlusMenu(false); }}>
                  <span className="chat-project-chip-emoji">{project.emoji}</span>
                  <span className="chat-project-chip-name">{project.name}</span>
                </div>
              ) : inSession && (
                <div className="chat-project-chip" onClick={() => { setShowOntologyPicker(!showOntologyPicker); setShowPlusMenu(false); }}>
                  <span className="chat-project-chip-emoji">📝</span>
                  <span className="chat-project-chip-name">{buildingName || t("plus.untitledOntology")}</span>
                </div>
              )}
            </div>
            <div className="chat-input-toolbar-right">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  const files = e.target.files;
                  if (files) {
                    Array.from(files).forEach((f) => {
                      setAttachedFiles((prev) => [...prev, f.name]);
                      onAddResource({
                        id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        name: f.name,
                        type: "file",
                        description: t("common.uploadedFile"),
                        lastSynced: t("common.justNow"),
                        status: "unused",
                        linkedOntologies: [],
                        size: f.size,
                        source: "upload",
                      });
                    });
                  }
                  e.target.value = "";
                }}
              />
              <button className="chat-input-action" aria-label="Voice input">
                <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              {loading ? (
                <button className="stop-btn" aria-label="Stop">
                  <svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                </button>
              ) : (
                <button className="send-btn" onClick={send} disabled={!input.trim() && attachedFiles.length === 0}>
                  <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {showResourcePicker && (
        <ResourcePicker
          resources={resources}
          folders={folders}
          onConfirm={(selected) => {
            const selectedFolderIds = new Set<string>();
            selected.forEach((r) => { if (r.folder) selectedFolderIds.add(r.folder); });

            const folderNames: string[] = [];
            const fileNames: string[] = [];

            selectedFolderIds.forEach((folderId) => {
              const folder = folders.find((f) => f.id === folderId);
              const folderFiles = resources.filter((r) => r.folder === folderId);
              const allSelected = folderFiles.every((r) => selected.some((s) => s.id === r.id));
              if (allSelected && folder) {
                folderNames.push(folder.name);
              } else {
                selected.filter((r) => r.folder === folderId).forEach((r) => fileNames.push(r.name));
              }
            });
            selected.filter((r) => !r.folder).forEach((r) => fileNames.push(r.name));

            setAttachedFiles((prev) => [...prev, ...folderNames, ...fileNames]);
            setShowResourcePicker(false);
          }}
          onUpload={(resource) => {
            onAddResource(resource);
          }}
          onClose={() => setShowResourcePicker(false)}
          t={t}
        />
      )}
    </div>
  );
}
