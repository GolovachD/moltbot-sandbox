// src/gateway/init.ts
import type { Sandbox } from '@cloudflare/sandbox';

export interface InitResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
}

/**
 * Ensures initialization has completed (stub for now).
 * TODO: Implement actual init logic.
 */
export async function ensureInitCompleted(_sandbox: Sandbox): Promise<InitResult> {
  // Placeholder — replace with real implementation
  return { success: true, skipped: true };
}
