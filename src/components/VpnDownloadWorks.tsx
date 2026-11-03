import { useRef, useState } from "react";
import { Alert, Group, Progress, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation, type TranslationKey } from "../i18n";
import { describeError } from "../lib/errors";
import { listSavedPluginVpnProfiles, SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY } from "../lib/plugin-vpn-profiles";
import type { VpnDownloadDraftWork, VpnDownloadHandoverWork, VpnDownloadRuntimeSnapshot } from "../lib/tasks/vpn-download-drafts";
import { isVpnDownloadVerificationNeeded } from "../lib/tasks/vpn-download-notifications";
import {
  cancelVpnDownloadDraft, cancelVpnDownloadHandoverWork, cancelVpnDownloadRange, openVpnDownloadVerification,
  pauseVpnDownloadWork, resumeVpnDownloadRange, resumeVpnDownloadWork, startVpnDownloadDraft,
} from "../lib/tasks/vpn-download-runtime";
import type { VpnDownloadPlan, VpnDownloadRangeState } from "../lib/tasks/vpn-download-types";
import { SettingsInlineControls } from "./SettingsPrimitives";
import { TextButton } from "./TextButton";
import { useConfirm } from "./ui/ConfirmDialog";
import { CloseIcon, InfoIcon, PauseIcon, PlayIcon } from "./ui/icons";
import { OverflowMenu, type OverflowMenuItem } from "./ui/OverflowMenu";
import { ResponsiveSheet } from "./ui/ResponsiveSheet";

export interface VpnDownloadWorkActions {
  retryDraft: (draftId: string) => Promise<void>;
  pauseWork: (pluginId: string, novelId: number) => Promise<void>;
  resumeWork: (pluginId: string, novelId: number) => Promise<void>;
  cancelDraft: (draftId: string) => void | Promise<void>;
  cancelHandoverWork: (workId: string) => Promise<void>;
  resumeRange: (planId: string, rangeId: string) => Promise<void>;
  cancelRange: (planId: string, rangeId: string) => Promise<void>;
  openVerification: (planId: string, rangeId: string) => Promise<void>;
}

const runtimeActions: VpnDownloadWorkActions = {
  retryDraft: startVpnDownloadDraft, pauseWork: pauseVpnDownloadWork, resumeWork: resumeVpnDownloadWork,
  cancelDraft: cancelVpnDownloadDraft, cancelHandoverWork: cancelVpnDownloadHandoverWork,
  resumeRange: resumeVpnDownloadRange, cancelRange: cancelVpnDownloadRange, openVerification: openVpnDownloadVerification,
};

