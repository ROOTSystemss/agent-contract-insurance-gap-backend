import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { JURISDICTION_PACKS, selectJurisdictionPacks } from "../jurisdictions/packs.js";
import { notFound } from "../shared/errors.js";
import { success } from "./helpers.js";
import { isIsoCountryCode } from "./schemas.js";

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const subdivisionCountries = new Set(["US", "CA", "IN", "AU"]);
const initialCatalog = Array.from({ length: 26 * 26 }, (_, index) =>
  String.fromCharCode(65 + Math.floor(index / 26), 65 + (index % 26)),
)
  .filter(isIsoCountryCode)
  .map((code) => ({
    code,
    name: regionNames.of(code) ?? code,
    subdivisionSupported: subdivisionCountries.has(code),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

export const jurisdictionRoutes: FastifyPluginAsync = async (app) => {
  app.get("/jurisdictions", async (request) =>
    success(
      request,
      initialCatalog.map((country) => ({
        ...country,
        supportStatus: selectJurisdictionPacks(country.code).status,
      })),
    ),
  );
  app.get("/jurisdictions/:code", async (request) => {
    const { code } = z
      .object({
        code: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{2}$/),
      })
      .parse(request.params);
    const known = initialCatalog.find((country) => country.code === code);
    return success(request, {
      code,
      name: known?.name ?? code,
      subdivisionSupported: known?.subdivisionSupported ?? false,
      ...selectJurisdictionPacks(code),
    });
  });
  app.get("/jurisdiction-packs", async (request) => success(request, JURISDICTION_PACKS));
  app.get("/jurisdiction-packs/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const pack = JURISDICTION_PACKS.find((item) => item.id === id);
    if (!pack) throw notFound("Jurisdiction pack");
    return success(request, pack);
  });
};
