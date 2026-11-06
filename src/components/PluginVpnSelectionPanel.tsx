import type { ReactNode } from "react";
import { Badge, Loader, Text, TextInput } from "@mantine/core";
import { useTranslation, type TranslationKey } from "../i18n";
import {
  cancelPluginVpnUrlTests,
  parsePluginVpnTestUrl,
  runPluginVpnUrlTests,
  type PluginVpnUrlTestOutcome,
  type PluginVpnUrlTestTarget,
} from "../lib/plugin-vpn-url-test";
import { isAndroidRuntime } from "../lib/tauri-runtime";
import { usePluginVpnUrlTestStore } from "../store/plugin-vpn-url-test";
import { IconButton } from "./IconButton";
import { TextButton } from "./TextButton";
import { CloseIcon, DeselectIcon, SelectAllIcon } from "./ui/icons";
import "../styles/plugin-vpn-finder.css";

interface PluginVpnSelectionPanelProps {
  /** Labeled bulk actions, as `SelectionAction`s. */
  actions: ReactNode;
  allSelected: boolean;
  count: number;
  onDeselectAll: () => void;
  onExit: () => void;
  onSelectAll: () => void;
  selectAllDisabled: boolean;
  /** The selected rows that have a profile to test, in list order. */
  testTargets: readonly PluginVpnUrlTestTarget[];
  /** Selected rows without a profile to test. */
  untestableCount?: number;
}

/**
 * Selection mode inside a VPN sheet: done, the count and select all on one
 * line, the bulk actions under it, then the URL test for the selected rows.
 */
export function PluginVpnSelectionPanel({
  actions,
  allSelected,
  count,
  onDeselectAll,
  onExit,
  onSelectAll,
  selectAllDisabled,
  testTargets,
  untestableCount = 0,
}: PluginVpnSelectionPanelProps) {
  const { t } = useTranslation();
  const countLabel = t("library.selectedCount", { count });

  return (
    <section aria-label={countLabel} className="norea-plugin-vpn-selection">
      <div className="norea-plugin-vpn-selection-bar">
        <IconButton label={t("selection.exit")} onClick={onExit} size="lg">
          <CloseIcon />
        </IconButton>
        <Text aria-live="polite" className="norea-plugin-vpn-selection-count" component="span" size="sm">
          {countLabel}
        </Text>
        {allSelected ? (
          <IconButton label={t("selection.deselectAll")} onClick={onDeselectAll} size="lg">
            <DeselectIcon />
          </IconButton>
        ) : (
          <IconButton disabled={selectAllDisabled} label={t("selection.selectAll")} onClick={onSelectAll} size="lg">
            <SelectAllIcon />
          </IconButton>
        )}
      </div>
      <div className="norea-plugin-vpn-selection-actions">{actions}</div>
      {isAndroidRuntime() ? <PluginVpnUrlTestForm targets={testTargets} untestableCount={untestableCount} /> : null}
    </section>
  );
}

function PluginVpnUrlTestForm({ targets, untestableCount }: { targets: readonly PluginVpnUrlTestTarget[]; untestableCount: number }) {
  const { t } = useTranslation();
  const url = usePluginVpnUrlTestStore((state) => state.url);
  const setUrl = usePluginVpnUrlTestStore((state) => state.setUrl);
  const run = usePluginVpnUrlTestStore((state) => state.run);
  const pending = usePluginVpnUrlTestStore((state) => Object.keys(state.progress).length);
  const validUrl = parsePluginVpnTestUrl(url) !== null;
  const showInvalid = url.trim() !== "" && !validUrl;
  const current = run ? run.hosts.length - pending + 1 : 0;

  return (
    <div className="norea-plugin-vpn-url-test">
      <TextInput
        autoCapitalize="off"
        autoCorrect="off"
        description={t("settings.data.pluginVpn.urlTest.help")}
        disabled={run !== null}
        error={showInvalid ? t("settings.data.pluginVpn.urlTest.invalidUrl") : undefined}
        inputMode="url"
        label={t("settings.data.pluginVpn.urlTest.url")}
        onChange={(event) => setUrl(event.currentTarget.value)}
        placeholder="https://"
        spellCheck={false}
        type="url"
        value={url}
      />
      <div className="norea-plugin-vpn-url-test-run">
        {run ? (
          <TextButton disabled={run.cancelling} onClick={() => void cancelPluginVpnUrlTests()}>
            {t("settings.data.pluginVpn.urlTest.cancel")}
          </TextButton>
        ) : (
          <TextButton
            disabled={!validUrl || targets.length === 0}
            onClick={() => void runPluginVpnUrlTests(targets, url)}
          >
            {t("settings.data.pluginVpn.urlTest.start", { count: targets.length })}
          </TextButton>
        )}
        {run ? (
          <Text aria-live="polite" className="norea-plugin-vpn-url-test-progress" component="span" role="status" size="sm">
            <Loader size="xs" />
            {t("settings.data.pluginVpn.urlTest.progress", { current: Math.min(current, run.hosts.length), total: run.hosts.length })}
          </Text>
        ) : null}
      </div>
      {untestableCount > 0 ? (
        <Text c="dimmed" size="xs">
          {t("settings.data.pluginVpn.urlTest.untestable", { count: untestableCount })}
        </Text>
      ) : null}
    </div>
  );
}

