import { useMediaQuery } from "@mantine/hooks";
import { Notifications } from "@mantine/notifications";

/** S10: bottom-center above the bottom navigation on phones, bottom-right on desktop. */
export const TOAST_POSITIONS = {
  desktop: "bottom-right",
  phone: "bottom-center",
} as const;

/**
 * The app's toast stack. `.norea-toasts` in ui.css lifts it above the bottom
 * navigation, the phone selection bar and visible reader bars.
 */
export function AppToasts() {
  const desktop = useMediaQuery("(min-width: 768px)", undefined, {
    getInitialValueInEffect: false,
  });
  return (
    <Notifications
      autoClose={5_000}
      className="norea-toasts"
      position={desktop ? TOAST_POSITIONS.desktop : TOAST_POSITIONS.phone}
    />
  );
}
