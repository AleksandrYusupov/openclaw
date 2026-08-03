// Read-only observability snapshot for external inventory and activity consumers.
import { createHash } from "node:crypto";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { createSessionMcpRuntime } from "../../agents/agent-bundle-mcp-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCommitHash } from "../../infra/git-commit.js";
import { agentsHandlers } from "./agents.js";
import { sessionsHandlers } from "./sessions.js";
import { skillsHandlers } from "./skills.js";
import { tasksHandlers } from "./tasks.js";
import { toolsCatalogHandlers } from "./tools-catalog.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestHandlers,
} from "./types.js";

const MAX_ACTIVITY_EVENTS = 1_000;
const MCP_PROBE_TIMEOUT_MS = 5_000;
const OPENCLAW_RUNTIME_REPOSITORY = "https://github.com/AleksandrYusupov/openclaw";
const OPENCLAW_UPSTREAM_REPOSITORY = "https://github.com/openclaw/openclaw";
const AI_DEV_TEAM_REPOSITORY = "https://github.com/AleksandrYusupov/ai-dev-team-2";
const ONYX_REPOSITORY = "https://github.com/AleksandrYusupov/xpn-knowledge-base-onyx";
const GIT_REVISION_PATTERN = /^[a-f0-9]{7,40}$/iu;
const FULL_GIT_REVISION_PATTERN = /^[a-f0-9]{40}$/iu;
const SAFE_REPOSITORY_PATH_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/iu;

type JsonRecord = Record<string, unknown>;

function records(value: unknown, key: string): JsonRecord[] {
  const source = asRecord(value)?.[key];
  return Array.isArray(source)
    ? source.map(asRecord).filter((item): item is JsonRecord => item !== undefined)
    : [];
}

function safeText(value: unknown, fallback: string, maxLength = 160): string {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, maxLength);
}

function safeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function buildRuntimeRepository(revision = resolveCommitHash({ moduleUrl: import.meta.url })) {
  const candidate = revision?.trim().toLowerCase() ?? "";
  return {
    provenanceType: "runtime",
    verified: true,
    provider: "github",
    status: "verified",
    url: OPENCLAW_RUNTIME_REPOSITORY,
    revision: GIT_REVISION_PATTERN.test(candidate) ? candidate : null,
    path: null,
  };
}

function normalizeSkillOrigin(skill: JsonRecord): string {
  if (skill.bundled === true && skill.source === "openclaw-bundled") {
    return "bundled";
  }
  const clawhub = asRecord(skill.clawhub);
  if (clawhub?.valid === true && clawhub.status === "linked") {
    return "clawhub";
  }
  switch (skill.source) {
    case "openclaw-managed":
      return "managed";
    case "openclaw-workspace":
      return "workspace";
    case "agents-skills-project":
      return "project";
    case "agents-skills-personal":
      return "personal";
    case "openclaw-extra":
      return "extra";
    case "openclaw-node":
      return "remote";
    default:
      return "unknown";
  }
}

function bundledSkillRepository(skill: JsonRecord, runtimeRevision: string | null) {
  if (skill.bundled !== true || skill.source !== "openclaw-bundled") {
    return null;
  }
  const rawPath = typeof skill.filePath === "string" ? skill.filePath.trim() : "";
  const normalized = rawPath.replaceAll("\\", "/");
  const marker = "/skills/";
  const markerIndex = normalized.lastIndexOf(marker);
  const relativePath = markerIndex >= 0 ? normalized.slice(markerIndex + 1) : normalized;
  const segments = relativePath.split("/");
  if (
    segments.length !== 3 ||
    segments[0] !== "skills" ||
    segments[2] !== "SKILL.md" ||
    !SAFE_REPOSITORY_PATH_SEGMENT.test(segments[1] ?? "")
  ) {
    return null;
  }
  return {
    provenanceType: "definition",
    verified: true,
    provider: "github",
    status: "verified",
    url: OPENCLAW_RUNTIME_REPOSITORY,
    revision: runtimeRevision,
    path: segments.join("/"),
  };
}

