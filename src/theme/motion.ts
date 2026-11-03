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
