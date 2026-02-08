import { afterEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";

/**
 * Integration test for the full groupRequireOneOf lifecycle:
 * 1. Required member present → messages received
 * 2. Required member removed → messages dropped (never reach session)
 * 3. Required member re-added → messages received again
 *
 * Verifies that messages during the non-compliant gap are completely
 * lost from OpenClaw's perspective (never dispatched to session).
 */

const dispatchedMessages: Array<{ body: string; sessionKey: string }> = [];

vi.mock("../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/dispatch.js")>();
  const dispatchInboundMessage = vi.fn(async (params: { ctx: MsgContext }) => {
    dispatchedMessages.push({
      body: String(params.ctx.RawBody ?? ""),
      sessionKey: String(params.ctx.SessionKey ?? ""),
    });
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  });
  return {
    ...actual,
    dispatchInboundMessage,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessage,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessage,
  };
});

vi.mock("./groups.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./groups.js")>();
  return {
    ...actual,
    checkGroupHasRequiredMember: vi.fn(),
    invalidateGroupMembershipCache: vi.fn(),
  };
});

import { createSignalEventHandler } from "./monitor/event-handler.js";
import { checkGroupHasRequiredMember } from "./groups.js";

const mockCheckMembership = vi.mocked(checkGroupHasRequiredMember);

function makeDeps() {
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    runtime: { log: () => {}, error: () => {} } as any,
    // oxlint-disable-next-line typescript/no-explicit-any
    cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
    baseUrl: "http://localhost",
    account: "+10000000000",
    accountId: "default",
    historyLimit: 0,
    groupHistories: new Map(),
    textLimit: 4000,
    dmPolicy: "open" as const,
    allowFrom: ["*"],
    groupAllowFrom: ["*"],
    groupRequireOneOf: ["+15551111111"],
    groupPolicy: "open" as const,
    reactionMode: "off" as const,
    reactionAllowlist: [],
    mediaMaxBytes: 1024,
    ignoreAttachments: true,
    sendReadReceipts: false,
    readReceiptsViaDaemon: false,
    fetchAttachment: async () => null,
    deliverReplies: async () => {},
    resolveSignalReactionTargets: () => [],
    // oxlint-disable-next-line typescript/no-explicit-any
    isSignalReactionMessage: () => false as any,
    shouldEmitSignalReactionNotification: () => false,
    buildSignalReactionSystemEventText: () => "reaction",
  };
}

function sendGroupMessage(handler: ReturnType<typeof createSignalEventHandler>, text: string) {
  return handler({
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: "+15559999999",
        sourceName: "Stranger",
        timestamp: Date.now(),
        dataMessage: {
          message: text,
          attachments: [],
          groupInfo: { groupId: "testGroup123", groupName: "Test Group" },
        },
      },
    }),
  });
}

describe("groupRequireOneOf full lifecycle", () => {
  afterEach(() => {
    dispatchedMessages.length = 0;
    vi.clearAllMocks();
  });

  it("accepts messages when required member present, drops when removed, accepts again when re-added", async () => {
    const handler = createSignalEventHandler(makeDeps());

    // ── Phase 1: Required member IS in the group ──────────────────
    // checkGroupHasRequiredMember returns true
    mockCheckMembership.mockResolvedValue(true);

    await sendGroupMessage(handler, "message-1-allowed");
    await sendGroupMessage(handler, "message-2-allowed");

    expect(dispatchedMessages).toHaveLength(2);
    expect(dispatchedMessages[0].body).toBe("message-1-allowed");
    expect(dispatchedMessages[1].body).toBe("message-2-allowed");

    // ── Phase 2: Required member REMOVED from group ───────────────
    // Simulate member removal: checkGroupHasRequiredMember now returns false
    mockCheckMembership.mockResolvedValue(false);

    await sendGroupMessage(handler, "message-3-should-be-lost");
    await sendGroupMessage(handler, "message-4-should-be-lost");
    await sendGroupMessage(handler, "message-5-should-be-lost");

    // These messages must NEVER reach the session
    expect(dispatchedMessages).toHaveLength(2); // Still only 2 from Phase 1
    // Verify none of the dropped messages appear
    const allBodies = dispatchedMessages.map((m) => m.body);
    expect(allBodies).not.toContain("message-3-should-be-lost");
    expect(allBodies).not.toContain("message-4-should-be-lost");
    expect(allBodies).not.toContain("message-5-should-be-lost");

    // ── Phase 3: Required member RE-ADDED to group ────────────────
    // checkGroupHasRequiredMember returns true again
    mockCheckMembership.mockResolvedValue(true);

    await sendGroupMessage(handler, "message-6-allowed-again");
    await sendGroupMessage(handler, "message-7-allowed-again");

    // Should have exactly 4 dispatched messages total (2 from Phase 1 + 2 from Phase 3)
    expect(dispatchedMessages).toHaveLength(4);
    expect(dispatchedMessages[2].body).toBe("message-6-allowed-again");
    expect(dispatchedMessages[3].body).toBe("message-7-allowed-again");

    // Final verification: the 3 messages from Phase 2 are completely gone
    const finalBodies = dispatchedMessages.map((m) => m.body);
    expect(finalBodies).toEqual([
      "message-1-allowed",
      "message-2-allowed",
      "message-6-allowed-again",
      "message-7-allowed-again",
    ]);
  });
});
