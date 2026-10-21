// Sando: per-session pending indicator — CLI facts, summary wire shape, row / header state and labels.
// Run: pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/sessionPendingIndicator.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveSessionPendingFacts,
  textHasFormBlock,
} from "../../shared/src/zcode-protocol-v4/sessions-index-pending.ts";
import { sessionSummarySchema } from "../../shared/src/zcode-protocol-v4/sessions-index.ts";
import type { ConversationSnapshot } from "../../shared/src/zcode-protocol-v4/snapshot.ts";
import { SessionsIndexProjection } from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-projection.ts";
import {
  describeSessionPending,
  deriveSessionPendingState,
  EMPTY_SESSION_PENDING_STATE,
} from "../src/lib/sessionPendingIndicator.ts";
import { deriveTaskLeadingIndicator } from "../src/lib/taskListItemPresentation.ts";
import { mapSessionSummaryToTaskMeta } from "../src/v4/mapSessionSummaryToTaskMeta.ts";
import { getTaskListRowActivity } from "../src/v4/taskListRowActivity.ts";
import { sessionPendingStateFromSummary } from "../src/v4/useSessionPendingState.ts";
import enUS from "../src/i18n/locales/en-US.ts";
import zhCN from "../src/i18n/locales/zh-CN.ts";

type Row = ConversationSnapshot["rows"]["window"][number];

let nextRowId = 1;
function userRow(text = "hi"): Row {
  return { rowId: nextRowId++, turnId: "t", kind: "userInput", text, origin: "realUser" } as Row;
}
function assistantRow(text: string, state = "complete"): Row {
  return { rowId: nextRowId++, turnId: "t", kind: "assistantText", text, state } as Row;
}
function toolRow(): Row {
  return { rowId: nextRowId++, turnId: "t", kind: "toolCall" } as unknown as Row;
}
function queueItem(state: "queued" | "reserved" | "promoting") {
  return { dispatch: { state } };
}

function snapshot(over: {
  phase?: string;
  rows?: Row[];
  queue?: Array<ReturnType<typeof queueItem>>;
  autoDrain?: boolean;
  running?: number;
  backgroundSubagents?: number;
  noSubagentsField?: boolean;
}): ConversationSnapshot {
  return {
    sessionId: "s1",
    control: { phase: over.phase ?? "completedSuccess", sessionEnded: true },
    meta: { title: "Task", titleSource: "default" },
    queue: { items: over.queue ?? [], autoDrain: over.autoDrain ?? true },
    pendingInteractions: [],
    backgroundWorks: Array.from({ length: over.backgroundSubagents ?? 0 }, (_, i) => ({
      workId: `w${i}`,
      kind: "subagent",
      status: "running",
      title: "child",
      startedAt: 1,
      anchorRowId: null,
    })),
    ...(over.noSubagentsField
      ? {}
      : {
          subagents: {
            revision: 1,
            childSessionIds: [],
            running: Array.from({ length: over.running ?? 0 }, (_, i) => ({
              childSessionId: `c${i}`,
              subagentType: "worker",
              title: "child",
              status: "running",
            })),
            endedTotal: 0,
          },
        }),
    goal: null,
    rows: { window: over.rows ?? [], totalCount: 0, firstRowId: null },
  } as unknown as ConversationSnapshot;
}

const FORM =
  'Pick one:\n\n```form\n{"title":"T","fields":[{"id":"a","label":"A","type":"yesno"}]}\n```\n';

test("form fence detection matches the workbench's isFormLanguage rule", () => {
  assert.equal(textHasFormBlock(FORM), true);
  assert.equal(textHasFormBlock("~~~ form\n{}\n~~~"), true);
  assert.equal(textHasFormBlock("```FORM\n{}\n```"), true);
  assert.equal(textHasFormBlock("```json\n{}\n```"), false);
  assert.equal(textHasFormBlock("```formula\nx\n```"), false);
  assert.equal(textHasFormBlock("we use a ```form block sometimes"), false);
});

