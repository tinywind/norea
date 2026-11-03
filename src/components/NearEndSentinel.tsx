import { useNearEnd } from "../lib/use-near-end";

/** A zero-height marker after a list that asks for more once it comes near. */
export function NearEndSentinel({
  className,
  enabled,
  onNearEnd,
}: {
  className: string;
  enabled: boolean;
  onNearEnd: () => void;
}) {
  const ref = useNearEnd(enabled, onNearEnd);
  return <div aria-hidden="true" className={className} ref={ref} />;
}
