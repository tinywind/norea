import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";

let activeToastId: string | null = null;
let sequence = 0;

/** Shows a read-state change with an Undo button; a newer change replaces the previous toast. */
export function showReadStateUndoToast({
  message,
  onUndo,
  undoLabel,
}: {
  message: string;
  onUndo: () => void;
  undoLabel: string;
}): void {
  if (activeToastId) notifications.hide(activeToastId);
  sequence += 1;
  const toastId = `read-state-undo:${sequence}`;
  activeToastId = toastId;
  notifications.show({
    color: "ok",
    id: toastId,
    message: (
      <span className="norea-novel-toast">
        <span>{message}</span>
        <Button
          onClick={() => {
            notifications.hide(toastId);
            if (activeToastId === toastId) activeToastId = null;
            onUndo();
          }}
          size="compact-sm"
          variant="subtle"
        >
          {undoLabel}
        </Button>
      </span>
    ),
    onClose: () => {
      if (activeToastId === toastId) activeToastId = null;
    },
  });
}
