import { invoke } from "@tauri-apps/api/core";
import enMessages from "../strings/languages/en/app.json";
import koMessages from "../strings/languages/ko/app.json";
import { describeError } from "./lib/errors";
import { isTauriRuntime } from "./lib/tauri-runtime";
import { installRuntimeCrashCapture } from "./lib/runtime-crash";

installRuntimeCrashCapture();

async function start(): Promise<void> {
  if (isTauriRuntime()) await invoke("device_backup_restore_check");
  await import("./main");
}

void start().catch(error => {
  const root = document.getElementById("root");
  if (!root) return;
  const messages = navigator.language.startsWith("ko") ? koMessages : enMessages;
  root.setAttribute("role", "alert");
  root.textContent = messages["deviceBackup.restoreBlocked"].replace("{error}", describeError(error));
});