type UrlTestTone = "ok" | "warn" | "danger";

export interface PluginVpnUrlTestPresentation {
  key: TranslationKey;
  values?: Record<string, string | number>;
  tone: UrlTestTone;
  /** The failure reason shown under the badge. */
  detail: string | null;
  /** Translated guidance shown under the badge instead of `detail`. */
  detailKey?: TranslationKey;
}

/** How one finished test reads in a row: a short badge label, its tone and an optional reason. */
export function pluginVpnUrlTestPresentation(outcome: PluginVpnUrlTestOutcome, locale: string): PluginVpnUrlTestPresentation {
  switch (outcome.kind) {
    case "ok":
      return outcome.status === null
        ? { key: "settings.data.pluginVpn.urlTest.result.okWithoutStatus", values: { ms: outcome.elapsedMs.toLocaleString(locale) }, tone: "ok", detail: null }
        : { key: "settings.data.pluginVpn.urlTest.result.ok", values: { status: outcome.status, ms: outcome.elapsedMs.toLocaleString(locale) }, tone: "ok", detail: null };
    case "httpError":
      return { key: "settings.data.pluginVpn.urlTest.result.httpError", values: { status: outcome.status, ms: outcome.elapsedMs.toLocaleString(locale) }, tone: "warn", detail: null };
    case "cloudflareChallenge":
      return { key: "settings.data.pluginVpn.urlTest.result.cloudflare", values: { status: outcome.status }, tone: "warn", detail: null };
    case "connectionFailed":
      return { key: "settings.data.pluginVpn.urlTest.result.connectionFailed", tone: "danger", detail: outcome.reason };
    case "requestFailed":
      return { key: "settings.data.pluginVpn.urlTest.result.requestFailed", tone: "danger", detail: outcome.reason };
    case "timedOut":
      return {
        key: outcome.stage === "connect" ? "settings.data.pluginVpn.urlTest.result.connectTimedOut" : "settings.data.pluginVpn.urlTest.result.requestTimedOut",
        tone: "danger",
        detail: null,
      };
    case "credentialsRequired":
      return { key: "settings.data.pluginVpn.urlTest.result.credentialsRequired", tone: "warn", detail: null };
    case "inUse":
      return { key: "settings.data.pluginVpn.urlTest.result.inUse", tone: "warn", detail: null };
    case "browserUnavailable":
      return {
        key: "settings.data.pluginVpn.urlTest.result.browserUnavailable",
        tone: "warn",
        detail: null,
        detailKey: "settings.data.pluginVpn.urlTest.result.browserUnavailableHelp",
      };
    case "error":
      return { key: "settings.data.pluginVpn.urlTest.result.error", tone: "danger", detail: outcome.message };
  }
}

const BADGE_COLORS: Record<UrlTestTone, string> = { ok: "ok", warn: "warn", danger: "danger" };

/** The queued, running or latest URL test result for one host; nothing before its first test. */
export function PluginVpnUrlTestStatus({ host }: { host: string }) {
  const { locale, t } = useTranslation();
  const progress = usePluginVpnUrlTestStore((state) => state.progress[host]);
  const record = usePluginVpnUrlTestStore((state) => state.results[host]);

  if (progress) {
    return (
      <div className="norea-plugin-vpn-url-result">
        <Badge
          leftSection={progress === "testing" ? <Loader size={10} color="currentColor" /> : undefined}
          size="sm"
          variant={progress === "testing" ? "light" : "default"}
        >
          {t(progress === "testing" ? "settings.data.pluginVpn.urlTest.result.testing" : "settings.data.pluginVpn.urlTest.result.queued")}
        </Badge>
      </div>
    );
  }
  if (!record) return null;
  const presentation = pluginVpnUrlTestPresentation(record.outcome, locale);
  const label = t(presentation.key, presentation.values);
  return (
    <div className="norea-plugin-vpn-url-result" title={t("settings.data.pluginVpn.urlTest.resultFor", { url: record.url })}>
      <Badge color={BADGE_COLORS[presentation.tone]} size="sm" variant="light">
        {label}
      </Badge>
      {presentation.detailKey || presentation.detail ? (
        <Text className="norea-plugin-vpn-url-result-detail" component="span" size="xs">
          {presentation.detailKey ? t(presentation.detailKey) : presentation.detail}
        </Text>
      ) : null}
    </div>
  );
}
