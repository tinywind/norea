import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useReaderStore } from "../../store/reader";
const FULL_PAGE_CHROME_HIDE_DELAY_MS = 5000;
const READER_SEEKBAR_HIDE_DELAY_MS = 2000;
const READER_SEEKBAR_FADE_OUT_MS = 500;
const READER_ACTIVITY_THROTTLE_MS = 250;

interface ReaderChromeOptions {
  active: boolean;
  chapterId: number;
  fullPageReader: boolean;
  showSeekbar: boolean;
  readerStateVisible: boolean;
}
export function useReaderChrome({
  active,
  chapterId,
  fullPageReader,
  showSeekbar,
  readerStateVisible,
}: ReaderChromeOptions) {
  const navigate = useNavigate();
  const chromeHideTimerRef = useRef<number | null>(null);
  const readerSeekbarHideTimerRef = useRef<number | null>(null);
  const readerSeekbarFadeTimerRef = useRef<number | null>(null);
  const readerSeekbarEnabledRef = useRef(false);
  const readerSeekbarPinnedByChromeRef = useRef(false);
  const readerSeekbarActiveRef = useRef(false);
  const lastReaderActivityAtRef = useRef(-READER_ACTIVITY_THROTTLE_MS);
  const [fullPageChromeVisible, setFullPageChromeVisible] = useState(false);
  const [readerSeekbarActivityVisible, setReaderSeekbarActivityVisible] =
    useState(false);
  const [readerSeekbarRenderMounted, setReaderSeekbarRenderMounted] =
    useState(false);
  const [readerSettingsOpen, setReaderSettingsOpen] = useState(false);
  const setFullPageReaderActive = useReaderStore(
    (state) => state.setFullPageReaderActive,
  );
  const setFullPageReaderChromeVisible = useReaderStore(
    (state) => state.setFullPageReaderChromeVisible,
  );
  const clearFullPageChromeTimer = useCallback(() => {
    if (chromeHideTimerRef.current !== null) {
      window.clearTimeout(chromeHideTimerRef.current);
      chromeHideTimerRef.current = null;
    }
  }, []);

  const scheduleFullPageChromeHide = useCallback(() => {
    if (!fullPageReader) return;
    clearFullPageChromeTimer();
    chromeHideTimerRef.current = window.setTimeout(() => {
      setFullPageChromeVisible(false);
      chromeHideTimerRef.current = null;
    }, FULL_PAGE_CHROME_HIDE_DELAY_MS);
  }, [clearFullPageChromeTimer, fullPageReader]);

  const clearReaderSeekbarHideTimer = useCallback(() => {
    if (readerSeekbarHideTimerRef.current !== null) {
      window.clearTimeout(readerSeekbarHideTimerRef.current);
      readerSeekbarHideTimerRef.current = null;
    }
  }, []);

  const clearReaderSeekbarFadeTimer = useCallback(() => {
    if (readerSeekbarFadeTimerRef.current !== null) {
      window.clearTimeout(readerSeekbarFadeTimerRef.current);
      readerSeekbarFadeTimerRef.current = null;
    }
  }, []);

  const fadeOutReaderSeekbar = useCallback(() => {
    clearReaderSeekbarFadeTimer();
    setReaderSeekbarActivityVisible(false);
    readerSeekbarFadeTimerRef.current = window.setTimeout(() => {
      readerSeekbarFadeTimerRef.current = null;
      if (
        !readerSeekbarEnabledRef.current ||
        (!readerSeekbarActiveRef.current &&
          !readerSeekbarPinnedByChromeRef.current)
      ) {
        setReaderSeekbarRenderMounted(false);
      }
    }, READER_SEEKBAR_FADE_OUT_MS);
  }, [clearReaderSeekbarFadeTimer]);

  const scheduleReaderSeekbarHide = useCallback(() => {
    clearReaderSeekbarHideTimer();
    readerSeekbarHideTimerRef.current = window.setTimeout(() => {
      readerSeekbarHideTimerRef.current = null;
      if (
        readerSeekbarActiveRef.current ||
        readerSeekbarPinnedByChromeRef.current
      ) {
        return;
      }
      fadeOutReaderSeekbar();
    }, READER_SEEKBAR_HIDE_DELAY_MS);
  }, [clearReaderSeekbarHideTimer, fadeOutReaderSeekbar]);

  const showReaderSeekbarForActivity = useCallback(() => {
    if (!readerSeekbarEnabledRef.current) return;
    clearReaderSeekbarFadeTimer();
    setReaderSeekbarRenderMounted(true);
    setReaderSeekbarActivityVisible(true);
    if (readerSeekbarPinnedByChromeRef.current) {
      clearReaderSeekbarHideTimer();
      return;
    }
    scheduleReaderSeekbarHide();
  }, [
    clearReaderSeekbarFadeTimer,
    clearReaderSeekbarHideTimer,
    scheduleReaderSeekbarHide,
  ]);

  const handleFullPageActivity = useCallback(() => {
    if (fullPageReader && fullPageChromeVisible) {
      scheduleFullPageChromeHide();
    }
  }, [fullPageChromeVisible, fullPageReader, scheduleFullPageChromeHide]);

  const handleReaderActivity = useCallback(() => {
    lastReaderActivityAtRef.current = performance.now();
    handleFullPageActivity();
  }, [handleFullPageActivity]);

  const handleFrequentReaderActivity = useCallback(() => {
    const now = performance.now();
    if (now - lastReaderActivityAtRef.current < READER_ACTIVITY_THROTTLE_MS) {
      return;
    }
    handleReaderActivity();
  }, [handleReaderActivity]);

  const handleReaderSeekbarActiveChange = useCallback(
    (active: boolean) => {
      readerSeekbarActiveRef.current = active;
      if (active) {
        clearReaderSeekbarFadeTimer();
        clearReaderSeekbarHideTimer();
        setReaderSeekbarRenderMounted(true);
        setReaderSeekbarActivityVisible(true);
        return;
      }
      showReaderSeekbarForActivity();
    },
    [
      clearReaderSeekbarFadeTimer,
      clearReaderSeekbarHideTimer,
      showReaderSeekbarForActivity,
    ],
  );

  const handleReaderMenuTap = useCallback(() => {
    showReaderSeekbarForActivity();
    if (!fullPageReader) return;
    if (fullPageChromeVisible) {
      clearFullPageChromeTimer();
      setFullPageChromeVisible(false);
      return;
    }
    setFullPageChromeVisible(true);
    scheduleFullPageChromeHide();
  }, [
    clearFullPageChromeTimer,
    fullPageChromeVisible,
    fullPageReader,
    scheduleFullPageChromeHide,
    showReaderSeekbarForActivity,
  ]);

  const openReaderSettingsPanel = useCallback(() => {
    clearFullPageChromeTimer();
    setFullPageChromeVisible(true);
    setReaderSettingsOpen(true);
  }, [clearFullPageChromeTimer]);

  const closeReaderSettingsPanel = useCallback(() => {
    setReaderSettingsOpen(false);
  }, []);

  const openReaderSettingsPage = useCallback(() => {
    void navigate({ to: "/settings", search: { section: "reader" } });
  }, [navigate]);

  useEffect(() => {
    clearFullPageChromeTimer();
    setFullPageChromeVisible(false);
    return clearFullPageChromeTimer;
  }, [chapterId, clearFullPageChromeTimer, fullPageReader]);

  const readerChromeAutoHide = fullPageReader && !readerStateVisible;
  const readerChromeVisible = !readerChromeAutoHide || fullPageChromeVisible;
  const readerSeekbarEnabled = showSeekbar && !readerStateVisible;
  const readerSeekbarPinnedByChrome =
    readerSeekbarEnabled && readerChromeAutoHide && readerChromeVisible;
  const readerSeekbarVisible =
    readerSeekbarEnabled &&
    (readerSeekbarActivityVisible || readerSeekbarPinnedByChrome);
  const readerSeekbarMounted =
    readerSeekbarEnabled &&
    (readerSeekbarRenderMounted || readerSeekbarVisible);
  const sharedFullPageReaderChromeVisible =
    fullPageReader && readerChromeVisible;
  useEffect(() => {
    readerSeekbarEnabledRef.current = readerSeekbarEnabled;
    readerSeekbarPinnedByChromeRef.current = readerSeekbarPinnedByChrome;
    if (!readerSeekbarEnabled) {
      clearReaderSeekbarHideTimer();
      clearReaderSeekbarFadeTimer();
      readerSeekbarActiveRef.current = false;
      setReaderSeekbarActivityVisible(false);
      setReaderSeekbarRenderMounted(false);
      return;
    }
    if (readerSeekbarPinnedByChrome) {
      clearReaderSeekbarHideTimer();
      clearReaderSeekbarFadeTimer();
      setReaderSeekbarRenderMounted(true);
      setReaderSeekbarActivityVisible(true);
      return;
    }
    if (readerSeekbarActivityVisible) {
      scheduleReaderSeekbarHide();
    }
  }, [
    clearReaderSeekbarFadeTimer,
    clearReaderSeekbarHideTimer,
    readerSeekbarActivityVisible,
    readerSeekbarEnabled,
    readerSeekbarPinnedByChrome,
    scheduleReaderSeekbarHide,
  ]);

  useEffect(() => {
    if (!readerSeekbarEnabled) {
      return;
    }
    clearReaderSeekbarFadeTimer();
    setReaderSeekbarRenderMounted(true);
    setReaderSeekbarActivityVisible(true);
    if (readerSeekbarPinnedByChromeRef.current) {
      clearReaderSeekbarHideTimer();
      return;
    }
    scheduleReaderSeekbarHide();
  }, [
    chapterId,
    clearReaderSeekbarFadeTimer,
    clearReaderSeekbarHideTimer,
    readerSeekbarEnabled,
    scheduleReaderSeekbarHide,
  ]);

  useEffect(
    () => () => {
      clearReaderSeekbarHideTimer();
      clearReaderSeekbarFadeTimer();
    },
    [clearReaderSeekbarFadeTimer, clearReaderSeekbarHideTimer],
  );

  useEffect(() => {
    setFullPageReaderChromeVisible(sharedFullPageReaderChromeVisible);
  }, [setFullPageReaderChromeVisible, sharedFullPageReaderChromeVisible]);

  useEffect(() => {
    setFullPageReaderActive(active && fullPageReader);
    return () => setFullPageReaderActive(false);
  }, [active, fullPageReader, setFullPageReaderActive]);

  useEffect(
    () => () => {
      setFullPageReaderChromeVisible(false);
    },
    [setFullPageReaderChromeVisible],
  );

  return {
    readerChromeVisible,
    readerSeekbarVisible,
    readerSeekbarMounted,
    readerSettingsOpen,
    openReaderSettingsPanel,
    closeReaderSettingsPanel,
    openReaderSettingsPage,
    handleReaderMenuTap,
    handleReaderActivity,
    handleFrequentReaderActivity,
    showReaderSeekbarForActivity,
    handleReaderSeekbarActiveChange,
  };
}
