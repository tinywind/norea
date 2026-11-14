import { invoke } from "@tauri-apps/api/core";
import {
  applyDbMutationEffects,
  type DbMutationEffects,
  type DbMutationEnvelope,
} from "./ipc";
import {
  restoreWorkMetadataDirectoriesFromRust,
  type WorkMetadataRecoveryProgress,
} from "./work-metadata";
import { isTauriRuntime } from "../lib/tauri-runtime";
import { useStorageRecoveryStore } from "../store/storage-recovery";
import { describeError } from "../lib/errors";
import { notifyWorkMetadataChanges } from "../lib/work-metadata";

export type DatabaseReadMode = "queued" | "committed";

let sessionRecoveryPromise: Promise<void> | null = null;
let metadataRecoveryRunId = 0;
let metadataRecoveryActive = false;
let pendingRecoveryCancel: Promise<unknown> | null = null;

function ensureSessionRecovered(): Promise<void> {
  if (!sessionRecoveryPromise) {
    sessionRecoveryPromise = (async () => {
      if (!isTauriRuntime()) return;
      const { recoverSourceChapterRenumbers } = await import(
        "../lib/source-chapter-renumber"
      );
      await recoverSourceChapterRenumbers();
      const { recoverNovelMergeStorage } = await import(
        "../lib/novel-merge-storage"
      );
      await recoverNovelMergeStorage();
      await restoreWorkMetadataDirectoriesFromRust(false);
    })().catch((error: unknown) => {
      sessionRecoveryPromise = null;
      throw error;
    });
  }
  return sessionRecoveryPromise;
}

export async function initializeDatabaseSession(): Promise<void> {
  await ensureSessionRecovered();
  startWorkMetadataRecovery();
}

export function cancelWorkMetadataRecovery(): void {
  metadataRecoveryRunId += 1;
  if (metadataRecoveryActive && isTauriRuntime()) {
    pendingRecoveryCancel = invoke("db_work_metadata_cancel_recovery").catch(
      () => undefined,
    );
  }
  metadataRecoveryActive = false;
  useStorageRecoveryStore.setState({
    status: "idle",
    progress: null,
    error: null,
  });
}

export function startWorkMetadataRecovery(rebuild = false): void {
  if (!isTauriRuntime() || (metadataRecoveryActive && !rebuild)) return;
  const runId = ++metadataRecoveryRunId;
  metadataRecoveryActive = true;
  useStorageRecoveryStore.setState({
    status: "idle",
    progress: null,
    error: null,
  });
  let recoveredWorks = 0;
  let receivedEvents = false;
  void (async () => {
    if (pendingRecoveryCancel) {
      await pendingRecoveryCancel;
    }
    try {
      await ensureSessionRecovered();
    } catch (error: unknown) {
      if (metadataRecoveryRunId === runId) {
        useStorageRecoveryStore.setState({
          status: "error",
          error: describeError(error),
        });
        metadataRecoveryActive = false;
      }
      return;
    }
    if (metadataRecoveryRunId !== runId) return;
    const { listen } = await import("@tauri-apps/api/event");
    let unlisten: (() => void) | undefined;
    let eventChain = Promise.resolve();
    try {
      unlisten = await listen<{
        progress: WorkMetadataRecoveryProgress;
        effects?: DbMutationEffects | null;
      }>("norea:storage-recovery-progress", (event) => {
        eventChain = eventChain.then(async () => {
          if (metadataRecoveryRunId !== runId) return;
          receivedEvents = true;
          if (event.payload.effects) {
            await applyDbMutationEffects(event.payload.effects);
          }
          if (metadataRecoveryRunId !== runId) return;
          const { progress } = event.payload;
          useStorageRecoveryStore.setState({
            status: "scanning",
            progress,
            error: null,
          });
          if (progress.recoveredWorks > recoveredWorks) {
            recoveredWorks = progress.recoveredWorks;
            notifyWorkMetadataChanges();
          }
        });
      });
      if (metadataRecoveryRunId !== runId) return;
      const envelope = await invoke<
        DbMutationEnvelope<WorkMetadataRecoveryProgress>
      >("db_startup_recover_work_metadata", { rebuild });
      await eventChain;
      if (metadataRecoveryRunId !== runId) return;
      if (!receivedEvents) {
        await applyDbMutationEffects(envelope.effects);
      }
      if (useStorageRecoveryStore.getState().status === "scanning") {
        useStorageRecoveryStore.setState({ status: "complete" });
      }
    } catch (error: unknown) {
      if (metadataRecoveryRunId === runId) {
        useStorageRecoveryStore.setState({
          status: "error",
          error: describeError(error),
        });
      }
    } finally {
      unlisten?.();
      if (metadataRecoveryRunId === runId) {
        metadataRecoveryActive = false;
      }
    }
  })();
}
