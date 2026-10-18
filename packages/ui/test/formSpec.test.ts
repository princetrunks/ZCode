// Sando: ```form blocks (same contract as the Planner). Run: pnpm exec tsx --test packages/ui/test/formSpec.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  composeFormAnswer,
  formKey,
  isFormLanguage,
  missingRequired,
  parseFormSpec,
} from "../src/lib/formSpec.js";

test("rejects bad JSON and empty field lists", () => {
  const bad = parseFormSpec("{nope");
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /not valid JSON/);
  assert.equal(parseFormSpec('{"fields":[]}').ok, false);
  assert.equal(parseFormSpec('{"fields":[{"type":"text"}]}').ok, false);
});

test("normalises fields: inferred types, de-duplicated ids, scale bounds", () => {
  const parsed = parseFormSpec(
    JSON.stringify({
      title: "Status",
      fields: [
        { id: "a", label: "Deploy?", type: "yesno", required: true },
        { label: "Pick", options: ["x", { value: "y", label: "Why" }] },
        { id: "a", label: "Dup id", type: "multi", options: [] },
        { label: "Rate", type: "scale", min: 1, max: 99 },
        { type: "text" },
      ],
    }),
  );
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const { form } = parsed;
  assert.equal(form.fields.length, 4); // unlabeled dropped
  assert.equal(form.fields[1].type, "choice"); // inferred from options
  assert.equal(form.fields[1].options?.[1].label, "Why");
  assert.equal(form.fields[2].type, "text"); // multi with no options falls back
  assert.notEqual(form.fields[2].id, "a"); // de-duplicated
  assert.deepEqual([form.fields[3].min, form.fields[3].max], [1, 5]);
  assert.equal(form.submit, "Send answers");
});

test("a bare array is a field list; question works as label", () => {
  const parsed = parseFormSpec(JSON.stringify([{ question: "Ship it?", type: "yesno" }]));
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.equal(parsed.form.title, "Questions");
    assert.equal(parsed.form.fields[0].label, "Ship it?");
  }
});

test("composes the answer message the model reads", () => {
  const parsed = parseFormSpec(
    JSON.stringify({
      title: "Status",
      fields: [
        { id: "a", label: "Deploy?", type: "yesno", required: true },
        { label: "Pick", options: ["x", "y"] },
        { id: "m", label: "Targets", type: "multi", options: ["web", "cli"] },
        { label: "Rate", type: "scale" },
      ],
    }),
  );
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const { form } = parsed;
  assert.deepEqual(missingRequired(form, {}), ["Deploy?"]);
  assert.deepEqual(missingRequired(form, { a: "Yes" }), []);
  const text = composeFormAnswer(form, { a: "Yes", q2: "y", m: ["web", "cli"] });
  assert.match(text, /^Form answers: Status\n/);
  assert.match(text, /- Deploy\?: Yes/);
  assert.match(text, /- Targets: web, cli/);
  assert.match(text, /- Rate: \(skipped\)/);
  assert.match(
    text,
    /\n\nanswers-json: \{"form":"Status","answers":\{"a":"Yes","q2":"y","m":\["web","cli"\]\}\}$/,
  );
});

test("form keys are stable and scoped", () => {
  assert.equal(formKey("abc"), formKey("abc"));
  assert.notEqual(formKey("abc"), formKey("abd"));
  assert.notEqual(formKey("abc", "s1"), formKey("abc", "s2"));
  assert.match(formKey("abc"), /^sando-form:/);
});

test("only the form fence language renders as a form", () => {
  assert.equal(isFormLanguage("form"), true);
  assert.equal(isFormLanguage(" FORM "), true);
  assert.equal(isFormLanguage("json"), false);
  assert.equal(isFormLanguage(undefined), false);
});
