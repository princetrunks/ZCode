"use client";

// Sando (ShrineTech): ```form blocks — the model asks several decisions at once and the user answers with chips and
// boxes instead of typing (2026-10-18; same contract as the Planner's Chat / Dive In / Lily forms).
//
// Submit dispatches a bubbling `sando-form-submit` DOM event. SessionPane listens on its own root and sends the composed
// text as the next user message (queued when a turn is running); it hands back a promise through `detail.accept`, and
// the form locks as "Sent" only once that resolves true. Answered state is kept in localStorage per session + source,
// so a re-render or reload shows it as sent. Surfaces with no listener (share view, previews) say so instead of
// pretending to send.

import { CheckIcon, PencilIcon } from "lucide-react";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  FORM_SUBMIT_EVENT,
  composeFormAnswer,
  formKey,
  missingRequired,
  parseFormSpec,
  type FormAnswerValue,
  type FormAnswers,
  type FormField,
  type FormSubmitDetail,
} from "@/lib/formSpec.js";

interface SavedFormState {
  at: number;
  answers: FormAnswers;
}

function readSaved(key: string): SavedFormState | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "null") as SavedFormState | null;
    return raw && typeof raw.at === "number" && raw.answers ? raw : null;
  } catch {
    return null;
  }
}

function writeSaved(key: string, state: SavedFormState): void {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // private mode / quota: the form still sends, it just will not remember
  }
}

const chipClassName =
  "inline-flex min-h-8 items-center gap-1 rounded-full border px-3 py-1 text-ui-sm transition-colors outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-70 " +
  "max-md:min-h-11 max-md:px-4";
const chipOffClassName = "border-border bg-background text-foreground hover:bg-hover";
const chipOnClassName = "border-primary bg-primary text-primary-foreground";
const textInputClassName =
  "w-full min-w-0 rounded-md border border-input-border bg-input px-2.5 py-1.5 text-ui-base text-foreground " +
  "outline-none placeholder:text-foreground-subtlest focus-visible:border-input-border-focused disabled:opacity-70 " +
  "max-md:min-h-11 max-md:text-[16px]";

interface FieldProps {
  field: FormField;
  value: FormAnswerValue | undefined;
  disabled: boolean;
  inputId: string;
  onChange: (value: FormAnswerValue) => void;
}

function stopEnter(event: KeyboardEvent<HTMLInputElement>) {
  // Enter in a one-line box must not submit the whole form (or reach the composer's shortcuts).
  event.stopPropagation();
  if (event.key === "Enter") event.preventDefault();
}

