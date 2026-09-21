import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import {
  Box,
  Group,
  Paper,
  Text,
  type BoxProps,
  type PaperProps,
} from "@mantine/core";
import { useTranslation } from "../i18n";
import { TextButton } from "./TextButton";

interface ConsoleCoverProps {
  alt: string;
  className?: string;
  height?: number | string;
  src: string | null;
  width?: number | string;
}

export function ConsoleCover({
  alt,
  className,
  height = 72,
  src,
  width = 48,
}: ConsoleCoverProps) {
  const normalizedSrc = normalizeCoverSource(src);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = normalizedSrc !== null && failedSrc !== normalizedSrc;
  const fallbackStyle = useMemo(() => createCoverFallbackStyle(alt), [alt]);

  useEffect(() => {
    setFailedSrc(null);
  }, [normalizedSrc]);

  const style = {
    "--norea-console-cover-height":
      typeof height === "number" ? pxToRem(height) : height,
    "--norea-console-cover-width":
      typeof width === "number" ? pxToRem(width) : width,
    ...fallbackStyle,
  } as CSSProperties;

  return (
    <span
      aria-label={alt}
      className={`norea-console-cover${className ? ` ${className}` : ""}`}
      style={style}
    >
      {showImage ? (
        <img
          alt={alt}
          className="norea-console-cover-image"
          decoding="async"
          draggable={false}
          loading="lazy"
          onError={() => setFailedSrc(normalizedSrc)}
          src={normalizedSrc ?? undefined}
        />
      ) : (
        <ConsoleCoverFallback title={alt} />
      )}
    </span>
  );
}

function normalizeCoverSource(src: string | null): string | null {
  const trimmed = src?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (
      url.hostname === "placehold.co" &&
      /^(No[ +]?Cover|\?)$/i.test(url.searchParams.get("text") ?? "")
    ) {
      return null;
    }
  } catch {
    return trimmed;
  }

  return trimmed;
}

function pxToRem(value: number): string {
  return `${value / 16}rem`;
}

function ConsoleCoverFallback({ title }: { title: string }) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const text = titleRef.current;
    if (!box || !text) return;

    let frame = 0;
    const fitTitle = () => {
      const style = window.getComputedStyle(box);
      const boxWidth =
        box.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      const boxHeight =
        box.clientHeight -
        Number.parseFloat(style.paddingTop) -
        Number.parseFloat(style.paddingBottom);
      if (boxWidth <= 0 || boxHeight <= 0) return;

      const maxSize = Math.min(18, Math.max(9, boxWidth * 0.18));
      let low = 7;
      let high = maxSize;

      text.style.width = `${boxWidth}px`;
      text.style.maxHeight = `${boxHeight}px`;
      text.style.fontSize = `${maxSize}px`;
      for (let i = 0; i < 7; i += 1) {
        const mid = (low + high) / 2;
        text.style.fontSize = `${mid}px`;
        if (
          text.scrollHeight <= boxHeight + 1 &&
          text.scrollWidth <= boxWidth + 1
        ) {
          low = mid;
        } else {
          high = mid;
        }
      }
      text.style.fontSize = `${Math.floor(low * 10) / 10}px`;
    };

    const scheduleFit = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(fitTitle);
    };

    scheduleFit();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleFit);
    observer?.observe(box);
    window.addEventListener("resize", scheduleFit);

    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", scheduleFit);
    };
  }, [title]);

  return (
    <span className="norea-console-cover-fallback" ref={boxRef} title={title}>
      <span className="norea-console-cover-fallback-title" ref={titleRef}>
        {title}
      </span>
    </span>
  );
}

function createCoverFallbackStyle(title: string): CSSProperties {
  const hash = hashTitle(title.trim() || "Untitled");
  const hueA = hash % 360;
  const hueB = (hueA + 48 + ((hash >>> 8) % 96)) % 360;
  const stripeAngles = [0, 24, 45, 60, 90, 120, 135, 156];
  const stripeAngle = stripeAngles[(hash >>> 16) % stripeAngles.length] ?? 45;
  const stripeGap = 16 + ((hash >>> 20) % 12);
  const stripeWidth = 5 + ((hash >>> 24) % 4);

  return {
    "--norea-console-cover-bg-a": `hsl(${hueA}, 52%, 32%)`,
    "--norea-console-cover-bg-b": `hsl(${hueB}, 48%, 20%)`,
    "--norea-console-cover-glow": `hsla(${(hueA + 26) % 360}, 70%, 72%, 0.42)`,
    "--norea-console-cover-stripe-angle": `${stripeAngle}deg`,
    "--norea-console-cover-stripe-gap": pxToRem(stripeGap),
    "--norea-console-cover-stripe-width": pxToRem(stripeWidth),
  } as CSSProperties;
}

