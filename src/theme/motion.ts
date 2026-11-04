/**
 * Millisecond mirrors of the motion tokens in `tokens.css`, for Mantine
 * transition props and JavaScript animations that cannot read CSS variables.
 */
export const MOTION_DURATION_FAST_MS = 120;
export const MOTION_DURATION_BASE_MS = 200;
export const MOTION_DURATION_SLOW_MS = 320;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** True when the system asks for reduced motion; JS animation paths jump instead. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

const EASE_DECELERATE = "var(--norea-ease-decelerate)";
const EASE_ACCELERATE = "var(--norea-ease-accelerate)";

interface OverlayTransition {
  duration: number;
  exitDuration: number;
  timingFunction: string;
  transition: {
    in: Record<string, string | number>;
    out: Record<string, string | number>;
    transitionProperty: string;
  };
}

/**
 * Builds Mantine transition props whose `out` state carries the accelerate
 * curve, so one transition enters decelerating and leaves accelerating.
 * Mantine already zeroes the durations when the system asks for reduced motion.
 */
function overlayTransition(
  duration: number,
  exitDuration: number,
  transitionProperty: string,
  shown: Record<string, string | number>,
  hidden: Record<string, string | number>,
): OverlayTransition {
  return {
    duration,
    exitDuration,
    timingFunction: EASE_DECELERATE,
    transition: {
      in: shown,
      out: { ...hidden, transitionTimingFunction: EASE_ACCELERATE },
      transitionProperty,
    },
  };
}

/** Enter and exit motion for every overlay family. */
export const OVERLAY_MOTION = {
  /** Dialogs fade in and scale up from 0.96. */
  dialog: overlayTransition(
    MOTION_DURATION_BASE_MS,
    MOTION_DURATION_FAST_MS,
    "opacity, transform",
    { opacity: 1, transform: "scale(1)" },
    { opacity: 0, transform: "scale(0.96)" },
  ),
  /** Bottom sheets and phone full-screen dialogs rise from the bottom edge. */
  sheetBottom: overlayTransition(
    MOTION_DURATION_SLOW_MS,
    MOTION_DURATION_BASE_MS,
    "transform",
    { transform: "translateY(0)" },
    { transform: "translateY(100%)" },
  ),
  /** Side drawers slide in from the trailing edge. */
  sheetSide: overlayTransition(
    MOTION_DURATION_SLOW_MS,
    MOTION_DURATION_BASE_MS,
    "transform",
    { transform: "translateX(0)" },
    { transform: "translateX(100%)" },
  ),
  /** Menus and popovers scale from the edge that faces their trigger (ui.css sets the origin). */
  popover: overlayTransition(
    MOTION_DURATION_FAST_MS,
    MOTION_DURATION_FAST_MS,
    "opacity, transform",
    { opacity: 1, transform: "scale(1)" },
    { opacity: 0, transform: "scale(0.96)" },
  ),
} as const;
