import { Box, Button, Modal, Text } from "@mantine/core";
import { useCallback, useEffect, useRef } from "react";
import { create } from "zustand";
import { useTranslation } from "../../i18n";
import { useOverlayBackNavigation } from "../../lib/android-back-navigation";
import { SHEET_CLASS_NAMES, SHEET_DIALOG_WIDTHS, SheetActions } from "./ResponsiveSheet";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Fills the confirm button in the danger role and starts focus on cancel. */
  danger?: boolean;
}

interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (confirmed: boolean) => void;
}

const useConfirmQueue = create<{ queue: readonly ConfirmRequest[] }>(() => ({ queue: [] }));
let nextRequestId = 0;

function settleConfirmation(id: number, confirmed: boolean): void {
  const { queue } = useConfirmQueue.getState();
  const request = queue.find((entry) => entry.id === id);
  if (!request) return;
  useConfirmQueue.setState({ queue: queue.filter((entry) => entry !== request) });
  request.resolve(confirmed);
}

/**
 * Returns a function that asks the user to confirm an action. Requests queue
 * and show one at a time in order. Each resolves `false` when cancelled or
 * dismissed, or when the calling component or the dialog unmounts first.
 */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const owned = useRef(new Set<number>());

  useEffect(() => {
    const ids = owned.current;
    return () => {
      for (const id of [...ids]) settleConfirmation(id, false);
    };
  }, []);

  return useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        const id = ++nextRequestId;
        const ids = owned.current;
        ids.add(id);
        const request: ConfirmRequest = {
          ...options,
          id,
          resolve: (confirmed) => {
            ids.delete(id);
            resolve(confirmed);
          },
        };
        useConfirmQueue.setState((state) => ({ queue: [...state.queue, request] }));
      }),
    [],
  );
}

/** Shows queued `useConfirm` requests. Mount once inside the app shell. */
export function ConfirmDialog() {
  const { t } = useTranslation();
  const request = useConfirmQueue((state) => state.queue[0]);
  const lastRequest = useRef(request);
  if (request) lastRequest.current = request;
  const shown = request ?? lastRequest.current;
  const settle = (confirmed: boolean) => {
    if (request) settleConfirmation(request.id, confirmed);
  };
  useOverlayBackNavigation(request !== undefined, () => settle(false));

  useEffect(
    () => () => {
      for (const entry of useConfirmQueue.getState().queue) {
        settleConfirmation(entry.id, false);
      }
    },
    [],
  );

  // A centered dialog at every width: a confirmation interrupts, and it stacks above the sheet it came from.
  return (
    <Modal
      centered
      classNames={{
        ...SHEET_CLASS_NAMES,
        body: `${SHEET_CLASS_NAMES.body} norea-responsive-sheet-body--with-footer`,
      }}
      opened={request !== undefined}
      onClose={() => settle(false)}
      size={SHEET_DIALOG_WIDTHS.sm}
      title={shown?.title}
      // Confirmations open from inside sheets, drawers and their dropdowns, so they sit above all of them.
      zIndex="var(--norea-z-confirm)"
    >
      {shown ? (
        <>
          <Text size="sm">{shown.message}</Text>
          <Box className="norea-responsive-sheet-footer">
            <SheetActions>
              <Button
                data-autofocus={shown.danger ? true : undefined}
                variant="default"
                onClick={() => settle(false)}
              >
                {shown.cancelLabel ?? t("common.cancel")}
              </Button>
              <Button
                color={shown.danger ? "danger" : undefined}
                data-autofocus={shown.danger ? undefined : true}
                onClick={() => settle(true)}
              >
                {shown.confirmLabel}
              </Button>
            </SheetActions>
          </Box>
        </>
      ) : null}
    </Modal>
  );
}