const VERIFIED_REPOSITORIES = new Map(
  [
    OPENCLAW_RUNTIME_REPOSITORY,
    OPENCLAW_UPSTREAM_REPOSITORY,
    AI_DEV_TEAM_REPOSITORY,
    ONYX_REPOSITORY,
  ].map((url) => [url.toLowerCase(), url]),
);

function trackedSkillRepository(skill: JsonRecord) {
  const clawhub = asRecord(skill.clawhub);
  if (clawhub?.valid !== true || clawhub.status !== "linked") {
    return null;
  }
  const rawSourceUrl = typeof clawhub.sourceUrl === "string" ? clawhub.sourceUrl.trim() : "";
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(rawSourceUrl);
  } catch {
    return null;
  }
  if (
    sourceUrl.protocol !== "https:" ||
    sourceUrl.hostname !== "github.com" ||
    sourceUrl.username ||
    sourceUrl.password ||
    sourceUrl.search ||
    sourceUrl.hash
  ) {
    return null;
  }
  const segments = sourceUrl.pathname.split("/").filter(Boolean);
  if (segments.length < 5 || segments[2] !== "tree") {
    return null;
  }
  const repositoryUrl = `https://github.com/${segments[0]}/${segments[1]}`;
  const verifiedRepository = VERIFIED_REPOSITORIES.get(repositoryUrl.toLowerCase());
  const revision = segments[3]?.toLowerCase() ?? "";
  const pathSegments = segments.slice(4);
  if (
    !verifiedRepository ||
    !FULL_GIT_REVISION_PATTERN.test(revision) ||
    pathSegments.length === 0 ||
    !pathSegments.every((segment) => SAFE_REPOSITORY_PATH_SEGMENT.test(segment))
  ) {
    return null;
  }
  if (pathSegments.at(-1) !== "SKILL.md") {
    pathSegments.push("SKILL.md");
  }
  return {
    provenanceType: "definition",
    verified: true,
    provider: "github",
    status: "verified",
    url: verifiedRepository,
    revision,
    path: pathSegments.join("/"),
  };
}

function skillDefinitionRepository(skill: JsonRecord, runtimeRevision: string | null) {
  return bundledSkillRepository(skill, runtimeRevision) ?? trackedSkillRepository(skill);
}

function mergeSkillInventory(skills: JsonRecord[]) {
  const grouped = new Map<string, JsonRecord[]>();
  for (const skill of skills) {
    const key = String(skill.key);
    const observations = grouped.get(key);
    if (observations) {
      observations.push(skill);
    } else {
      grouped.set(key, [skill]);
    }
  }
  const mergedSkills: JsonRecord[] = [];
  for (const observations of grouped.values()) {
    const first = observations[0] ?? {};
    const origins = new Set(observations.map((skill) => String(skill.origin)));
    const repositorySignatures = new Set(
      observations.map((skill) => JSON.stringify(skill.repositories ?? [])),
    );
    const statuses = new Set(observations.map((skill) => String(skill.status)));
    const repositories =
      origins.size === 1 && repositorySignatures.size === 1
        ? ((first.repositories as JsonRecord[] | undefined) ?? [])
        : [];
    mergedSkills.push({
      ...first,
      status: statuses.has("error") ? "error" : statuses.has("disabled") ? "disabled" : "available",
      origin: origins.size === 1 ? first.origin : "unknown",
      repositories,
    });
  }
  return mergedSkills;
}

function safeTimestamp(value: unknown, fallback: number): string {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return new Date(numeric).toISOString();
}

function opaque(domain: string, value: string): string {
  return createHash("sha256").update(`${domain}\0${value}`, "utf8").digest("hex").slice(0, 32);
}

