// Symmetric encryption for workspace secrets at rest (provider API keys, Codex
// OAuth tokens). AES-256-GCM with a key derived from config. The stored blob is
// `iv(12) || authTag(16) || ciphertext` so a single Buffer round-trips through
// the WorkspaceSecret.ciphertext Bytes column.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { config } from "../config.ts";

const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (cachedKey) return cachedKey;
  // Prefer a dedicated SECRETS_KEY; fall back to SESSION_SECRET for dev. scrypt
  // stretches whatever string we're given into a fixed 32-byte AES key.
  const raw = config.secretsKey() || config.sessionSecret();
  cachedKey = scryptSync(raw, "manta-secrets-v1", 32);
  return cachedKey;
}

export function encrypt(plaintext: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

export function decrypt(buf: Buffer): string {
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export function encryptJson(value: unknown): Buffer {
  return encrypt(JSON.stringify(value));
}

export function decryptJson<T>(buf: Buffer): T {
  return JSON.parse(decrypt(buf)) as T;
}
