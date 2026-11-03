import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { listRepositories } from "../../db/queries/repository";
import { shouldOpenFirstRunSetup } from "../../lib/first-run-setup";
import { pluginManager } from "../../lib/plugins/manager";
import { useSetupStore } from "../../store/setup";

/**
 * RD9: once per launch, after the storage gate, opens /setup when the user
 * has neither finished nor skipped it and no repository or plugin exists.
 * Launches into any page other than the Library (a file, a link) are left alone.
 */
export function useFirstRunSetupRedirect(pathname: string): void {
  const navigate = useNavigate();
  const setupState = useSetupStore((state) => state.setupState);
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const checkedRef = useRef(false);

  useEffect(() => {
    if (checkedRef.current || setupState !== null) return;
    checkedRef.current = true;
    let cancelled = false;
    void (async () => {
      const repositories = await listRepositories();
      await pluginManager.loadInstalledFromDb();
      if (cancelled) return;
      const open = shouldOpenFirstRunSetup({
        pathname: pathnameRef.current,
        pluginCount: pluginManager.list().length,
        repositoryCount: repositories.length,
        setupState: useSetupStore.getState().setupState,
      });
      if (open) await navigate({ to: "/setup", replace: true });
    })().catch((error: unknown) => {
      console.warn("[setup] first-run check failed", error);
    });
    return () => {
      cancelled = true;
    };
  }, [navigate, setupState]);
}
