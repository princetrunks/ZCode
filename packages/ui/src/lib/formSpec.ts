// Sando (ShrineTech): ```form blocks — answerable questions inside an assistant reply (2026-10-18).
// Same contract as the Planner (Project_Planner client/src/lib/formSpec.js); ported, not imported.
// Pure helpers (no DOM): parse the JSON spec and turn the answers into the plain-text message that goes back to
// the model. components/ai-elements/form-block.tsx draws the controls.
//
// Spec (JSON inside the fence):
//   { "title": "Status check", "intro": "…", "submit": "Send answers",
//     "fields": [ { "id": "deploy", "label": "Deploy now?", "type": "choice", "options": ["Yes", "Not yet"], "note": "…" },
//                 { "id": "x", "label": "…", "type": "multi" | "yesno" | "scale" | "text", "options": [...],
//                   "min": 1, "max": 5, "placeholder": "…", "required": true, "other": true, "multiline": true } ] }
// choice / multi accept options as strings or {value, label}. "other": true adds a free-text "Other" box.

export type FormFieldType = "choice" | "multi" | "yesno" | "scale" | "text";

export const FORM_TYPES: ReadonlySet<string> = new Set([
  "choice",
  "multi",
  "yesno",
  "scale",
  "text",
]);

export interface FormOption {
  value: string;
  label: string;
}

export interface FormField {
  id: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  note?: string;
  options?: FormOption[];
  other?: boolean;
  min?: number;
  max?: number;
  placeholder?: string;
  multiline?: boolean;
}

export interface FormSpec {
  id: string;
  title: string;
  intro: string;
  submit: string;
  fields: FormField[];
}

export type FormAnswerValue = string | string[];
export type FormAnswers = Record<string, FormAnswerValue | undefined>;

export type ParseFormResult = { ok: true; form: FormSpec } | { ok: false; error: string };

function normOption(o: unknown): FormOption | null {
  if (o && typeof o === "object") {
    const rec = o as { value?: unknown; label?: unknown };
    const value = String(rec.value ?? rec.label ?? "").trim();
    return value ? { value, label: String(rec.label ?? value) } : null;
  }
  const value = String(o ?? "").trim();
  return value ? { value, label: value } : null;
}

/** Tolerates a missing type (choice when options exist, else text) and a bare array of fields. */
export function parseFormSpec(src: string): ParseFormResult {
  let raw: unknown;
  try {
    raw = JSON.parse(String(src || ""));
  } catch (e) {
    return { ok: false, error: `not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  if (Array.isArray(raw)) raw = { fields: raw };
  const spec = raw as {
    id?: unknown;
    title?: unknown;
    intro?: unknown;
    submit?: unknown;
    fields?: unknown;
  };
  if (!spec || typeof spec !== "object" || !Array.isArray(spec.fields) || !spec.fields.length) {
    return { ok: false, error: 'needs a "fields" list' };
  }
  const seen = new Set<string>();
  const fields: FormField[] = [];
  (spec.fields as unknown[]).forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const f = item as Record<string, unknown>;
    const label = String(f.label ?? f.question ?? "").trim();
    if (!label) return;
    let id = String(f.id ?? "").trim() || `q${i + 1}`;
    while (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    const options = (Array.isArray(f.options) ? f.options : [])
      .map(normOption)
      .filter((o): o is FormOption => o !== null);
    let type = String(f.type || "").toLowerCase();
    if (!FORM_TYPES.has(type)) type = options.length ? "choice" : "text";
    if ((type === "choice" || type === "multi") && !options.length) type = "text";
    const field: FormField = { id, label, type: type as FormFieldType, required: !!f.required };
    if (f.note) field.note = String(f.note);
    if (type === "choice" || type === "multi") {
      field.options = options;
      field.other = !!f.other;
    }
    if (type === "scale") {
      const min = Number(f.min);
      const max = Number(f.max);
      field.min = f.min != null && Number.isFinite(min) ? Math.round(min) : 1;
      field.max = f.max != null && Number.isFinite(max) ? Math.round(max) : 5;
      if (field.max <= field.min || field.max - field.min > 10) {
        field.min = 1;
        field.max = 5;
      }
    }
    if (type === "text") {
      field.placeholder = String(f.placeholder || "");
      field.multiline = !!f.multiline;
    }
    fields.push(field);
  });
  if (!fields.length) return { ok: false, error: "no field has a label" };
  return {
    ok: true,
    form: {
      id: String(spec.id || ""),
      title: String(spec.title || "Questions"),
      intro: spec.intro ? String(spec.intro) : "",
      submit: String(spec.submit || "Send answers"),
      fields,
    },
  };
}

function isEmpty(v: FormAnswerValue | undefined): boolean {
  return v == null || v === "" || (Array.isArray(v) && !v.length);
}

/** Labels of required fields with no answer. */
export function missingRequired(form: FormSpec, answers: FormAnswers): string[] {
  return form.fields.filter((f) => f.required && isEmpty(answers[f.id])).map((f) => f.label);
}

/**
 * The message the model reads. Skipped questions are listed as skipped, so the model does not take
 * silence for a yes. A trailing JSON line carries the exact answers for tools that want them.
 */
export function composeFormAnswer(form: FormSpec, answers: FormAnswers): string {
  const lines = [`Form answers: ${form.title}`];
  const exact: Record<string, FormAnswerValue> = {};
  for (const f of form.fields) {
    const v = answers[f.id];
    if (v === undefined || isEmpty(v)) {
      lines.push(`- ${f.label}: (skipped)`);
      continue;
    }
    exact[f.id] = v;
    lines.push(`- ${f.label}: ${Array.isArray(v) ? v.join(", ") : v}`);
  }
  lines.push(
    "",
    `answers-json: ${JSON.stringify({ form: form.id || form.title, answers: exact })}`,
  );
  return lines.join("\n");
}

/** Stable short key for "this form was already answered" (localStorage). `scope` is the session id when known. */
export function formKey(src: string, scope = ""): string {
  let h = 5381;
  const s = `${scope}\n${String(src || "")}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `sando-form:${(h >>> 0).toString(36)}`;
}

/** Fence languages that render as a form. */
export function isFormLanguage(language: string | undefined): boolean {
  return (language ?? "").trim().toLowerCase() === "form";
}

/** Name of the bubbling DOM event a submitted form dispatches; SessionPane listens for it and sends the text. */
export const FORM_SUBMIT_EVENT = "sando-form-submit";

export interface FormSubmitDetail {
  text: string;
  answers: FormAnswers;
  formId: string;
  /** Set by the listener: resolves true once the message was accepted (sent or queued). */
  accept?: (result: Promise<boolean>) => void;
}
