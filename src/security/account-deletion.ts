import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { DocumentStorage } from "../documents/storage.js";
import type { GovernanceGateway } from "../governance/gateway.js";
import type { Store } from "../persistence/store.js";

// Self-service account deletion (safeguard S-14, "delete on request").
//   - A workspace the person owns ALONE is deleted with everything this service keeps for it, including uploaded
//     files. Before that, its agent certificates are revoked on Authority Atlas (the only remote "deactivate" call
//     Atlas or Trust Proof offer); a certificate that cannot be revoked is reported, not hidden.
//   - In a workspace where another owner remains, only this person leaves: membership and signer enrolment go, and
//     one audit line ("user.account_deleted", no email) is written there so the remaining owners see it.
//   - The user row is deleted when nothing refers to it any more; otherwise it becomes a tombstone (email, name and
//     password replaced, two-factor and one-time links removed). Either way every session ends.
//   - Remote data that this service has no API to delete (the Authority Atlas identity and Trust Proof organization
//     created for a workspace, Trust Proof signer accounts) is listed in the result. Signed receipts and
//     certificates already handed out stay verifiable: signing keys are not touched.
export interface RemoteLeftover {
  service: "Authority Atlas" | "Trust Proof";
  what: string;
}

export interface DeletionResult {
  workspacesDeleted: number;
  workspacesLeft: number;
  otherMembersRemoved: number;
  filesDeleted: number;
  filesNotDeleted: number;
  certificatesRevoked: number;
  certificatesNotRevoked: number;
  userRecord: "deleted" | "anonymised";
  remoteNotDeleted: RemoteLeftover[];
}

export async function deleteAccount(
  deps: { store: Store; storage: DocumentStorage; governance?: GovernanceGateway | null },
  userId: string,
  requestId: string,
): Promise<DeletionResult> {
  const { store, storage, governance } = deps;
  const result: DeletionResult = {
    workspacesDeleted: 0, workspacesLeft: 0, otherMembersRemoved: 0, filesDeleted: 0, filesNotDeleted: 0,
    certificatesRevoked: 0, certificatesNotRevoked: 0, userRecord: "deleted", remoteNotDeleted: [],
  };
  for (const membership of await store.listMembershipsForUser(userId)) {
    const orgId = membership.organizationId;
    const members = await store.listMembers(orgId);
    const otherOwners = members.filter((m) => m.role === "owner" && m.userId !== userId);
    if (membership.role === "owner" && otherOwners.length === 0) {
      const link = await store.getServiceLink(orgId);
      if (link) {
        const organization = await store.getOrganization(orgId);
        const atlasReady = Boolean(governance && governance.status().atlas && organization);
        for (const jti of await store.listConsoleCertificateIds(orgId)) {
          try {
            if (!atlasReady || !organization) throw new Error("not configured");
            await governance!.revokeCertificate(organization, jti);
            result.certificatesRevoked++;
          } catch {
            result.certificatesNotRevoked++;
          }
        }
        result.remoteNotDeleted.push(
          { service: "Authority Atlas", what: "The workspace's Authority Atlas identity and its certificate records (revoked certificates stay listed as revoked). Authority Atlas has no delete call; ask RootSystems to remove them." },
          { service: "Trust Proof", what: "The workspace's Trust Proof organization, its signed approvals and agent-action ledger. Trust Proof has no delete call; ask RootSystems to remove them." },
        );
      }
      result.otherMembersRemoved += members.filter((m) => m.userId !== userId).length;
      const { storageKeys } = await store.deleteOrganization(orgId);
      for (const key of storageKeys) {
        try { await storage.delete(key); result.filesDeleted++; } catch { result.filesNotDeleted++; }
      }
      result.workspacesDeleted++;
    } else {
      const signers = await store.listConsoleSigners(orgId);
      if (signers.some((s) => s.userId === userId)) {
        result.remoteNotDeleted.push({ service: "Trust Proof", what: "Your personal Trust Proof signer account in a workspace you left, and the approvals you signed there (other owners keep them as their records)." });
      }
      await store.addAuditEvent({
        id: randomUUID(), organizationId: orgId, actorId: userId, resourceType: "user", resourceId: userId,
        action: "user.account_deleted", requestId, metadata: {}, createdAt: new Date().toISOString(),
      });
      await store.removeMembership(orgId, userId);
      result.workspacesLeft++;
    }
  }
  result.userRecord = await store.deleteOrAnonymiseUser(userId, {
    email: `deleted-${randomUUID()}@deleted.invalid`,
    passwordHash: await bcrypt.hash(randomBytes(32).toString("hex"), 10),
    at: new Date().toISOString(),
  });
  return result;
}