test("awaitingForm: last finished reply with a form and nothing from the user after it", () => {
  assert.equal(
    deriveSessionPendingFacts(snapshot({ rows: [userRow(), assistantRow(FORM)] })).awaitingForm,
    true,
  );
  // tool rows after the reply do not hide it
  assert.equal(
    deriveSessionPendingFacts(snapshot({ rows: [userRow(), assistantRow(FORM), toolRow()] }))
      .awaitingForm,
    true,
  );
  // answered (the answers arrive as the next user message)
  assert.equal(
    deriveSessionPendingFacts(snapshot({ rows: [assistantRow(FORM), userRow("Form answers: T")] }))
      .awaitingForm,
    false,
  );
  // a later reply without a form supersedes it
  assert.equal(
    deriveSessionPendingFacts(snapshot({ rows: [assistantRow(FORM), assistantRow("done")] }))
      .awaitingForm,
    false,
  );
  // still streaming / turn running → not waiting yet
  assert.equal(
    deriveSessionPendingFacts(snapshot({ rows: [assistantRow(FORM, "streaming")] })).awaitingForm,
    false,
  );
  assert.equal(
    deriveSessionPendingFacts(snapshot({ phase: "running", rows: [assistantRow(FORM)] }))
      .awaitingForm,
    false,
  );
  assert.equal(deriveSessionPendingFacts(snapshot({ rows: [] })).awaitingForm, false);
});

test("queue and sub-agent counts", () => {
  const facts = deriveSessionPendingFacts(
    snapshot({
      queue: [queueItem("queued"), queueItem("reserved"), queueItem("promoting")],
      running: 2,
    }),
  );
  assert.equal(facts.queuedCount, 2, "promoting is already becoming the next turn");
  assert.equal(facts.queuePaused, false);
  assert.equal(facts.runningSubagentCount, 2);
  const paused = deriveSessionPendingFacts(
    snapshot({ queue: [queueItem("queued")], autoDrain: false }),
  );
  assert.equal(paused.queuePaused, true);
  assert.equal(deriveSessionPendingFacts(snapshot({ autoDrain: false })).queuePaused, false);
  // old snapshots without `subagents` fall back to running background subagent works
  assert.equal(
    deriveSessionPendingFacts(snapshot({ noSubagentsField: true, backgroundSubagents: 3 }))
      .runningSubagentCount,
    3,
  );
});

test("summary wire: new fields are optional (old frames parse) and round-trip", () => {
  const base = {
    sessionId: "s1",
    workspaceId: "w",
    title: "x",
    phase: "running",
    sessionEnded: false,
    hasBackgroundWork: false,
    lastActivityAt: 1,
    createdAt: 1,
  };
  assert.equal(sessionSummarySchema.safeParse(base).success, true);
  const full = {
    ...base,
    queuedCount: 2,
    queuePaused: true,
    runningSubagentCount: 1,
    awaitingForm: true,
  };
  assert.deepEqual(sessionSummarySchema.parse(full), full);
  assert.equal(sessionSummarySchema.safeParse({ ...base, queuedCount: -1 }).success, false);
});

test("CLI projection: counts land in the summary and a change emits exactly one upsert", () => {
  const projection = new SessionsIndexProjection("w", "e");
  const extra = { createdAt: 1, lastActivityAt: 2 };
  const first = projection.upsertFromConversation(
    snapshot({ phase: "running", queue: [queueItem("queued")] }),
    extra,
  );
  assert.equal(first.length, 1);
  const s1 = (first[0] as { session: Record<string, unknown> }).session;
  assert.equal(s1.queuedCount, 1);
  assert.equal("runningSubagentCount" in s1, false, "zero counts stay absent on the wire");
  // same facts → conflated
  assert.equal(
    projection.upsertFromConversation(
      snapshot({ phase: "running", queue: [queueItem("queued")] }),
      extra,
    ).length,
    0,
  );
  // queue drained, a child started → one upsert
  const next = projection.upsertFromConversation(snapshot({ phase: "running", running: 1 }), extra);
  assert.equal(next.length, 1);
  const s2 = (next[0] as { session: Record<string, unknown> }).session;
  assert.equal("queuedCount" in s2, false);
  assert.equal(s2.runningSubagentCount, 1);
  // turn ends on a form → awaitingForm
  const done = projection.upsertFromConversation(
    snapshot({ rows: [userRow(), assistantRow(FORM)] }),
    extra,
  );
  assert.equal((done[0] as { session: Record<string, unknown> }).session.awaitingForm, true);
});

function summary(over: Record<string, unknown>) {
  return sessionSummarySchema.parse({
    sessionId: "s1",
    workspaceId: "w",
    title: "x",
    phase: "completedSuccess",
    sessionEnded: true,
    hasBackgroundWork: false,
    lastActivityAt: 1,
    createdAt: 1,
    ...over,
  });
}

test("summary → row activity sidecar → pending state", () => {
  const task = mapSessionSummaryToTaskMeta(
    summary({ phase: "running", queuedCount: 3, runningSubagentCount: 2 }),
    { workspacePath: "/w" },
  );
  const activity = getTaskListRowActivity(task);
  assert.equal(activity?.queuedCount, 3);
  assert.equal(activity?.runningSubagentCount, 2);
  const state = deriveSessionPendingState(task, activity);
  assert.deepEqual(state, {
    running: true,
    waiting: null,
    queued: 3,
    queuePaused: false,
    agents: 2,
    unread: false,
  });
});