async function invokeReadHandler(params: {
  handler: GatewayRequestHandler | undefined;
  method: string;
  requestParams?: JsonRecord;
  context: GatewayRequestContext;
  client: GatewayClient | null;
}): Promise<unknown> {
  if (!params.handler) {
    throw new Error(`missing internal handler: ${params.method}`);
  }
  const requestParams = params.requestParams ?? {};
  let response: { ok: boolean; payload?: unknown; message?: string } | undefined;
  await params.handler({
    req: {
      type: "req",
      id: `observability:${params.method}`,
      method: params.method,
      params: requestParams,
    },
    params: requestParams,
    client: params.client,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      response = { ok, payload, message: error?.message };
    },
    context: params.context,
  });
  if (!response?.ok) {
    throw new Error(response?.message ?? `${params.method} did not return a result`);
  }
  return response.payload;
}

function normalizeSkillState(skill: JsonRecord): "available" | "disabled" | "error" {
  if (
    skill.disabled === true ||
    skill.blockedByAllowlist === true ||
    skill.blockedByAgentFilter === true ||
    skill.platformIncompatible === true ||
    skill.eligible === false
  ) {
    return "disabled";
  }
  return skill.error ? "error" : "available";
}

function normalizeTaskOutcome(status: string): "success" | "error" | "running" {
  if (status === "failed" || status === "timed_out" || status === "cancelled") {
    return "error";
  }
  return status === "completed" ? "success" : "running";
}

function normalizeSessionOutcome(status: string): "success" | "error" | "running" {
  if (status === "failed" || status === "error" || status === "timed_out") {
    return "error";
  }
  if (status === "completed" || status === "closed" || status === "archived") {
    return "success";
  }
  return "running";
}

function buildActivityEvents(tasksResult: unknown, sessionsResult: unknown, capturedAtMs: number) {
  const events: JsonRecord[] = [];
  for (const task of records(tasksResult, "tasks")) {
    const taskId = safeText(task.taskId ?? task.id, "", 500);
    const agentId = safeText(task.agentId, "", 200);
    if (!taskId || !agentId) {
      continue;
    }
    const status = safeText(task.status, "running", 40).toLowerCase();
    const outcome = normalizeTaskOutcome(status);
    events.push({
      eventId: `openclaw:event:${opaque("openclaw-observability-task-v1", taskId)}`,
      eventKind: "task",
      agentId,
      occurredAt: safeTimestamp(task.endedAt ?? task.updatedAt ?? task.createdAt, capturedAtMs),
      trigger: safeText(task.kind ?? task.runtime, "task", 80),
      outcome,
      chatReference: opaque(
        "openclaw-observability-chat-v1",
        safeText(task.sessionKey, taskId, 500),
      ),
      evidenceCode: "OBS-OPENCLAW-TASKS-LIST",
      ...(outcome === "error"
        ? {
            errorCode: `OPENCLAW_TASK_${status.toUpperCase()}`,
            errorTitle: `OpenClaw task ${status.replaceAll("_", " ")}`,
          }
        : {}),
    });
  }
  for (const session of records(sessionsResult, "sessions")) {
    const sessionKey = safeText(session.key ?? session.sessionKey ?? session.id, "", 500);
    const agentId = safeText(session.agentId ?? asRecord(session.agentRuntime)?.agentId, "", 200);
    if (!sessionKey || !agentId) {
      continue;
    }
    const status = safeText(session.status ?? session.state, "active", 40).toLowerCase();
    const outcome = normalizeSessionOutcome(status);
    events.push({
      eventId: `openclaw:event:${opaque("openclaw-observability-session-v1", sessionKey)}`,
      eventKind: "session",
      agentId,
      occurredAt: safeTimestamp(session.updatedAt ?? session.createdAt, capturedAtMs),
      trigger: "session",
      outcome,
      chatReference: opaque("openclaw-observability-chat-v1", sessionKey),
      evidenceCode: "OBS-OPENCLAW-SESSIONS-LIST",
      ...(outcome === "error"
        ? {
            errorCode: `OPENCLAW_SESSION_${status.toUpperCase()}`,
            errorTitle: `OpenClaw session ${status.replaceAll("_", " ")}`,
          }
        : {}),
    });
  }
  return events
    .toSorted((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt)))
    .slice(0, MAX_ACTIVITY_EVENTS);
}

