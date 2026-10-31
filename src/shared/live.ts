import type { Question } from "./question";

export type LiveState = {
  readonly revision: number;
  readonly mode: "waiting" | "question";
  readonly question: Question | null;
  readonly startsAt: number | null;
  readonly lastQuestionId: number | null;
};

export type LiveAnswer = { readonly option: 0 | 1; readonly timedOut: boolean };

export type LiveTally = {
  readonly revision: number;
  readonly option0: number;
  readonly option1: number;
  readonly timedOut: number;
};

export type LiveSettings = { readonly sensitivity: number };

export const SENSITIVITY = { min: 0.25, max: 3, step: 0.05, default: 1 } as const;

export const clampSensitivity = (n: number) =>
  Number.isFinite(n)
    ? Math.round(Math.min(SENSITIVITY.max, Math.max(SENSITIVITY.min, n)) * 100) / 100
    : SENSITIVITY.default;

export type ServerMessage =
  | { type: "state"; serverNow: number; live: LiveState; settings: LiveSettings; build?: string }
  | { type: "settings"; settings: LiveSettings }
  | { type: "presence"; displays: number }
  | { type: "tally"; tally: LiveTally; displays: number };

export type LiveStatus = {
  live: LiveState;
  displays: number;
  tally: LiveTally;
  settings: LiveSettings;
};
