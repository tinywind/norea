import {
  useId,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Alert,
  Box,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  VisuallyHidden,
  type AlertProps,
  type PaperProps,
} from "@mantine/core";
import { BackIconButton } from "./BackIconButton";
import { TextButton } from "./TextButton";
import { useSiteBrowserStore } from "../store/site-browser";

interface BlockingLoadingOverlayProps {
  cancelLabel?: string;
  /** Recovery shown under the label, such as Verify for a held source. */
  children?: ReactNode;
  label: ReactNode;
  onCancel?: () => void;
}

export function BlockingLoadingOverlay({
  cancelLabel,
  children,
  label,
  onCancel,
}: BlockingLoadingOverlayProps) {
  const labelId = useId();
  const siteBrowserVisible = useSiteBrowserStore((state) => state.visible);

  if (siteBrowserVisible) return null;

  return (
    <Box
      aria-busy="true"
      aria-labelledby={labelId}
      aria-modal="true"
      className="norea-blocking-loading-overlay"
      role="dialog"
    >
      <Paper
        className="norea-blocking-loading-panel"
        p="lg"
        radius="sm"
        withBorder
      >
        <Stack align="center" gap="md">
          <Loader aria-hidden="true" size="md" />
          <Text id={labelId} ta="center">
            {label}
          </Text>
          {children}
          {onCancel && cancelLabel ? (
            <TextButton autoFocus onClick={onCancel}>
              {cancelLabel}
            </TextButton>
          ) : null}
        </Stack>
      </Paper>
    </Box>
  );
}

type PageFrameSize = "narrow" | "default" | "wide" | "full";

interface PageFrameProps {
  children: ReactNode;
  className?: string;
  /** A full-width `PageHeader` drawn above the padded frame. */
  header?: ReactNode;
  size?: PageFrameSize;
}

export function PageFrame({
  children,
  className,
  header,
  size = "default",
}: PageFrameProps) {
  const sizeClassName =
    size === "default" ? "" : ` norea-page-frame--${size}`;
  const classNames = `norea-page-frame${sizeClassName}${
    className ? ` ${className}` : ""
  }`;

  return (
    <>
      {header}
      <div className={classNames}>
        <Stack className="norea-page-frame-stack" gap="lg">
          {children}
        </Stack>
      </div>
    </>
  );
}

interface PageHeaderProps
  extends Omit<ComponentPropsWithoutRef<"header">, "children" | "title"> {
  /** Trailing controls, primary first and the overflow last. */
  actions?: ReactNode;
  backDisabled?: boolean;
  /** `close` in a mode that replaces the bar, such as selection. */
  backIcon?: "back" | "close";
  /** Accessible name of the back button; defaults to "Back". */
  backLabel?: string;
  /** One aligned sub-row for controls that do not fit the bar on phones. */
  below?: ReactNode;
  /** Page controls in place of the visible title, such as tabs or a search field. */
  children?: ReactNode;
  /** Leading back button. Omit only on primary navigation destinations. */
  onBack?: () => void;
  /** Omitted while the page is loading or missing, such as an unknown novel. */
  title?: ReactNode;
  /** `span` when the page heading lives elsewhere, as on the novel hero. */
  titleElement?: "h1" | "h2" | "span";
  /** Keeps the title for screen readers only, as on primary destinations. */
  titleHidden?: boolean;
  titleId?: string;
}

/**
 * The one page header.
 *
 * Primary navigation destinations (Library, Updates, History, Browse, More)
 * show no back button and no visible title: the selected bottom nav or rail
 * item already names the page, so the bar carries the page's own controls
 * and the title stays for screen readers only. Every page reached by
 * drilling in passes `onBack`, drawn at the leading edge before its title,
 * which returns to the previous in-app page and falls back to a parent page
 * on a cold start; Android back calls the same handler. Actions always group
 * at the trailing edge.
 */
