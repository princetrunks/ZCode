// ============================================================
// Sando: which files a child changed (SANDO-SUBAGENTS.md)
// ============================================================
// Collected live from the child's event sink: child ToolCallResult events are appended to the store and
// are not reliably in the child's TurnResult.events. A path is recorded when a write tool is scheduled
// and kept only once that call returns a result, so refused or failed writes are not listed. Bash edits
// are invisible here by design (documented limit).

import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { isAbsolute, relative } from "node:path";

const WRITE_TOOL_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path", "file_path"],
};

export interface FilesTouchedCollector {
  observe(event: SessionEvent): void;
  /** Workspace-relative where possible, in first-touched order, no duplicates. */
  list(): string[];
}

export function createFilesTouchedCollector(workspaceRoot: string): FilesTouchedCollector {
  const pendingPathByToolCallId = new Map<string, string>();
  const touched = new Set<string>();

  return {
    observe(event) {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload || typeof payload !== "object") return;
      if (event.type === SessionEventType.ToolCallScheduled) {
        const fields = WRITE_TOOL_PATH_FIELDS[String(payload.toolName)];
        const input = payload.input as Record<string, unknown> | undefined;
        if (!fields || !input || typeof input !== "object") return;
        const path = fields.map((field) => input[field]).find((v) => typeof v === "string" && v);
        if (typeof path === "string") {
          pendingPathByToolCallId.set(String(payload.toolCallId), path);
        }
        return;
      }
      if (event.type === SessionEventType.ToolCallResult) {
        const id = String(payload.toolCallId);
        const path = pendingPathByToolCallId.get(id);
        if (path === undefined) return;
        pendingPathByToolCallId.delete(id);
        const result = payload.result as { success?: unknown } | undefined;
        if (result?.success === false) return;
        touched.add(displayPath(workspaceRoot, path));
        return;
      }
      if (event.type === SessionEventType.ToolCallError) {
        pendingPathByToolCallId.delete(String(payload.toolCallId));
      }
    },
    list: () => [...touched],
  };
}

function displayPath(workspaceRoot: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(workspaceRoot, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}
