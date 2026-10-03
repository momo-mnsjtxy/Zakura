import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { globalRegistry } from "@zakura/core";
import {
  EmailInboundService,
  type EmailInboundScheduler,
} from "../src/services/email-inbound.js";

const WEBHOOK_PROVIDER = "email-inbound-webhook-test";
const FAILING_PROVIDER = "email-inbound-failing-test";
const POLLING_PROVIDER = "email-inbound-polling-test";

function provider(id: string, callTool: (args: unknown) => Promise<unknown>) {
  if (globalRegistry.has(id)) return;
  globalRegistry.register(() => ({
    id,
    name: id,
    description: "",
    version: "1",
    category: "email",
    capabilities: ["tools"],
    configSchema: { type: "object", properties: {} },
    createRuntimeSpec: () => ({ containers: [], endpointTemplate: null }),
    healthCheck: async () => ({ status: "healthy", message: "ok" }),
    listTools: async () => [],
    callTool: async (_handle: unknown, _toolName: string, args: unknown) => callTool(args),
  }) as never);
}

function target(
  providerId: string,
  connectorRef: string,
  settings: Record<string, unknown> = {},
) {
  return {
    connectorRef,
    capabilityRef: "email-bettermail",
    providerId,
    product: "bettermail",
    mcpUrl: "zakura://email/bettermail",
    connectorName: connectorRef,
    instanceSlug: connectorRef,
    auth: { profile: connectorRef },
    credentials: {
      values: {},
      settings: {
        inboundEnabled: true,
        inboundSecret: "webhook-secret",
        inboundAgentId: "agent-1",
        allowedEmails: "allowed@example.test",
        mailbox: "inbox@example.test",
        ...settings,
      },
    },
  };
}

