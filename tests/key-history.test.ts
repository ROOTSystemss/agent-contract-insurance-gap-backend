import { describe, expect, it } from "vitest";
import { createPqSigner, sha512Hex } from "../src/crypto/pq-sign.js";
import { keyHistory, KEYRING_FORMAT } from "../src/crypto/key-history.js";

// The console publishes its signing keys like the other RootSystems products (rootsystems.keyring/v1).
describe("signing key history", () => {
  const signer = createPqSigner(Buffer.alloc(32, 7).toString("base64"));
  const older = createPqSigner(Buffer.alloc(32, 8).toString("base64"));

  it("publishes the current key as active when there is no history", () => {
    const h = keyHistory("ai-agent-trust", signer, undefined)!;
    expect(h.format).toBe(KEYRING_FORMAT);
    expect(h.keys).toHaveLength(1);
    expect(h.keys[0]).toMatchObject({ keyId: signer!.keyId, publicKey: signer!.publicKey, status: "active" });
  });

  it("publishes a well-formed history whose active key is the current key", () => {
    const ring = { format: KEYRING_FORMAT, keys: [
      { keyId: older!.keyId, publicKey: older!.publicKey, status: "retired", validUntil: "2026-10-01" },
      { keyId: signer!.keyId, publicKey: signer!.publicKey, status: "active", validFrom: "2026-10-01" },
    ] };
    const h = keyHistory("ai-agent-trust", signer, JSON.stringify(ring))!;
    expect(h.keys.map((k) => k.status)).toEqual(["retired", "active"]);
  });

  it("ignores a history with a wrong key id or a different active key (fail closed)", () => {
    const wrongId = { format: KEYRING_FORMAT, keys: [{ keyId: "0".repeat(32), publicKey: signer!.publicKey, status: "active" }] };
    expect(keyHistory("ai-agent-trust", signer, JSON.stringify(wrongId))!.keys[0]!.keyId).toBe(signer!.keyId);
    const otherActive = { format: KEYRING_FORMAT, keys: [{ keyId: sha512Hex(Buffer.from(older!.publicKey, "base64")).slice(0, 32), publicKey: older!.publicKey, status: "active" }] };
    const h = keyHistory("ai-agent-trust", signer, JSON.stringify(otherActive))!;
    expect(h.keys).toHaveLength(1);
    expect(h.keys[0]!.publicKey).toBe(signer!.publicKey);
  });

  it("publishes nothing when no signing key is configured", () => {
    expect(keyHistory("ai-agent-trust", null, undefined)).toBeNull();
  });
});