async function probeMcpServers(cfg: OpenClawConfig, capturedAt: string) {
  const configured = asRecord(cfg.mcp?.servers) ?? {};
  const enabledServers = Object.fromEntries(
    Object.entries(configured)
      .filter(([, value]) => asRecord(value)?.enabled !== false)
      .map(([name, value]) => [
        name,
        { ...asRecord(value), connectionTimeoutMs: MCP_PROBE_TIMEOUT_MS },
      ]),
  );
  let catalog: Awaited<
    ReturnType<ReturnType<typeof createSessionMcpRuntime>["getCatalog"]>
  > | null = null;
  if (Object.keys(enabledServers).length > 0) {
    const runtime = createSessionMcpRuntime({
      sessionId: "openclaw-observability-probe",
      workspaceDir: process.cwd(),
      cfg: { ...cfg, mcp: { ...cfg.mcp, servers: enabledServers } },
      manifestRegistry: { plugins: [] },
    });
    try {
      catalog = await runtime.getCatalog();
    } finally {
      await runtime.dispose();
    }
  }
  const failed = new Set((catalog?.diagnostics ?? []).map((item) => item.serverName));
  return Object.entries(configured)
    .map(([key, value]) => {
      const server = asRecord(value) ?? {};
      const disabled = server.enabled === false;
      const connected = Boolean(catalog?.servers[key]);
      const codex = asRecord(server.codex);
      return {
        key,
        name: safeText(server.name, key),
        status: disabled ? "disabled" : connected && !failed.has(key) ? "healthy" : "degraded",
        checkedAt: capturedAt,
        evidenceCode: disabled ? "OBS-OPENCLAW-MCP-DISABLED" : "OBS-OPENCLAW-MCP-PROBE",
        agentIds: safeStringArray(server.agentIds ?? server.agents ?? codex?.agents),
      };
    })
    .toSorted((left, right) => left.key.localeCompare(right.key));
}