function hashTitle(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

interface ConsoleProgressProps {
  className?: string;
  status?: "active" | "done" | "idle";
  value: number;
}

export function ConsoleProgress({
  className,
  status = "active",
  value,
}: ConsoleProgressProps) {
  const { t } = useTranslation();
  const clamped = Math.max(0, Math.min(100, Math.round(value)));

  return (
    <span
      className={`norea-console-progress${className ? ` ${className}` : ""}`}
      aria-label={t("reader.progressAria", { progress: clamped })}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
    >
      <span
        className="norea-console-progress-bar"
        data-status={status}
        style={{ width: `${clamped}%` }}
      />
    </span>
  );
}

interface ConsoleStatusDotProps {
  label: ReactNode;
  status?: "active" | "done" | "idle" | "warning" | "error";
}

export function ConsoleStatusDot({
  label,
  status = "idle",
}: ConsoleStatusDotProps) {
  return (
    <span className="norea-console-status" data-status={status}>
      <span className="norea-console-status-dot" aria-hidden />
      {label}
    </span>
  );
}

interface ConsoleChipProps {
  active?: boolean;
  ariaLabel?: string;
  children: ReactNode;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  pressed?: boolean;
  title?: string;
  tone?: "default" | "accent" | "error" | "warning" | "success";
}

export function ConsoleChip({
  active = false,
  ariaLabel,
  children,
  disabled = false,
  onClick,
  pressed,
  title,
  tone = "default",
}: ConsoleChipProps) {
  if (onClick) {
    return (
      <TextButton
        aria-label={ariaLabel}
        aria-pressed={pressed}
        active={active}
        className="norea-console-chip"
        disabled={disabled}
        onClick={onClick}
        size="sm"
        title={title}
        tone={tone}
        type="button"
      >
        {children}
      </TextButton>
    );
  }

  return (
    <span
      aria-label={ariaLabel}
      className="norea-console-chip"
      data-active={active}
      data-tone={tone}
      title={title}
    >
      {children}
    </span>
  );
}

interface ConsolePanelProps extends PaperProps {
  children?: ReactNode;
  title?: ReactNode;
}

export function ConsolePanel({
  children,
  className,
  title,
  ...props
}: ConsolePanelProps) {
  return (
    <Paper
      className={`norea-console-panel${className ? ` ${className}` : ""}`}
      radius={5}
      withBorder
      {...props}
    >
      {title ? <div className="norea-console-panel-title">{title}</div> : null}
      {children}
    </Paper>
  );
}

interface ConsoleSectionHeaderProps {
  actions?: ReactNode;
  count?: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
}

export function ConsoleSectionHeader({
  actions,
  count,
  eyebrow,
  title,
}: ConsoleSectionHeaderProps) {
  return (
    <Group className="norea-console-section-header" justify="space-between">
      <Box style={{ minWidth: 0 }}>
        {eyebrow ? <Text className="norea-console-kicker">{eyebrow}</Text> : null}
        <Group gap="xs" wrap="nowrap">
          <Text className="norea-console-section-title" truncate>
            {title}
          </Text>
          {count ? <span className="norea-console-section-count">{count}</span> : null}
        </Group>
      </Box>
      {actions ? (
        <Group gap="xs" justify="flex-end" wrap="wrap">
          {actions}
        </Group>
      ) : null}
    </Group>
  );
}

interface ConsoleStatusStripProps extends BoxProps {
  children: ReactNode;
}

export function ConsoleStatusStrip({
  children,
  className,
  ...props
}: ConsoleStatusStripProps) {
  return (
    <Box
      className={`norea-console-status-strip${className ? ` ${className}` : ""}`}
      {...props}
    >
      {children}
    </Box>
  );
}
