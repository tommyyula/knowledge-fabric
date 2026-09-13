import type { DictationAdapter, Unsubscribe } from "@assistant-ui/react";

type SpeechRecognitionCtor = new () => {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  addEventListener: (type: string, listener: (event: any) => void) => void;
};

function getSpeechRecognitionAPI(): SpeechRecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const speechWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

export class ResilientWebSpeechDictationAdapter implements DictationAdapter {
  private readonly language: string;

  constructor(options: { language?: string } = {}) {
    this.language = options.language ?? (typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-US");
  }

  static isSupported(): boolean {
    return getSpeechRecognitionAPI() !== undefined;
  }

  listen(): DictationAdapter.Session {
    const SpeechRecognitionAPI = getSpeechRecognitionAPI();
    if (!SpeechRecognitionAPI) {
      throw new Error("SpeechRecognition is not supported in this browser. Try using Chrome or Edge.");
    }

    const speechStartCallbacks = new Set<() => void>();
    const speechEndCallbacks = new Set<(result: DictationAdapter.Result) => void>();
    const speechCallbacks = new Set<(result: DictationAdapter.Result) => void>();
    const retriableErrors = new Set(["no-speech", "network", "aborted"]);

    let finalTranscript = "";
    let recognition: InstanceType<SpeechRecognitionCtor> | null = null;
    let stopped = false;

    const session: DictationAdapter.Session = {
      status: { type: "starting" },
      stop: async () => {
        stopped = true;
        recognition?.stop();
        await new Promise<void>((resolve) => {
          const waitForEnd = () => {
            if (session.status.type === "ended") resolve();
            else window.setTimeout(waitForEnd, 50);
          };
          waitForEnd();
        });
      },
      cancel: () => {
        stopped = true;
        recognition?.abort();
        session.status = { type: "ended", reason: "cancelled" };
      },
      onSpeechStart: (callback: () => void): Unsubscribe => {
        speechStartCallbacks.add(callback);
        return () => { speechStartCallbacks.delete(callback); };
      },
      onSpeechEnd: (callback: (result: DictationAdapter.Result) => void): Unsubscribe => {
        speechEndCallbacks.add(callback);
        return () => { speechEndCallbacks.delete(callback); };
      },
      onSpeech: (callback: (result: DictationAdapter.Result) => void): Unsubscribe => {
        speechCallbacks.add(callback);
        return () => { speechCallbacks.delete(callback); };
      },
    };

    const startRecognition = () => {
      if (stopped) return;
      recognition = new SpeechRecognitionAPI();
      recognition.lang = this.language;
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.addEventListener("start", () => {
        session.status = { type: "running" };
      });

      recognition.addEventListener("speechstart", () => {
        for (const callback of speechStartCallbacks) callback();
      });

      recognition.addEventListener("result", (event) => {
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result?.[0]?.transcript;
          if (!transcript) continue;

          if (result.isFinal) {
            finalTranscript += transcript;
            for (const callback of speechCallbacks) callback({ transcript, isFinal: true });
          } else {
            for (const callback of speechCallbacks) callback({ transcript, isFinal: false });
          }
        }
      });

      recognition.addEventListener("end", () => {
        if (!stopped) {
          startRecognition();
          return;
        }

        session.status = { type: "ended", reason: "stopped" };
        if (finalTranscript) {
          for (const callback of speechEndCallbacks) callback({ transcript: finalTranscript });
          finalTranscript = "";
        }
      });

      recognition.addEventListener("error", (event) => {
        if (stopped) return;
        if (retriableErrors.has(event.error)) return;

        stopped = true;
        session.status = { type: "ended", reason: "error" };
      });

      try {
        recognition.start();
      } catch {
        stopped = true;
        session.status = { type: "ended", reason: "error" };
      }
    };

    startRecognition();
    return session;
  }
}
