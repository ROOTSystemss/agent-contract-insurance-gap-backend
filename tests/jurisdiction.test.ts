import { describe, expect, it } from "vitest";
import { GLOBAL_PACK, JURISDICTION_PACKS } from "../src/jurisdictions/packs.js";
import { validatePack } from "../src/jurisdictions/pack-schema.js";
import { countryCodeSchema } from "../src/api/schemas.js";

describe("jurisdiction pack safety", () => {
  it("validates every bundled pack and its checksum", () => {
    for (const pack of JURISDICTION_PACKS) expect(validatePack(pack)).toEqual(pack);
  });

  it("fails closed for a modified or malformed pack", () => {
    expect(() => validatePack({ ...GLOBAL_PACK, name: "Tampered" })).toThrow("checksum mismatch");
    expect(() => validatePack({ id: "incomplete" })).toThrow();
  });

  it("accepts ISO countries and rejects non-country region codes", () => {
    expect(countryCodeSchema.parse("us")).toBe("US");
    expect(() => countryCodeSchema.parse("EU")).toThrow();
    expect(() => countryCodeSchema.parse("ZZ")).toThrow();
  });
});
