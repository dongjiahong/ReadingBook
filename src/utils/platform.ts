import { useEffect, useState } from 'react';

const MOBILE_BREAKPOINT_PX = 768;

export function isMobileUserAgent(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function isMacDesktopRuntime(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (!('__TAURI_INTERNALS__' in window)) return false;
  if (isMobileUserAgent()) return false;
  return /Mac/i.test(navigator.platform || navigator.userAgent);
}

/**
 * Returns true on Android/iOS runtimes or narrow viewports (<= 768px),
 * allowing desktop browser/window preview of the mobile reading layout.
 */
export function useIsMobileLayout(): boolean {
  const [mobile, setMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return isMobileUserAgent() || window.innerWidth <= MOBILE_BREAKPOINT_PX;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const check = () => {
      setMobile(isMobileUserAgent() || window.innerWidth <= MOBILE_BREAKPOINT_PX);
    };
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  return mobile;
}
