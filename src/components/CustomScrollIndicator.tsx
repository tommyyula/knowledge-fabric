import { type PointerEvent as ReactPointerEvent, type RefObject, type WheelEvent as ReactWheelEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

const SCROLLBAR_HIDE_DELAY_MS = 2700;
const SCROLLBAR_TRACK_INSET = 18;
const SCROLLBAR_THUMB_MIN_HEIGHT = 44;
const SCROLLBAR_THUMB_MAX_HEIGHT = 160;
const SCROLLBAR_WIDTH = 6.75;

interface ScrollIndicatorState {
  visible: boolean;
  scrollable: boolean;
  top: number;
  thumbHeight: number;
  rect: { top: number; right: number; height: number } | null;
}

function getScrollIndicatorMetrics(viewport: HTMLElement, bottomBoundarySelector?: string) {
  const viewportRect = viewport.getBoundingClientRect();
  const bottomBoundary = bottomBoundarySelector ? viewport.querySelector<HTMLElement>(bottomBoundarySelector) : null;
  const bottomBoundaryRect = bottomBoundary?.getBoundingClientRect();
  const bottom = bottomBoundaryRect ? Math.min(viewportRect.bottom, Math.max(viewportRect.top, bottomBoundaryRect.top)) : viewportRect.bottom;
  const indicatorHeight = Math.max(0, bottom - viewportRect.top);
  const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const scrollable = maxScroll > 1 && indicatorHeight > SCROLLBAR_TRACK_INSET * 2;
  const trackHeight = Math.max(0, indicatorHeight - SCROLLBAR_TRACK_INSET * 2);
  const ratio = viewport.clientHeight / viewport.scrollHeight;
  const thumbHeight = Math.max(SCROLLBAR_THUMB_MIN_HEIGHT, Math.min(SCROLLBAR_THUMB_MAX_HEIGHT, trackHeight * ratio));
  const movable = Math.max(0, trackHeight - thumbHeight);
  const top = SCROLLBAR_TRACK_INSET + (maxScroll > 0 ? (viewport.scrollTop / maxScroll) * movable : 0);

  return {
    maxScroll,
    scrollable,
    top,
    thumbHeight,
    movable,
    rect: { top: viewportRect.top, right: viewportRect.right, height: indicatorHeight },
  };
}

export default function CustomScrollIndicator<T extends HTMLElement>({
  viewportRef,
  bottomBoundarySelector,
  className,
}: {
  viewportRef: RefObject<T | null>;
  bottomBoundarySelector?: string;
  className?: string;
}) {
  const [state, setState] = useState<ScrollIndicatorState>({
    visible: false,
    scrollable: false,
    top: SCROLLBAR_TRACK_INSET,
    thumbHeight: SCROLLBAR_THUMB_MIN_HEIGHT,
    rect: null,
  });
  const hideTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startScrollTop: number;
    maxScroll: number;
    movable: number;
    previousUserSelect: string;
    previousScrollBehavior: string;
  } | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const syncScrollIndicator = useCallback(
    (visible: boolean) => {
      const viewport = viewportRef.current;
      if (!viewport) return;

      const metrics = getScrollIndicatorMetrics(viewport, bottomBoundarySelector);
      setState({
        visible: visible && metrics.scrollable,
        scrollable: metrics.scrollable,
        top: metrics.top,
        thumbHeight: metrics.thumbHeight,
        rect: metrics.rect,
      });
    },
    [bottomBoundarySelector, viewportRef],
  );

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => {
      setState((current) => ({ ...current, visible: false }));
      hideTimerRef.current = null;
    }, SCROLLBAR_HIDE_DELAY_MS);
  }, [clearHideTimer]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;

    const reveal = () => {
      window.requestAnimationFrame(() => syncScrollIndicator(true));
      scheduleHide();
    };
    const handleResize = () => syncScrollIndicator(false);

    const resizeObserver = new ResizeObserver(() => syncScrollIndicator(false));
    resizeObserver.observe(viewport);
    if (viewport.firstElementChild) resizeObserver.observe(viewport.firstElementChild);
    const bottomBoundary = bottomBoundarySelector ? viewport.querySelector<HTMLElement>(bottomBoundarySelector) : null;
    if (bottomBoundary) resizeObserver.observe(bottomBoundary);
    viewport.addEventListener("scroll", reveal, { passive: true });
    viewport.addEventListener("wheel", reveal, { passive: true });
    viewport.addEventListener("touchmove", reveal, { passive: true });
    window.addEventListener("resize", handleResize);
    syncScrollIndicator(false);

    return () => {
      clearHideTimer();
      resizeObserver.disconnect();
      viewport.removeEventListener("scroll", reveal);
      viewport.removeEventListener("wheel", reveal);
      viewport.removeEventListener("touchmove", reveal);
      window.removeEventListener("resize", handleResize);
    };
  }, [bottomBoundarySelector, clearHideTimer, scheduleHide, syncScrollIndicator, viewportRef]);

  const handleThumbPointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    const viewport = viewportRef.current;
    if (!viewport) return;

    const metrics = getScrollIndicatorMetrics(viewport, bottomBoundarySelector);
    const movable = Math.max(1, metrics.movable);
    if (!metrics.scrollable || metrics.maxScroll <= 0) return;

    clearHideTimer();
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: viewport.scrollTop,
      maxScroll: metrics.maxScroll,
      movable,
      previousUserSelect: document.body.style.userSelect,
      previousScrollBehavior: viewport.style.scrollBehavior,
    };
    document.body.style.userSelect = "none";
    viewport.style.scrollBehavior = "auto";
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    syncScrollIndicator(true);
  };

  const handleThumbPointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current;
    const viewport = viewportRef.current;
    if (!drag || !viewport || drag.pointerId !== event.pointerId) return;

    const nextScrollTop = drag.startScrollTop + ((event.clientY - drag.startY) / drag.movable) * drag.maxScroll;
    const clampedScrollTop = Math.min(drag.maxScroll, Math.max(0, nextScrollTop));
    const nextThumbTop = SCROLLBAR_TRACK_INSET + (clampedScrollTop / drag.maxScroll) * drag.movable;
    viewport.scrollTop = clampedScrollTop;
    event.currentTarget.style.transform = `translateY(${nextThumbTop}px)`;
    event.preventDefault();
    syncScrollIndicator(true);
  };

  const endThumbDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    document.body.style.userSelect = drag.previousUserSelect;
    const viewport = viewportRef.current;
    if (viewport) viewport.style.scrollBehavior = drag.previousScrollBehavior;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    syncScrollIndicator(true);
    scheduleHide();
  };

  const handleThumbWheel = (event: ReactWheelEvent<HTMLSpanElement>) => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    viewport.scrollTop += event.deltaY;
    event.preventDefault();
    syncScrollIndicator(true);
    scheduleHide();
  };

  if (!state.scrollable || !state.rect || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={cn("aui-thread-scroll-indicator", state.visible && "visible", className)}
      aria-hidden="true"
      style={{
        top: state.rect.top,
        left: state.rect.right - SCROLLBAR_WIDTH,
        height: state.rect.height,
      }}
    >
      <span
        className="aui-thread-scroll-indicator-thumb"
        onPointerDown={handleThumbPointerDown}
        onPointerMove={handleThumbPointerMove}
        onPointerUp={endThumbDrag}
        onPointerCancel={endThumbDrag}
        onWheel={handleThumbWheel}
        style={{
          height: state.thumbHeight,
          transform: `translateY(${state.top}px)`,
        }}
      />
    </div>,
    document.body,
  );
}
