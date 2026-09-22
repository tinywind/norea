import { Box } from "@mantine/core";
import { useEffect, useState } from "react";
import {
  formatTimeForLocale,
  useTranslation,
  type AppLocale,
} from "../../i18n";
import { type PageInfo } from "./reader-content-metrics";
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
  showScrollPercentage: boolean;
  showBatteryAndTime: boolean;
  isPagedReader: boolean;
  progress: number;
  pageInfo: PageInfo;
  textColor: string;
  bottom: number | string;
}
export function ReaderStatusOverlay({
  showScrollPercentage,
  showBatteryAndTime,
  isPagedReader,
  progress,
  pageInfo,
  textColor,
  bottom: overlayBottom,
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

  return (
    <>
      {" "}
      {(showScrollPercentage || showBatteryAndTime) && (
        <Box
          style={{
            position: "fixed",
            left: "0.75rem",
            right: "0.75rem",
            bottom: overlayBottom,
            display: "flex",
            justifyContent: "space-between",
            gap: "0.75rem",
            color: textColor,
            fontSize: "0.75rem",
            pointerEvents: "none",
            opacity: 0.78,
            zIndex: 4,
          }}
        >
          <span>
            {showScrollPercentage
              ? isPagedReader
                ? `${pageInfo.current}/${pageInfo.total}`
                : `${Math.round(progress)}%`
              : ""}
          </span>
          <span>
            {showBatteryAndTime
              ? [battery, formatClock(now, locale)].filter(Boolean).join(" | ")
              : ""}
          </span>
        </Box>
      )}
    </>
  );
}
