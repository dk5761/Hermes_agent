/**
 * Smoke test for backend/src/ws/attach-and-submit.ts. Covers the call-order
 * contract (bridge.build → image.attach loop → prompt.submit) and the
 * recovery branches (busy interrupt, session_gone recover-and-retry).
 *
 * Mocks the AttachmentBridge and HermesWsClient to avoid network. Asserts
 * the expected JSON-RPC method sequence.
 *
 * Run with:
 *   pnpm exec tsx scripts/test-attach-and-submit.ts
 */
import {
  AttachmentResolutionError,
  ImageAttachFailedError,
  PromptSubmitFailedError,
  prepareImageAttach,
  submitPrompt,
} from "../src/ws/attach-and-submit.js";
import {
  AttachmentBridge,
  AttachmentUnauthorizedError,
  type AttachmentBridgeResult,
} from "../src/ws/attachment-bridge.js";
import type { HermesWsClient } from "../src/hermes/ws-client.js";
import type { AppLogger } from "../src/logger.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    console.error("✗ FAIL:", message);
    process.exit(1);
  }
  console.log("✓", message);
}

const noopLog: AppLogger = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {}, child: (() => noopLog) as any, level: "info", silent: () => {},
} as unknown as AppLogger;

interface RpcCall {
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any;
}

