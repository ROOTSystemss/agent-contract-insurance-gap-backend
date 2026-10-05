import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EmailVault } from "../src/persistence/email-vault.js";
import { PrismaStore } from "../src/persistence/prisma-store.js";

const key = randomBytes(32);

describe("EmailVault", () => {
  const vault = new EmailVault(key);

  it("seals emails so the stored value hides the address and opens back", () => {
    const sealed = vault.seal("owner@example.com");
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(sealed).not.toContain("owner");
    expect(vault.seal("owner@example.com")).not.toBe(sealed);
    expect(vault.open(sealed)).toBe("owner@example.com");
  });

  it("gives the same fingerprint regardless of case and spacing", () => {
    expect(vault.index(" Owner@Example.COM ")).toBe(vault.index("owner@example.com"));
    expect(vault.index("other@example.com")).not.toBe(vault.index("owner@example.com"));
    expect(new EmailVault(randomBytes(32)).index("owner@example.com")).not.toBe(vault.index("owner@example.com"));
  });

  it("passes plain values through and stores as-is without a key", () => {
    const keyless = new EmailVault(null);
    expect(vault.open("legacy@example.com")).toBe("legacy@example.com");
    expect(keyless.seal("dev@example.com")).toBe("dev@example.com");
    expect(keyless.index("dev@example.com")).toBeNull();
    expect(() => keyless.open(vault.seal("owner@example.com"))).toThrow(/DOCUMENT_ENCRYPTION_KEY/);
  });

  it("rejects tampered values and wrong-sized keys", () => {
    const sealed = vault.seal("owner@example.com");
    expect(() => vault.open(sealed.slice(0, -4) + "AAAA")).toThrow();
    expect(() => new EmailVault(randomBytes(16))).toThrow(/32 bytes/);
  });
});

// Set ACG_TEST_DATABASE_URL to a disposable local database that has had `prisma migrate deploy` run.
const databaseUrl = process.env.ACG_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PrismaStore account email encryption (Postgres)", () => {
  let client: PrismaClient;
  let store: PrismaStore;

  beforeAll(async () => {
    const host = new URL(databaseUrl!).hostname;
    if (!["localhost", "127.0.0.1"].includes(host)) throw new Error("ACG_TEST_DATABASE_URL must point at a local database");
    client = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    store = new PrismaStore(client, new EmailVault(key));
    await store.reset();
  });

  afterAll(async () => {
    await client?.$disconnect();
  });

  it("stores new account emails encrypted and finds them in any case", async () => {
    const created = await store.createRegistration({
      email: "Founder@Example.com",
      name: "Founder",
      passwordHash: "hash",
      organizationName: "Example Co",
    });
    expect(created.user.email).toBe("founder@example.com");

    const raw = await client.user.findUniqueOrThrow({ where: { id: created.user.id } });
    expect(raw.email.startsWith("enc:v1:")).toBe(true);
    expect(raw.email).not.toContain("founder");
    expect(raw.emailHash).toMatch(/^[0-9a-f]{64}$/);

    expect((await store.findUserByEmail(" FOUNDER@example.com "))?.id).toBe(created.user.id);
    expect((await store.getUser(created.user.id))?.email).toBe("founder@example.com");
    const members = await store.listMembers(created.organization.id);
    expect(members[0]?.user.email).toBe("founder@example.com");
  });

  it("refuses a second account with the same email", async () => {
    await expect(
      store.createRegistration({ email: "founder@EXAMPLE.com", name: "Copy", passwordHash: "hash", organizationName: "Copy Co" }),
    ).rejects.toThrow("EMAIL_EXISTS");
  });

  it("upgrades accounts and signers stored before encryption, once", async () => {
    const membership = await client.organizationMember.findFirstOrThrow();
    const owner = { id: membership.userId };
    const legacy = await client.user.create({ data: { email: "legacy@example.com", name: "Legacy", passwordHash: "hash" } });
    await client.consoleSigner.create({
      data: { organizationId: membership.organizationId, userId: owner.id, trustProofEmail: "signer@example.com" },
    });

    expect((await store.findUserByEmail("Legacy@example.com"))?.id).toBe(legacy.id);
    expect(await store.encryptStoredEmails()).toBe(2);
    expect(await store.encryptStoredEmails()).toBe(0);

    const raw = await client.user.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(raw.email.startsWith("enc:v1:")).toBe(true);
    expect(raw.emailHash).not.toBeNull();
    expect((await store.findUserByEmail("legacy@example.com"))?.email).toBe("legacy@example.com");

    const rawSigner = await client.consoleSigner.findFirstOrThrow();
    expect(rawSigner.trustProofEmail.startsWith("enc:v1:")).toBe(true);
    const signers = await store.listConsoleSigners(membership.organizationId);
    expect(signers[0]?.trustProofEmail).toBe("signer@example.com");
  });

  it("seals console signer emails on write", async () => {
    const membership = await client.organizationMember.findFirstOrThrow();
    const owner = { id: membership.userId };
    const saved = await store.addConsoleSigner({
      organizationId: membership.organizationId,
      userId: owner.id,
      trustProofEmail: "new-signer@example.com",
    });
    expect(saved.trustProofEmail).toBe("new-signer@example.com");
    const raw = await client.consoleSigner.findFirstOrThrow({ where: { userId: owner.id } });
    expect(raw.trustProofEmail).not.toContain("new-signer");
  });
});
