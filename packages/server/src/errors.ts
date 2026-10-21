/** An error the API turns into an HTTP response. `code` is stable and machine-readable; `message` is plain language for a person. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Role = "owner" | "manager" | "estimator" | "viewer";

/** Who is calling, resolved from the session. Every repository call takes one and filters by `orgId`. */
export interface Ctx {
  userId: string;
  orgId: string;
  role: Role;
}

const RANK: Record<Role, number> = { viewer: 0, estimator: 1, manager: 2, owner: 3 };

/** Throws 403 unless the caller's role is at least `min`. viewer < estimator < manager < owner. */
export function requireRole(ctx: Ctx, min: Role): void {
  if (RANK[ctx.role] < RANK[min]) throw new HttpError(403, "forbidden", `This needs the ${min} role or higher.`);
}