describe("email inbound lifecycle", () => {
  before(() => {
    provider(WEBHOOK_PROVIDER, async () => ({ content: [] }));
    provider(FAILING_PROVIDER, async () => {
      throw new Error("fake mailbox outage");
    });
    provider(POLLING_PROVIDER, async () => ({
      content: [{
        type: "text",
        text: JSON.stringify([{ id: "poll-mail", from: "allowed@example.test", subject: "Poll" }]),
      }],
    }));
  });

  function serviceHarness(opts: {
    targets?: unknown[];
    tenantAvailable?: (tenantId: string) => boolean;
    handleInbound?: (input: { externalEventId: string }) => Promise<unknown>;
    dbTenants?: string[];
    scheduler?: EmailInboundScheduler;
  } = {}) {
    const ingressCalls: string[] = [];
    const targets = opts.targets ?? [target(WEBHOOK_PROVIDER, "email-webhook")];
    const integrationCatalog = {
      listAllDirectConnectorTargets: async () => targets,
    };
    const agentService = {
      get: async (_tenantId: string, agentId: string) => ({ id: agentId, configJson: "{}" }),
    };
    const remoteIngress = {
      ensureBinding: async () => ({ id: "binding-1" }),
      handleInbound: async (input: { externalEventId: string }) => {
        ingressCalls.push(input.externalEventId);
        return opts.handleInbound?.(input) ?? { accepted: true };
      },
    };
    const db = {
      select: () => ({
        from: async () => (opts.dbTenants ?? []).map((id) => ({ id })),
      }),
    };
    const service = new EmailInboundService(
      db as never,
      integrationCatalog as never,
      agentService as never,
      {} as never,
      {} as never,
      remoteIngress as never,
      {
        scheduler: opts.scheduler,
        now: () => 100_000,
        isTenantAvailable: opts.tenantAvailable,
      },
    );
    return { service, ingressCalls };
  }

  it("verifies secrets defensively and retries delivery before marking seen", async () => {
    let failNext = true;
    const { service, ingressCalls } = serviceHarness({
      handleInbound: async () => {
        if (failNext) {
          failNext = false;
          throw new Error("transient ingress failure");
        }
        return { accepted: true };
      },
    });
    assert.equal(await service.verifyWebhookSecret("tenant", "", "email-webhook"), false);
    assert.equal(await service.verifyWebhookSecret("tenant", "wrong", "email-webhook"), false);
    assert.equal(
      await service.verifyWebhookSecret("tenant", "webhook-secret", "email-webhook"),
      true,
    );
    const mail = { id: "retry-mail", from: "allowed@example.test", subject: "Retry" };
    await assert.rejects(
      () => service.handleWebhook("tenant", mail, "webhook-secret", "email-webhook"),
      /transient ingress failure/,
    );
    assert.equal(
      await service.handleWebhook("tenant", mail, "webhook-secret", "email-webhook"),
      true,
    );
    assert.deepEqual(ingressCalls, ["retry-mail", "retry-mail"]);
  });

  it("single-flights concurrent webhooks and fingerprints id-less mail", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, ingressCalls } = serviceHarness({
      handleInbound: async () => {
        await gate;
        return { accepted: true };
      },
    });
    const mail = { id: "same-mail", from: "allowed@example.test", subject: "Same" };
    const first = service.handleWebhook("tenant", mail, "webhook-secret", "email-webhook");
    const second = service.handleWebhook("tenant", mail, "webhook-secret", "email-webhook");
    await new Promise((resolve) => setImmediate(resolve));
    release();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(ingressCalls.length, 1);
    assert.equal(await service.handleWebhook("tenant", mail, "webhook-secret", "email-webhook"), true);
    assert.equal(ingressCalls.length, 1);

    const withoutId = {
      receivedAt: "2026-10-03T12:00:00Z",
      from: "allowed@example.test",
      subject: "No id",
      text: "same body",
    };
    await service.handleWebhook("tenant", withoutId, "webhook-secret", "email-webhook");
    await service.handleWebhook("tenant", withoutId, "webhook-secret", "email-webhook");
    assert.equal(ingressCalls.length, 2);
    assert.match(ingressCalls[1]!, /^email-sha256:/);
  });

  it("blocks and drains a suspended tenant, then permits explicit resume", async () => {
    const { service, ingressCalls } = serviceHarness();
    await service.stopTenant("tenant");
    assert.equal(
      await service.handleWebhook(
        "tenant",
        { id: "blocked", from: "allowed@example.test" },
        "webhook-secret",
        "email-webhook",
      ),
      false,
    );
    service.resumeTenant("tenant");
    assert.equal(
      await service.handleWebhook(
        "tenant",
        { id: "resumed", from: "allowed@example.test" },
        "webhook-secret",
        "email-webhook",
      ),
      true,
    );
    assert.deepEqual(ingressCalls, ["resumed"]);
  });

  it("auto-resumes a suspended tenant only after the authoritative check recovers", async () => {
    let available = false;
    const { service, ingressCalls } = serviceHarness({
      tenantAvailable: () => available,
    });
    await service.stopTenant("tenant", { resumeWhenAvailable: true });
    const mail = { id: "resume-check", from: "allowed@example.test" };
    assert.equal(
      await service.handleWebhook("tenant", mail, "webhook-secret", "email-webhook"),
      false,
    );
    available = true;
    assert.equal(
      await service.handleWebhook("tenant", mail, "webhook-secret", "email-webhook"),
      true,
    );
    assert.deepEqual(ingressCalls, ["resume-check"]);
  });

  it("isolates a failed polling target and cancels its scheduler", async () => {
    const handles = new Set<object>();
    const scheduler: EmailInboundScheduler = {
      setInterval: ((fn: () => void) => {
        const handle = { fn, unref() {} };
        handles.add(handle);
        return handle;
      }) as typeof setInterval,
      clearInterval: ((handle: object) => handles.delete(handle)) as typeof clearInterval,
    };
    const { service, ingressCalls } = serviceHarness({
      dbTenants: ["tenant"],
      scheduler,
      targets: [
        target(FAILING_PROVIDER, "email-failing"),
        target(POLLING_PROVIDER, "email-polling"),
      ],
    });
    await service.runOnce();
    assert.deepEqual(ingressCalls, ["poll-mail"]);
    service.start();
    assert.equal(handles.size, 1);
    await service.stopAndDrain();
    assert.equal(handles.size, 0);
  });
});
