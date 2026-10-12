/**
 * Key management's row cipher (docs/governance.md §2.10). STUB committed before round 14: a pass-through until 14c
 * makes it AES-256-GCM per row ("DV2E" | v1 | iv(12) | ciphertext + tag) under the org's DEK, wrapped by EKM_ROOT_KEY.
 * Rows without the header read as plain, so files encrypt gradually.
 */
export interface RoomCipher {
  readonly enabled: boolean;
  seal(plain: Uint8Array): Promise<Uint8Array>;
  open(stored: Uint8Array): Promise<Uint8Array>;
}

export const PLAIN_CIPHER: RoomCipher = {
  enabled: false,
  seal: async (p) => p,
  open: async (s) => s,
};
