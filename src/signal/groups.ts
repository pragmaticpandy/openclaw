/**
 * Signal group ID resolution and membership checking via signal-cli listGroups RPC.
 *
 * Base64 group IDs are case-sensitive, but internal session keys lowercase them.
 * This module resolves a potentially-lowercased group ID back to the canonical
 * case by querying signal-cli for the list of known groups.
 *
 * It also provides group membership checking for the `groupRequireOneOf` feature,
 * which gates group message acceptance on whether specific phone numbers are
 * members of the group.
 */

import { signalRpcRequest } from "./client.js";
import { normalizeE164 } from "../utils.js";
import { parseSignalAllowEntry } from "./identity.js";

export type SignalGroupMember = {
  number?: string | null;
  uuid?: string | null;
};

export type SignalGroupEntry = {
  id: string;
  name?: string;
  isMember?: boolean;
  isBlocked?: boolean;
  members?: SignalGroupMember[];
};

type ListGroupsResult = SignalGroupEntry[];

const GROUP_ID_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MEMBERSHIP_CACHE_TTL_MS = 60 * 1000; // 60 seconds

let cachedGroups: ListGroupsResult | null = null;
let cachedAt = 0;
let cacheAccountKey = "";

/**
 * Per-group membership decision cache.
 * Maps `accountKey|groupId` → { allowed: boolean, cachedAt: number }.
 */
const membershipCache = new Map<string, { allowed: boolean; cachedAt: number }>();

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
 * Get the cached group list, refreshing if stale or for a different account.
 * Shared by both resolveSignalGroupId and checkGroupHasRequiredMember.
 */
async function getCachedGroups(opts: {
  baseUrl: string;
  account?: string;
  timeoutMs?: number;
  forceFresh?: boolean;
}): Promise<ListGroupsResult> {
  const accountKey = buildAccountKey(opts.baseUrl, opts.account);
  const now = Date.now();

  if (
    !opts.forceFresh &&
    cachedGroups &&
    cacheAccountKey === accountKey &&
    now - cachedAt < GROUP_ID_CACHE_TTL_MS
  ) {
    return cachedGroups;
  }

  const groups = await listGroups(opts);
  cachedGroups = groups;
  cachedAt = now;
  cacheAccountKey = accountKey;
  return groups;
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
  // Try exact match on cached data first (fast path)
  const accountKey = buildAccountKey(opts.baseUrl, opts.account);
  const now = Date.now();
  if (cachedGroups && cacheAccountKey === accountKey && now - cachedAt < GROUP_ID_CACHE_TTL_MS) {
    const exact = cachedGroups.find((g) => g.id === groupId);
    if (exact) {
      return exact.id;
    }
  }

  // Fetch fresh group list
  const groups = await getCachedGroups({ ...opts, forceFresh: true });

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

/**
 * Check whether a group contains at least one member matching the
 * `requiredEntries` list. Entries are parsed using the same logic as
 * `allowFrom`/`groupAllowFrom` — supports E.164 phone numbers, UUIDs,
 * `uuid:` prefixes, and `*` wildcard.
 *
 * Uses a per-group membership cache (60s TTL) that can be invalidated
 * by group update events via `invalidateGroupMembershipCache`.
 *
 * @returns true if any required entry matches a group member.
 */
export async function checkGroupHasRequiredMember(
  groupId: string,
  requiredNumbers: string[],
  opts: {
    baseUrl: string;
    account?: string;
    timeoutMs?: number;
  },
): Promise<boolean> {
  if (requiredNumbers.length === 0) {
    return true; // No requirement → all groups pass
  }

  const accountKey = buildAccountKey(opts.baseUrl, opts.account);
  const cacheKey = `${accountKey}|${groupId}`;
  const now = Date.now();

  // Check membership cache
  const cached = membershipCache.get(cacheKey);
  if (cached && now - cached.cachedAt < MEMBERSHIP_CACHE_TTL_MS) {
    return cached.allowed;
  }

  // Fetch groups (uses shared group list cache)
  const groups = await getCachedGroups(opts);

  // Find the group (case-insensitive, since inbound groupIds may be lowercased)
  const lowered = groupId.toLowerCase();
  const group = groups.find((g) => g.id === groupId) ??
    groups.find((g) => g.id.toLowerCase() === lowered);

  if (!group) {
    // Group not found → not allowed
    membershipCache.set(cacheKey, { allowed: false, cachedAt: now });
    return false;
  }

  const members = group.members ?? [];

  // Parse required entries using the same logic as allowFrom/groupAllowFrom
  const parsedRequired = requiredNumbers
    .map((n) => parseSignalAllowEntry(String(n)))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  // Wildcard "*" → always allowed
  if (parsedRequired.some((entry) => entry.kind === "any")) {
    membershipCache.set(cacheKey, { allowed: true, cachedAt: now });
    return true;
  }

  const requiredPhones = new Set(
    parsedRequired.filter((e) => e.kind === "phone").map((e) => (e as { kind: "phone"; e164: string }).e164),
  );
  const requiredUuids = new Set(
    parsedRequired.filter((e) => e.kind === "uuid").map((e) => (e as { kind: "uuid"; raw: string }).raw),
  );

  const allowed = members.some((member) => {
    if (member.number) {
      const normalized = normalizeE164(member.number);
      if (normalized && requiredPhones.has(normalized)) return true;
    }
    if (member.uuid) {
      if (requiredUuids.has(member.uuid)) return true;
    }
    return false;
  });

  membershipCache.set(cacheKey, { allowed, cachedAt: now });
  return allowed;
}

/**
 * Invalidate the membership cache for a specific group.
 * Call this when a group membership change event is detected.
 * Also invalidates the shared group list cache to force a fresh fetch.
 */
export function invalidateGroupMembershipCache(groupId?: string): void {
  if (groupId) {
    // Invalidate all cache entries for this group (across account keys)
    for (const key of membershipCache.keys()) {
      if (key.endsWith(`|${groupId}`)) {
        membershipCache.delete(key);
      }
    }
  } else {
    // Invalidate everything
    membershipCache.clear();
  }
  // Also invalidate the shared group list cache
  cachedAt = 0;
}

// ── Test helpers ──────────────────────────────────────────────────────
// Exported for tests only. Not part of the public API.

/** @internal */
export function _resetCaches(): void {
  cachedGroups = null;
  cachedAt = 0;
  cacheAccountKey = "";
  membershipCache.clear();
}

/** @internal */
export function _getMembershipCacheSize(): number {
  return membershipCache.size;
}
