import { notifications } from "@mantine/notifications";

const SETTINGS_TOAST_AUTO_CLOSE_MS = 5000;

type SettingsToastColor = "info" | "ok" | "danger";

export function showSettingsToast(
  color: SettingsToastColor,
  title: string,
  message?: string,
): void {
  notifications.show({
    color,
    title,
    message,
    autoClose: SETTINGS_TOAST_AUTO_CLOSE_MS,
  });
}

export function showSettingsLoadingToast(
  id: string,
  title: string,
  message: string,
): void {
  notifications.show({
    id,
    color: "info",
    title,
    message,
    loading: true,
    autoClose: SETTINGS_TOAST_AUTO_CLOSE_MS,
    withCloseButton: false,
  });
}

export function updateSettingsToast(
  id: string,
  color: Exclude<SettingsToastColor, "info">,
  title: string,
  message: string,
): void {
  notifications.update({
    id,
    color,
    title,
    message,
    loading: false,
    autoClose: SETTINGS_TOAST_AUTO_CLOSE_MS,
    withCloseButton: true,
  });
}
