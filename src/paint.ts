// MC2's team paint (mclib/mech3d.cpp Mech3DAppearance::resetPaintScheme): mech and vehicle textures mark their
// paintable areas in pure red, green or blue, and each is replaced by a colour of the unit's scheme. Shared by the
// three.js viewer and the WebGPU sea page.

export interface PaintScheme {
  /** Texels that are mostly red, green or blue take these colours. */
  red: string;
  green: string;
  blue: string;
}

export const PLAYER_PAINT: PaintScheme = { red: '#ff7e00', green: '#ff7e00', blue: '#ff7e00' }; // code/prefs.cpp defaults

/** Mission colours are [base, highlight1, highlight2]; code/mission.cpp passes (hl1, hl2, base). */
export function paintFromMission(colors: [string, string, string]): PaintScheme {
  return { red: colors[1], green: colors[2], blue: colors[0] };
}

export function paintKey(scheme: PaintScheme): string {
  return `${scheme.red}/${scheme.green}/${scheme.blue}`;
}

/**
 * Recolour RGBA8 pixels in place. A channel at least 3x the others is a paint mask; its strength sets the shade and
 * the ratio sets how much of the paint replaces the original texel (the remaster's softened version of the rule, which
 * also suits the AI-upscaled textures whose mask edges are blurred).
 */
export function paintPixels(d: Uint8ClampedArray, scheme: PaintScheme): void {
  const slots = [scheme.red, scheme.green, scheme.blue].map(parseHex);
  const MIN_DOMINANT = 16;
  const RATIO = 3;
  const RATIO_MARGIN = 1.5;
  for (let i = 0; i < d.length; i += 4) {
    const rgb = [d[i]!, d[i + 1]!, d[i + 2]!];
    let slot = -1;
    for (let s = 0; s < 3; s++) {
      const a = rgb[(s + 1) % 3]!;
      const b = rgb[(s + 2) % 3]!;
      if (rgb[s]! >= MIN_DOMINANT && rgb[s]! >= RATIO * a && rgb[s]! >= RATIO * b) {
        slot = s;
        break;
      }
    }
    if (slot < 0) continue;
    const dominant = rgb[slot]!;
    const other = Math.max(rgb[(slot + 1) % 3]!, rgb[(slot + 2) % 3]!);
    const dn = dominant / 255;
    const shade = 1 - (1 - dn) * (1 - dn);
    const mix = Math.min(1, Math.max(0, (dominant / (other + 1) - RATIO) / (RATIO * (RATIO_MARGIN - 1))));
    if (mix <= 0) continue;
    const tint = slots[slot]!;
    d[i] = ((tint >> 16) & 255) * shade * mix + rgb[0]! * (1 - mix);
    d[i + 1] = ((tint >> 8) & 255) * shade * mix + rgb[1]! * (1 - mix);
    d[i + 2] = (tint & 255) * shade * mix + rgb[2]! * (1 - mix);
  }
}

function parseHex(color: string): number {
  return parseInt(color.replace('#', ''), 16);
}
