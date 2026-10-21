/** Quantities, rates and percentages are decimal strings, so nothing is ever a float. */

export type ResourceKind = "labour" | "plant" | "material" | "subcontract" | "other";

export const RESOURCE_KINDS: ResourceKind[] = ["labour", "plant", "material", "subcontract", "other"];

export interface Resource {
  id: string;
  kind: ResourceKind;
  /** e.g. "hr", "m3", "t" */
  unit: string;
  /** Cost per unit */
  rate: string;
}

/** One resource consumed per unit of the line's measured quantity. */
export interface Component {
  resourceId: string;
  /** Resource units per line unit (for labour: hours per line unit) */
  qtyPerUnit: string;
  /** Waste allowance, percent (e.g. "5" for 5%) */
  wastePct?: string;
}

export interface EstimateLine {
  id: string;
  code: string;
  description: string;
  /** Every line must link to a scope item (enforced by tender gate, not by the engine). */
  scopeItemId?: string;
  quantity: string;
  unit: string;
  components: Component[];
}

export interface Section {
  id: string;
  name: string;
  lines: EstimateLine[];
  sections: Section[];
}

export interface OnCost {
  id: string;
  name: string;
  /** Percent applied to the direct cost of the listed kinds */
  pct: string;
  appliesTo: ResourceKind[];
}

export interface Settings {
  onCosts: OnCost[];
  /** Percent of (direct + on-costs) */
  overheadPct: string;
  margin: {
    /** markup: pct of cost. margin: pct of sell price. */
    mode: "markup" | "margin";
    pct: string;
  };
}

export interface Estimate {
  resources: Resource[];
  root: Section;
  settings: Settings;
}
