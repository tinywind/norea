import type { RefObject } from "react";
import { useEffect } from "react";
import { type ReaderContentHandle } from "../ReaderContent";
function logReaderRouteInput(event: string, details: Record<string, unknown>) {
  if (!import.meta.env.DEV) return;
  console.warn("[reader-input:route]", event, details);
}

interface ReaderKeyboardOptions {
  active: boolean;
  readerSettingsOpen: boolean;
  contentRef: RefObject<ReaderContentHandle | null>;
  closeReaderSettingsPanel: () => void;
  handleReaderActivity: () => void;
  handleReaderBack: () => boolean;
}
export function useReaderKeyboard({
  active,
  readerSettingsOpen,
  contentRef,
  closeReaderSettingsPanel,
  handleReaderActivity,
  handleReaderBack,
}: ReaderKeyboardOptions) {
  useEffect(() => {
    if (!active) return;

    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (readerSettingsOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeReaderSettingsPanel();
        }
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (
        target &&
        (target.closest("input, button, a, textarea, select, [role='slider']") ||
          (target instanceof HTMLElement && target.isContentEditable))
      ) {
        return;
      }
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          handleReaderActivity();
          handleReaderBack();
          break;
        case "PageDown":
        case "ArrowDown":
        case " ":
        case "ArrowRight":
          event.preventDefault();
          handleReaderActivity();
          logReaderRouteInput("key-page-step", {
            key: event.key,
            direction: 1,
            hasContentRef: Boolean(contentRef.current),
          });
          contentRef.current?.scrollByPage(1, `key-${event.key}`);
          break;
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
    closeReaderSettingsPanel,
    handleReaderActivity,
    handleReaderBack,
    readerSettingsOpen,
  ]);
}
