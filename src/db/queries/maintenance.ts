import { invokeDbMutation } from "../ipc";

export interface MaintenanceResult {
  rowsAffected: number;
}

export async function clearLibraryMembership(): Promise<MaintenanceResult> {
  return invokeDbMutation<MaintenanceResult>(
    "db_maintenance_clear_library_membership",
  );
}

export async function clearDownloadedChapterContent(): Promise<MaintenanceResult> {
  return invokeDbMutation<MaintenanceResult>(
    "db_maintenance_clear_downloaded_chapter_content",
  );
}

export async function clearUpdatesTab(): Promise<MaintenanceResult> {
  return invokeDbMutation<MaintenanceResult>(
    "db_maintenance_clear_updates_tab",
  );
}

export async function clearReadingProgress(): Promise<MaintenanceResult> {
  return invokeDbMutation<MaintenanceResult>(
    "db_maintenance_clear_reading_progress",
  );
}
