import { useEffect } from "react";
import { BLACK, blackOrWhite, parseColor } from "../../theme/color";

let appBackground = "#ffffff";
let readerBackground: string | undefined;

function updateSystemBars(): void {
  const background = parseColor(readerBackground ?? appBackground);
  if (!background || typeof window === "undefined") return;
  const icons = blackOrWhite(background);
  window.__NoreaAndroidWindow?.setLightSystemBars?.(icons.r === BLACK.r);
}

/** Keeps Android system icons legible when the app theme differs from the OS. */
export function setAppSystemBarBackground(background: string): void {
  appBackground = background;
  updateSystemBars();
}

/** The visible reader owns the system bars until it leaves the foreground. */
export function useReaderSystemBarBackground(background: string, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    readerBackground = background;
    updateSystemBars();
    return () => {
      readerBackground = undefined;
      updateSystemBars();
    };
  }, [active, background]);
}
