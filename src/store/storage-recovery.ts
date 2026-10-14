import { create } from "zustand";
import type { WorkMetadataRecoveryProgress } from "../db/work-metadata";

interface StorageRecoveryState {
  status: "idle" | "scanning" | "complete" | "error";
  progress: WorkMetadataRecoveryProgress | null;
  error: string | null;
}

export const useStorageRecoveryStore = create<StorageRecoveryState>(() => ({
  status: "idle", progress: null, error: null,
}));
