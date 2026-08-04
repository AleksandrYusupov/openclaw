import { afterEach, describe, expect, it } from "vitest";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../../logging/diagnostic-session-state.js";
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
  resetDiagnosticSessionStateForTest();
});

function responding(payload: unknown): GatewayRequestHandler {
  return ({ respond }) => respond(true, payload, undefined);
}

describe("observability repository provenance", () => {
  it("exports only a validated runtime revision for the verified fork", () => {
    const revision = "a".repeat(40);
    expect(testApi.buildRuntimeRepository(revision)).toEqual({
      provenanceType: "runtime",
      verified: true,
      provider: "github",
      status: "verified",
      url: "https://github.com/AleksandrYusupov/openclaw",
      revision,
      path: null,
    });
    expect(testApi.buildRuntimeRepository("not-a-revision").revision).toBeNull();
  });

  it("links only bundled skill definitions with a safe repo-relative path", () => {
    expect(
      testApi.bundledSkillRepository(
        {
          bundled: true,
          source: "openclaw-bundled",
          filePath: "/opt/openclaw/skills/incident-review/SKILL.md",
        },
        "a".repeat(40),
      ),
    ).toMatchObject({
      provenanceType: "definition",
      verified: true,
      url: "https://github.com/AleksandrYusupov/openclaw",
      revision: "a".repeat(40),
      path: "skills/incident-review/SKILL.md",
    });
    expect(
      testApi.bundledSkillRepository(
        {
          bundled: false,
          source: "openclaw-workspace",
          filePath: "/private/workspace/skills/custom/SKILL.md",
        },
        "a".repeat(40),
      ),
    ).toBeNull();
    expect(
      testApi.bundledSkillRepository(
        {
          bundled: true,
          source: "openclaw-bundled",
          filePath: "skills/../SKILL.md",
        },
        "a".repeat(40),
      ),
    ).toBeNull();
  });

  it("links only valid commit-pinned tracked definitions from the repository allowlist", () => {
    const revision = "b".repeat(40);
    expect(
      testApi.trackedSkillRepository({
        clawhub: {
          status: "linked",
          valid: true,
          sourceUrl: `https://github.com/AleksandrYusupov/ai-dev-team-2/tree/${revision}/skills/fix-agent`,
        },
      }),
    ).toEqual({
      provenanceType: "definition",
      verified: true,
      provider: "github",
      status: "verified",
      url: "https://github.com/AleksandrYusupov/ai-dev-team-2",
      revision,
      path: "skills/fix-agent/SKILL.md",
    });
    expect(
      testApi.trackedSkillRepository({
        clawhub: {
          status: "linked",
          valid: true,
          sourceUrl: `https://github.com/unregistered/private/tree/${revision}/skills/secret`,
        },
      }),
    ).toBeNull();
    expect(
      testApi.trackedSkillRepository({
        clawhub: {
          status: "linked",
          valid: true,
          sourceUrl: "https://github.com/AleksandrYusupov/ai-dev-team-2/tree/main/skills/fix-agent",
        },
      }),
    ).toBeNull();
  });

  it("drops definition provenance when the same skill key has conflicting origins", () => {
    const repository = {
      provenanceType: "definition",
      verified: true,
      provider: "github",
      status: "verified",
      url: "https://github.com/AleksandrYusupov/openclaw",
      revision: "c".repeat(40),
      path: "skills/shared/SKILL.md",
    };
    const bundled = {
      key: "shared",
      name: "Shared",
      status: "available",
      origin: "bundled",
      repositories: [repository],
    };
    const workspace = {
      key: "shared",
      name: "Shared override",
      status: "available",
      origin: "workspace",
      repositories: [],
    };
    for (const observations of [
      [bundled, workspace],
      [workspace, bundled],
    ]) {
      expect(testApi.mergeSkillInventory(observations)).toEqual([
        expect.objectContaining({ key: "shared", origin: "unknown", repositories: [] }),
      ]);
    }
  });
});

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

  it("attributes bounded runtime tool and skill evidence to MCP and skill inventory", () => {
    const state = getDiagnosticSessionState({ sessionKey: "raw-runtime-session" });
    state.toolCallHistory = [
      {
        toolName: "safe-server__run",
        argsHash: "private-args-hash",
        resultHash: "error:private-result-hash",
        timestamp: 1_800_000_001_000,
      },
    ];

    const events = testApi.buildActivityEvents(
      { tasks: [] },
      {
        sessions: [
          {
            key: "raw-runtime-session",
            agentId: "agent-manager",
            status: "active",
            updatedAt: 1_800_000_001_000,
          },
        ],
      },
      1_800_000_002_000,
      {
        mcpKeyByToolPrefix: new Map([["safe-server__", "safe-server"]]),
        skillKeyByName: new Map([["incident review", "incident-review"]]),
        skillUsage: [
          {
            agentId: "agent-manager",
            runId: "private-run-id",
            sessionKey: "raw-runtime-session",
            skillName: "Incident Review",
            ts: 1_800_000_001_500,
            seq: 7,
          },
        ],
      },
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventKind: "tool",
          mcpId: "safe-server",
          outcome: "error",
          evidenceCode: "OBS-OPENCLAW-TOOL-OUTCOME",
        }),
        expect.objectContaining({
          eventKind: "skill",
          skillIds: ["incident-review"],
          outcome: "success",
          evidenceCode: "OBS-OPENCLAW-SKILL-USED",
        }),
      ]),
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("raw-runtime-session");
    expect(serialized).not.toContain("private-run-id");
    expect(serialized).not.toContain("private-args-hash");
    expect(serialized).not.toContain("private-result-hash");
  });

  it("assembles a complete read-only snapshot from existing gateway read models", async () => {
    agentsHandlers["agents.list"] = responding({
      agents: [{ id: "agent-manager", name: "Agent Manager" }],
    });
    skillsHandlers["skills.status"] = responding({
      skills: [
        {
          key: "incident-review",
          name: "Incident Review",
          eligible: true,
          bundled: true,
          source: "openclaw-bundled",
          filePath: "/opt/openclaw/skills/incident-review/SKILL.md",
        },
        {
          key: "private-workspace-skill",
          name: "Private Workspace Skill",
          eligible: true,
          bundled: false,
          source: "openclaw-workspace",
          filePath: "/private/workspace/skills/private-workspace-skill/SKILL.md",
        },
      ],
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
      provenanceVersion: 2,
      sourceCounts: { agents: 1, skills: 2, tools: 1, mcp: 0, activityEvents: 1 },
      agents: [{ id: "agent-manager", status: "available" }],
      skills: [
        {
          key: "incident-review",
          status: "available",
          origin: "bundled",
          repositories: [
            {
              provenanceType: "definition",
              verified: true,
              url: "https://github.com/AleksandrYusupov/openclaw",
              path: "skills/incident-review/SKILL.md",
            },
          ],
        },
        {
          key: "private-workspace-skill",
          status: "available",
          origin: "workspace",
          repositories: [],
        },
      ],
      activityCoverage: [{ agentId: "agent-manager", eventCount: 1, complete: true }],
    });
    expect(JSON.stringify(response?.payload)).not.toContain("private-task-id");
    expect(JSON.stringify(response?.payload)).not.toContain("private-session-id");
    expect(JSON.stringify(response?.payload)).not.toContain("/private/workspace");
  });
});
