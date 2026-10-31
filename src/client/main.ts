import { SENSITIVITY, type LiveState, type ServerMessage } from "../shared/live";
import { DEFAULT_QUESTION, type Question } from "../shared/question";
import { reloadIfOutdated, watchBuild } from "./build";
import { connectLive } from "./live-client";

const STAGE_W = 1920;
const STAGE_H = 1080;
const INTRO_MS = 1300;
const RESULT_DELAY_MS = 700;
const LABEL_SIZE = 40.54;
const LABEL_WIDTH = 384;
const TITLE_SIZE = 150;
const TITLE_WIDTH = 1700;

const STICK_DEADZONE = 0.18;
const PICK_THRESHOLD = 0.45;
const CHARGE_SECONDS = 0.75;
const TRIGGER_DEADZONE = 0.08;

const BTN = { A: 0, B: 1, LB: 4, RB: 5, LT: 6, RT: 7, LEFT: 14, RIGHT: 15 } as const;

const ANSWER_STORAGE = "tlo-answer";
const DISPLAY_STORAGE = "tlo-display-id";

type State = "waiting" | "intro" | "running" | "chosen" | "result";
type StoredAnswer = { revision: number; option: 0 | 1; timedOut: boolean };

const PREVIEW = new URLSearchParams(location.search).has("preview");

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;

const stage = $<HTMLDivElement>("#stage");
const cursorEl = $<SVGSVGElement>("#cursor");
const fill = $<HTMLDivElement>("#timer-fill");
const ghost = $<HTMLSpanElement>("#ghost");
const hint = $<HTMLDivElement>("#hint");
const statusEl = $<HTMLParagraphElement>("#status");
const toastText = $<HTMLSpanElement>("#toast-text");
const toast = $<HTMLDivElement>(".toast");
const resultLabel = $<HTMLParagraphElement>("#result-label");
const resultSub = $<HTMLParagraphElement>("#result-sub");
const promptEl = $<HTMLParagraphElement>("#prompt");
const resultLockup = $<HTMLDivElement>("#result-lockup");
const waitingText = $<HTMLParagraphElement>("#waiting-text");
const options = [...document.querySelectorAll<HTMLButtonElement>(".option")];
const waitingLockup = $<HTMLDivElement>(".waiting .lockup");
const controls = [...document.querySelectorAll<HTMLElement>(".control")];

const OPTION_RECTS = [
  { x: 276.41, y: 476, w: 609, h: 174 },
  { x: 1033.59, y: 476, w: 609, h: 174 },
];

let question: Question = DEFAULT_QUESTION;
let revision = -1;
let shownQuestion = false;
let clockOffset = 0;

let state: State = "waiting";
let timerStart = 0;
let hover: number | null = null;
let keyboardFocus: number | null = null;
let lastSecond = -1;
const cursor = { x: STAGE_W / 2, y: 780 };
const prevButtons: boolean[] = [];
let padName: string | null = null;
let online = PREVIEW;
let introTimer = 0;
let padFocus: number | null = null;
let charge = 0;
let lastChargeBuzz = 0;
let lean = 0;
let nextBeatAt = 0;
let beatTimer = 0;
let resultTimer = 0;
let sensitivity: number = SENSITIVITY.default;
let live: { send: (msg: Record<string, unknown>) => void } | null = null;

const choiceMs = () => question.durationSeconds * 1000;

const setState = (next: State) => {
  state = next;
  stage.dataset.state = next;
  renderHint();
};

let scale = 1;
const fit = () => {
  scale = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
  stage.style.setProperty("--scale", String(scale));
};
window.addEventListener("resize", fit);
fit();

const toStage = (clientX: number, clientY: number) => {
  const r = stage.getBoundingClientRect();
  return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
};

const fitText = (el: HTMLElement, size: number, width: number) => {
  el.style.fontSize = `${size}px`;
  const natural = el.scrollWidth;
  if (natural > width) el.style.fontSize = `${(size * width) / natural}px`;
};

