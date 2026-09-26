import { isAbortError } from "../abort";

/** Explicit cancellation is different from a WebView or lifecycle interruption. */
export class TaskUserCancelledError extends DOMException {
  readonly cancelledByUser = true;

  constructor() {
    super("Task was cancelled.", "AbortError");
  }
}

export function isTaskUserCancelledError(error: unknown): boolean {
  return isAbortError(error) &&
    "cancelledByUser" in (error as object) &&
    (error as { cancelledByUser: unknown }).cancelledByUser === true;
}
