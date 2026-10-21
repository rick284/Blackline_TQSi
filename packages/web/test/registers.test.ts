import { describe, expect, it } from "vitest";
import { newQuote, newRegisterItem, nextFree, setQuoteField, setRegisterField, type QuoteBody, type RegisterBody } from "../src/lib/registers.js";

const made = <T extends { ok: boolean }>(r: T) => { if (!r.ok) throw new Error((r as any).error); return r as Extract<T, { ok: true }>; };

describe("register edits", () => {
  it("numbers a new item within its kind and starts an RFI open", () => {
    const a = made(newRegisterItem("rfi", "Confirm retaining height", [], [], 1));
    expect(a.recordId).toBe("register:R-N1");
    expect(a.data.body).toMatchObject({ kind: "rfi", ref: "RFI-01", status: "OPEN", title: "Confirm retaining height" });
    const b = made(newRegisterItem("rfi", "Second", [a.data.body as RegisterBody], ["R-N1"], 2));
    expect(b.data.body).toMatchObject({ ref: "RFI-02", id: "R-N2" });
    const c = made(newRegisterItem("assumption", "Normal weekday access", [a.data.body as RegisterBody], ["R-N1"], 3));
    expect(c.data.body).toMatchObject({ ref: "A1" });
  });

  it("refuses an unknown kind or an empty item, in words", () => {
    expect(newRegisterItem("memo", "x", [], [], 1)).toMatchObject({ ok: false, error: expect.stringContaining("must be one of") });
    expect(newRegisterItem("rfi", "  ", [], [], 1)).toMatchObject({ ok: false, error: expect.stringContaining("Describe") });
  });

  it("edits a field without touching the original, and checks RFI status and rating", () => {
    const body = made(newRegisterItem("rfi", "x", [], [], 1)).data.body as RegisterBody;
    expect(setRegisterField(body, "status", "closed")).toMatchObject({ ok: true, body: { status: "CLOSED" } });
    expect(setRegisterField(body, "status", "maybe")).toMatchObject({ ok: false, error: expect.stringContaining("OPEN or CLOSED") });
    expect(setRegisterField(body, "rag", "amber")).toMatchObject({ ok: true, body: { rag: "AMBER" } });
    expect(setRegisterField(body, "rag", "purple")).toMatchObject({ ok: false });
    expect(body.status).toBe("OPEN");
  });
});

describe("quote edits", () => {
  it("starts a quote from its package with the next Q-nn", () => {
    const a = made(newQuote("Line marking", [], [], 1));
    expect(a.recordId).toBe("quote:N1");
    expect(a.data.body).toMatchObject({ ref: "Q-01", package: "Line marking" });
    const b = made(newQuote("Geotech", [a.data.body as QuoteBody], ["N1"], 2));
    expect(b.data.body).toMatchObject({ ref: "Q-02", id: "N2" });
    expect(newQuote(" ", [], [], 1)).toMatchObject({ ok: false });
  });

  it("keeps amounts as plain decimal strings and refuses words", () => {
    const body = made(newQuote("Geotech", [], [], 1)).data.body as QuoteBody;
    expect(setQuoteField(body, "amount", "$4,600.50")).toMatchObject({ ok: true, body: { amount: "4600.5" } });
    expect(setQuoteField(body, "amount", "TBC")).toMatchObject({ ok: false, error: expect.stringContaining("number") });
    expect(setQuoteField(body, "amount", "-5")).toMatchObject({ ok: false });
  });

  it("finds the next free id", () => {
    expect(nextFree("N", ["N1", "N3"])).toBe("N2");
  });
});