/** One novel's VPN-owned downloads, gathered across its handover waits, preparing drafts and enrolled plans. */
export interface VpnDownloadWork {
  key: string;
  title: string;
  pluginId: string;
  novelId: number;
  drafts: VpnDownloadDraftWork[];
  plans: VpnDownloadPlan[];
  handover: VpnDownloadHandoverWork[];
  completed: number;
  total: number;
  unfinished: { planId: string; range: VpnDownloadRangeState }[];
  /** The user paused the whole work. */
  held: boolean;
  canPause: boolean;
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
const terminal = (range: VpnDownloadRangeState) => range.phase === "completed" || range.phase === "cancelled";

export function vpnDownloadWorks(snapshot: VpnDownloadRuntimeSnapshot): VpnDownloadWork[] {
  const works = new Map<string, VpnDownloadWork>();
  for (const item of [...snapshot.plans, ...snapshot.drafts, ...snapshot.handover ?? []]) {
    const key = JSON.stringify([item.pluginId, item.novelId]);
    const work = works.get(key) ?? { key, title: item.title, pluginId: item.pluginId, novelId: item.novelId, drafts: [], plans: [], handover: [],
      completed: 0, total: 0, unfinished: [], held: false, canPause: false };
    if ("ranges" in item) {
      work.plans.push(item);
      for (const range of item.ranges) {
        work.total += range.selectedChapterIds.length;
        work.completed += range.checkpoint;
        if (!terminal(range)) work.unfinished.push({ planId: item.id, range });
      }
    } else if ("chapterIds" in item) {
      work.handover.push(item);
      work.total += item.chapterIds.length;
    } else {
      work.drafts.push(item);
      work.total += item.selectedChapterIds.length;
    }
    works.set(key, work);
  }
  return [...works.values()].filter(work => work.unfinished.length || work.drafts.length || work.handover.length).map(work => {
    const held = work.unfinished.some(({ range }) => range.userPaused && range.pauseReason === "work-paused") ||
      work.drafts.some(draft => draft.userPaused) || work.handover.some(waiting => waiting.userPaused);
    return { ...work, held, canPause: !held && (work.unfinished.some(({ range }) => !range.userPaused) || work.drafts.length > 0 || work.handover.length > 0) };
  });
}

function usePendingActions() {
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const pending = useRef(new Set<string>());
  async function run(key: string, action: () => unknown | Promise<unknown>): Promise<void> {
    if (pending.current.has(key)) return;
    pending.current.add(key); setPendingKeys(new Set(pending.current));
    setErrors(current => ({ ...current, [key]: null }));
    try { await action(); }
    catch (error) { setErrors(current => ({ ...current, [key]: describeError(error) })); }
    finally { pending.current.delete(key); setPendingKeys(new Set(pending.current)); }
  }
  return { pendingKeys, errors, run };
}

/** A novel row in the Downloads list for work that downloads through VPN workers. */
export function VpnDownloadWorkRow({ work, snapshot, actions = runtimeActions }: {
  work: VpnDownloadWork;
  snapshot: VpnDownloadRuntimeSnapshot;
  actions?: VpnDownloadWorkActions;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [detailsOpened, setDetailsOpened] = useState(false);
  const { pendingKeys, errors, run } = usePendingActions();
  const busy = pendingKeys.has(work.key);
  const runEnabled = !snapshot.run || snapshot.run.status === "running";
  const items: OverflowMenuItem[] = [];
  if (work.canPause) items.push({ icon: PauseIcon, label: t("vpnDownload.pauseWork"), disabled: busy || !runEnabled,
    onClick: () => { if (runEnabled) void run(work.key, () => actions.pauseWork(work.pluginId, work.novelId)); } });
  else if (work.held) items.push({ icon: PlayIcon, label: t("vpnDownload.resumeWork"), disabled: busy || !runEnabled,
    onClick: () => { if (runEnabled) void run(work.key, () => actions.resumeWork(work.pluginId, work.novelId)); } });
  items.push({ icon: InfoIcon, label: t("vpnDownload.details"), onClick: () => setDetailsOpened(true) });
  items.push({ icon: CloseIcon, label: t("vpnDownload.cancelWork"), danger: true, disabled: busy, onClick: () => { void (async () => {
    const confirmed = await confirm({ title: t("vpnDownload.cancelWorkConfirm.title", { title: work.title }),
      message: t("vpnDownload.cancelWorkConfirm.message", { count: work.drafts.length + work.handover.length + work.unfinished.length }),
      confirmLabel: t("vpnDownload.cancelWork"), cancelLabel: t("common.keep"), danger: true });
    if (confirmed) await run(work.key, () => Promise.all([
      ...work.drafts.map(draft => actions.cancelDraft(draft.id)),
      ...work.handover.map(waiting => actions.cancelHandoverWork(waiting.id)),
      ...work.unfinished.map(({ planId, range }) => actions.cancelRange(planId, range.id)),
    ]));
  })(); } });

  return (
    <div className="norea-task-work-group" data-collapsed="true" data-vpn-work={work.key}>
      <div className="norea-task-work-header">
        <div className="norea-task-work-copy">
          <Text className="norea-task-work-title" lineClamp={1}>{work.title}</Text>
          <span className="norea-task-route-label">{t("vpnDownload.routeLabel")}</span>
          <span className="norea-task-group-count">{t("vpnDownload.workProgress", { completed: work.completed, total: work.total })}</span>
          {work.held ? <span className="norea-task-group-count">{t("vpnDownload.phase.paused")}</span> : null}
        </div>
        <div className="norea-task-group-actions">
          <OverflowMenu items={items} label={t("vpnDownload.workOptions", { title: work.title })} />
        </div>
      </div>
      <Progress aria-label={t("vpnDownload.workProgressLabel", { title: work.title })} className="norea-task-work-progress"
        value={work.total ? work.completed / work.total * 100 : 0} size="xs" />
      {errors[work.key] ? <Alert color="danger" role="alert">{errors[work.key]}</Alert> : null}
      <ResponsiveSheet opened={detailsOpened} onClose={() => setDetailsOpened(false)} title={t("vpnDownload.detailsTitle", { title: work.title })}>
        {detailsOpened ? <VpnDownloadWorkDetails work={work} snapshot={snapshot} actions={actions} /> : null}
      </ResponsiveSheet>
    </div>
  );
}

function rangeStateKey(range: VpnDownloadRangeState, runEnabled: boolean): TranslationKey | null {
  if (terminal(range) || range.phase !== "paused") return PHASE_KEYS[range.phase];
  if (range.pauseReason) return PAUSE_KEYS[range.pauseReason] ?? null;
  if (range.userPaused) return "vpnDownload.userPaused";
  return runEnabled ? "vpnDownload.phase.waitingWorker" : PHASE_KEYS.paused;
}

/** The technical breakdown of one work: its ranges, their servers and why each one waits. */
export function VpnDownloadWorkDetails({ work, snapshot, actions = runtimeActions }: {
  work: VpnDownloadWork;
  snapshot: VpnDownloadRuntimeSnapshot;
  actions?: VpnDownloadWorkActions;
}) {
  const { t } = useTranslation();
  const vault = useQuery({ queryKey: SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY, queryFn: listSavedPluginVpnProfiles, meta: { errorPresentation: "inline" } });
  const { pendingKeys, errors, run } = usePendingActions();
  const runEnabled = !snapshot.run || snapshot.run.status === "running";
  const profiles = vault.data?.profiles ?? [];

  return (
    <Stack gap="md">
      {snapshot.error ? <Alert color="danger" role="alert">{snapshot.error}</Alert> : null}
      {work.handover.map(waiting => <Text key={waiting.id} size="sm" role="status" className="norea-vpn-download-range">{t("vpnDownload.phase.waitingHandover")}</Text>)}
      {work.drafts.map(draft => {
        const key = JSON.stringify(["draft", draft.id]);
        const phaseKey: TranslationKey = !runEnabled || draft.userPaused ? "vpnDownload.phase.paused" : draft.phase === "waiting-profile" ? "vpnDownload.phase.waitingProfile" :
          draft.phase === "failed" ? "vpnDownload.phase.failed" : "vpnDownload.phase.preparing";
        return <Stack key={draft.id} gap="xs" className="norea-vpn-download-range">
          <Text size="sm" role="status">{t(phaseKey)}</Text>
          {draft.error ? <Alert color="danger" role="alert">{draft.error}</Alert> : null}
          {draft.phase === "failed" ? <SettingsInlineControls>
            <TextButton disabled={pendingKeys.has(key) || !runEnabled || draft.userPaused} loading={pendingKeys.has(key)}
              onClick={() => { if (runEnabled && !draft.userPaused) return run(key, () => actions.retryDraft(draft.id)); }}>{t("common.retry")}</TextButton>
          </SettingsInlineControls> : null}
          {errors[key] ? <Alert color="danger" role="alert">{errors[key]}</Alert> : null}
        </Stack>;
      })}
      {work.plans.flatMap(plan => plan.ranges.map(range => {
        const key = JSON.stringify(["range", plan.id, range.id]);
        const label = (id: number) => snapshot.chapterLabels[plan.id]?.[id] ?? t("vpnDownload.chapterId", { id });
        const interval = `${label(range.startChapterId)} / ${label(range.endChapterId)}`;
        const stateKey = rangeStateKey(range, runEnabled);
        const profile = profiles.find(candidate => candidate.id === range.profileId && candidate.hash === range.profileHash);
        const verify = isVpnDownloadVerificationNeeded(plan, range);
        const resume = !terminal(range) && range.phase === "paused" && range.userPaused && range.pauseReason !== "work-paused";
        const canAct = !pendingKeys.has(key) && runEnabled && snapshot.capabilities.supported;
        const actionLabel = (action: string) => t("vpnDownload.rangeAction", { action, title: plan.title, interval });
        return (
          <Stack key={range.id} gap="xs" className="norea-vpn-download-range" data-vpn-range={range.id} component="section" aria-label={`${plan.title}: ${interval}`}>
            <Group justify="space-between" gap="sm">
              <Text size="sm" fw={500} className="norea-vpn-download-heading">{interval}</Text>
              <Text size="sm" className="norea-vpn-download-progress">{t("vpnDownload.workProgress", { completed: range.checkpoint, total: range.selectedChapterIds.length })}</Text>
            </Group>
            <Progress aria-label={t("vpnDownload.progressLabel")} value={range.selectedChapterIds.length ? range.checkpoint / range.selectedChapterIds.length * 100 : 100} size="xs" />
            <Text size="sm" c="dimmed">{stateKey ? t(stateKey) : range.pauseReason}</Text>
            {!terminal(range) ? <Text size="sm" c="dimmed" className="norea-vpn-download-heading">
              {profile ? t("vpnDownload.server", { ip: profile.ip, protocol: profile.protocol.toUpperCase() }) : t("vpnDownload.serverPending")}
            </Text> : null}
            {verify || resume ? <SettingsInlineControls>
              {verify ? <TextButton aria-label={actionLabel(t("vpnDownload.openVerification"))} disabled={!canAct}
                onClick={() => { if (canAct) return run(key, () => actions.openVerification(plan.id, range.id)); }}>{t("vpnDownload.openVerification")}</TextButton> : null}
              {resume ? <TextButton aria-label={actionLabel(t("vpnDownload.resume"))} disabled={!canAct || work.held}
                onClick={() => { if (canAct && !work.held) return run(key, () => actions.resumeRange(plan.id, range.id)); }}>{t("vpnDownload.resume")}</TextButton> : null}
            </SettingsInlineControls> : null}
            {errors[key] ? <Alert color="danger" role="alert">{errors[key]}</Alert> : null}
          </Stack>
        );
      }))}
    </Stack>
  );
}
