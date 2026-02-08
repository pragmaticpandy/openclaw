import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkGroupHasRequiredMember,
  invalidateGroupMembershipCache,
  _resetCaches,
  _getMembershipCacheSize,
} from "./groups.js";

// Mock the signal RPC client
vi.mock("./client.js", () => ({
  signalRpcRequest: vi.fn(),
}));

import { signalRpcRequest } from "./client.js";
const mockRpc = vi.mocked(signalRpcRequest);

const BASE_OPTS = { baseUrl: "http://localhost:8080", account: "+10000000000" };

function makeGroup(id: string, members: Array<{ number?: string | null; uuid?: string | null }>) {
  return { id, name: `Group ${id}`, isMember: true, isBlocked: false, members };
}

describe("checkGroupHasRequiredMember", () => {
  afterEach(() => {
    _resetCaches();
    vi.clearAllMocks();
  });

  it("returns true when a required number is in the group", async () => {
    mockRpc.mockResolvedValueOnce([
      makeGroup("abc123", [
        { number: "+15551111111", uuid: "uuid-1" },
        { number: "+15552222222", uuid: "uuid-2" },
      ]),
    ]);

    const result = await checkGroupHasRequiredMember(
      "abc123",
      ["+15551111111"],
      BASE_OPTS,
    );
    expect(result).toBe(true);
  });

  it("returns false when no required number is in the group", async () => {
    mockRpc.mockResolvedValueOnce([
      makeGroup("abc123", [
        { number: "+15553333333", uuid: "uuid-3" },
        { number: "+15554444444", uuid: "uuid-4" },
      ]),
    ]);

    const result = await checkGroupHasRequiredMember(
      "abc123",
      ["+15551111111"],
      BASE_OPTS,
    );
    expect(result).toBe(false);
  });

  it("returns true when no required numbers are specified (empty array)", async () => {
    // Should not even call RPC
    const result = await checkGroupHasRequiredMember("abc123", [], BASE_OPTS);
    expect(result).toBe(true);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns false when group is not found", async () => {
    mockRpc.mockResolvedValueOnce([
      makeGroup("other-group", [{ number: "+15551111111", uuid: "uuid-1" }]),
    ]);

    const result = await checkGroupHasRequiredMember(
      "nonexistent",
      ["+15551111111"],
      BASE_OPTS,
    );
    expect(result).toBe(false);
  });

  it("handles members with null phone numbers", async () => {
    mockRpc.mockResolvedValueOnce([
      makeGroup("abc123", [
        { number: null, uuid: "uuid-1" },
        { number: "+15551111111", uuid: "uuid-2" },
      ]),
    ]);

    const result = await checkGroupHasRequiredMember(
      "abc123",
      ["+15551111111"],
      BASE_OPTS,
    );
    expect(result).toBe(true);
  });

  it("handles members with no phone numbers at all", async () => {
    mockRpc.mockResolvedValueOnce([
      makeGroup("abc123", [
        { number: null, uuid: "uuid-1" },
        { uuid: "uuid-2" },
      ]),
    ]);

    const result = await checkGroupHasRequiredMember(
      "abc123",
      ["+15551111111"],
      BASE_OPTS,
    );
    expect(result).toBe(false);
  });

  it("matches any one of multiple required numbers", async () => {
    mockRpc.mockResolvedValueOnce([
      makeGroup("abc123", [
        { number: "+15553333333", uuid: "uuid-3" },
      ]),
    ]);

    const result = await checkGroupHasRequiredMember(
      "abc123",
      ["+15551111111", "+15552222222", "+15553333333"],
      BASE_OPTS,
    );
    expect(result).toBe(true);
  });

  it("uses case-insensitive group ID matching", async () => {
    mockRpc.mockResolvedValueOnce([
      makeGroup("AbC123dEf=", [
        { number: "+15551111111", uuid: "uuid-1" },
      ]),
    ]);

    const result = await checkGroupHasRequiredMember(
      "abc123def=",
      ["+15551111111"],
      BASE_OPTS,
    );
    expect(result).toBe(true);
  });

  it("matches by UUID when entry is a UUID", async () => {
    mockRpc.mockResolvedValueOnce([
      makeGroup("abc123", [
        { number: "+15551111111", uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
        { number: "+15552222222", uuid: "11111111-2222-3333-4444-555555555555" },
      ]),
    ]);

    const result = await checkGroupHasRequiredMember(
      "abc123",
      ["11111111-2222-3333-4444-555555555555"],
      BASE_OPTS,
    );
    expect(result).toBe(true);
  });

  it("matches by UUID with uuid: prefix", async () => {
    mockRpc.mockResolvedValueOnce([
      makeGroup("abc123", [
        { number: "+15551111111", uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
      ]),
    ]);

    const result = await checkGroupHasRequiredMember(
      "abc123",
      ["uuid:a1b2c3d4-e5f6-7890-abcd-ef1234567890"],
      BASE_OPTS,
    );
    expect(result).toBe(true);
  });

  it("matches with mixed phone numbers and UUIDs", async () => {
    mockRpc.mockResolvedValueOnce([
      makeGroup("abc123", [
        { number: "+15559999999", uuid: "deadbeef-0000-1111-2222-333333333333" },
      ]),
    ]);

    // Phone doesn't match, but UUID does
    const result = await checkGroupHasRequiredMember(
      "abc123",
      ["+15551111111", "deadbeef-0000-1111-2222-333333333333"],
      BASE_OPTS,
    );
    expect(result).toBe(true);
  });

  it("supports wildcard '*' entry", async () => {
    mockRpc.mockResolvedValueOnce([
      makeGroup("abc123", []),
    ]);

    const result = await checkGroupHasRequiredMember(
      "abc123",
      ["*"],
      BASE_OPTS,
    );
    expect(result).toBe(true);
  });

  it("caches membership results", async () => {
    mockRpc.mockResolvedValue([
      makeGroup("abc123", [
        { number: "+15551111111", uuid: "uuid-1" },
      ]),
    ]);

    await checkGroupHasRequiredMember("abc123", ["+15551111111"], BASE_OPTS);
    await checkGroupHasRequiredMember("abc123", ["+15551111111"], BASE_OPTS);

    // Should only call RPC once due to caching
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(_getMembershipCacheSize()).toBe(1);
  });

  it("handles groups with no members array", async () => {
    mockRpc.mockResolvedValueOnce([
      { id: "abc123", name: "Empty Group", isMember: true },
    ]);

    const result = await checkGroupHasRequiredMember(
      "abc123",
      ["+15551111111"],
      BASE_OPTS,
    );
    expect(result).toBe(false);
  });
});

describe("invalidateGroupMembershipCache", () => {
  afterEach(() => {
    _resetCaches();
    vi.clearAllMocks();
  });

  it("invalidates cache for a specific group, forcing fresh RPC call", async () => {
    mockRpc.mockResolvedValue([
      makeGroup("abc123", [
        { number: "+15551111111", uuid: "uuid-1" },
      ]),
    ]);

    // First call populates cache
    await checkGroupHasRequiredMember("abc123", ["+15551111111"], BASE_OPTS);
    expect(mockRpc).toHaveBeenCalledTimes(1);

    // Invalidate
    invalidateGroupMembershipCache("abc123");

    // Second call should make a new RPC request
    await checkGroupHasRequiredMember("abc123", ["+15551111111"], BASE_OPTS);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it("invalidates all groups when no groupId specified", async () => {
    mockRpc.mockResolvedValue([
      makeGroup("abc123", [{ number: "+15551111111", uuid: "uuid-1" }]),
      makeGroup("def456", [{ number: "+15552222222", uuid: "uuid-2" }]),
    ]);

    await checkGroupHasRequiredMember("abc123", ["+15551111111"], BASE_OPTS);
    await checkGroupHasRequiredMember("def456", ["+15552222222"], BASE_OPTS);
    expect(_getMembershipCacheSize()).toBe(2);

    invalidateGroupMembershipCache();
    expect(_getMembershipCacheSize()).toBe(0);
  });

  it("reflects membership changes after invalidation", async () => {
    // First call: member is present
    mockRpc.mockResolvedValueOnce([
      makeGroup("abc123", [
        { number: "+15551111111", uuid: "uuid-1" },
        { number: "+15552222222", uuid: "uuid-2" },
      ]),
    ]);

    let result = await checkGroupHasRequiredMember("abc123", ["+15551111111"], BASE_OPTS);
    expect(result).toBe(true);

    // Invalidate cache (simulating group update event)
    invalidateGroupMembershipCache("abc123");

    // Second call: member was removed
    mockRpc.mockResolvedValueOnce([
      makeGroup("abc123", [
        { number: "+15552222222", uuid: "uuid-2" },
      ]),
    ]);

    result = await checkGroupHasRequiredMember("abc123", ["+15551111111"], BASE_OPTS);
    expect(result).toBe(false);
  });
});
