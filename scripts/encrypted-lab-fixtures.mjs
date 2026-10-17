import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
// Synthetic, process-local fixture. Not AWS KMS, Secret Manager or S3.
// No key/cleartext/ciphertext is persisted in a repository or evidence report.
export function encryptedLabFixtures() {
  const key = randomBytes(32);
  const records = new Map();
  return {
    put(reference, content) {
      if (records.has(reference)) throw Error("LAB_REVISION_EXISTS");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(reference));
      const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
      records.set(reference, { nonce, ciphertext, tag: cipher.getAuthTag() });
    },
    get(reference) {
      const record = records.get(reference);
      if (!record) throw Error("LAB_REVISION_MISSING");
      const decipher = createDecipheriv("aes-256-gcm", key, record.nonce);
      decipher.setAAD(Buffer.from(reference));
      decipher.setAuthTag(record.tag);
      return Buffer.concat([decipher.update(record.ciphertext), decipher.final()]);
    },
    remove(reference) {
      records.delete(reference);
    },
    close() {
      records.clear();
      key.fill(0);
    },
  };
}