function setPrompt(text: string) {
  promptEl.textContent = "";
  const step = Math.min(11, 1000 / Math.max(1, text.length));
  [...text].forEach((ch, i) => {
    const span = document.createElement("span");
    span.className = "ch";
    span.style.setProperty("--d", `${i * step}ms`);
    span.textContent = ch;
    promptEl.append(span);
  });
}

function applyQuestion(q: Question) {
  question = q;
  setPrompt(q.prompt);
  options.forEach((el, i) => {
    const o = q.options[i];
    const label = el.querySelector<HTMLElement>(".label")!;
    const sub = el.querySelector<HTMLElement>(".sub")!;
    label.textContent = o.label;
    sub.textContent = o.sub;
    sub.hidden = o.sub.length === 0;
    fitText(label, LABEL_SIZE, LABEL_WIDTH);
  });
  const lines = q.resultTitle.split("\n");
  for (const layer of resultLockup.querySelectorAll<HTMLElement>("span")) {
    layer.replaceChildren(
      ...lines.flatMap((line, i) => (i === 0 ? [line] : [document.createElement("br"), line])),
    );
  }
  resultLockup.setAttribute("aria-label", lines.join(" "));
  resultLockup.hidden = q.resultTitle.trim().length === 0;
  promptEl.hidden = q.prompt.trim().length === 0;
  ghost.textContent = String(q.durationSeconds);
}

const btnA = '<span class="btn btn-a">A</span>';
const btnStick = '<span class="btn btn-stick">LS</span>';
const btnRt = '<span class="btn btn-trigger">RT</span>';

function renderHint() {
  if (state === "intro" || state === "running") {
    hint.innerHTML = `<span class="hint-item">${btnStick} Pick a side</span><span class="hint-item">${btnRt} Squeeze to lock in</span><span class="hint-item">${btnA} Quick choose</span>`;
  } else if (state === "result") {
    hint.innerHTML = PREVIEW
      ? `<span class="hint-item">Press ${btnA} to replay</span>`
      : `<span class="hint-item">Waiting for the next question</span>`;
  } else {
    hint.textContent = "";
  }
}

function renderStatus() {
  if (PREVIEW) {
    statusEl.textContent = "Preview";
    return;
  }
  if (!online) {
    statusEl.textContent = "Connection lost. Reconnecting…";
    return;
  }
  statusEl.textContent = padName
    ? `${padName} connected`
    : "No controller found. Press any button on it to connect, or use the mouse.";
}

const cleanPadName = (id: string) => {
  const name = id.replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
  return name.length > 0 && name.length < 48 ? name : "Controller";
};

window.addEventListener("gamepadconnected", (e) => {
  padName = cleanPadName(e.gamepad.id);
  renderStatus();
});
window.addEventListener("gamepaddisconnected", () => {
  padName = activePad() ? padName : null;
  renderStatus();
});

type Haptics = {
  playEffect?: (type: string, params: Record<string, number>) => Promise<unknown>;
};

const rumble = (duration: number, strong: number, weak: number) => {
  const pad = activePad();
  const actuator = (pad as (Gamepad & { vibrationActuator?: Haptics }) | null)?.vibrationActuator;
  actuator
    ?.playEffect?.("dual-rumble", {
      startDelay: 0,
      duration,
      strongMagnitude: strong,
      weakMagnitude: weak,
    })
    ?.catch(() => {});
};

function clearRound() {
  window.clearTimeout(introTimer);
  window.clearTimeout(resultTimer);
  delete stage.dataset.low;
  delete stage.dataset.hover;
  options.forEach((o) => o.classList.remove("is-chosen", "is-hover", "is-pressed"));
  hover = null;
  keyboardFocus = null;
  padFocus = null;
  setCharge(0);
  window.clearTimeout(beatTimer);
  nextBeatAt = 0;
  cursor.x = STAGE_W / 2;
  cursor.y = 780;
}

function showWaiting() {
  clearRound();
  waitingText.textContent = shownQuestion ? "Waiting for the next question" : "Waiting to start";
  setState("waiting");
}

