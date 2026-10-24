import { create } from "zustand";
import type { ContentDeletionRequest } from "../lib/content-deletion";
import { useContentSyncStore } from "./content-sync";

type ContentDeletionInput =
  | Extract<ContentDeletionRequest, { kind: "server-work" | "server-chapters" }>
  | Omit<Extract<ContentDeletionRequest, { kind: "library" }>, "serverUrl">
  | Omit<Extract<ContentDeletionRequest, { kind: "downloads" }>, "serverUrl">;
interface PendingDeletion { id: number; request: ContentDeletionRequest; resolve: (changed: boolean) => void }
export const useContentDeletionStore = create<{ pending: PendingDeletion | null }>(() => ({ pending: null }));
let nextId = 0;

export function confirmContentDeletion(input: ContentDeletionInput): Promise<boolean> {
  if (useContentDeletionStore.getState().pending) return Promise.resolve(false);
  const request: ContentDeletionRequest = "source" in input ? input : { ...input, serverUrl: useContentSyncStore.getState().serverUrl };
  return new Promise(resolve => useContentDeletionStore.setState({ pending: { id: ++nextId, request, resolve } }));
}

export function finishContentDeletion(id: number, changed: boolean): void {
  const pending = useContentDeletionStore.getState().pending;
  if (pending?.id !== id) return;
  useContentDeletionStore.setState({ pending: null });
  pending.resolve(changed);
}
