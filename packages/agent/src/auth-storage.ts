import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AuthStorageData = Record<string, Credential>;

/**
 * Small app-owned credential store for Manta.
 *
 * Pi 0.81 made credential persistence an injected async interface. Manta still
 * needs synchronous blob editing for its encrypted workspace settings UI, so
 * this store keeps that API while implementing Pi's CredentialStore contract
 * for request-time OAuth refreshes.
 */
export class MantaAuthStorage implements CredentialStore {
  private readonly chains = new Map<string, Promise<unknown>>();

  private constructor(
    private readonly data: AuthStorageData,
    private readonly authPath?: string,
  ) {}

  static create(authPath = join(homedir(), ".pi", "agent", "auth.json")): MantaAuthStorage {
    try {
      const parsed = JSON.parse(readFileSync(authPath, "utf8")) as AuthStorageData;
      return new MantaAuthStorage(parsed, authPath);
    } catch {
      return new MantaAuthStorage({}, authPath);
    }
  }

  static inMemory(data: AuthStorageData = {}): MantaAuthStorage {
    return new MantaAuthStorage(structuredClone(data));
  }

  getAll(): AuthStorageData {
    return structuredClone(this.data);
  }

  set(providerId: string, credential: Credential): void {
    this.data[providerId] = structuredClone(credential);
    this.persist();
  }

  remove(providerId: string): void {
    delete this.data[providerId];
    this.persist();
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const credential = this.data[providerId];
    return credential ? structuredClone(credential) : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.data).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const next = await fn(await this.read(providerId));
      if (next !== undefined) this.set(providerId, next);
      return next ?? this.read(providerId);
    });
    this.chains.set(providerId, operation);
    try {
      return await operation;
    } finally {
      if (this.chains.get(providerId) === operation) this.chains.delete(providerId);
    }
  }

  async delete(providerId: string): Promise<void> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.remove(providerId));
    this.chains.set(providerId, operation);
    try {
      await operation;
    } finally {
      if (this.chains.get(providerId) === operation) this.chains.delete(providerId);
    }
  }

  private persist(): void {
    if (!this.authPath) return;
    mkdirSync(dirname(this.authPath), { recursive: true });
    writeFileSync(this.authPath, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
  }
}