function playQuestion(q: Question, startAt: number) {
  clearRound();
  shownQuestion = true;
  applyQuestion(q);
  stage.classList.remove("play-intro");
  void stage.offsetWidth;
  stage.classList.add("play-intro");
  setState("intro");
  setTimer(1);
  rumble(180, 0.6, 0.6);
  timerStart = startAt;
  introTimer = window.setTimeout(() => {
    lastSecond = -1;
    setState("running");
  }, Math.max(0, startAt - performance.now()));
}

function showResult(index: number, timedOut: boolean, animate: boolean) {
  const choice = question.options[index];
  options.forEach((o, i) => {
    o.classList.toggle("is-chosen", i === index);
    o.classList.toggle("is-hover", i === index);
  });
  delete stage.dataset.low;
  const note = timedOut ? question.timeoutToast : choice.toast;
  toastText.textContent = note;
  toast.style.display = note ? "" : "none";
  resultLabel.textContent = choice.label;
  resultLabel.hidden = choice.label.length === 0;
  resultSub.textContent = choice.resultSub;
  resultSub.hidden = choice.resultSub.length === 0;

  const reveal = () => {
    setState("result");
    fitText(resultLockup, TITLE_SIZE, TITLE_WIDTH);
    delete stage.dataset.hover;
  };
  if (animate) {
    setState("chosen");
    resultTimer = window.setTimeout(reveal, RESULT_DELAY_MS);
  } else reveal();
}

function choose(index: number, timedOut = false) {
  if (state !== "running") return;
  window.clearTimeout(beatTimer);
  setCharge(0);
  rumble(timedOut ? 600 : 380, 1, timedOut ? 0.8 : 1);
  const option: 0 | 1 = index === 1 ? 1 : 0;
  if (!PREVIEW) {
    const answer: StoredAnswer = { revision, option, timedOut };
    localStorage.setItem(ANSWER_STORAGE, JSON.stringify(answer));
    live?.send({ type: "choice", revision, option, timedOut });
  }
  showResult(option, timedOut, true);
}

function confirm() {
  if (state === "running" && hover !== null) {
    const el = options[hover];
    el.classList.add("is-pressed");
    window.setTimeout(() => el.classList.remove("is-pressed"), 90);
    choose(hover);
  } else if (state === "result" && PREVIEW) {
    playQuestion(question, performance.now() + INTRO_MS);
  }
}

function setTimer(t: number) {
  fill.style.setProperty("--t", String(Math.max(0, Math.min(1, t))));
}

function tickTimer(now: number) {
  if (state !== "running") return;
  const total = choiceMs();
  const elapsed = now - timerStart;
  const t = 1 - elapsed / total;
  setTimer(t);

  const seconds = Math.max(0, Math.ceil((total - elapsed) / 1000));
  if (seconds !== lastSecond) {
    lastSecond = seconds;
    ghost.textContent = String(seconds);
    ghost.classList.remove("tick");
    void ghost.offsetWidth;
    ghost.classList.add("tick");
    if (seconds <= question.lowSeconds && seconds > 0) stage.dataset.low = "";
  }

  heartbeat(now, total - elapsed);
  if (t <= 0) choose(question.timeoutOption, true);
}

function heartbeat(now: number, remainingMs: number) {
  if (remainingMs <= 0) return;
  const low = remainingMs <= question.lowSeconds * 1000;
  const progress = 1 - remainingMs / choiceMs();
  const period = low ? 430 : 1000 - 350 * progress;
  if (nextBeatAt === 0) nextBeatAt = now + 250;
  if (now < nextBeatAt) return;
  nextBeatAt = now + period;
  fill.classList.remove("beat");
  void fill.offsetWidth;
  fill.classList.add("beat");
  if (charge > 0.05) return;
  const strength = low ? 0.75 : 0.18 + 0.3 * progress;
  rumble(55, strength, strength * 0.5);
  beatTimer = window.setTimeout(() => {
    if (state === "running" && charge <= 0.05) rumble(40, strength * 0.55, strength * 0.3);
  }, 150);
}

function setCharge(value: number) {
  charge = value;
  options.forEach((o, i) => o.style.setProperty("--charge", String(i === hover ? value : 0)));
}

function storedAnswer(rev: number): StoredAnswer | null {
  try {
    const a = JSON.parse(localStorage.getItem(ANSWER_STORAGE) ?? "null") as StoredAnswer | null;
    return a && a.revision === rev ? a : null;
  } catch {
    return null;
  }
}

