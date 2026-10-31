export type Option = {
  readonly label: string;
  readonly sub: string;
  readonly toast: string;
  readonly resultSub: string;
};

export type Question = {
  readonly id: number;
  readonly position: number;
  readonly enabled: boolean;
  readonly prompt: string;
  readonly durationSeconds: number;
  readonly lowSeconds: number;
  readonly timeoutOption: 0 | 1;
  readonly timeoutToast: string;
  readonly resultTitle: string;
  readonly options: readonly [Option, Option];
  readonly updatedAt?: string;
};

export type QuestionInput = Omit<Question, "id" | "position" | "updatedAt">;

export const LIMITS = {
  prompt: 220,
  label: 32,
  sub: 100,
  toast: 48,
  resultSub: 140,
  timeoutToast: 48,
  resultTitleLine: 24,
  resultTitleLines: 3,
  durationMin: 3,
  durationMax: 300,
  lowMax: 30,
} as const;

export const DEFAULT_QUESTION: Question = {
  id: 0,
  position: 0,
  enabled: true,
  prompt:
    "EXUN gets one final secret order: wipe the firmware completely and delete every trace of NIGIRO by 31 October.",
  durationSeconds: 10,
  lowSeconds: 3,
  timeoutOption: 0,
  timeoutToast: "Time ran out.",
  resultTitle: "THE LAST\nORDER",
  options: [
    {
      label: "WIPE THE FIRMWARE",
      sub: "The scientists still inside would die.",
      toast: "Nano will remember that.",
      resultSub: "The scientists still inside would die.",
    },
    {
      label: "HELP NANO",
      sub: "If you still want to help, you know where to come.",
      toast: "EXUN will remember that.",
      resultSub: "If you still want to help, you know where to come.",
    },
  ],
};

export const BLANK_QUESTION: QuestionInput = {
  enabled: true,
  prompt: "",
  durationSeconds: 10,
  lowSeconds: 3,
  timeoutOption: 0,
  timeoutToast: "Time ran out.",
  resultTitle: "THE LAST\nORDER",
  options: [
    { label: "", sub: "", toast: "", resultSub: "" },
    { label: "", sub: "", toast: "", resultSub: "" },
  ],
};

type Result = { ok: true; value: QuestionInput } | { ok: false; errors: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : "");
const oneLine = (v: unknown) => clean(v).replace(/\s+/g, " ");

export function validateQuestion(raw: unknown): Result {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["Send the question as a JSON object."] };

  const text = (name: string, value: unknown, max: number, required: boolean) => {
    const v = oneLine(value);
    if (required && v.length === 0) errors.push(`${name} can't be empty.`);
    if (v.length > max) errors.push(`${name} is ${v.length} characters; the limit is ${max}.`);
    return v;
  };
  const whole = (name: string, value: unknown, min: number, max: number) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${name} must be a whole number from ${min} to ${max}.`);
      return min;
    }
    return n;
  };

  const prompt = text("Question", raw.prompt, LIMITS.prompt, false);
  const durationSeconds = whole("Timer", raw.durationSeconds, LIMITS.durationMin, LIMITS.durationMax);
  const lowSeconds = whole("Warning time", raw.lowSeconds, 0, LIMITS.lowMax);
  if (lowSeconds >= durationSeconds) errors.push("Warning time must be shorter than the timer.");
  const timeoutOption = raw.timeoutOption === 1 ? 1 : 0;
  const timeoutToast = text("Time-out notification", raw.timeoutToast, LIMITS.timeoutToast, false);

  const titleLines = clean(raw.resultTitle)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
  if (titleLines.length > LIMITS.resultTitleLines) {
    errors.push(`Result title can have at most ${LIMITS.resultTitleLines} lines.`);
  }
  if (titleLines.some((l) => l.length > LIMITS.resultTitleLine)) {
    errors.push(`Each result title line can be at most ${LIMITS.resultTitleLine} characters.`);
  }

  const rawOptions = Array.isArray(raw.options) ? raw.options : [];
  if (rawOptions.length !== 2) errors.push("A question needs exactly two options.");
  const options = [0, 1].map((i) => {
    const o = isRecord(rawOptions[i]) ? rawOptions[i] : {};
    const n = `Option ${i + 1}`;
    const sub = text(`${n} hover text`, o.sub, LIMITS.sub, false);
    return {
      label: text(`${n} label`, o.label, LIMITS.label, false),
      sub,
      toast: text(`${n} notification`, o.toast, LIMITS.toast, false),
      resultSub: text(`${n} result text`, o.resultSub, LIMITS.resultSub, false),
    };
  }) as unknown as [Option, Option];

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      enabled: raw.enabled !== false,
      prompt,
      durationSeconds,
      lowSeconds,
      timeoutOption,
      timeoutToast,
      resultTitle: titleLines.join("\n"),
      options,
    },
  };
}
