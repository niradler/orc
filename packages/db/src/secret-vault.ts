import { decryptSecret, encryptSecret } from "@orc/core/secrets";

type VaultEntry = {
  ciphertext: string;
  expiresAt: number;
};

export class SecretDeliveryVault {
  private readonly entries = new Map<string, VaultEntry>();

  store(requestId: string, values: Record<string, string>, expiresAt: number): void {
    const ciphertext = encryptSecret(JSON.stringify(values));
    this.entries.set(requestId, { ciphertext, expiresAt });
  }

  has(requestId: string, now = Date.now()): boolean {
    const entry = this.entries.get(requestId);
    if (!entry) return false;
    if (entry.expiresAt <= now) {
      this.entries.delete(requestId);
      return false;
    }
    return true;
  }

  claim(requestId: string, now = Date.now()): Record<string, string> | null {
    const entry = this.entries.get(requestId);
    this.entries.delete(requestId);
    if (!entry || entry.expiresAt <= now) return null;
    try {
      const parsed = JSON.parse(decryptSecret(entry.ciphertext)) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return parsed as Record<string, string>;
    } catch {
      return null;
    }
  }

  delete(requestId: string): void {
    this.entries.delete(requestId);
  }

  prune(now = Date.now()): number {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
        removed++;
      }
    }
    return removed;
  }

  clearAll(): void {
    this.entries.clear();
  }
}

export const defaultSecretVault = new SecretDeliveryVault();