function applyLive(next: LiveState, serverNow: number) {
  clockOffset = serverNow - Date.now();
  if (next.revision === revision) return;
  revision = next.revision;

  if (next.mode !== "question" || !next.question) {
    showWaiting();
    return;
  }

  const answered = storedAnswer(next.revision);
  if (answered) {
    clearRound();
    shownQuestion = true;
    applyQuestion(next.question);
    showResult(answered.option, answered.timedOut, false);
    return;
  }

  const startsAtLocal = (next.startsAt ?? serverNow) - clockOffset;
  playQuestion(next.question, performance.now() + (startsAtLocal - Date.now()));
}

function displayId() {
  let id = localStorage.getItem(DISPLAY_STORAGE);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DISPLAY_STORAGE, id);
  }
  return id;
}

function activePad(): Gamepad | null {
  const pads = navigator.getGamepads?.() ?? [];
  let best: Gamepad | null = null;
  for (const p of pads) {
    if (p && p.connected && (!best || p.timestamp > best.timestamp)) best = p;
  }
  return best;
}

const isDown = (pad: Gamepad, i: number) => {
  const b = pad.buttons[i];
  return !!b && (b.pressed || b.value > 0.5);
};

function markControl(input: string, active: boolean) {
  for (const c of controls) {
    if (c.dataset.input !== input) continue;
    c.classList.toggle("is-active", active);
    if (active) c.classList.add("is-done");
  }
}

function pollPad(dt: number) {
  const pad = activePad();
  if (!pad) {
    lean += (leanTarget(0) - lean) * (1 - Math.exp(-dt * 10));
    stage.style.setProperty("--lean", lean.toFixed(3));
    return;
  }
  if (!padName) {
    padName = cleanPadName(pad.id);
    renderStatus();
  }

  const pressed = (i: number) => isDown(pad, i) && !prevButtons[i];
  const lx = pad.axes[0] ?? 0;
  const ly = pad.axes[1] ?? 0;
  const stickX = Math.abs(lx) > STICK_DEADZONE ? lx : 0;
  const stickY = Math.abs(ly) > STICK_DEADZONE ? ly : 0;
  const trigger = Math.max(pad.buttons[BTN.RT]?.value ?? 0, pad.buttons[BTN.LT]?.value ?? 0);

  if (stickX !== 0 || stickY !== 0) {
    stage.dataset.cursor = "hidden";
    keyboardFocus = null;
  }
  const threshold = PICK_THRESHOLD / sensitivity;
  if (stickX <= -threshold) padFocus = 0;
  if (stickX >= threshold) padFocus = 1;
  if (pressed(BTN.LEFT) || pressed(BTN.LB)) padFocus = 0;
  if (pressed(BTN.RIGHT) || pressed(BTN.RB)) padFocus = 1;

  lean += (leanTarget(stickX) - lean) * (1 - Math.exp(-dt * 10));
  stage.style.setProperty("--lean", lean.toFixed(3));
  stage.style.setProperty("--tilt-y", (stickY * 0.6).toFixed(3));
  stage.style.setProperty("--rt", trigger.toFixed(3));

  if (state === "waiting") {
    markControl("stick", stickX !== 0 || stickY !== 0);
    markControl("rt", trigger > TRIGGER_DEADZONE);
    markControl("a", isDown(pad, BTN.A));
    if (pressed(BTN.A)) {
      rumble(90, 0.4, 0.6);
      waitingLockup.classList.remove("ping");
      void waitingLockup.offsetWidth;
      waitingLockup.classList.add("ping");
    }
    if (trigger > TRIGGER_DEADZONE && performance.now() - lastChargeBuzz > 110) {
      lastChargeBuzz = performance.now();
      rumble(120, trigger * 0.6, trigger * 0.4);
    }
  }

  if (state === "running" && hover !== null) {
    if (trigger > TRIGGER_DEADZONE) {
      setCharge(Math.min(1, charge + (dt / CHARGE_SECONDS) * (0.35 + 0.65 * trigger)));
      if (performance.now() - lastChargeBuzz > 100) {
        lastChargeBuzz = performance.now();
        rumble(130, 0.15 + 0.85 * charge, 0.2 + 0.6 * charge);
      }
      if (charge >= 1) confirm();
    } else if (charge > 0) {
      setCharge(Math.max(0, charge - dt * 4));
    }
  } else if (charge > 0) {
    setCharge(0);
  }

  if (pressed(BTN.A)) confirm();

  pad.buttons.forEach((_, i) => {
    prevButtons[i] = isDown(pad, i);
  });
}

