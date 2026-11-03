import { useRef, useState } from "react";
import { Alert, Group, Progress, Stack, Text } from "@mantine/core";
import { useTranslation, type TranslationKey } from "../i18n";
import { describeError } from "../lib/errors";
import type { SavedVpnProfile } from "../lib/plugin-vpn-profiles";
import type { VpnDownloadDraftWork, VpnDownloadHandoverWork, VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";
import type { VpnDownloadPlan, VpnDownloadRangeState } from "../lib/tasks/vpn-download-types";
import { SettingsInlineControls } from "./SettingsPrimitives";
import { TextButton } from "./TextButton";
import { useConfirm } from "./ui/ConfirmDialog";

export interface VpnDownloadRangeActions {
  retryDraft: (draftId: string) => Promise<void>;
  pauseWork: (pluginId: string, novelId: number) => Promise<void>;
  resumeWork: (pluginId: string, novelId: number) => Promise<void>;
  cancelDraft: (draftId: string) => void | Promise<void>;
  cancelHandoverWork: (workId: string) => Promise<void>;
  resumeRange: (planId: string, rangeId: string, restartPass?: boolean) => Promise<void>;
  pauseRange: (planId: string, rangeId: string) => Promise<void>;
  cancelRange: (planId: string, rangeId: string) => Promise<void>;
  openVerification: (planId: string, rangeId: string) => Promise<void>;
}

const PHASE_KEYS: Record<VpnDownloadRangeState["phase"], TranslationKey> = {
  paused: "vpnDownload.phase.paused", connecting: "vpnDownload.phase.connecting", running: "vpnDownload.phase.running",
  completed: "vpnDownload.phase.completed", cancelled: "vpnDownload.phase.cancelled",
};
const PAUSE_KEYS: Record<string, TranslationKey> = {
  "profiles-exhausted": "vpnDownload.reason.exhausted", "profile-unavailable": "vpnDownload.reason.unavailable",
  "profile-in-use": "vpnDownload.reason.inUse", interrupted: "vpnDownload.reason.interrupted", offline: "network.waiting",
  "challenge-captcha": "vpnDownload.reason.captcha", "challenge-cloudflare": "vpnDownload.reason.cloudflare",
  "manual-verification": "vpnDownload.reason.verification", "verification-unavailable": "vpnDownload.reason.verificationUnavailable",
  "authentication-required": "vpnDownload.reason.authentication", "download-failed": "vpnDownload.reason.downloadFailed",
  "runtime-error": "vpnDownload.reason.runtimeError", "user-paused": "vpnDownload.userPaused",
  "automatic-off": "vpnDownload.reason.off", cancelled: "vpnDownload.phase.cancelled",
  "work-paused": "vpnDownload.workPaused",
};

export function VpnDownloadRanges({ snapshot, profiles, actions }: {
  snapshot: VpnDownloadRuntimeSnapshot;
  profiles: readonly SavedVpnProfile[];
  actions: VpnDownloadRangeActions;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const pending = useRef(new Set<string>());
  const workGroups = new Map<string, { title: string; pluginId: string; novelId: number; drafts: VpnDownloadDraftWork[]; plans: VpnDownloadPlan[]; handover: VpnDownloadHandoverWork[] }>();
  for (const work of [...snapshot.plans, ...snapshot.drafts, ...snapshot.handover ?? []]) {
    const key = JSON.stringify([work.pluginId, work.novelId]);
    const group = workGroups.get(key) ?? { title: work.title, pluginId: work.pluginId, novelId: work.novelId, drafts: [], plans: [], handover: [] };
    if ("ranges" in work) group.plans.push(work); else if ("chapterIds" in work) group.handover.push(work); else group.drafts.push(work);
    workGroups.set(key, group);
  }
  const runEnabled = !snapshot.run || snapshot.run.status === "running";

  async function run(key: string, action: () => unknown | Promise<unknown>): Promise<void> {
    if (pending.current.has(key)) return;
    pending.current.add(key); setPendingKeys(new Set(pending.current));
    setErrors(current => ({ ...current, [key]: null }));
    try { await action(); }
    catch (error) { setErrors(current => ({ ...current, [key]: describeError(error) })); }
    finally { pending.current.delete(key); setPendingKeys(new Set(pending.current)); }
  }

  return (
    <Stack gap="md">
      {[...workGroups].map(([workKey, work]) => {
        const total = work.handover.reduce((sum, waiting) => sum + waiting.chapterIds.length, 0) + work.drafts.reduce((sum, draft) => sum + draft.selectedChapterIds.length, 0) +
          work.plans.reduce((sum, plan) => sum + plan.ranges.reduce((count, range) => count + range.selectedChapterIds.length, 0), 0);
        const completed = work.plans.reduce((sum, plan) => sum + plan.ranges.reduce((count, range) => count + range.checkpoint, 0), 0);
        const unfinished = work.plans.flatMap(plan => plan.ranges.filter(range => range.phase !== "completed" && range.phase !== "cancelled")
          .map(range => ({ planId: plan.id, range })));
        const workHeld = unfinished.some(({ range }) => range.userPaused && range.pauseReason === "work-paused") ||
          work.drafts.some(draft => draft.userPaused) || work.handover.some(waiting => waiting.userPaused);
        const canPauseWork = !workHeld && (unfinished.some(({ range }) => !range.userPaused) || work.drafts.length > 0 || work.handover.length > 0);
        const workBusy = pendingKeys.has(workKey);
        const actionLabel = (action: string) => t("vpnDownload.workAction", { action, title: work.title });
        return (
          <Stack key={workKey} gap="sm" className="norea-vpn-download-work" data-vpn-work={workKey} component="section" aria-label={work.title}>
            <Group justify="space-between" gap="sm">
              <Text component="h3" size="sm" fw={600} className="norea-vpn-download-heading">{work.title}</Text>
              <Text size="sm" className="norea-vpn-download-progress">{t("vpnDownload.progress", { completed, total })}</Text>
            </Group>
            <Progress aria-label={t("vpnDownload.progressLabel")} value={total ? completed / total * 100 : 0} size="xs" />
            {unfinished.length || work.drafts.length || work.handover.length ? <SettingsInlineControls>
              {canPauseWork ? <TextButton aria-label={actionLabel(t("vpnDownload.pauseWork"))} disabled={workBusy || !runEnabled}
                onClick={() => { if (runEnabled) return run(workKey, () => actions.pauseWork(work.pluginId, work.novelId)); }}>{t("vpnDownload.pauseWork")}</TextButton> :
                workHeld ? <TextButton aria-label={actionLabel(t("vpnDownload.resumeWork"))} disabled={workBusy || !runEnabled}
                  onClick={() => { if (runEnabled) return run(workKey, () => actions.resumeWork(work.pluginId, work.novelId)); }}>{t("vpnDownload.resumeWork")}</TextButton> : null}
              <TextButton tone="danger" aria-label={actionLabel(t("vpnDownload.cancelWork"))} disabled={workBusy}
                onClick={async () => {
                  const confirmed = await confirm({ title: t("vpnDownload.cancelWorkConfirm.title", { title: work.title }),
                    message: t("vpnDownload.cancelWorkConfirm.message", { count: work.drafts.length + work.handover.length + unfinished.length }),
                    confirmLabel: t("vpnDownload.cancelWork"), cancelLabel: t("common.keep"), danger: true });
                  if (confirmed) await run(workKey, () => Promise.all([
                    ...work.drafts.map(draft => actions.cancelDraft(draft.id)),
                    ...work.handover.map(waiting => actions.cancelHandoverWork(waiting.id)),
                    ...unfinished.map(({ planId, range }) => actions.cancelRange(planId, range.id)),
                  ]));
                }}>{t("vpnDownload.cancelWork")}</TextButton>
            </SettingsInlineControls> : null}
            {errors[workKey] ? <Alert color="danger" role="alert">{errors[workKey]}</Alert> : null}
            {work.handover.map(waiting => <Stack key={waiting.id} gap="xs" className="norea-vpn-download-range">
              <Text size="sm" role="status">{t("vpnDownload.phase.waitingHandover")}</Text>
              <SettingsInlineControls>
                <TextButton tone="danger" disabled={workBusy || pendingKeys.has(waiting.id)} onClick={() => run(waiting.id, () => actions.cancelHandoverWork(waiting.id))}>{t("vpnDownload.cancelDraft")}</TextButton>
              </SettingsInlineControls>
              {errors[waiting.id] ? <Alert color="danger" role="alert">{errors[waiting.id]}</Alert> : null}
            </Stack>)}
            {work.drafts.map(draft => {
              const key = JSON.stringify(["draft", draft.id]);
              const phaseKey: TranslationKey = !runEnabled || draft.userPaused ? "vpnDownload.phase.paused" : draft.phase === "waiting-profile" ? "vpnDownload.phase.waitingProfile" :
                draft.phase === "failed" ? "vpnDownload.phase.failed" : "vpnDownload.phase.preparing";
              return <Stack key={draft.id} gap="xs" className="norea-vpn-download-range">
                <Text size="sm" role="status">{t(phaseKey)}</Text>
                {draft.error ? <Alert color="danger" role="alert">{draft.error}</Alert> : null}
                <SettingsInlineControls>
                  {draft.phase === "failed" ? <TextButton disabled={workBusy || pendingKeys.has(key) || !runEnabled || draft.userPaused} loading={pendingKeys.has(key)}
                    onClick={() => { if (runEnabled && !draft.userPaused) return run(key, () => actions.retryDraft(draft.id)); }}>{t("common.retry")}</TextButton> : null}
                  <TextButton tone="danger" disabled={workBusy || pendingKeys.has(key)} onClick={() => run(key, () => actions.cancelDraft(draft.id))}>{t("vpnDownload.cancelDraft")}</TextButton>
                </SettingsInlineControls>
                {errors[key] ? <Alert color="danger" role="alert">{errors[key]}</Alert> : null}
              </Stack>;
            })}
            {work.plans.flatMap(plan => plan.ranges.map(range => {
              const key = JSON.stringify(["range", plan.id, range.id]);
              const busy = workBusy || pendingKeys.has(key);
              const terminal = range.phase === "completed" || range.phase === "cancelled";
              const exhausted = range.pauseReason === "profiles-exhausted";
              const profile = profiles.find(profile => profile.id === range.profileId);
              const label = (id: number) => snapshot.chapterLabels[plan.id]?.[id] ?? t("vpnDownload.chapterId", { id });
              const interval = `${label(range.startChapterId)} / ${label(range.endChapterId)}`;
              const currentId = range.selectedChapterIds[range.checkpoint];
              const canResume = !busy && !workHeld && !snapshot.loading && runEnabled && snapshot.capabilities.supported;
              const reasonKey = range.pauseReason ? PAUSE_KEYS[range.pauseReason] : undefined;
              const phaseKey = range.phase === "paused" && !range.userPaused && !range.pauseReason && runEnabled ? "vpnDownload.phase.waitingWorker" : PHASE_KEYS[range.phase];
              const actionLabel = (action: string) => t("vpnDownload.rangeAction", { action, title: plan.title, interval });
              return (
                <Stack key={range.id} gap="xs" className="norea-vpn-download-range" data-vpn-range={range.id} component="section" aria-label={`${plan.title}: ${interval}`}>
                  <Group justify="space-between" gap="sm">
                    <Text size="sm" fw={500} className="norea-vpn-download-heading">{interval}</Text>
                    <Text size="sm">{t(phaseKey)}</Text>
                  </Group>
                  <Text size="sm" className="norea-vpn-download-heading">{profile ? `${profile.ip} · ${profile.protocol.toUpperCase()}` : t("vpnDownload.profileMissing", { id: range.profileId })}</Text>
                  <Text size="sm" className="norea-vpn-download-progress">{t("vpnDownload.progress", { completed: range.checkpoint, total: range.selectedChapterIds.length })}</Text>
                  <Progress aria-label={t("vpnDownload.progressLabel")} value={range.selectedChapterIds.length ? range.checkpoint / range.selectedChapterIds.length * 100 : 100} size="xs" />
                  {!terminal && currentId !== undefined ? <Text size="sm">{t("vpnDownload.currentChapter", { chapter: label(currentId) })}</Text> : null}
                  {range.pauseReason ? <Text size="sm" c="dimmed">{reasonKey ? t(reasonKey) : range.pauseReason}</Text> : null}
                  {range.userPaused && range.pauseReason !== "user-paused" ? <Text size="sm" c="dimmed">{t("vpnDownload.userPaused")}</Text> : null}
                  {!terminal ? <SettingsInlineControls>
                    {range.phase === "paused" ?
                      <TextButton aria-label={actionLabel(t("vpnDownload.resume"))} disabled={!canResume || exhausted}
                        onClick={() => { if (canResume && !exhausted) return run(key, () => actions.resumeRange(plan.id, range.id)); }}>{t("vpnDownload.resume")}</TextButton> :
                      <TextButton aria-label={actionLabel(t("vpnDownload.pause"))} disabled={busy}
                        onClick={() => run(key, () => actions.pauseRange(plan.id, range.id))}>{t("vpnDownload.pause")}</TextButton>}
                    {exhausted && range.phase === "paused" ? <TextButton aria-label={actionLabel(t("vpnDownload.restartPass"))} disabled={!canResume}
                      onClick={() => { if (canResume) return run(key, () => actions.resumeRange(plan.id, range.id, true)); }}>{t("vpnDownload.restartPass")}</TextButton> : null}
                    {range.challenge ? <TextButton aria-label={actionLabel(t("vpnDownload.openVerification"))} disabled={busy || !snapshot.capabilities.supported || !runEnabled}
                      onClick={() => { if (snapshot.capabilities.supported && runEnabled) return run(key, () => actions.openVerification(plan.id, range.id)); }}>{t("vpnDownload.openVerification")}</TextButton> : null}
                    <TextButton tone="danger" aria-label={actionLabel(t("vpnDownload.cancelRange"))} disabled={busy}
                      onClick={async () => {
                        const confirmed = await confirm({ title: t("vpnDownload.cancelRangeConfirm.title"),
                          message: t("vpnDownload.cancelRangeConfirm.message", { title: plan.title, interval, completed: range.checkpoint, total: range.selectedChapterIds.length }),
                          confirmLabel: t("vpnDownload.cancelRange"), cancelLabel: t("common.keep"), danger: true });
                        if (confirmed) await run(key, () => actions.cancelRange(plan.id, range.id));
                      }}>{t("vpnDownload.cancelRange")}</TextButton>
                  </SettingsInlineControls> : null}
                  {errors[key] ? <Alert color="danger" role="alert">{errors[key]}</Alert> : null}
                </Stack>
              );
            }))}
          </Stack>
        );
      })}
    </Stack>
  );
}
