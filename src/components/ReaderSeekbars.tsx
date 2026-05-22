import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

type ReaderSeekbarOrientation = "horizontal" | "vertical";

interface ReaderSeekbarsProps {
  bottomOffset?: number | string;
  label: string;
  onActivity?: () => void;
  onActiveChange?: (active: boolean) => void;
  onCommit?: () => void;
  onSeek: (progress: number) => void;
  progress: number;
  showHorizontal: boolean;
  showVertical: boolean;
}

interface ReaderSeekbarProps {
  label: string;
  onActivity?: () => void;
  onActiveChange?: (active: boolean) => void;
  onCommit?: () => void;
  onSeek: (progress: number) => void;
  orientation: ReaderSeekbarOrientation;
  progress: number;
}

interface PointerPosition {
  clientX: number;
  clientY: number;
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, progress));
}

function getPointerProgress(
  element: HTMLElement,
  pointer: PointerPosition,
  orientation: ReaderSeekbarOrientation,
): number {
  const rect = element.getBoundingClientRect();
  if (orientation === "vertical") {
    return clampProgress(((pointer.clientY - rect.top) / rect.height) * 100);
  }
  return clampProgress(((pointer.clientX - rect.left) / rect.width) * 100);
}

function ReaderSeekbar({
  label,
  onActivity,
  onActiveChange,
  onCommit,
  onSeek,
  orientation,
  progress,
}: ReaderSeekbarProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLSpanElement | null>(null);
  const activePointerRef = useRef<number | null>(null);
  const removeDocumentDragListenersRef = useRef<(() => void) | null>(null);
  const onActivityRef = useRef(onActivity);
  const onActiveChangeRef = useRef(onActiveChange);
  const onCommitRef = useRef(onCommit);
  const onSeekRef = useRef(onSeek);
  const [active, setActive] = useState(false);
  const clampedProgress = clampProgress(progress);

  useEffect(() => {
    onActivityRef.current = onActivity;
    onActiveChangeRef.current = onActiveChange;
    onCommitRef.current = onCommit;
    onSeekRef.current = onSeek;
  });

  useEffect(
    () => () => {
      removeDocumentDragListenersRef.current?.();
      removeDocumentDragListenersRef.current = null;
      if (activePointerRef.current !== null) {
        onActiveChangeRef.current?.(false);
      }
      activePointerRef.current = null;
    },
    [],
  );

  function removeDocumentDragListeners(): void {
    removeDocumentDragListenersRef.current?.();
    removeDocumentDragListenersRef.current = null;
  }

  function notifyActivity(): void {
    onActivityRef.current?.();
  }

  function setSeekbarActive(nextActive: boolean): void {
    setActive(nextActive);
    onActiveChangeRef.current?.(nextActive);
  }

  function seekFromPointer(pointer: PointerPosition): void {
    const element = trackRef.current;
    if (!element) return;
    onSeekRef.current(getPointerProgress(element, pointer, orientation));
  }

  function finishPointer(pointerId: number): void {
    if (activePointerRef.current !== pointerId) return;
    activePointerRef.current = null;
    removeDocumentDragListeners();
    setSeekbarActive(false);
    onCommitRef.current?.();
  }

  function startDocumentDragListeners(pointerId: number): void {
    if (typeof window === "undefined") return;
    removeDocumentDragListeners();

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      if (
        activePointerRef.current !== pointerId ||
        event.pointerId !== pointerId
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      notifyActivity();
      seekFromPointer(event);
    };
    const handlePointerUp = (event: globalThis.PointerEvent) => {
      if (
        activePointerRef.current !== pointerId ||
        event.pointerId !== pointerId
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      notifyActivity();
      seekFromPointer(event);
      finishPointer(pointerId);
    };
    const handlePointerCancel = (event: globalThis.PointerEvent) => {
      if (
        activePointerRef.current !== pointerId ||
        event.pointerId !== pointerId
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      notifyActivity();
      finishPointer(pointerId);
    };
    const options: AddEventListenerOptions = {
      capture: true,
      passive: false,
    };

    window.addEventListener("pointermove", handlePointerMove, options);
    window.addEventListener("pointerup", handlePointerUp, options);
    window.addEventListener("pointercancel", handlePointerCancel, options);
    removeDocumentDragListenersRef.current = () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("pointercancel", handlePointerCancel, true);
    };
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? 10 : 5;
    let nextProgress: number | null = null;

    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        nextProgress = clampedProgress - step;
        break;
      case "ArrowRight":
      case "ArrowDown":
        nextProgress = clampedProgress + step;
        break;
      case "Home":
        nextProgress = 0;
        break;
      case "End":
        nextProgress = 100;
        break;
      default:
        break;
    }

    if (nextProgress === null) return;
    event.preventDefault();
    notifyActivity();
    onSeek(clampProgress(nextProgress));
    onCommit?.();
  }

  return (
    <div
      ref={elementRef}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(clampedProgress)}
      aria-valuetext={`${Math.round(clampedProgress)}%`}
      className="lnr-reader-floating-seekbar"
      data-active={active}
      data-orientation={orientation}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={handleKeyDown}
      onPointerCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        finishPointer(event.pointerId);
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        notifyActivity();
        activePointerRef.current = event.pointerId;
        startDocumentDragListeners(event.pointerId);
        setSeekbarActive(true);
        seekFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (activePointerRef.current !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        notifyActivity();
        seekFromPointer(event);
      }}
      onPointerUp={(event) => {
        if (activePointerRef.current !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        notifyActivity();
        seekFromPointer(event);
        finishPointer(event.pointerId);
      }}
      role="slider"
      style={
        { "--lnr-reader-seek-progress": `${clampedProgress}%` } as CSSProperties
      }
      tabIndex={0}
    >
      <span ref={trackRef} className="lnr-reader-floating-seekbar-track">
        <span className="lnr-reader-floating-seekbar-fill" />
        <span className="lnr-reader-floating-seekbar-thumb" />
      </span>
    </div>
  );
}

export function ReaderSeekbars({
  bottomOffset = "1rem",
  label,
  onActivity,
  onActiveChange,
  onCommit,
  onSeek,
  progress,
  showHorizontal,
  showVertical,
}: ReaderSeekbarsProps) {
  if (!showHorizontal && !showVertical) return null;

  const renderHorizontal = showHorizontal && !showVertical;

  return (
    <div
      className="lnr-reader-seekbars"
      style={
        {
          "--lnr-reader-seek-bottom":
            typeof bottomOffset === "number"
              ? `${bottomOffset}px`
              : bottomOffset,
        } as CSSProperties
      }
    >
      {renderHorizontal ? (
        <ReaderSeekbar
          label={label}
          onActivity={onActivity}
          onActiveChange={onActiveChange}
          onCommit={onCommit}
          onSeek={onSeek}
          orientation="horizontal"
          progress={progress}
        />
      ) : null}
      {showVertical ? (
        <ReaderSeekbar
          label={label}
          onActivity={onActivity}
          onActiveChange={onActiveChange}
          onCommit={onCommit}
          onSeek={onSeek}
          orientation="vertical"
          progress={progress}
        />
      ) : null}
    </div>
  );
}
