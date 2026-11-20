import { useEffect } from "react";
import { useAutoBackupStore } from "../../store/auto-backup";
import { isAppActive, subscribeAppLifecycle } from "../app-lifecycle";
import { isTauriRuntime } from "../tauri-runtime";
import { runAutomaticBackupIfDue } from "./auto-backup";

const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * RD15: checks the automatic backup schedule at launch, whenever the app
 * becomes visible again, hourly while it stays visible, and when the
 * schedule changes. A run missed while the app was closed happens at the
 * next launch.
 */
export function useAutomaticBackup(): void {
  const schedule = useAutoBackupStore((state) => state.schedule);

  useEffect(() => {
    if (!isTauriRuntime() || schedule === "off") return;
    const check = () => {
      if (!isAppActive()) return;
      void runAutomaticBackupIfDue();
    };
    check();
    const unsubscribeLifecycle = subscribeAppLifecycle((active) => {
      if (active) check();
    });
    const timer = window.setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      unsubscribeLifecycle();
      window.clearInterval(timer);
    };
  }, [schedule]);
}
