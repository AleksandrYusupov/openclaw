import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticSkillUsedEvent,
} from "../../infra/diagnostic-events.js";

const MAX_SKILL_ACTIVITY_EVENTS = 1_000;

export type ObservedSkillUsage = Pick<
  DiagnosticSkillUsedEvent,
  "agentId" | "runId" | "sessionId" | "sessionKey" | "skillName" | "ts" | "seq"
>;

const observedSkillUsage: ObservedSkillUsage[] = [];

// Keep only bounded, path-free runtime facts. Snapshot assembly never receives
// prompts, transcripts, skill files, or diagnostic private data.
onTrustedInternalDiagnosticEvent((event, metadata) => {
  if (!metadata.trusted || event.type !== "skill.used" || !event.agentId) {
    return;
  }
  observedSkillUsage.push({
    agentId: event.agentId,
    runId: event.runId,
    sessionId: event.sessionId,
    sessionKey: event.sessionKey,
    skillName: event.skillName,
    ts: event.ts,
    seq: event.seq,
  });
  if (observedSkillUsage.length > MAX_SKILL_ACTIVITY_EVENTS) {
    observedSkillUsage.splice(0, observedSkillUsage.length - MAX_SKILL_ACTIVITY_EVENTS);
  }
});

export function getObservedSkillUsage(): readonly ObservedSkillUsage[] {
  return observedSkillUsage;
}
