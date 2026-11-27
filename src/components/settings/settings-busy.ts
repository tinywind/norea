/**
 * Settings actions that replace or clear app data share one busy flag, so a
 * running backup restore or maintenance task locks the other data controls.
 */
export interface SettingsBusyProps {
  busyAction: string | null;
  isBusy: boolean;
  onBusyChange: (action: string | null) => void;
}
