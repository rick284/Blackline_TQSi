/**
 * Tender register: the narrative record behind an estimate, kept as structured items instead of loose text.
 *
 * kinds   document   a basis document / drawing / specification        ref = revision or date, detail = how the estimate uses it
 *         inclusion  something the price includes
 *         exclusion  something excluded or by others
 *         assumption an estimating assumption or qualification
 *         rfi        a request for information / clarification         status OPEN | CLOSED, rag, action = closeout action
 *         risk       a key risk or watch-out                           likelihood / impact / rating / owner
 */
export const KINDS = ["document", "inclusion", "exclusion", "assumption", "rfi", "risk"] as const;
export type Kind = (typeof KINDS)[number];
export const FIELDS = ["ref", "title", "detail", "action", "status", "rag", "owner", "likelihood", "impact", "rating"] as const;
type Field = (typeof FIELDS)[number];

const LIMITS: Record<Field, number> = { ref: 40, title: 300, detail: 3000, action: 3000, status: 80, rag: 10, owner: 80, likelihood: 20, impact: 20, rating: 20 };
const RAGS = ["", "RED", "AMBER", "GREEN"];
const PREFIX: Record<Kind, string> = { document: "DOC", inclusion: "INC", exclusion: "EX", assumption: "A", rfi: "RFI", risk: "RT" };

export type RegisterItem = { id: string; kind: Kind } & Record<Field, string>;

export class RegisterError extends Error {}

export function setField(item: RegisterItem, field: string, value: unknown): void {
  if (!(FIELDS as readonly string[]).includes(field)) throw new RegisterError(`'${field}' can't be edited on a register item.`);
  const f = field as Field;
  let v = value === null || value === undefined ? "" : String(value).trim();
  if (f === "rag") {
    v = v.toUpperCase();
    if (!RAGS.includes(v)) throw new RegisterError("Rating must be RED, AMBER, GREEN or blank.");
  }
  if (f === "status" && item.kind === "rfi") {
    v = v.toUpperCase();
    if (v !== "OPEN" && v !== "CLOSED") throw new RegisterError("An RFI is OPEN or CLOSED.");
  }
  if (v.length > LIMITS[f]) throw new RegisterError(`${f.charAt(0).toUpperCase() + f.slice(1)} is too long (limit ${LIMITS[f]} characters).`);
  item[f] = v;
}

export function buildItem(itemId: string, v: Partial<Record<Field | "kind", unknown>>, existing: RegisterItem[]): RegisterItem {
  const kind = String(v.kind ?? "") as Kind;
  if (!(KINDS as readonly string[]).includes(kind)) throw new RegisterError(`A register item must be one of: ${KINDS.join(", ")}.`);
  const item = { id: itemId, kind, ...Object.fromEntries(FIELDS.map((f) => [f, ""])) } as RegisterItem;
  if (kind === "rfi") item.status = "OPEN";
  for (const f of FIELDS) if (v[f] !== undefined && v[f] !== null && v[f] !== "") setField(item, f, v[f]);
  if (!item.ref) {
    // next reference for the kind, e.g. RFI-05
    const nums = existing.filter((x) => x.kind === kind).map((x) => /(\d+)/.exec(x.ref)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]));
    const n = 1 + Math.max(0, ...nums);
    item.ref = kind !== "assumption" ? `${PREFIX[kind]}-${String(n).padStart(2, "0")}` : `A${n}`;
  }
  if (!item.title && !item.detail) throw new RegisterError("Describe the item: it needs a title or some detail.");
  if (existing.some((x) => x.ref === item.ref && x.kind === kind)) throw new RegisterError(`${item.ref} is already used.`);
  return item;
}

export function statusSummary(items: RegisterItem[]) {
  const rfis = items.filter((x) => x.kind === "rfi");
  return {
    rfis: rfis.length,
    openRfis: rfis.filter((x) => x.status !== "CLOSED").length,
    openRedRfis: rfis.filter((x) => x.status !== "CLOSED" && x.rag === "RED").length,
    redRisks: items.filter((x) => x.kind === "risk" && x.rag === "RED").length,
  };
}

/** One item per non-empty line of free text (turns the intake form's boxes into register items). */
export function fromText(kind: Kind, text: string, existing: RegisterItem[], newId: () => string): RegisterItem[] {
  const out: RegisterItem[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.replace(/^[ \-•\t]+|[ \-•\t]+$/g, "");
    if (line) out.push(buildItem(newId(), { kind, title: line.slice(0, 300), detail: line.length > 300 ? line : "" }, [...existing, ...out]));
  }
  return out;
}