export function PageHeader({
  actions,
  backDisabled,
  backIcon,
  backLabel,
  below,
  children,
  className,
  onBack,
  title,
  titleElement: TitleElement = "h1",
  titleHidden = false,
  titleId,
  ...props
}: PageHeaderProps) {
  const slot = children ?? null;
  const showTitle = title !== undefined && !titleHidden && slot === null;

  return (
    <header
      className={`norea-app-bar${className ? ` ${className}` : ""}`}
      data-has-back={onBack ? "true" : "false"}
      {...props}
    >
      <div className="norea-app-bar-row">
        {onBack ? (
          <BackIconButton
            className="norea-app-bar-back"
            disabled={backDisabled}
            icon={backIcon}
            label={backLabel}
            onClick={onBack}
          />
        ) : null}
        {title !== undefined && !showTitle ? (
          <VisuallyHidden component={TitleElement} id={titleId}>
            {title}
          </VisuallyHidden>
        ) : null}
        {showTitle ? (
          <TitleElement className="norea-app-bar-title" id={titleId}>
            {title}
          </TitleElement>
        ) : (
          <div className="norea-app-bar-slot">{slot}</div>
        )}
        {actions ? <div className="norea-app-bar-actions">{actions}</div> : null}
      </div>
      {below ? <div className="norea-app-bar-subrow">{below}</div> : null}
    </header>
  );
}

interface PageSectionProps extends PaperProps {
  children: ReactNode;
}

export function PageSection({
  children,
  className,
  ...props
}: PageSectionProps) {
  return (
    <Paper
      className={`norea-surface${className ? ` ${className}` : ""}`}
      p={{ base: "md", sm: "lg" }}
      radius="sm"
      withBorder
      {...props}
    >
      {children}
    </Paper>
  );
}

interface StateViewProps {
  action?: { label: string; onClick: () => void };
  color?: AlertProps["color"];
  /** Diagnostic text, such as a raw error, collapsed under `label`. */
  details?: { content: ReactNode; label: string };
  message?: ReactNode;
  secondaryAction?: { label: string; onClick: () => void };
  title: ReactNode;
}

export function StateView({
  action,
  color,
  details,
  message,
  secondaryAction,
  title,
}: StateViewProps) {
  return (
    <Alert
      className="norea-surface"
      color={color}
      radius="sm"
      title={title}
      variant={color ? "light" : "default"}
    >
      {message ? <Text size="sm">{message}</Text> : null}
      {action || secondaryAction ? (
        <Group gap="xs" mt="md">
          {action ? (
            <TextButton
              size="sm"
              variant="default"
              onClick={action.onClick}
            >
              {action.label}
            </TextButton>
          ) : null}
          {secondaryAction ? (
            <TextButton size="sm" variant="subtle" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </TextButton>
          ) : null}
        </Group>
      ) : null}
      {details ? (
        <details className="norea-state-details">
          <summary>{details.label}</summary>
          <Text c="dimmed" component="div" size="xs">
            {details.content}
          </Text>
        </details>
      ) : null}
    </Alert>
  );
}

interface ListRowProps extends Omit<PaperProps, "title"> {
  actions?: ReactNode;
  ariaLabel?: string;
  badges?: ReactNode;
  heading: ReactNode;
  leading?: ReactNode;
  meta?: ReactNode;
  onActivate?: () => void;
  subtitle?: ReactNode;
}

export function ListRow({
  actions,
  ariaLabel,
  badges,
  className,
  heading,
  leading,
  meta,
  onActivate,
  subtitle,
  ...props
}: ListRowProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!onActivate) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onActivate();
  };

  return (
    <Paper
      className={`norea-surface norea-list-row${onActivate ? " norea-list-row--interactive norea-state-layer" : ""}${className ? ` ${className}` : ""}`}
      onClick={onActivate}
      onKeyDown={handleKeyDown}
      p="md"
      radius="sm"
      role={onActivate ? "button" : undefined}
      tabIndex={onActivate ? 0 : undefined}
      withBorder
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      {...props}
    >
      <Group align="center" gap="md" wrap="nowrap">
        {leading ? <Box className="norea-list-row-leading">{leading}</Box> : null}
        <Box className="norea-list-row-main">
          <Group gap="xs" wrap="wrap">
            <Box className="norea-list-row-heading">{heading}</Box>
            {badges}
          </Group>
          {subtitle ? (
            <Box className="norea-list-row-subtitle">
              {subtitle}
            </Box>
          ) : null}
          {meta ? (
            <Group className="norea-list-row-meta" gap="xs" mt={6} wrap="wrap">
              {meta}
            </Group>
          ) : null}
        </Box>
        {actions ? (
          <Group
            className="norea-list-row-actions"
            gap="xs"
            justify="flex-end"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            wrap="wrap"
          >
            {actions}
          </Group>
        ) : null}
      </Group>
    </Paper>
  );
}
