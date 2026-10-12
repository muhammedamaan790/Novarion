import { describe, expect, it } from "vitest";
import metaJson from "../../../contracts/mock_meta.json";
import type { Meta } from "../api/client";
import { importRecords, parseCsv, parseValue, splitHeader, UNKNOWN } from "./importCase";

const meta = metaJson as unknown as Meta;
const local = { ...meta, run_mode: "local" } as Meta;
const f = (id: string) => meta.features.find((x) => x.id === id)!;

describe("case import (plan §11, §11A)", () => {
  it("parses RFC 4180 CSV with quotes, escaped quotes and CRLF", () => {
    expect(parseCsv('a,b\r\n"1,5","say ""hi"""\r\n')).toEqual([["a", "b"], ["1,5", 'say "hi"']]);
  });

  it("reads units from headers", () => {
    expect(splitHeader("LDL [mg/dL]")).toEqual({ name: "LDL", unit: "mg/dL" });
    expect(splitHeader("age (years)")).toEqual({ name: "age", unit: "years" });
    expect(splitHeader("hdl")).toEqual({ name: "hdl", unit: null });
  });

  it("matches id → display name → alias, never fuzzy", () => {
    const r = importRecords([{ ldl: "120", "Ex-smoker": "1", HDL: "40", LDH: "200" }], meta, 10);
    expect(r.recognized.map((x) => x.feature).sort()).toEqual(["ex_smoker", "hdl", "ldl"]);
    expect(r.unknownDropped).toEqual(["LDH"]); // LDH is not HDL or LDL
  });

  it("drops label columns and lists them; never sends them", () => {
    const r = importRecords([{ age: "60", Cath: "CAD", LAD: "Stenotic" }], meta, 10);
    expect(r.leakageDropped).toEqual(["Cath", "LAD"]);
    expect(Object.keys(r.rows[0]!.inputs)).toEqual(["age"]);
  });

  it("identifier columns: rejected in hosted mode, dropped + listed in local mode", () => {
    const rec = [{ age: "60", "Patient Name": "Jane Doe", MRN: "123" }];
    expect(importRecords(rec, meta, 10).rejected).toMatch(/Identifier column/);
    const r = importRecords(rec, local, 10);
    expect(r.rejected).toBeNull();
    expect(r.identifiersDropped).toEqual(["Patient Name", "MRN"]);
    expect(JSON.stringify(r.rows)).not.toContain("Jane");
  });

  it("keeps locale-formatted numbers as text (server BLOCKs) and maps tokens / UNKNOWN", () => {
    expect(parseValue(f("triglycerides"), "1,250")).toBe("1,250");
    expect(parseValue(f("creatinine"), "0.9")).toBe(0.9);
    expect(parseValue(f("diabetes"), "Yes")).toBe(1);
    expect(parseValue(f("obesity"), "Y")).toBe(1);
    expect(parseValue(f("sex"), "Fmale")).toBe(0);
    expect(parseValue(f("sex"), "male")).toBe(1);
    expect(parseValue(f("sex"), "1")).toBe(1);
    expect(parseValue(f("valvular_heart_disease"), "Moderate")).toBe("moderate");
    expect(parseValue(f("ldl"), "unknown")).toBe(UNKNOWN);
    expect(parseValue(f("age"), "unknown")).toBe("unknown"); // age does not allow UNKNOWN → server BLOCKs
  });

  it("unit status: header unit = explicit; none = canonical_assumed; a different unit withholds the value", () => {
    const r = importRecords([{ "ldl [mg/dL]": "120", hdl: "40", "FBS [mmol/L]": "6.1" }], meta, 10);
    const row = r.rows[0]!;
    expect(row.unitStatus).toEqual({ ldl: "explicit", hdl: "canonical_assumed" });
    expect(row.inputs.fasting_blood_sugar).toBeNull();
    expect(r.unitMismatches).toEqual([{ column: "FBS [mmol/L]", declared: "mmol/L", expected: "mg/dL" }]);
  });

  it("reads the trusted dataset record id and enforces size/row limits", () => {
    expect(importRecords([{ dataset_record_id: "ZAS-0003", age: "54" }], meta, 10).rows[0]!.datasetRecordId).toBe(2);
    expect(importRecords([{ age: "1" }], meta, 2 * 1024 * 1024).rejected).toMatch(/1 MB/);
    expect(importRecords(Array.from({ length: 501 }, () => ({ age: "1" })), meta, 10).rejected).toMatch(/500/);
  });
});
