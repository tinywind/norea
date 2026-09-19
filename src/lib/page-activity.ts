import { createContext, useContext } from "react";

/**
 * Whether the enclosing page slot is the page currently shown. Pages that stay
 * mounted behind the active page read `false` and must not react to input,
 * back navigation, or history events.
 */
export const PageActivityContext = createContext(true);

export function usePageActivity(): boolean {
  return useContext(PageActivityContext);
}
