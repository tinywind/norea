import type { KeyboardEvent, ReactNode } from "react";
import {
  Alert,
  Box,
  Group,
  Paper,
  Stack,
  Text,
  Title,
  type AlertProps,
  type PaperProps,
} from "@mantine/core";
import { IconButton } from "./IconButton";
import { TextButton } from "./TextButton";

type PageFrameSize = "narrow" | "default" | "wide" | "full";

interface PageFrameProps {
  children: ReactNode;
  className?: string;
  size?: PageFrameSize;
}

export function PageFrame({
  children,
  className,
  size = "default",
}: PageFrameProps) {
  const sizeClassName =
    size === "default" ? "" : ` lnr-page-frame--${size}`;
  const classNames = `lnr-page-frame${sizeClassName}${
    className ? ` ${className}` : ""
  }`;

  return (
    <main className={classNames}>
      <Stack className="lnr-page-frame-stack" gap="lg">
        {children}
      </Stack>
    </main>
  );
}

interface PageHeaderProps {
  title: ReactNode;
  actions?: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  meta?: ReactNode;
}

export function PageHeader({
  actions,
  description,
  eyebrow,
  meta,
  title,
}: PageHeaderProps) {
  return (
    <header
      className="lnr-page-header"
      data-has-actions={actions ? "true" : "false"}
    >
      <Box className="lnr-page-header-copy">
        {eyebrow ? <Text className="lnr-page-kicker">{eyebrow}</Text> : null}
        <Title className="lnr-page-title" order={1}>
          {title}
        </Title>
        {description ? (
          <Text className="lnr-page-description" mt="xs">
            {description}
          </Text>
        ) : null}
        {meta ? (
          <Group gap="xs" mt="sm">
            {meta}
          </Group>
        ) : null}
      </Box>
      {actions ? (
        <Group gap="xs" justify="flex-end" wrap="wrap">
          {actions}
        </Group>
      ) : null}
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
      className={`lnr-surface${className ? ` ${className}` : ""}`}
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
  action?: {
    icon?: ReactNode;
    iconOnly?: boolean;
    label: string;
    onClick: () => void;
    size?: "sm" | "lg";
  };
  color?: AlertProps["color"];
  message?: ReactNode;
  title: ReactNode;
}

export function StateView({
  action,
  color = "gray",
  message,
  title,
}: StateViewProps) {
  return (
    <Alert className="lnr-surface" color={color} radius="sm" title={title}>
      {message ? <Text size="sm">{message}</Text> : null}
      {action?.iconOnly && action.icon ? (
        <IconButton
          className="lnr-state-action-icon"
          label={action.label}
          mt="md"
          onClick={action.onClick}
          size={action.size ?? "sm"}
          type="button"
        >
          {action.icon}
        </IconButton>
      ) : action ? (
        <TextButton
          mt="md"
          size="sm"
          variant="light"
          onClick={action.onClick}
        >
          {action.label}
        </TextButton>
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
      className={`lnr-surface lnr-list-row${onActivate ? " lnr-list-row--interactive" : ""}${className ? ` ${className}` : ""}`}
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
        {leading ? <Box className="lnr-list-row-leading">{leading}</Box> : null}
        <Box className="lnr-list-row-main">
          <Group gap="xs" wrap="wrap">
            <Box className="lnr-list-row-heading">{heading}</Box>
            {badges}
          </Group>
          {subtitle ? (
            <Box className="lnr-list-row-subtitle">
              {subtitle}
            </Box>
          ) : null}
          {meta ? (
            <Group className="lnr-list-row-meta" gap="xs" mt={6} wrap="wrap">
              {meta}
            </Group>
          ) : null}
        </Box>
        {actions ? (
          <Group
            className="lnr-list-row-actions"
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
