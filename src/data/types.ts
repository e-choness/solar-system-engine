export type BodyKind = 'star' | 'planet' | 'dwarf' | 'moon' | 'asteroid' | 'comet';

/** Which surface generator to use when a body has no photographic map. */
export type Procedural = 'rocky' | 'icy' | 'cratered' | 'dusty' | 'comet' | 'metal' | 'charon';

/** Irregular bodies: triaxial ellipsoid, or two lobes for contact binaries. */
export type Shape =
  | { type: 'ellipsoid'; radii: [number, number, number] }
  | { type: 'contact'; lobes: [[number, number, number], [number, number, number]]; seed?: number };

export interface Rotation {
  /** IAU north pole, right ascension (deg, ICRF). */
  ra: number;
  /** IAU north pole, declination (deg, ICRF). */
  dec: number;
  /** Prime meridian angle at J2000 (deg). */
  w0: number;
  /** Prime meridian rate (deg/day). Negative for retrograde rotators. */
  wDot: number;
}

export interface Atmosphere {
  /** Scattering color (sRGB hex). */
  color: string;
  /** Sunset / terminator tint. */
  sunset?: string;
  /** Shell thickness relative to body radius. */
  height: number;
  /** Overall opacity of the limb glow, 0..1. */
  density: number;
}

export interface Rings {
  /** Radii in km from the body center. */
  inner: number;
  outer: number;
  texture?: string;
  color: string;
  opacity: number;
}

export interface Visual {
  /** Texture id under public/textures (without suffix). */
  map?: string;
  night?: string;
  clouds?: string;
  normal?: string;
  specular?: string;
  /** Rotate the texture so its u=0.5 column sits at the prime meridian (deg). */
  mapLonOffset?: number;
  /** Map is an artist's impression rather than spacecraft imagery. */
  impression?: boolean;
  procedural?: Procedural;
  /** Base / marker color (sRGB hex). */
  color: string;
  /** Secondary color for procedural surfaces. */
  accent?: string;
  atmosphere?: Atmosphere;
  rings?: Rings;
  /** Brightness boost for the far-away point marker (1 = default). */
  glow?: number;
}

export type AudioKind = 'original' | 'recording' | 'sonification';

export interface AudioDef {
  kind: AudioKind;
  /** File under public/audio for recordings. */
  src?: string;
  /** Short attribution shown in the UI. */
  credit?: string;
  /** What the recording captures. */
  caption?: string;
}

export interface Physical {
  /** Mean radius (km). */
  radius: number;
  mass?: number;
  /** Sidereal rotation period in hours; negative = retrograde. */
  rotationH?: number;
  /** Mean surface (or 1-bar) temperature in kelvin. */
  tempK?: number;
  /** Human readable range when a mean is misleading. */
  tempRange?: string;
  albedo?: number;
  /** Axial tilt (deg). */
  obliquity?: number;
  atmosphere?: string;
  /** Known moons as of 2025 when larger than the moons modelled here. */
  knownMoons?: number;
}

export interface BodyDef {
  id: string;
  name: string;
  kind: BodyKind;
  /** Subtitle such as "Ice giant" or "Galilean moon". */
  class: string;
  parent?: string;
  /** JPL Horizons COMMAND used by scripts/fetch-ephemeris.mjs. */
  horizons?: string;
  physical: Physical;
  shape?: Shape;
  rotation?: Rotation;
  tidallyLocked?: boolean;
  /** Mass ratio used to offset a primary from its barycenter (Earth/Moon, Pluto/Charon). */
  baryShare?: number;
  visual: Visual;
  audio: AudioDef;
  discovered?: string;
  missions?: string[];
  description: string;
  facts?: string[];
  wiki: string;
}
