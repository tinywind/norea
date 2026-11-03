import { useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
} from "react";
const FULL_PAGE_CHROME_HIDE_DELAY_MS = 5000;
const READER_ACTIVITY_THROTTLE_MS = 250;

interface ReaderChromeOptions {
  chapterId: number;
  fullPageReader: boolean;
  readerStateVisible: boolean;
}
export function useReaderChrome({
  chapterId,
  fullPageReader,
  readerStateVisible,
}: ReaderChromeOptions) {
  const navigate = useNavigate();
  const chromeHideTimerRef = useRef<number | null>(null);
  const focusInsideChromeRef = useRef(false);
  const seekbarActiveRef = useRef(false);
  const overlayOpenRef = useRef(false);
  const chromeVisibleRef = useRef(false);
  const lastReaderActivityAtRef = useRef(-READER_ACTIVITY_THROTTLE_MS);
  const [fullPageChromeVisible, setFullPageChromeVisible] = useState(false);
  const [readerSettingsOpen, setReaderSettingsOpen] = useState(false);
  const [chapterListOpen, setChapterListOpen] = useState(false);
  const chromeAutoHide = fullPageReader && !readerStateVisible;
  const readerChromeVisible = !chromeAutoHide || fullPageChromeVisible;
  const overlayOpen = readerSettingsOpen || chapterListOpen;
  chromeVisibleRef.current = chromeAutoHide && fullPageChromeVisible;
  overlayOpenRef.current = overlayOpen;

  const clearChromeHideTimer = useCallback(() => {
    if (chromeHideTimerRef.current !== null) {
      window.clearTimeout(chromeHideTimerRef.current);
      chromeHideTimerRef.current = null;
    }
  }, []);

  const scheduleChromeHide = useCallback(() => {
    clearChromeHideTimer();
    if (!fullPageReader) return;
    chromeHideTimerRef.current = window.setTimeout(() => {
      chromeHideTimerRef.current = null;
      if (
        focusInsideChromeRef.current ||
        seekbarActiveRef.current ||
        overlayOpenRef.current
      ) {
        return;
      }
      setFullPageChromeVisible(false);
    }, FULL_PAGE_CHROME_HIDE_DELAY_MS);
  }, [clearChromeHideTimer, fullPageReader]);

  const hideReaderChrome = useCallback(() => {
    clearChromeHideTimer();
    setFullPageChromeVisible(false);
  }, [clearChromeHideTimer]);

  const handleReaderActivity = useCallback(() => {
    lastReaderActivityAtRef.current = performance.now();
    if (chromeVisibleRef.current) scheduleChromeHide();
  }, [scheduleChromeHide]);

  const handleFrequentReaderActivity = useCallback(() => {
    const now = performance.now();
    if (now - lastReaderActivityAtRef.current < READER_ACTIVITY_THROTTLE_MS) {
      return;
    }
    handleReaderActivity();
  }, [handleReaderActivity]);

  const handleReaderSeekbarActiveChange = useCallback(
    (active: boolean) => {
      seekbarActiveRef.current = active;
      if (!active && chromeVisibleRef.current) scheduleChromeHide();
    },
    [scheduleChromeHide],
  );

  const handleReaderMenuTap = useCallback(() => {
    if (!chromeAutoHide) return;
    if (fullPageChromeVisible) {
      hideReaderChrome();
      return;
    }
    setFullPageChromeVisible(true);
    scheduleChromeHide();
  }, [
    chromeAutoHide,
    fullPageChromeVisible,
    hideReaderChrome,
    scheduleChromeHide,
  ]);

  const chromeFocusHandlers = {
    onFocus: () => {
      focusInsideChromeRef.current = true;
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      focusInsideChromeRef.current = false;
      if (chromeVisibleRef.current) scheduleChromeHide();
    },
  };

  const openReaderSettingsPanel = useCallback(() => {
    clearChromeHideTimer();
    setFullPageChromeVisible(true);
    setReaderSettingsOpen(true);
  }, [clearChromeHideTimer]);

  const closeReaderSettingsPanel = useCallback(() => {
    setReaderSettingsOpen(false);
  }, []);

  const openChapterList = useCallback(() => {
    clearChromeHideTimer();
    setChapterListOpen(true);
  }, [clearChromeHideTimer]);

  const closeChapterList = useCallback(() => {
    setChapterListOpen(false);
  }, []);

  const closeTopReaderOverlay = useCallback((): boolean => {
    if (chapterListOpen) {
      setChapterListOpen(false);
      return true;
    }
    if (readerSettingsOpen) {
      setReaderSettingsOpen(false);
      return true;
    }
    return false;
  }, [chapterListOpen, readerSettingsOpen]);

  const openReaderSettingsPage = useCallback(() => {
    void navigate({ to: "/settings", search: { section: "reader" } });
  }, [navigate]);

  useEffect(() => {
    if (!overlayOpen && chromeVisibleRef.current) scheduleChromeHide();
  }, [overlayOpen, scheduleChromeHide]);

  useEffect(() => {
    clearChromeHideTimer();
    setFullPageChromeVisible(false);
    return clearChromeHideTimer;
  }, [chapterId, clearChromeHideTimer, fullPageReader]);

  return {
    readerChromeVisible,
    readerChromeDismissible: chromeAutoHide && readerChromeVisible,
    readerSettingsOpen,
    chapterListOpen,
    openReaderSettingsPanel,
    closeReaderSettingsPanel,
    openChapterList,
    closeChapterList,
    closeTopReaderOverlay,
    openReaderSettingsPage,
    handleReaderMenuTap,
    hideReaderChrome,
    handleReaderActivity,
    handleFrequentReaderActivity,
    handleReaderSeekbarActiveChange,
    chromeFocusHandlers,
  };
}
