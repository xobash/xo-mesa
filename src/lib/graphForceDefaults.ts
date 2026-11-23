/**
 * Graph force sliders and their defaults, in Obsidian's units. Kept free of
 * the force engine so settings can import it without loading d3-force.
 */
import { clamp } from "./clamp";

/** Slider positions, in the same units as Obsidian's graph controls. */
export interface GraphForceSettings {
  /** 0..1, log curve. */
  center: number;
  /** 0..20, cubed. */
  repel: number;
  /** 0..1, log curve. */
  linkForce: number;
  /** World units, 30..500. */
  linkDistance: number;
}

const SLIDER_CURVE_BASE = 0.01;


/** Map a 0..1 slider position to a 0..1 strength on Obsidian's log curve. */
export function sliderStrength(position: number): number {
  const p = clamp(position, 0, 1);
  return (Math.pow(SLIDER_CURVE_BASE, 1 - p) - SLIDER_CURVE_BASE) / (1 - SLIDER_CURVE_BASE);
}

/** Inverse of `sliderStrength`. */
export function sliderPosition(strength: number): number {
  const s = clamp(strength, 0, 1);
  return 1 - Math.log(s * (1 - SLIDER_CURVE_BASE) + SLIDER_CURVE_BASE) / Math.log(SLIDER_CURVE_BASE);
}

/** Obsidian's default force sliders: center strength 0.1, charge -1000, link strength 1. */
export const GRAPH_FORCE_DEFAULTS: GraphForceSettings = {
  center: sliderPosition(0.1),
  repel: 10,
  linkForce: sliderPosition(1),
  linkDistance: 250,
};

/** The physical force values for a set of slider positions. */
export function graphForceValues(settings: GraphForceSettings) {
  const cubed = Math.pow(clamp(settings.repel, 0, 20), 3);
  return {
    center: sliderStrength(settings.center),
    // A zero slider keeps a unit charge so coincident nodes still separate.
    charge: -Math.max(1, cubed),
    link: sliderStrength(settings.linkForce),
    linkDistance: clamp(settings.linkDistance, 30, 500),
  };
}