test("waiting priority: approval / question beat form; form never shows while running", () => {
  const withPermission = mapSessionSummaryToTaskMeta(
    summary({
      phase: "running",
      pendingInteraction: { interactionId: "i", kind: "permission" },
      pendingInteractionSummary: { permissionCount: 1, userInputCount: 0 },
    }),
    { workspacePath: "/w" },
  );
  assert.equal(
    deriveSessionPendingState(withPermission, getTaskListRowActivity(withPermission)).waiting,
    "permission",
  );
  assert.equal(
    deriveTaskLeadingIndicator(withPermission, getTaskListRowActivity(withPermission)),
    "waiting",
  );

  const form = mapSessionSummaryToTaskMeta(summary({ awaitingForm: true }), {
    workspacePath: "/w",
  });
  assert.equal(deriveSessionPendingState(form, getTaskListRowActivity(form)).waiting, "form");
  // waiting beats unread in the leading slot
  const formUnread = { ...form, unreadAt: 5 };
  assert.equal(deriveTaskLeadingIndicator(formUnread, getTaskListRowActivity(form)), "waiting");

  const runningForm = mapSessionSummaryToTaskMeta(
    summary({ phase: "running", awaitingForm: true }),
    {
      workspacePath: "/w",
    },
  );
  assert.equal(
    deriveSessionPendingState(runningForm, getTaskListRowActivity(runningForm)).waiting,
    null,
  );
  assert.equal(
    deriveTaskLeadingIndicator(runningForm, getTaskListRowActivity(runningForm)),
    "loading",
  );
});

test("leading slot keeps upstream order otherwise: error > unread > loading > none", () => {
  const errored = mapSessionSummaryToTaskMeta(summary({ phase: "error", awaitingForm: true }), {
    workspacePath: "/w",
  });
  assert.equal(deriveTaskLeadingIndicator(errored, getTaskListRowActivity(errored)), "error");
  const plain = mapSessionSummaryToTaskMeta(summary({}), { workspacePath: "/w" });
  assert.equal(
    deriveTaskLeadingIndicator({ ...plain, unreadAt: 1 }, getTaskListRowActivity(plain)),
    "unread",
  );
  assert.equal(deriveTaskLeadingIndicator(plain, getTaskListRowActivity(plain)), "none");
  assert.equal(deriveTaskLeadingIndicator(plain, null), "none");
});

const fmt =
  (dict: Record<string, string>) =>
  (id: string, values?: Record<string, string>): string => {
    const template = dict[id];
    assert.ok(template, `missing string ${id}`);
    return template.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? `{${key}}`);
  };

test("labels: header sentence, singular / plural, paused, unread only in lists", () => {
  const state = {
    running: true,
    waiting: null,
    queued: 2,
    queuePaused: false,
    agents: 1,
    unread: true,
  } as const;
  assert.equal(
    describeSessionPending(state, fmt(enUS)).join(" · "),
    "Working… · 2 queued messages · 1 sub-agent running · New reply",
  );
  assert.equal(
    describeSessionPending(state, fmt(enUS), { includeUnread: false }).join(" · "),
    "Working… · 2 queued messages · 1 sub-agent running",
  );
  assert.deepEqual(
    describeSessionPending(
      { ...EMPTY_SESSION_PENDING_STATE, waiting: "form", queued: 1, queuePaused: true },
      fmt(enUS),
    ),
    ["Waiting for your form answers", "1 queued (paused)"],
  );
  assert.deepEqual(describeSessionPending(EMPTY_SESSION_PENDING_STATE, fmt(enUS)), []);
  // every key exists in zh-CN too
  for (const waiting of ["permission", "userInput", "form"] as const) {
    describeSessionPending({ ...state, waiting, agents: 3, queued: 1 }, fmt(zhCN));
    describeSessionPending(
      { ...state, waiting, agents: 1, queued: 4, queuePaused: true },
      fmt(zhCN),
    );
  }
});

test("header state from a summary ignores unread and tolerates a missing session", () => {
  assert.deepEqual(sessionPendingStateFromSummary(undefined), EMPTY_SESSION_PENDING_STATE);
  assert.deepEqual(
    sessionPendingStateFromSummary(summary({ phase: "running", runningSubagentCount: 2 })),
    {
      running: true,
      waiting: null,
      queued: 0,
      queuePaused: false,
      agents: 2,
      unread: false,
    },
  );
});
