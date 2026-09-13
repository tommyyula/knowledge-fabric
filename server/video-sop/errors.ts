export class VideoSopError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "VideoSopError";
  }
}

export function videoSopErrorDetails(error: unknown): {
  code: string;
  message: string;
} {
  if (error instanceof VideoSopError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "CANCELED", message: "The video SOP task was canceled." };
  }
  return {
    code: "PROCESSING_FAILED",
    message: error instanceof Error ? error.message : "Video SOP processing failed.",
  };
}
