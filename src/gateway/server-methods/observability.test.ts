import { afterEach, describe, expect, it } from "vitest";
import { agentsHandlers } from "./agents.js";
import { observabilityHandlers, testApi } from "./observability.js";
import { sessionsHandlers } from "./sessions.js";
import { skillsHandlers } from "./skills.js";
import { tasksHandlers } from "./tasks.js";
import { toolsCatalogHandlers } from "./tools-catalog.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./types.js";

const originalHandlers = {
  agents: agentsHandlers["agents.list"]!,
  skills: skillsHandlers["skills.status"]!,
  tasks: tasksHandlers["tasks.list"]!,
  sessions: sessionsHandlers["sessions.list"]!,
  tools: toolsCatalogHandlers["tools.catalog"]!,
};

afterEach(() => {
  agentsHandlers["agents.list"] = originalHandlers.agents;
  skillsHandlers["skills.status"] = originalHandlers.skills;
  tasksHandlers["tasks.list"] = originalHandlers.tasks;
  sessionsHandlers["sessions.list"] = originalHandlers.sessions;
  toolsCatalogHandlers["tools.catalog"] = originalHandlers.tools;
});

function responding(payload: unknown): GatewayRequestHandler {
  return ({ respond }) => respond(true, payload, undefined);
}

describe("observability activity projection", () => {
  it("returns opaque references and no task/session payload text", () => {
    const events = testApi.buildActivityEvents(
      {
        tasks: [
          {
            taskId: "raw-task-id",
            agentId: "agent-manager",
            sessionKey: "raw-session-key",
            status: "failed",
            updatedAt: 1_800_000_000_000,
            prompt: "secret prompt",
            error: "secret stack trace",
          },
        ],
      },
      {
        sessions: [
          {
            key: "raw-session-key-2",
            agentId: "researcher",
            status: "active",
            updatedAt: 1_800_000_001_000,
            messages: ["secret message"],
          },
        ],
      },
      1_800_000_002_000,
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      agentId: "researcher",
      outcome: "running",
      evidenceCode: "OBS-OPENCLAW-SESSIONS-LIST",
    });
    expect(events[1]).toMatchObject({
      agentId: "agent-manager",
      outcome: "error",
      errorCode: "OPENCLAW_TASK_FAILED",
      evidenceCode: "OBS-OPENCLAW-TASKS-LIST",
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("raw-task-id");
    expect(serialized).not.toContain("raw-session-key");
    expect(serialized).not.toContain("secret prompt");
    expect(serialized).not.toContain("secret stack trace");
    expect(serialized).not.toContain("secret message");
  });

  it("assembles a complete read-only snapshot from existing gateway read models", async () => {
    agentsHandlers["agents.list"] = responding({
      agents: [{ id: "agent-manager", name: "Agent Manager" }],
    });
    skillsHandlers["skills.status"] = responding({
      skills: [{ key: "incident-review", name: "Incident Review", eligible: true }],
    });
    toolsCatalogHandlers["tools.catalog"] = responding({
      groups: [{ tools: [{ id: "tasks_list", label: "Tasks list" }] }],
    });
    tasksHandlers["tasks.list"] = responding({
      tasks: [
        {
          taskId: "private-task-id",
          agentId: "agent-manager",
          sessionKey: "private-session-id",
          status: "completed",
          updatedAt: 1_800_000_000_000,
        },
      ],
    });
    sessionsHandlers["sessions.list"] = responding({ sessions: [] });

    let response: { ok: boolean; payload?: unknown } | undefined;
    await observabilityHandlers["observability.snapshot"]?.({
      req: { type: "req", id: "test", method: "observability.snapshot", params: {} },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, payload) => {
        response = { ok, payload };
      },
      context: {
        getRuntimeConfig: () => ({ mcp: { servers: {} } }),
        logGateway: { warn: () => undefined },
      } as unknown as GatewayRequestContext,
    });

    expect(response?.ok).toBe(true);
    expect(response?.payload).toMatchObject({
      complete: true,
      sourceCounts: { agents: 1, skills: 1, tools: 1, mcp: 0, activityEvents: 1 },
      agents: [{ id: "agent-manager", status: "available" }],
      skills: [{ key: "incident-review", status: "available" }],
      activityCoverage: [{ agentId: "agent-manager", eventCount: 1, complete: true }],
    });
    expect(JSON.stringify(response?.payload)).not.toContain("private-task-id");
    expect(JSON.stringify(response?.payload)).not.toContain("private-session-id");
  });
});