function FormFieldControl({ field, value, disabled, inputId, onChange }: FieldProps) {
  const { intl } = useZCodeIntl();
  if (field.type === "text") {
    const text = typeof value === "string" ? value : "";
    return field.multiline ? (
      <textarea
        id={inputId}
        className={cn(textInputClassName, "resize-y")}
        rows={3}
        placeholder={field.placeholder}
        value={text}
        disabled={disabled}
        onKeyDown={(event) => event.stopPropagation()}
        onChange={(event) => onChange(event.target.value)}
      />
    ) : (
      <input
        id={inputId}
        type="text"
        className={textInputClassName}
        placeholder={field.placeholder}
        value={text}
        disabled={disabled}
        onKeyDown={stopEnter}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  const yes = intl.formatMessage({ id: "sando.form.yes" });
  const no = intl.formatMessage({ id: "sando.form.no" });
  let choices: { value: string; label: string }[];
  if (field.type === "yesno") {
    // The value stays English so the model always reads Yes / No, whatever the UI language.
    choices = [
      { value: "Yes", label: yes },
      { value: "No", label: no },
    ];
  } else if (field.type === "scale") {
    choices = [];
    for (let n = field.min ?? 1; n <= (field.max ?? 5); n++) {
      choices.push({ value: String(n), label: String(n) });
    }
  } else {
    choices = field.options ?? [];
  }
  const multi = field.type === "multi";
  const known = new Set(choices.map((c) => c.value));
  const selected: string[] = multi
    ? Array.isArray(value)
      ? value
      : []
    : typeof value === "string" && value
      ? [value]
      : [];
  const otherText = selected.find((v) => !known.has(v)) ?? "";

  return (
    <>
      <div className="flex flex-wrap gap-1.5" role={multi ? "group" : "radiogroup"}>
        {choices.map((choice) => {
          const on = selected.includes(choice.value);
          return (
            <button
              key={choice.value}
              type="button"
              role={multi ? "checkbox" : "radio"}
              aria-checked={on}
              disabled={disabled}
              className={cn(chipClassName, on ? chipOnClassName : chipOffClassName)}
              onClick={() => {
                if (multi) {
                  onChange(
                    on ? selected.filter((v) => v !== choice.value) : [...selected, choice.value],
                  );
                } else {
                  onChange(on ? "" : choice.value);
                }
              }}
            >
              {multi && on ? <CheckIcon className="size-3.5" aria-hidden /> : null}
              {choice.label}
            </button>
          );
        })}
      </div>
      {field.other ? (
        <input
          id={inputId}
          type="text"
          className={cn(textInputClassName, "mt-2")}
          placeholder={intl.formatMessage({ id: "sando.form.other" })}
          value={otherText}
          disabled={disabled}
          onKeyDown={stopEnter}
          onChange={(event) => {
            const typed = event.target.value;
            if (multi) {
              onChange([...selected.filter((v) => known.has(v)), ...(typed ? [typed] : [])]);
            } else {
              onChange(typed);
            }
          }}
        />
      ) : null}
    </>
  );
}

function trimAnswers(answers: FormAnswers): FormAnswers {
  const out: FormAnswers = {};
  for (const [id, v] of Object.entries(answers)) {
    if (Array.isArray(v)) out[id] = v.map((x) => x.trim()).filter(Boolean);
    else if (typeof v === "string") out[id] = v.trim();
  }
  return out;
}

export interface FormBlockProps {
  /** JSON source inside the ```form fence. */
  code: string;
  /** Session the reply belongs to; scopes the "answered" memory. */
  scope?: string;
  /** Rendered instead when the spec does not parse. */
  fallback: ReactNode;
}

export function FormBlock({ code, scope, fallback }: FormBlockProps) {
  const { intl } = useZCodeIntl();
  const parsed = useMemo(() => parseFormSpec(code), [code]);
  const key = useMemo(() => formKey(code, scope ?? ""), [code, scope]);
  const rootRef = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState<SavedFormState | null>(() => readSaved(key));
  const [answers, setAnswers] = useState<FormAnswers>(() => saved?.answers ?? {});
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const [warning, setWarning] = useState("");
  const uid = useMemo(() => `${key.slice(11)}-${Math.random().toString(36).slice(2, 6)}`, [key]);

  const locked = (saved !== null && !editing) || sending;

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!parsed.ok || sending) return;
      const clean = trimAnswers(answers);
      const missing = missingRequired(parsed.form, clean);
      if (missing.length) {
        setWarning(
          intl.formatMessage({ id: "sando.form.missing" }, { fields: missing.join(", ") }),
        );
        return;
      }
      let result: Promise<boolean> | null = null;
      const detail: FormSubmitDetail = {
        text: composeFormAnswer(parsed.form, clean),
        answers: clean,
        formId: parsed.form.id || parsed.form.title,
        accept: (r) => {
          result = r;
        },
      };
      const evt = new CustomEvent<FormSubmitDetail>(FORM_SUBMIT_EVENT, {
        bubbles: true,
        cancelable: true,
        detail,
      });
      rootRef.current?.dispatchEvent(evt);
      const pending = result as Promise<boolean> | null;
      if (!evt.defaultPrevented || !pending) {
        setWarning(intl.formatMessage({ id: "sando.form.noListener" }));
        return;
      }
      setWarning("");
      setSending(true);
      pending
        .then((ok) => {
          if (!ok) {
            setWarning(intl.formatMessage({ id: "sando.form.notSent" }));
            return;
          }
          const next = { at: Date.now(), answers: clean };
          writeSaved(key, next);
          setSaved(next);
          setEditing(false);
        })
        .catch(() => setWarning(intl.formatMessage({ id: "sando.form.notSent" })))
        .finally(() => setSending(false));
    },
    [answers, intl, key, parsed, sending],
  );

  if (!parsed.ok) {
    return (
      <div className="my-4" data-sando-form="error">
        <div className="mb-1 text-ui-sm text-muted-foreground">
          {intl.formatMessage({ id: "sando.form.invalid" }, { error: parsed.error })}
        </div>
        {fallback}
      </div>
    );
  }

  const { form } = parsed;
  const answered = saved !== null && !editing;
  const answeredAt = saved
    ? new Date(saved.at).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

  return (
    <div
      ref={rootRef}
      className={cn(
        "my-4 rounded-lg border border-border bg-card p-3 text-ui-base max-md:p-2.5",
        answered && "opacity-90",
      )}
      data-sando-form={answered ? "answered" : "open"}
    >
      <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div>
          <div className="font-medium text-foreground">{form.title}</div>
          {form.intro ? (
            <p className="mt-1 text-ui-sm text-muted-foreground">{form.intro}</p>
          ) : null}
        </div>
        {form.fields.map((field) => {
          const inputId = `sando-form-${uid}-${field.id}`;
          return (
            <fieldset key={field.id} className="m-0 min-w-0 border-0 p-0" disabled={locked}>
              <legend className="mb-1.5 p-0 text-ui-sm font-medium text-foreground">
                {field.label}
                {field.required ? <span className="text-destructive"> *</span> : null}
              </legend>
              {field.note ? (
                <div className="mb-1.5 text-ui-xs text-muted-foreground">{field.note}</div>
              ) : null}
              <FormFieldControl
                field={field}
                value={answers[field.id]}
                disabled={locked}
                inputId={inputId}
                onChange={(value) => {
                  setWarning("");
                  setAnswers((prev) => ({ ...prev, [field.id]: value }));
                }}
              />
            </fieldset>
          );
        })}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span
            className={cn("mr-auto text-ui-xs", warning ? "text-warning" : "text-muted-foreground")}
            role={warning ? "alert" : undefined}
          >
            {warning ||
              (answered
                ? intl.formatMessage({ id: "sando.form.answeredAt" }, { when: answeredAt })
                : "")}
          </span>
          {answered ? (
            <button
              type="button"
              className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-ui-sm text-muted-foreground hover:bg-hover hover:text-foreground max-md:min-h-11"
              onClick={() => {
                setWarning("");
                setEditing(true);
              }}
            >
              <PencilIcon className="size-3.5" aria-hidden />
              {intl.formatMessage({ id: "sando.form.change" })}
            </button>
          ) : null}
          <button
            type="submit"
            disabled={locked}
            className="inline-flex min-h-8 items-center gap-1 rounded-md bg-primary px-3 text-ui-sm text-primary-foreground hover:bg-primary/80 disabled:opacity-60 max-md:min-h-11 max-md:px-4"
          >
            {answered ? <CheckIcon className="size-3.5" aria-hidden /> : null}
            {answered
              ? intl.formatMessage({ id: "sando.form.sent" })
              : sending
                ? intl.formatMessage({ id: "sando.form.sending" })
                : form.submit}
          </button>
        </div>
      </form>
    </div>
  );
}
