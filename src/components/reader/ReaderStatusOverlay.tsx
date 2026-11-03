import { Box } from "@mantine/core";
import { useEffect, useState } from "react";
import {
  formatTimeForLocale,
  useTranslation,
  type AppLocale,
} from "../../i18n";
interface BatteryManagerLike {
  level: number;
  charging: boolean;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

function formatClock(date: Date, locale: AppLocale): string {
  return formatTimeForLocale(locale, date);
}

interface ReaderStatusOverlayProps {
  showProgress: boolean;
  showBatteryAndTime: boolean;
  progressLabel: string;
  textColor: string;
}
export function ReaderStatusOverlay({
  showProgress,
  showBatteryAndTime,
  progressLabel,
  textColor,
}: ReaderStatusOverlayProps) {
  const { locale, t } = useTranslation();
  const [now, setNow] = useState(() => new Date());
  const [battery, setBattery] = useState<string | null>(null);
  useEffect(() => {
    if (!showBatteryAndTime) return;
    const interval = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, [showBatteryAndTime]);

  useEffect(() => {
    if (!showBatteryAndTime) {
      setBattery(null);
      return;
    }
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<BatteryManagerLike>;
    };
    let manager: BatteryManagerLike | null = null;
    let disposed = false;
    const update = () => {
      if (!manager || disposed) return;
      setBattery(
        `${Math.round(manager.level * 100)}%${
          manager.charging ? ` ${t("readerContent.charging")}` : ""
        }`,
      );
    };
    void nav
      .getBattery?.()
      .then((nextManager) => {
        if (disposed) return;
        manager = nextManager;
        update();
        manager.addEventListener?.("levelchange", update);
        manager.addEventListener?.("chargingchange", update);
      })
      .catch(() => setBattery(null));
    return () => {
      disposed = true;
      manager?.removeEventListener?.("levelchange", update);
      manager?.removeEventListener?.("chargingchange", update);
    };
  }, [showBatteryAndTime, t]);

  if (!showProgress && !showBatteryAndTime) return null;

  return (
    <Box
      className="norea-reader-status-overlay"
      style={{ color: textColor }}
    >
      <span>{showProgress ? progressLabel : ""}</span>
      <span>
        {showBatteryAndTime
          ? [battery, formatClock(now, locale)].filter(Boolean).join(" | ")
          : ""}
      </span>
    </Box>
  );
}
