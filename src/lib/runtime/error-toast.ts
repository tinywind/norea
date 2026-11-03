import { notifications } from "@mantine/notifications";
import { describeError } from "../errors";

interface ErrorPresentationMeta extends Record<string, unknown> {
  errorPresentation?: "inline" | "toast";
  errorToastGroup?: string;
}

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: ErrorPresentationMeta;
    mutationMeta: ErrorPresentationMeta;
  }
}

const ERROR_TOAST_LIFETIME_MS = 5_000;
const lastShownAt = new Map<string, number>();

function errorToastId(group: string): string {
  let hash = 2166136261;
  for (let index = 0; index < group.length; index += 1) {
    hash = Math.imul(hash ^ group.charCodeAt(index), 16777619);
  }
  return `error:${(hash >>> 0).toString(36)}`;
}

export function showErrorToast(
  title: string,
  error: unknown,
  group: string = title,
): void {
  const message = describeError(error);
  const key = JSON.stringify([group, message]);
  const now = Date.now();
  for (const [storedKey, shownAt] of lastShownAt) {
    if (now - shownAt >= ERROR_TOAST_LIFETIME_MS) lastShownAt.delete(storedKey);
  }
  if (lastShownAt.has(key)) return;

  lastShownAt.set(key, now);
  notifications.show({
    id: errorToastId(key),
    color: "danger",
    title,
    message,
    autoClose: ERROR_TOAST_LIFETIME_MS,
  });
}
