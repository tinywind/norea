import type { RefObject } from "react";
import { useEffect } from "react";
import { type ReaderContentHandle } from "../ReaderContent";
import { hasReaderTextSelection } from "./reader-content-metrics";
function logReaderRouteInput(event: string, details: Record<string, unknown>) {
  if (!import.meta.env.DEV) return;
  console.warn("[reader-input:route]", event, details);
}

interface ReaderKeyboardOptions {
  active: boolean;
  contentRef: RefObject<ReaderContentHandle | null>;
  /** Closes the topmost reader overlay; returns false when none is open. */
  closeTopReaderOverlay: () => boolean;
  /** A modal reader overlay owns every key except Escape. */
  modalOverlayOpen: boolean;
  readerChromeDismissible: boolean;
  hideReaderChrome: () => void;
  handleReaderActivity: () => void;
  handleReaderBack: () => boolean;
  openAdjacentChapter: (direction: 1 | -1) => void;
}

function getChapterKeyDirection(event: KeyboardEvent): 1 | -1 | null {
  if (event.metaKey || event.shiftKey) return null;
  if (!event.ctrlKey && !event.altKey) {
    if (event.key === "]") return 1;
    if (event.key === "[") return -1;
    return null;
  }
  if (event.ctrlKey && !event.altKey) {
    if (event.key === "ArrowRight") return 1;
    if (event.key === "ArrowLeft") return -1;
  }
  return null;
}

export function useReaderKeyboard({
  active,
  contentRef,
  closeTopReaderOverlay,
  modalOverlayOpen,
  readerChromeDismissible,
  hideReaderChrome,
  handleReaderActivity,
  handleReaderBack,
  openAdjacentChapter,
}: ReaderKeyboardOptions) {
  useEffect(() => {
    if (!active) return;

    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (event.key === "Escape") {
        if (
          target?.closest(
            "input, textarea, select, [role='combobox'], [role='listbox'], [role='menu']",
          )
        ) {
          return;
        }
        event.preventDefault();
        if (closeTopReaderOverlay()) return;
        if (readerChromeDismissible) {
          hideReaderChrome();
          return;
        }
        handleReaderBack();
        return;
      }
      if (modalOverlayOpen || hasReaderTextSelection()) return;
      if (
        target &&
        (target.closest(
          "input, button, a, textarea, select, [role='slider'], [role='dialog'], [role='menu']",
        ) ||
          (target instanceof HTMLElement && target.isContentEditable))
      ) {
        return;
      }
      const chapterDirection = getChapterKeyDirection(event);
      if (chapterDirection !== null) {
        event.preventDefault();
        handleReaderActivity();
        openAdjacentChapter(chapterDirection);
        return;
      }
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.shiftKey && event.key !== " ") return;
      switch (event.key) {
        case "PageDown":
        case "ArrowDown":
        case " ":
        case "ArrowRight": {
          const direction: 1 | -1 =
            event.key === " " && event.shiftKey ? -1 : 1;
          event.preventDefault();
          handleReaderActivity();
          logReaderRouteInput("key-page-step", {
            key: event.key,
            direction,
            hasContentRef: Boolean(contentRef.current),
          });
          contentRef.current?.scrollByPage(direction, `key-${event.key}`);
          break;
        }
        case "PageUp":
        case "ArrowUp":
        case "ArrowLeft":
          event.preventDefault();
          handleReaderActivity();
          logReaderRouteInput("key-page-step", {
            key: event.key,
            direction: -1,
            hasContentRef: Boolean(contentRef.current),
          });
          contentRef.current?.scrollByPage(-1, `key-${event.key}`);
          break;
        case "Home":
          event.preventDefault();
          handleReaderActivity();
          contentRef.current?.scrollToStart();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [
    active,
    closeTopReaderOverlay,
    contentRef,
    handleReaderActivity,
    handleReaderBack,
    hideReaderChrome,
    modalOverlayOpen,
    openAdjacentChapter,
    readerChromeDismissible,
  ]);
}
