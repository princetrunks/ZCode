// Sando (ShrineTech): phone-width web layout.
// Below 768 px the workspace sidebar becomes an off-canvas drawer that starts closed, and the main pane takes the
// full width. The drawer choice is remembered per browser (localStorage), separately from the desktop layout, so a
// phone never inherits "sidebar open" from a wide window. Desktop (Electron) never takes this path.
import { useSyncExternalStore } from "react";

export const SANDO_NARROW_VIEWPORT_QUERY = "(max-width: 767.98px)";
const MOBILE_SIDEBAR_STORAGE_KEY = "sando.mobileSidebarOpen";

function readNarrowViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(SANDO_NARROW_VIEWPORT_QUERY).matches;
}

export function isNarrowViewport(): boolean {
  return readNarrowViewport();
}

function subscribeNarrowViewport(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(SANDO_NARROW_VIEWPORT_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

export function useNarrowViewport(): boolean {
  return useSyncExternalStore(subscribeNarrowViewport, readNarrowViewport, () => false);
}

/** The phone drawer starts closed unless the user left it open last time. */
export function readMobileSidebarOpen(): boolean {
  try {
    return window.localStorage.getItem(MOBILE_SIDEBAR_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function persistMobileSidebarOpen(open: boolean): void {
  try {
    window.localStorage.setItem(MOBILE_SIDEBAR_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // Private mode / blocked storage: the drawer simply starts closed next time.
  }
}
