import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { TOOL_NAME_SEPARATOR } from "../../agents/agent-bundle-mcp-names.js";
import { createSessionMcpRuntime } from "../../agents/agent-bundle-mcp-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const MCP_PROBE_TIMEOUT_MS = 5_000;

export type ObservabilityMcpReasonCode =
  | "disabled"
  | "timeout"
  | "connection_failed"
  | "catalog_failed"
  | "runtime_diagnostic";

function safeMcpText(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 160);
}

function safeMcpStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export function normalizeObservabilityMcpReasonCode(message: string): ObservabilityMcpReasonCode {
  const normalized = message.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return "timeout";
  }
  if (
    normalized.includes("tools/list") ||
    normalized.includes("list tools") ||
    normalized.includes("catalog")
  ) {
    return "catalog_failed";
  }
  if (
    normalized.includes("connect") ||
    normalized.includes("transport") ||
    normalized.includes("closed") ||
    normalized.includes("start") ||
    normalized.includes("spawn")
  ) {
    return "connection_failed";
  }
  return "runtime_diagnostic";
}

export async function probeObservabilityMcpServers(cfg: OpenClawConfig, capturedAt: string) {
  const configured = asRecord(cfg.mcp?.servers) ?? {};
  const enabledServers = Object.fromEntries(
    Object.entries(configured)
      .filter(([, value]) => asRecord(value)?.enabled !== false)
      .map(([name, value]) => [
        name,
        Object.assign({}, asRecord(value), { connectionTimeoutMs: MCP_PROBE_TIMEOUT_MS }),
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
  const failureReasons = new Map<string, ObservabilityMcpReasonCode>();
  for (const diagnostic of catalog?.diagnostics ?? []) {
    failureReasons.set(
      diagnostic.serverName,
      normalizeObservabilityMcpReasonCode(diagnostic.message),
    );
  }
  const servers = Object.entries(configured)
    .map(([key, value]) => {
      const server = asRecord(value) ?? {};
      const disabled = server.enabled === false;
      const connected = Boolean(catalog?.servers[key]);
      const codex = asRecord(server.codex);
      const reasonCode = disabled
        ? "disabled"
        : (failureReasons.get(key) ?? (connected ? undefined : "connection_failed"));
      const observation = {
        key,
        name: safeMcpText(server.name, key),
        status: disabled ? "disabled" : reasonCode ? "degraded" : "healthy",
        lifecycleState: "current",
        accessState: disabled ? "disabled" : "available",
        checkedAt: capturedAt,
        evidenceCode: disabled ? "OBS-OPENCLAW-MCP-DISABLED" : "OBS-OPENCLAW-MCP-PROBE",
        agentIds: safeMcpStringArray(server.agentIds ?? server.agents ?? codex?.agents),
      };
      return reasonCode ? Object.assign(observation, { reasonCode }) : observation;
    })
    .toSorted((left, right) => left.key.localeCompare(right.key));
  const mcpKeyByToolPrefix = new Map<string, string>();
  for (const tool of catalog?.tools ?? []) {
    mcpKeyByToolPrefix.set(`${tool.safeServerName}${TOOL_NAME_SEPARATOR}`, tool.serverName);
  }
  return { servers, mcpKeyByToolPrefix };
}
