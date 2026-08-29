import { UnstyledButton } from "@mantine/core";
import type { VpnGateServerVerdictValue } from "../db/queries/vpn-gate-server-verdict";
import { useTranslation, type TranslationKey } from "../i18n";

interface VpnGateServerVerdictControlProps {
  disabled?: boolean;
  disabledReason?: string | null;
  ip: string;
  onChange: (verdict: VpnGateServerVerdictValue | null) => void | Promise<void>;
  verdict: VpnGateServerVerdictValue | null;
}

const VERDICT_LABEL_KEYS: Record<
  VpnGateServerVerdictValue | "unmarked",
  TranslationKey
> = {
  fails: "settings.data.pluginVpn.finder.verdict.fails",
  unmarked: "settings.data.pluginVpn.finder.verdict.unmarked",
  works: "settings.data.pluginVpn.finder.verdict.works",
};

export function nextVpnGateServerVerdict(
  verdict: VpnGateServerVerdictValue | null,
): VpnGateServerVerdictValue | null {
  if (verdict === null) return "works";
  return verdict === "works" ? "fails" : null;
}

export function vpnGateServerVerdictSymbol(
  verdict: VpnGateServerVerdictValue | null,
): "" | "O" | "X" {
  if (verdict === null) return "";
  return verdict === "works" ? "O" : "X";
}

export function VpnGateServerVerdictControl({
  disabled = false,
  disabledReason,
  ip,
  onChange,
  verdict,
}: VpnGateServerVerdictControlProps) {
  const { t } = useTranslation();
  const nextVerdict = nextVpnGateServerVerdict(verdict);
  const currentLabel = t(VERDICT_LABEL_KEYS[verdict ?? "unmarked"]);
  const nextLabel = t(VERDICT_LABEL_KEYS[nextVerdict ?? "unmarked"]);
  const label = t("settings.data.pluginVpn.finder.verdict.controlLabel", {
    current: currentLabel,
    ip,
    next: nextLabel,
  });
  const accessibleLabel = disabledReason ? `${label} ${disabledReason}` : label;

  return (
    <UnstyledButton
      aria-label={accessibleLabel}
      className="lnr-vpn-gate-verdict-control"
      data-verdict={verdict ?? "unmarked"}
      disabled={disabled}
      onClick={() => {
        void onChange(nextVerdict);
      }}
      title={accessibleLabel}
      type="button"
    >
      <span aria-hidden="true">{vpnGateServerVerdictSymbol(verdict)}</span>
    </UnstyledButton>
  );
}
