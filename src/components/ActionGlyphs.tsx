interface ActionGlyphProps {
  className?: string;
}

export function CheckGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 12l5 5L20 6" />
    </svg>
  );
}

export function ArrowDownGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 5v14" />
      <path d="m7 14 5 5 5-5" />
    </svg>
  );
}

export function ArrowUpGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 19V5" />
      <path d="m7 10 5-5 5 5" />
    </svg>
  );
}

export function ChevronDownGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function ChevronUpGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="m6 15 6-6 6 6" />
    </svg>
  );
}

export function CloseGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </svg>
  );
}

export function ClockGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v5l3 2" />
    </svg>
  );
}

export function DownloadGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 4v10" />
      <path d="m8 10 4 4 4-4" />
      <path d="M5 20h14" />
    </svg>
  );
}

export function DownloadedGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5 5h14v14H5z" />
      <path d="m8 12 3 3 5-6" />
    </svg>
  );
}

export function LibraryAddGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 0-4 4z" />
      <path d="M12 9v6" />
      <path d="M9 12h6" />
    </svg>
  );
}

export function LibraryAddedGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 0-4 4z" />
      <path d="m9 12 2 2 5-5" />
    </svg>
  );
}

export function DetailsGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  );
}

export function DragHandleGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="9" cy="7" r="1" />
      <circle cx="15" cy="7" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="17" r="1" />
      <circle cx="15" cy="17" r="1" />
    </svg>
  );
}

export function EditGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

export function ExternalLinkGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

export function MoreGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}

export function PlayGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

export function PauseGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M8 5v14" />
      <path d="M16 5v14" />
    </svg>
  );
}

export function PlayFromStartGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5 5v14" />
      <path d="M10 5v14l9-7z" />
    </svg>
  );
}

export function PinGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M14 4l6 6" />
      <path d="M9 14 4 19" />
      <path d="M10 4h7l3 3-7 7v5l-2 1-7-7 1-2h5z" />
    </svg>
  );
}

export function UnpinGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 17v5" />
      <path d="M7 17h10" />
      <path d="M9 4h6" />
      <path d="M10 4v7l-3 6h10l-3-6V4" />
    </svg>
  );
}

export function PlusGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export function RefreshGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M20 12a8 8 0 0 1-13.66 5.66" />
      <path d="M4 12A8 8 0 0 1 17.66 6.34" />
      <path d="M17 3v4h-4" />
      <path d="M7 21v-4h4" />
    </svg>
  );
}

export function RepositoryGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5 6h14" />
      <path d="M5 12h14" />
      <path d="M5 18h14" />
      <path d="M8 4v4" />
      <path d="M8 10v4" />
      <path d="M8 16v4" />
    </svg>
  );
}

export function RetryGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v6h-6" />
    </svg>
  );
}

export function SearchGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

export function SettingsGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3" />
      <path d="M12 19v3" />
      <path d="M4.93 4.93l2.12 2.12" />
      <path d="M16.95 16.95l2.12 2.12" />
      <path d="M2 12h3" />
      <path d="M19 12h3" />
      <path d="M4.93 19.07l2.12-2.12" />
      <path d="M16.95 7.05l2.12-2.12" />
    </svg>
  );
}

export function ReaderSettingsGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 7h16" />
      <path d="M4 17h16" />
      <path d="M8 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
      <path d="M16 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
    </svg>
  );
}

export function SourceGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5 5h9a4 4 0 0 1 4 4v10H9a4 4 0 0 0-4 4z" />
      <path d="M9 10h5" />
      <path d="M9 14h4" />
    </svg>
  );
}

export function SortGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 7h10" />
      <path d="M4 12h7" />
      <path d="M4 17h4" />
      <path d="M17 5v14" />
      <path d="m14 16 3 3 3-3" />
    </svg>
  );
}

export function SpinnerGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 3a9 9 0 1 1-8.49 6" />
    </svg>
  );
}

export function TrashGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M7 7l1 13h8l1-13" />
      <path d="M10 11v5" />
      <path d="M14 11v5" />
    </svg>
  );
}

export function UnreadGlyph({ className }: ActionGlyphProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5 5h14v14H5z" />
      <path d="M8 10h6" />
      <path d="M8 14h5" />
      <circle cx="17" cy="7" r="2" />
    </svg>
  );
}
