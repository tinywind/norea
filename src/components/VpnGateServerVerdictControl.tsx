import type { VpnGateServerVerdictValue } from "../db/queries/vpn-gate-server-verdict";
import { useTranslation } from "../i18n";
import { IconButton } from "./IconButton";
import { ExcludeIcon, PreferIcon } from "./ui/icons";

interface VpnGateServerVerdictControlProps {
  /** Shows the Not used toggle; lists whose rows are all Preferred offer Not used elsewhere. */
  blockable?: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  ip: string;
  onChange: (verdict: VpnGateServerVerdictValue | null) => void | Promise<void>;
  /** Blocks only "Add to Preferred", for a server whose profile cannot be saved yet. */
  preferDisabledReason?: string | null;
  size?: "sm" | "lg";
  verdict: VpnGateServerVerdictValue | null;
}

/** Pressing a list toggle sets that entry, and pressing it again clears it. */
export function toggledVpnGateServerVerdict(
  verdict: VpnGateServerVerdictValue | null,
  pressed: VpnGateServerVerdictValue,
): VpnGateServerVerdictValue | null {
  return verdict === pressed ? null : pressed;
}

export function VpnGateServerVerdictControl({
  blockable = true,
  disabled = false,
  disabledReason,
  ip,
  onChange,
  preferDisabledReason,
  size = "lg",
  verdict,
}: VpnGateServerVerdictControlProps) {
  const { t } = useTranslation();
  const preferred = verdict === "works";
  const blocked = verdict === "fails";
  const preferBlocked = !preferred && Boolean(preferDisabledReason);
  const describe = (label: string, reason?: string | null) =>
    reason ? `${label}. ${reason}` : label;

  return (
    <span
      aria-label={t("settings.data.pluginVpn.finder.verdict.group", { ip })}
      className="norea-vpn-gate-verdict-control"
      data-verdict={verdict ?? "unmarked"}
      role="group"
    >
      <IconButton
        active={preferred}
        aria-pressed={preferred}
        className="norea-vpn-gate-verdict-toggle"
        disabled={disabled || preferBlocked}
        label={describe(
          t(preferred
            ? "settings.data.pluginVpn.finder.verdict.unprefer"
            : "settings.data.pluginVpn.finder.verdict.prefer"),
          disabled ? disabledReason : preferBlocked ? preferDisabledReason : null,
        )}
        onClick={() => {
          void onChange(toggledVpnGateServerVerdict(verdict, "works"));
        }}
        size={size}
      >
        <PreferIcon />
      </IconButton>
      {blockable ? <IconButton
        active={blocked}
        aria-pressed={blocked}
        className="norea-vpn-gate-verdict-toggle"
        disabled={disabled}
        label={describe(
          t(blocked
            ? "settings.data.pluginVpn.finder.verdict.unblock"
            : "settings.data.pluginVpn.finder.verdict.block"),
          disabled ? disabledReason : null,
        )}
        onClick={() => {
          void onChange(toggledVpnGateServerVerdict(verdict, "fails"));
        }}
        size={size}
        tone={blocked ? "danger" : "default"}
      >
        <ExcludeIcon />
      </IconButton> : null}
    </span>
  );
}