async function buildSnapshot(context: GatewayRequestContext, client: GatewayClient | null) {
  const capturedAtMs = Date.now();
  const capturedAt = new Date(capturedAtMs).toISOString();
  const runtimeRepository = buildRuntimeRepository();
  const agentsResult = await invokeReadHandler({
    handler: agentsHandlers["agents.list"],
    method: "agents.list",
    context,
    client,
  });
  const agents = records(agentsResult, "agents")
    .map((agent) => ({
      id: safeText(agent.id ?? agent.agentId, "", 200),
      name: safeText(agent.name ?? agent.displayName, safeText(agent.id, "agent", 200)),
      status: agent.enabled === false ? "disabled" : "available",
      checkedAt: capturedAt,
      evidenceCode: "OBS-OPENCLAW-AGENTS-LIST",
    }))
    .filter((agent) => agent.id)
    .toSorted((left, right) => left.id.localeCompare(right.id));

  const skills: JsonRecord[] = [];
  const tools: JsonRecord[] = [];
  const relations: JsonRecord[] = [];
  for (const agent of agents) {
    const skillsResult = await invokeReadHandler({
      handler: skillsHandlers["skills.status"],
      method: "skills.status",
      requestParams: { agentId: agent.id },
      context,
      client,
    });
    for (const skill of records(skillsResult, "skills")) {
      const key = safeText(skill.skillKey ?? skill.key ?? skill.id ?? skill.name, "", 240);
      if (!key) {
        continue;
      }
      const definitionRepository = skillDefinitionRepository(skill, runtimeRepository.revision);
      skills.push({
        key,
        name: safeText(skill.name, key),
        status: normalizeSkillState(skill),
        origin: normalizeSkillOrigin(skill),
        repositories: definitionRepository ? [definitionRepository] : [],
        checkedAt: capturedAt,
        evidenceCode: "OBS-OPENCLAW-SKILLS-STATUS",
      });
      if (skill.eligible === true && normalizeSkillState(skill) === "available") {
        relations.push({ source: agent.id, target: key, kind: "loads_skill" });
      }
    }
    const toolsResult = await invokeReadHandler({
      handler: toolsCatalogHandlers["tools.catalog"],
      method: "tools.catalog",
      requestParams: { agentId: agent.id, includePlugins: true },
      context,
      client,
    });
    for (const group of records(toolsResult, "groups")) {
      for (const tool of records(group, "tools")) {
        const key = safeText(tool.id ?? tool.name, "", 240);
        if (!key) {
          continue;
        }
        tools.push({ key, name: safeText(tool.label ?? tool.name, key), status: "available" });
        relations.push({ source: agent.id, target: key, kind: "has_tool" });
      }
    }
  }

  const tasksResult = await invokeReadHandler({
    handler: tasksHandlers["tasks.list"],
    method: "tasks.list",
    requestParams: { limit: 500 },
    context,
    client,
  });
  const sessionsResult = await invokeReadHandler({
    handler: sessionsHandlers["sessions.list"],
    method: "sessions.list",
    requestParams: { limit: 500 },
    context,
    client,
  });
  const activityEvents = buildActivityEvents(tasksResult, sessionsResult, capturedAtMs);
  const coverage = agents.map((agent) => {
    const events = activityEvents.filter((event) => event.agentId === agent.id);
    return {
      agentId: agent.id,
      eventCount: events.length,
      lastEventAt: events[0]?.occurredAt ?? null,
      capturedAt,
      complete: true,
      evidenceCode: "OBS-OPENCLAW-ACTIVITY-COVERAGE",
    };
  });
  const mcpWithScopes = await probeMcpServers(context.getRuntimeConfig(), capturedAt);
  for (const server of mcpWithScopes) {
    for (const agentId of server.agentIds) {
      if (agents.some((agent) => agent.id === agentId)) {
        relations.push({ source: agentId, target: server.key, kind: "uses_mcp" });
      }
    }
  }
  const mcp = mcpWithScopes.map(({ agentIds: _agentIds, ...server }) => server);

  const uniqueBy = (values: JsonRecord[], key: string) => [
    ...new Map(values.map((value) => [String(value[key]), value])).values(),
  ];
  const uniqueSkills = mergeSkillInventory(skills).toSorted((a, b) =>
    String(a.key).localeCompare(String(b.key)),
  );
  const uniqueTools = uniqueBy(tools, "key").toSorted((a, b) =>
    String(a.key).localeCompare(String(b.key)),
  );
  const uniqueRelations = [
    ...new Map(
      relations.map((relation) => [
        `${String(relation.source)}\0${String(relation.target)}\0${String(relation.kind)}`,
        relation,
      ]),
    ).values(),
  ].toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const sourceCounts = {
    agents: agents.length,
    skills: uniqueSkills.length,
    tools: uniqueTools.length,
    mcp: mcp.length,
    activityEvents: activityEvents.length,
  };
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        agents,
        skills: uniqueSkills,
        tools: uniqueTools,
        mcp,
        sourceCounts,
        runtimeRepository,
      }),
    )
    .digest("hex");
  return {
    schemaVersion: 1,
    provenanceVersion: 2,
    complete: true,
    capturedAt,
    revision,
    sourceCounts,
    runtimeRepository,
    agents,
    skills: uniqueSkills,
    tools: uniqueTools,
    mcp,
    relations: uniqueRelations,
    activityEvents,
    activityCoverage: coverage,
  };
}

export const observabilityHandlers: GatewayRequestHandlers = {
  "observability.snapshot": async ({ params, respond, context, client }) => {
    if (Object.keys(params).length > 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "observability.snapshot does not accept params"),
      );
      return;
    }
    try {
      respond(true, await buildSnapshot(context, client), undefined);
    } catch (error) {
      context.logGateway.warn(
        `observability snapshot unavailable: ${error instanceof Error ? error.name : "error"}`,
      );
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "observability snapshot is incomplete"),
      );
    }
  },
};

export const testApi = {
  buildActivityEvents,
  buildRuntimeRepository,
  bundledSkillRepository,
  mergeSkillInventory,
  normalizeSessionOutcome,
  normalizeTaskOutcome,
  trackedSkillRepository,
};