function makeMockClient(handler: (call: RpcCall) => unknown): {
  client: HermesWsClient;
  calls: RpcCall[];
} {
  const calls: RpcCall[] = [];
  const client = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: async (method: string, params: any) => {
      const call = { method, params };
      calls.push(call);
      const result = handler(call);
      if (result instanceof Error) throw result;
      return result;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as HermesWsClient;
  return { client, calls };
}

function makeMockBridge(result: AttachmentBridgeResult | Error): AttachmentBridge {
  return {
    build: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as AttachmentBridge;
}

const STD_INPUT = {
  userId: "user-1",
  appSessionId: "app-1",
  hermesSessionId: "hsid-1",
};

async function testHappyPathWithImages(): Promise<void> {
  const bridge = makeMockBridge({
    imagePaths: [
      { attachmentId: "att-a", localPath: "/tmp/a.png" },
      { attachmentId: "att-b", localPath: "/tmp/b.png" },
    ],
    promptPrefix: "[ctx]",
    warnings: [],
  });
  const { client, calls } = makeMockClient(() => ({}));
  const prep = await prepareImageAttach(
    { sharedClient: client, attachmentBridge: bridge, log: noopLog },
    { ...STD_INPUT, attachmentIds: ["att-a", "att-b"], text: "hello" },
  );
  assert(prep.bridgeResult !== null, "bridge result is populated");
  assert(prep.finalText.startsWith("[ctx]") && prep.finalText.includes("hello"), "finalText prepends prefix");
  assert(calls.length === 2, "two image.attach calls");
  assert(calls[0]?.method === "image.attach" && calls[0]?.params.path === "/tmp/a.png", "first image.attach a.png");
  assert(calls[1]?.method === "image.attach" && calls[1]?.params.path === "/tmp/b.png", "second image.attach b.png");
}

async function testNoAttachmentsSkipsBridge(): Promise<void> {
  const bridge = makeMockBridge(new Error("should not be called"));
  const { client, calls } = makeMockClient(() => ({}));
  const prep = await prepareImageAttach(
    { sharedClient: client, attachmentBridge: bridge, log: noopLog },
    { ...STD_INPUT, attachmentIds: [], text: "hi" },
  );
  assert(prep.bridgeResult === null, "no bridge call when attachmentIds empty");
  assert(prep.finalText === "hi", "finalText is the user text verbatim");
  assert(calls.length === 0, "no image.attach calls");
}

async function testAttachmentUnauthorizedThrows(): Promise<void> {
  const bridge = makeMockBridge(new AttachmentUnauthorizedError("att-x"));
  const { client } = makeMockClient(() => ({}));
  let caught: unknown = null;
  try {
    await prepareImageAttach(
      { sharedClient: client, attachmentBridge: bridge, log: noopLog },
      { ...STD_INPUT, attachmentIds: ["att-x"], text: "hi" },
    );
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof AttachmentUnauthorizedError, "unauthorized re-throws as AttachmentUnauthorizedError");
}

async function testGenericBridgeErrorWraps(): Promise<void> {
  const bridge = makeMockBridge(new Error("disk full"));
  const { client } = makeMockClient(() => ({}));
  let caught: unknown = null;
  try {
    await prepareImageAttach(
      { sharedClient: client, attachmentBridge: bridge, log: noopLog },
      { ...STD_INPUT, attachmentIds: ["att-x"], text: "hi" },
    );
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof AttachmentResolutionError, "generic bridge error wraps as AttachmentResolutionError");
}

async function testImageAttachFailureSurfaces(): Promise<void> {
  const bridge = makeMockBridge({
    imagePaths: [
      { attachmentId: "att-a", localPath: "/tmp/a.png" },
      { attachmentId: "att-b", localPath: "/tmp/b.png" },
    ],
    promptPrefix: "",
    warnings: [],
  });
  const { client } = makeMockClient((call) => {
    if (call.method === "image.attach" && call.params.path === "/tmp/b.png") {
      return new Error("upstream attach refused");
    }
    return {};
  });
  let caught: unknown = null;
  try {
    await prepareImageAttach(
      { sharedClient: client, attachmentBridge: bridge, log: noopLog },
      { ...STD_INPUT, attachmentIds: ["att-a", "att-b"], text: "hi" },
    );
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof ImageAttachFailedError, "image.attach failure throws ImageAttachFailedError");
  assert((caught as ImageAttachFailedError).attachmentId === "att-b", "attachmentId field is the failing one");
}

async function testSubmitPromptHappy(): Promise<void> {
  const { client, calls } = makeMockClient((call) => {
    if (call.method === "prompt.submit") return {};
    return {};
  });
  const result = await submitPrompt(
    { sharedClient: client, log: noopLog },
    { hermesSessionId: "hsid-1", finalText: "hi" },
  );
  assert(result.hermesSessionId === "hsid-1", "session id unchanged on happy path");
  assert(calls.length === 1 && calls[0]?.method === "prompt.submit", "single prompt.submit call");
}

async function testSubmitPromptBusyInterruptRetries(): Promise<void> {
  let promptCalls = 0;
  const { client, calls } = makeMockClient((call) => {
    if (call.method === "prompt.submit") {
      promptCalls += 1;
      if (promptCalls === 1) return new Error("session busy code 4009");
      return {};
    }
    if (call.method === "session.interrupt") return {};
    return {};
  });
  const result = await submitPrompt(
    { sharedClient: client, log: noopLog },
    { hermesSessionId: "hsid-1", finalText: "hi" },
  );
  assert(result.hermesSessionId === "hsid-1", "busy retry preserves session id");
  // Expected sequence: prompt.submit (busy) → session.interrupt → prompt.submit (ok)
  assert(calls.length === 3, `three calls (got ${calls.length})`);
  assert(calls[0]?.method === "prompt.submit", "first is prompt.submit");
  assert(calls[1]?.method === "session.interrupt", "second is session.interrupt");
  assert(calls[2]?.method === "prompt.submit", "third is prompt.submit retry");
}

async function testSubmitPromptSessionGoneRecovers(): Promise<void> {
  let promptCalls = 0;
  const { client } = makeMockClient((call) => {
    if (call.method === "prompt.submit") {
      promptCalls += 1;
      if (promptCalls === 1) return new Error("session not found");
      return {};
    }
    return {};
  });
  let recoveredOnce = false;
  const result = await submitPrompt(
    { sharedClient: client, log: noopLog },
    {
      hermesSessionId: "hsid-old",
      finalText: "hi",
      recoverSession: async (failed) => {
        assert(failed === "hsid-old", "recoverSession sees the failed id");
        recoveredOnce = true;
        return "hsid-new";
      },
    },
  );
  assert(recoveredOnce, "recoverSession was invoked");
  assert(result.hermesSessionId === "hsid-new", "result reflects new session id");
}

async function testSubmitPromptUnrecoverableThrows(): Promise<void> {
  const { client } = makeMockClient(() => new Error("upstream offline"));
  let caught: unknown = null;
  try {
    await submitPrompt(
      { sharedClient: client, log: noopLog },
      { hermesSessionId: "hsid-1", finalText: "hi" },
    );
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof PromptSubmitFailedError, "non-recoverable error throws PromptSubmitFailedError");
}

async function main(): Promise<void> {
  await testHappyPathWithImages();
  await testNoAttachmentsSkipsBridge();
  await testAttachmentUnauthorizedThrows();
  await testGenericBridgeErrorWraps();
  await testImageAttachFailureSurfaces();
  await testSubmitPromptHappy();
  await testSubmitPromptBusyInterruptRetries();
  await testSubmitPromptSessionGoneRecovers();
  await testSubmitPromptUnrecoverableThrows();
  console.log("\nAll attach-and-submit checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
