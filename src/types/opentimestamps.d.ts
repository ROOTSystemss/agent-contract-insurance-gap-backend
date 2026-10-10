// Minimal types for the parts of the untyped "opentimestamps" package this service uses (crypto/ots.ts).
declare module "opentimestamps/index.js" {
  interface DetachedTimestampFile {
    serializeToBytes(): Uint8Array;
    fileDigest(): Uint8Array;
  }
  const OpenTimestamps: {
    DetachedTimestampFile: {
      fromHash(op: unknown, hash: Buffer): DetachedTimestampFile;
      deserialize(bytes: Buffer): DetachedTimestampFile;
    };
    Ops: { OpSHA256: new () => unknown };
    stamp(file: DetachedTimestampFile): Promise<void>;
  };
  export default OpenTimestamps;
}
