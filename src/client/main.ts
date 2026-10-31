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
const CURSOR_SPEED = 1500;
const OPTION_FRICTION = 0.55;

const BTN = { A: 0, B: 1, LB: 4, RB: 5, LEFT: 14, RIGHT: 15 } as const;

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

const OPTION_RECTS = [
  { x: 276.41, y: 476, w: 609, h: 174 },
  { x: 1033.59, y: 476, w: 609, h: 174 },
];
const SNAP_POINTS = [
  { x: 363, y: 563 },
  { x: 1555, y: 563 },
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
let snapTarget: { x: number; y: number } | null = null;
const prevButtons: boolean[] = [];
let padName: string | null = null;
let online = PREVIEW;
let introTimer = 0;
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

function renderHint() {
  if (state === "intro" || state === "running") {
    hint.innerHTML = `<span class="hint-item">${btnStick} Move</span><span class="hint-item">${btnA} Choose</span>`;
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
  rumble(timedOut ? 500 : 260, timedOut ? 1 : 0.8, 0.6);
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

function snapTo(index: number) {
  if (state !== "running" && state !== "intro") return;
  snapTarget = SNAP_POINTS[index];
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
    if (seconds <= question.lowSeconds && seconds > 0) {
      stage.dataset.low = "";
      rumble(70, 0.35, 0.2);
    }
  }

  if (t <= 0) choose(question.timeoutOption, true);
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

function pollPad(dt: number) {
  const pad = activePad();
  if (!pad) return;
  if (!padName) {
    padName = cleanPadName(pad.id);
    renderStatus();
  }

  const pressed = (i: number) => isDown(pad, i) && !prevButtons[i];

  const lx = pad.axes[0] ?? 0;
  const ly = pad.axes[1] ?? 0;
  const mag = Math.hypot(lx, ly);
  if (mag > STICK_DEADZONE) {
    const strength = ((mag - STICK_DEADZONE) / (1 - STICK_DEADZONE)) ** 2;
    const friction = hitTest(cursor.x, cursor.y) !== null ? OPTION_FRICTION : 1;
    const speed = CURSOR_SPEED * sensitivity * strength * friction * dt;
    cursor.x += (lx / mag) * speed;
    cursor.y += (ly / mag) * speed;
    snapTarget = null;
    keyboardFocus = null;
    stage.dataset.cursor = "visible";
  }

  if (pressed(BTN.LEFT) || pressed(BTN.LB)) snapTo(0);
  if (pressed(BTN.RIGHT) || pressed(BTN.RB)) snapTo(1);
  if (pressed(BTN.A)) confirm();
  if (pressed(BTN.A) || pressed(BTN.LEFT) || pressed(BTN.RIGHT)) stage.dataset.cursor = "visible";

  pad.buttons.forEach((_, i) => {
    prevButtons[i] = isDown(pad, i);
  });
}

window.addEventListener("pointermove", (e) => {
  const p = toStage(e.clientX, e.clientY);
  cursor.x = p.x;
  cursor.y = p.y;
  snapTarget = null;
  keyboardFocus = null;
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
  const nextHover = keyboardFocus ?? hitTest(cursor.x, cursor.y);
  if (nextHover === hover) return;
  hover = nextHover;
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

  if (snapTarget) {
    const k = 1 - Math.exp(-dt * 18);
    cursor.x += (snapTarget.x - cursor.x) * k;
    cursor.y += (snapTarget.y - cursor.y) * k;
    if (Math.hypot(snapTarget.x - cursor.x, snapTarget.y - cursor.y) < 0.5) snapTarget = null;
  }
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
