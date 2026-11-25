import { useEffect, useRef } from 'react';

interface BackEntry {
  id: number;
  onBack: () => void;
}

let nextEntryId = 1;
const stack: BackEntry[] = [];
const poppedByBrowser = new Set<number>();
let ignoringPopCount = 0;
let listenerAttached = false;

function ensurePopstateListener(): void {
  if (listenerAttached || typeof window === 'undefined') return;
  listenerAttached = true;

  window.addEventListener('popstate', () => {
    if (ignoringPopCount > 0) {
      ignoringPopCount -= 1;
      return;
    }
    const top = stack.pop();
    if (!top) return;
    poppedByBrowser.add(top.id);
    top.onBack();
  });
}

/**
 * Registers a layered Back-navigation handler synced with `window.history`.
 * On Android (edge-swipe or system Back), Tauri WebView pops history instead of
 * exiting the Activity, closing the top-most modal/sheet/reader step by step.
 */
export function useBackHandler(active: boolean, onBack: () => void): void {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    ensurePopstateListener();

    const id = nextEntryId++;
    stack.push({
      id,
      onBack: () => onBackRef.current(),
    });
    window.history.pushState({ __rbBackId: id }, '');

    return () => {
      if (poppedByBrowser.has(id)) {
        poppedByBrowser.delete(id);
        return;
      }
      const idx = stack.findIndex((item) => item.id === id);
      if (idx !== -1) {
        stack.splice(idx, 1);
        ignoringPopCount += 1;
        window.history.back();
      }
    };
  }, [active]);
}
