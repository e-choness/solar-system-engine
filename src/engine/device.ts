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

/** iPhones and iPads, including iPads that report themselves as Macs. Every browser there runs WebKit. */
export function isAppleMobile(h: DeviceHints) {
  if (/iPhone|iPad|iPod/i.test(h.userAgent)) return true;
  return h.platform === 'MacIntel' && h.maxTouchPoints > 1;
}

export const APPLE_MOBILE = nav
  ? isAppleMobile({ userAgent: nav.userAgent, platform: nav.platform, maxTouchPoints: nav.maxTouchPoints })
  : false;

/** iPhone Safari has no element fullscreen, and embeds may not be allowed it. */
export const CAN_FULLSCREEN = typeof document !== 'undefined' && Boolean(document.fullscreenEnabled);

export type BackendChoice = 'webgpu' | 'webgl';

/** `?backend=webgl` or `?backend=webgpu` overrides the automatic choice, for testing on a real device. */
export function requestedBackend(search: string): BackendChoice | null {
  const value = new URLSearchParams(search).get('backend')?.toLowerCase();
  return value === 'webgl' || value === 'webgpu' ? value : null;
}

/**
 * The backend to try first. iPhones and iPads start on WebGL 2: Safari's WebGPU
 * there is new (iOS 26) and the engine failed to start through it on a real
 * iPhone, while WebGL 2 is mature and also runs on Metal. Elsewhere WebGPU comes
 * first, unless it already failed on this device during the session.
 */
export function preferredBackend(o: { appleMobile: boolean; forced: boolean; requested: BackendChoice | null }): BackendChoice {
  if (o.requested) return o.requested;
  return o.forced || o.appleMobile ? 'webgl' : 'webgpu';
}

export interface GraphicsSupport {
  webgpu: boolean;
  webgl2: boolean;
  webgl: boolean;
}

/** Which graphics APIs the browser will hand out. Each probe context is released straight away. */
export function probeGraphics(): GraphicsSupport {
  const probe = (type: 'webgl2' | 'webgl') => {
    try {
      const gl = document.createElement('canvas').getContext(type) as WebGLRenderingContext | null;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      return Boolean(gl);
    } catch {
      return false;
    }
  };
  return { webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator, webgl2: probe('webgl2'), webgl: probe('webgl') };
}

/** What a player can do when no renderer would start, in plain words. */
export function graphicsAdvice(s: GraphicsSupport, appleMobile: boolean): { title: string; advice: string } {
  if (!s.webgl2 && !s.webgl && !s.webgpu) {
    return {
      title: 'This browser has 3D graphics turned off.',
      advice: appleMobile
        ? 'On iPhone and iPad that usually means Lockdown Mode or an app’s built-in browser. Open the page in Safari. If Lockdown Mode is on, tap aA › Website Settings and turn it off for this site.'
        : 'Turn on hardware acceleration (sometimes called graphics acceleration) in the browser’s settings, then reload.',
    };
  }
  if (!s.webgl2 && !s.webgpu) {
    return {
      title: 'This browser is too old for the engine.',
      advice: 'It only offers WebGL 1, and the engine needs WebGL 2 or WebGPU. Updating the browser, or the system, adds them.',
    };
  }
  return {
    title: 'The graphics driver would not start the renderer.',
    advice: 'Close other tabs and apps that use 3D graphics, then reload.',
  };
}

/** No renderer could start; carries what the browser supports, for the error screen. */
export class GraphicsUnavailableError extends Error {
  readonly support: GraphicsSupport;
  readonly title: string;
  readonly advice: string;

  constructor(cause: unknown, support: GraphicsSupport, appleMobile: boolean) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'GraphicsUnavailableError';
    this.support = support;
    ({ title: this.title, advice: this.advice } = graphicsAdvice(support, appleMobile));
  }
}

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
