import { afterEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";

let capturedCtx: MsgContext | undefined;
let dispatchCallCount = 0;

vi.mock("../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/dispatch.js")>();
  const dispatchInboundMessage = vi.fn(async (params: { ctx: MsgContext }) => {
    capturedCtx = params.ctx;
    dispatchCallCount++;
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  });
  return {
    ...actual,
    dispatchInboundMessage,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessage,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessage,
  };
});

// Mock the groups module
vi.mock("./groups.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./groups.js")>();
  return {
    ...actual,
    checkGroupHasRequiredMember: vi.fn(),
    invalidateGroupMembershipCache: vi.fn(),
  };
});

import { createSignalEventHandler } from "./monitor/event-handler.js";
import { checkGroupHasRequiredMember, invalidateGroupMembershipCache } from "./groups.js";

const mockCheckMembership = vi.mocked(checkGroupHasRequiredMember);
const mockInvalidateCache = vi.mocked(invalidateGroupMembershipCache);

function makeDeps(overrides: Record<string, unknown> = {}) {
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
    groupRequireOneOf: [] as string[],
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
    ...overrides,
  };
}

function groupMessage(text: string, groupId = "g1", groupName = "Test Group") {
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: "+15559999999",
        sourceName: "Stranger",
        timestamp: Date.now(),
        dataMessage: {
          message: text,
          attachments: [],
          groupInfo: { groupId, groupName },
        },
      },
    }),
  };
}

function groupUpdateMessage(groupId = "g1", groupName = "Test Group") {
  // Group update events have groupInfo but no message text
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: "+15559999999",
        sourceName: "Stranger",
        timestamp: Date.now(),
        dataMessage: {
          message: "",
          attachments: [],
          groupInfo: { groupId, groupName },
        },
      },
    }),
  };
}

function dmMessage(text: string) {
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: "+15551111111",
        sourceName: "Alice",
        timestamp: Date.now(),
        dataMessage: {
          message: text,
          attachments: [],
        },
      },
    }),
  };
}

describe("signal groupRequireOneOf gate", () => {
  afterEach(() => {
    capturedCtx = undefined;
    dispatchCallCount = 0;
    vi.clearAllMocks();
  });

  it("allows group messages when groupRequireOneOf is empty (backwards compatible)", async () => {
    const handler = createSignalEventHandler(makeDeps({ groupRequireOneOf: [] }));
    await handler(groupMessage("hello"));

    expect(dispatchCallCount).toBe(1);
    expect(mockCheckMembership).not.toHaveBeenCalled();
  });

  it("allows group messages when required member is present", async () => {
    mockCheckMembership.mockResolvedValueOnce(true);

    const handler = createSignalEventHandler(
      makeDeps({ groupRequireOneOf: ["+15551111111"] }),
    );
    await handler(groupMessage("hello"));

    expect(mockCheckMembership).toHaveBeenCalledWith(
      "g1",
      ["+15551111111"],
      expect.objectContaining({ baseUrl: "http://localhost" }),
    );
    expect(dispatchCallCount).toBe(1);
  });

  it("blocks group messages when no required member is present", async () => {
    mockCheckMembership.mockResolvedValueOnce(false);

    const handler = createSignalEventHandler(
      makeDeps({ groupRequireOneOf: ["+15551111111"] }),
    );
    await handler(groupMessage("hello"));

    expect(mockCheckMembership).toHaveBeenCalled();
    expect(dispatchCallCount).toBe(0);
  });

  it("blocks group messages when membership check throws", async () => {
    mockCheckMembership.mockRejectedValueOnce(new Error("RPC failed"));

    const handler = createSignalEventHandler(
      makeDeps({ groupRequireOneOf: ["+15551111111"] }),
    );
    await handler(groupMessage("hello"));

    expect(dispatchCallCount).toBe(0);
  });

  it("does not check groupRequireOneOf for DMs", async () => {
    const handler = createSignalEventHandler(
      makeDeps({ groupRequireOneOf: ["+15551111111"] }),
    );
    await handler(dmMessage("hello"));

    expect(mockCheckMembership).not.toHaveBeenCalled();
    expect(dispatchCallCount).toBe(1);
  });

  it("applies groupRequireOneOf independently from groupPolicy", async () => {
    // groupPolicy would allow, but groupRequireOneOf blocks
    mockCheckMembership.mockResolvedValueOnce(false);

    const handler = createSignalEventHandler(
      makeDeps({
        groupRequireOneOf: ["+15551111111"],
        groupPolicy: "open",
        groupAllowFrom: ["*"],
      }),
    );
    await handler(groupMessage("hello"));

    expect(dispatchCallCount).toBe(0);
  });

  it("calls checkGroupHasRequiredMember with correct group ID for gate check", async () => {
    mockCheckMembership.mockResolvedValueOnce(true);

    const handler = createSignalEventHandler(
      makeDeps({ groupRequireOneOf: ["+15551111111", "+15552222222"] }),
    );
    await handler(groupMessage("hello", "myGroupId"));

    expect(mockCheckMembership).toHaveBeenCalledWith(
      "myGroupId",
      ["+15551111111", "+15552222222"],
      expect.objectContaining({ baseUrl: "http://localhost" }),
    );
  });

  it("does not invalidate cache on group update when groupRequireOneOf is empty", async () => {
    const handler = createSignalEventHandler(
      makeDeps({ groupRequireOneOf: [] }),
    );

    await handler(groupUpdateMessage("g1"));

    expect(mockInvalidateCache).not.toHaveBeenCalled();
  });
});
