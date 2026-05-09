import path from "node:path";
import {
  buildCandidateDedupeKey,
  DEFAULT_CANDIDATE_CONFIDENCE_THRESHOLD,
  extractCandidateDraftsFromMessages,
  type CandidateDraft,
  type CandidateMessageRow,
} from "./candidate-extractor.js";
import { getSessionFiles, parseSessionFile, type ParsedSession } from "./session-parser.js";

export type CandidateSourceType = "correction" | "failure" | "tool_sequence" | "explicit_tag";

export interface ShadowCandidate {
  sessionId: string;
  messageId: string | null;
  project: string;
  tag: string;
  snippet: string;
  rationale: string;
  confidence: number;
  sourceType: CandidateSourceType;
  extractorRule: string;
  timestamp: string;
  evidenceCount: number;
}

export interface ShadowRuleCount {
  rule: string;
  count: number;
}

export interface CandidateShadowReport {
  filesScanned: number;
  sessionsScanned: number;
  rawCandidateCount: number;
  candidateCount: number;
  duplicateCount: number;
  duplicateRate: number;
  lowConfidenceCount: number;
  lowConfidenceRate: number;
  topRules: ShadowRuleCount[];
  errors: string[];
}

function toMessageRows(session: ParsedSession): CandidateMessageRow[] {
  return session.messages.map((message) => ({
    id: message.id,
    session_id: session.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    tool_calls: message.toolCalls ?? [],
    project: session.project,
  }));
}

function toShadowCandidate(draft: CandidateDraft): ShadowCandidate {
  return { ...draft };
}

export function extractShadowCandidatesFromSession(session: ParsedSession): ShadowCandidate[] {
  return extractCandidateDraftsFromMessages(toMessageRows(session)).map(toShadowCandidate);
}

export function buildCandidateShadowReport(
  sessionsDir: string,
  options: { confidenceThreshold?: number } = {},
): CandidateShadowReport {
  const files = getSessionFiles(sessionsDir);
  const errors: string[] = [];
  const confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CANDIDATE_CONFIDENCE_THRESHOLD;

  const seen = new Set<string>();
  const ruleCounts = new Map<string, number>();

  let sessionsScanned = 0;
  let rawCandidateCount = 0;
  let candidateCount = 0;
  let duplicateCount = 0;
  let lowConfidenceCount = 0;

  for (const file of files) {
    try {
      const session = parseSessionFile(file);
      if (!session) {
        errors.push(`Failed to parse: ${path.basename(file)}`);
        continue;
      }

      sessionsScanned++;
      const candidates = extractShadowCandidatesFromSession(session);
      rawCandidateCount += candidates.length;

      for (const candidate of candidates) {
        const dedupeKey = buildCandidateDedupeKey(
          candidate.sessionId,
          candidate.messageId,
          candidate.tag,
          candidate.extractorRule,
          candidate.snippet,
        );

        if (seen.has(dedupeKey)) {
          duplicateCount++;
          continue;
        }

        seen.add(dedupeKey);
        candidateCount++;

        if (candidate.confidence < confidenceThreshold) {
          lowConfidenceCount++;
        }

        ruleCounts.set(candidate.extractorRule, (ruleCounts.get(candidate.extractorRule) ?? 0) + 1);
      }
    } catch (err) {
      errors.push(`Error scanning ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const topRules = Array.from(ruleCounts.entries())
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    filesScanned: files.length,
    sessionsScanned,
    rawCandidateCount,
    candidateCount,
    duplicateCount,
    duplicateRate: rawCandidateCount > 0 ? duplicateCount / rawCandidateCount : 0,
    lowConfidenceCount,
    lowConfidenceRate: candidateCount > 0 ? lowConfidenceCount / candidateCount : 0,
    topRules,
    errors,
  };
}
