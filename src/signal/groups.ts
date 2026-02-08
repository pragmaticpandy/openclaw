/**
 * Signal group ID resolution via signal-cli listGroups RPC.
 *
 * Base64 group IDs are case-sensitive, but internal session keys lowercase them.
 * This module resolves a potentially-lowercased group ID back to the canonical
 * case by querying signal-cli for the list of known groups.
 */

import { signalRpcRequest } from "./client.js";

type SignalGroupEntry = {
  id: string;
  name?: string;
  isMember?: boolean;
  isBlocked?: boolean;
};

type ListGroupsResult = SignalGroupEntry[];

const GROUP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedGroups: ListGroupsResult | null = null;
let cachedAt = 0;
let cacheAccountKey = "";

function buildAccountKey(baseUrl: string, account?: string): string {
  return `${baseUrl}|${account ?? ""}`;
}

async function listGroups(opts: {
  baseUrl: string;
  account?: string;
  timeoutMs?: number;
}): Promise<ListGroupsResult> {
  const params: Record<string, unknown> = {};
  if (opts.account) {
    params.account = opts.account;
  }
  const result = await signalRpcRequest<ListGroupsResult>("listGroups", params, {
    baseUrl: opts.baseUrl,
    timeoutMs: opts.timeoutMs ?? 10_000,
  });
  return Array.isArray(result) ? result : [];
}

/**
 * Resolve a potentially-lowercased Signal group ID to the canonical (correct-case) ID.
 *
 * Queries signal-cli's listGroups and finds a case-insensitive match.
 * - Exactly 1 match → returns the correct-case ID
 * - 0 matches → throws (group not found)
 * - 2+ matches → throws (ambiguous, though extremely unlikely for base64)
 */
export async function resolveSignalGroupId(
  groupId: string,
  opts: {
    baseUrl: string;
    account?: string;
    timeoutMs?: number;
  },
): Promise<string> {
  const accountKey = buildAccountKey(opts.baseUrl, opts.account);
  const now = Date.now();

  // Use cache if fresh and same account
  if (cachedGroups && cacheAccountKey === accountKey && now - cachedAt < GROUP_CACHE_TTL_MS) {
    // Try exact match first (fast path, no ambiguity possible)
    const exact = cachedGroups.find((g) => g.id === groupId);
    if (exact) {
      return exact.id;
    }
  }

  // Fetch fresh group list
  const groups = await listGroups(opts);
  cachedGroups = groups;
  cachedAt = now;
  cacheAccountKey = accountKey;

  // Exact match (the ID was already correct case)
  const exact = groups.find((g) => g.id === groupId);
  if (exact) {
    return exact.id;
  }

  // Case-insensitive match
  const lowered = groupId.toLowerCase();
  const matches = groups.filter((g) => g.id.toLowerCase() === lowered);

  if (matches.length === 1) {
    return matches[0].id;
  }
  if (matches.length === 0) {
    throw new Error(
      `Signal group not found: no group matches "${groupId}" (case-insensitive). ` +
        `Known groups: ${groups.length}`,
    );
  }
  // Extremely unlikely for base64, but handle it
  throw new Error(
    `Signal group ID "${groupId}" is ambiguous: ${matches.length} groups match case-insensitively. ` +
      `Provide the exact base64 group ID.`,
  );
}
