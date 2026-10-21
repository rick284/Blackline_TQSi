/**
 * Input shapes follow the Blackline QSi estimate documents (snake_case), so QSi's own
 * test fixtures run against this engine unchanged. Numbers may arrive as JSON numbers
 * or decimal strings; they are converted through their decimal text, never as binary floats.
 */

export type Num = number | string | null | undefined;

export interface ResourceLine {
  category?: string;
  type?: string;
  qty?: Num;
  rate?: Num;
  included_in_total?: boolean | null;
  [k: string]: unknown;
}

export interface Task {
  resources?: ResourceLine[];
  included_in_total?: boolean | null;
  [k: string]: unknown;
}

export interface Zone {
  tasks?: Task[];
  included_in_total?: boolean | null;
  [k: string]: unknown;
}

export interface RiskLine {
  id?: string;
  name?: string;
  kind?: "allowance" | "opportunity";
  basis?: string[];
  percent?: Num;
  enabled?: boolean;
  notes?: string;
  legacy_key?: string;
}

export interface LegacyRiskConfig {
  enabled?: boolean;
  percent?: Num;
  name?: string;
  linkedCategory?: string;
  notes?: string;
}

export interface EstimateInput {
  zones?: Zone[];
  /** Legacy flat lines: one resource per row. */
  line_items?: ResourceLine[];
  risk_allowance_percent?: Num;
  use_detailed_risk?: boolean;
  detailed_risk_settings?: Record<string, LegacyRiskConfig> | null;
  /** When present (even empty) these rows price the risk and legacy settings are ignored. */
  risk_lines?: RiskLine[] | null;
  overhead_percent?: Num;
  profit_margin_percent?: Num;
  gst_percent?: Num;
}

export interface RegisterItem {
  expected_value?: Num;
  item_type?: "risk" | "opportunity";
  include_in_pricing?: boolean;
  status?: string;
  is_active?: boolean | null;
  is_financially_active?: boolean | null;
  [k: string]: unknown;
}