function leanTarget(stickX: number) {
  if (state === "waiting") return stickX;
  if (state !== "running" && state !== "intro") return 0;
  if (stickX !== 0) return stickX;
  return hover === 0 ? -0.35 : hover === 1 ? 0.35 : 0;
}

window.addEventListener("pointermove", (e) => {
  const p = toStage(e.clientX, e.clientY);
  cursor.x = p.x;
  cursor.y = p.y;
  keyboardFocus = null;
  padFocus = null;
  stage.dataset.cursor = "visible";
});

window.addEventListener("pointerdown", (e) => {
  if (!e.isPrimary) return;
  const p = toStage(e.clientX, e.clientY);
  cursor.x = p.x;
  cursor.y = p.y;
  updateHover();
  confirm();
});

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    keyboardFocus = e.key === "ArrowLeft" ? 0 : 1;
    stage.dataset.cursor = "hidden";
    options[keyboardFocus].focus({ preventScroll: true });
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (state === "running" && hover === null) keyboardFocus = 0;
    updateHover();
    confirm();
  }
});

options.forEach((o, i) => {
  o.addEventListener("focus", () => {
    if (stage.dataset.cursor === "hidden") keyboardFocus = i;
  });
});

function hitTest(x: number, y: number): number | null {
  for (let i = 0; i < OPTION_RECTS.length; i++) {
    const r = OPTION_RECTS[i];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
  }
  return null;
}

function updateHover() {
  if (state !== "running") {
    if (state !== "chosen" && state !== "result" && hover !== null) {
      hover = null;
      options.forEach((o) => o.classList.remove("is-hover"));
      delete stage.dataset.hover;
    }
    return;
  }
  const nextHover = keyboardFocus ?? padFocus ?? hitTest(cursor.x, cursor.y);
  if (nextHover === hover) return;
  hover = nextHover;
  setCharge(0);
  options.forEach((o, i) => o.classList.toggle("is-hover", i === nextHover));
  if (nextHover === null) delete stage.dataset.hover;
  else {
    stage.dataset.hover = String(nextHover);
    rumble(70, 0.25, 0.6);
  }
}

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  pollPad(dt);

  cursor.x = Math.min(STAGE_W - 4, Math.max(0, cursor.x));
  cursor.y = Math.min(STAGE_H - 4, Math.max(0, cursor.y));
  cursorEl.style.transform = `translate(${cursor.x}px, ${cursor.y}px)`;

  tickTimer(now);
  updateHover();

  requestAnimationFrame(frame);
}

document.fonts.ready.then(() => {
  renderStatus();
  requestAnimationFrame(frame);

  if (PREVIEW) {
    window.addEventListener("message", (e) => {
      if (e.origin !== location.origin) return;
      const data = e.data as { type?: string; question?: Question };
      if (data?.type !== "preview" || !data.question) return;
      playQuestion(data.question, performance.now() + INTRO_MS);
    });
    window.parent.postMessage({ type: "preview-ready" }, location.origin);
    return;
  }

  showWaiting();
  watchBuild(() => state !== "running" && state !== "intro");
  live = connectLive(
    { role: "display", id: displayId() },
    (msg: ServerMessage) => {
      if (msg.type === "state" && reloadIfOutdated(msg.build, () => state !== "running" && state !== "intro")) return;
      if (msg.type === "state" || msg.type === "settings") sensitivity = msg.settings.sensitivity;
      if (msg.type === "state") applyLive(msg.live, msg.serverNow);
    },
    (connected) => {
      online = connected;
      renderStatus();
    },
  );
});
