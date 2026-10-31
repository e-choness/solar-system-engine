export interface DeviceHints {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** navigator.userAgentData.mobile, where the browser has it. */
  uaMobile?: boolean;
}

/**
 * Phones and tablets, including iPads that report themselves as Macs. Touch
 * laptops are deliberately not mobile: they have a desktop GPU and keep the full
 * desktop renderer.
 */
export function isMobileDevice(h: DeviceHints) {
  if (h.uaMobile) return true;
  if (/Android|iPhone|iPad|iPod|Mobi/i.test(h.userAgent)) return true;
  return h.platform === 'MacIntel' && h.maxTouchPoints > 1;
}

const nav = typeof navigator === 'undefined' ? null : (navigator as Navigator & { userAgentData?: { mobile?: boolean } });

/** Selects the mobile render budget: every desktop code path stays as it was when this is false. */
export const MOBILE = nav
  ? isMobileDevice({
      userAgent: nav.userAgent,
      platform: nav.platform,
      maxTouchPoints: nav.maxTouchPoints,
      uaMobile: nav.userAgentData?.mobile,
    })
  : false;

/** iPhone Safari has no element fullscreen, and embeds may not be allowed it. */
export const CAN_FULLSCREEN = typeof document !== 'undefined' && Boolean(document.fullscreenEnabled);

const WEBGL_KEY = 'solar-system.force-webgl';

/** True after WebGPU failed on this device earlier in the session. */
export function webglForced() {
  try {
    return sessionStorage.getItem(WEBGL_KEY) === '1';
  } catch {
    return false;
  }
}

/** Makes the next page load skip WebGPU. */
export function forceWebGL() {
  try {
    sessionStorage.setItem(WEBGL_KEY, '1');
  } catch {
    // Storage can be unavailable inside sandboxed iframes; the reload then tries WebGPU again.
  }
}
