import {
  BLANK_QUESTION,
  LIMITS,
  validateQuestion,
  type Question,
  type QuestionInput,
} from "../shared/question";
import {
  clampSensitivity,
  type LiveState,
  type LiveStatus,
  type LiveTally,
  type ServerMessage,
} from "../shared/live";
import { reloadIfOutdated, watchBuild } from "./build";
import { connectLive } from "./live-client";

const KEY_STORAGE = "tlo-admin-key";

type Draft = { id: number | null; data: QuestionInput };

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;

const lock = $<HTMLElement>("#lock");
const lockForm = $<HTMLFormElement>("#lock-form");
const lockKey = $<HTMLInputElement>("#lock-key");
const lockError = $<HTMLParagraphElement>("#lock-error");
const app = $<HTMLDivElement>("#app");
const list = $<HTMLOListElement>("#list");
const form = $<HTMLFormElement>("#form");
const errorsEl = $<HTMLUListElement>("#errors");
const dirtyEl = $<HTMLSpanElement>("#dirty");
const syncStatus = $<HTMLParagraphElement>("#sync-status");
const saveBtn = $<HTMLButtonElement>("#save");
const deleteBtn = $<HTMLButtonElement>("#delete");
const duplicateBtn = $<HTMLButtonElement>("#duplicate");
const preview = $<HTMLIFrameElement>("#preview");

let adminKey = localStorage.getItem(KEY_STORAGE) ?? "";
let questions: Question[] = [];
let current: Draft | null = null;
let savedSnapshot = "";
let previewReady = false;
let previewTimer = 0;
let busy = false;
let liveState: LiveState | null = null;
let liveDisplays = 0;
let liveTally: LiveTally | null = null;
let liveConnected = false;
let liveConn: ReturnType<typeof connectLive> | null = null;

const liveScreens = $<HTMLSpanElement>("#live-screens");
const liveNow = $<HTMLParagraphElement>("#live-now");
const livePanel = $<HTMLElement>("#live");
const livePrev = $<HTMLButtonElement>("#live-prev");
const liveWait = $<HTMLButtonElement>("#live-wait");
const liveNext = $<HTMLButtonElement>("#live-next");
const tallyEl = $<HTMLDivElement>("#tally");
const tallyHead = $<HTMLParagraphElement>("#tally-head");
const tallyRows = $<HTMLUListElement>("#tally-rows");
const livePrompt = $<HTMLParagraphElement>("#live-prompt");
const liveUpnext = $<HTMLParagraphElement>("#live-upnext");
const tabCount = $<HTMLSpanElement>("#tab-count");
const editorTitle = $<HTMLSpanElement>("#editor-title");
const sens = $<HTMLInputElement>("#sens");
const sensValue = $<HTMLOutputElement>("#sens-value");
let sensDragging = false;

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors: string[] = [],
  ) {
    super(message);
  }
}

type View = "live" | "questions" | "edit";
const phone = window.matchMedia("(max-width: 900px)");

function setView(view: View) {
  app.dataset.view = view;
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    const active = tab.dataset.tab === (view === "edit" ? "questions" : view);
    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  if (phone.matches) window.scrollTo(0, 0);
}

for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  tab.addEventListener("click", () => setView(tab.dataset.tab as View));
}
$<HTMLButtonElement>("#back").addEventListener("click", () => setView("questions"));

const buzz = (ms = 15) => navigator.vibrate?.(ms);

let wakeLock: { release: () => Promise<void> } | null = null;
async function keepAwake() {
  if (wakeLock || document.visibilityState !== "visible" || app.hidden) return;
  try {
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void>; addEventListener: (t: string, f: () => void) => void }> };
    };
    const lock = await nav.wakeLock?.request("screen");
    if (!lock) return;
    wakeLock = lock;
    lock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {}
}
document.addEventListener("visibilitychange", () => void keepAwake());

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${adminKey}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { error?: string; errors?: string[] };
  if (!res.ok) {
    throw new ApiError(body.error ?? `Request failed (${res.status}).`, res.status, body.errors);
  }
  return body as T;
}

const setStatus = (text: string) => {
  syncStatus.textContent = text;
};

function showLock(message = "") {
  app.hidden = true;
  lock.hidden = false;
  lockError.textContent = message;
  lockKey.value = "";
  lockKey.focus();
}

async function unlock(key: string) {
  adminKey = key;
  try {
    await api("/api/admin/check");
  } catch (err) {
    adminKey = "";
    localStorage.removeItem(KEY_STORAGE);
    showLock(err instanceof ApiError && err.status === 401 ? "That key isn't right." : "Couldn't reach the server. Try again.");
    return;
  }
  localStorage.setItem(KEY_STORAGE, key);
  lock.hidden = true;
  app.hidden = false;
  await refresh();
  startLive();
  void keepAwake();
}

lockForm.addEventListener("submit", (e) => {
  e.preventDefault();
  void unlock(lockKey.value.trim());
});

$<HTMLButtonElement>("#lock-button").addEventListener("click", () => {
  if (isDirty() && !window.confirm("Discard unsaved changes and lock?")) return;
  localStorage.removeItem(KEY_STORAGE);
  adminKey = "";
  current = null;
  showLock();
});

function startLive() {
  if (liveConn) return;
  watchBuild(() => !isDirty());
  void api<LiveStatus>("/api/admin/live").then(applyStatus).catch(handleError);
  liveConn = connectLive(
    { role: "admin" },
    (msg: ServerMessage) => {
      if (msg.type === "state" && reloadIfOutdated(msg.build, () => !isDirty())) return;
      if (msg.type === "state") liveState = msg.live;
      if (msg.type === "state" || msg.type === "settings") showSensitivity(msg.settings.sensitivity);
      if (msg.type === "presence") liveDisplays = msg.displays;
      if (msg.type === "tally") {
        liveTally = msg.tally;
        liveDisplays = msg.displays;
      }
      renderLive();
      if (msg.type === "state") renderList();
    },
    (connected) => {
      liveConnected = connected;
      renderLive();
    },
  );
}

function showSensitivity(value: number) {
  if (sensDragging) return;
  sens.value = String(value);
  sensValue.textContent = `${value.toFixed(2)}×`;
}

sens.addEventListener("input", () => {
  sensDragging = true;
  sensValue.textContent = `${Number(sens.value).toFixed(2)}×`;
});
sens.addEventListener("change", async () => {
  const value = clampSensitivity(Number(sens.value));
  try {
    await api<LiveStatus>("/api/admin/live", {
      method: "POST",
      body: JSON.stringify({ action: "settings", sensitivity: value }),
    });
    setStatus(`Cursor speed set to ${value.toFixed(2)}×`);
  } catch (err) {
    handleError(err);
  } finally {
    sensDragging = false;
    showSensitivity(value);
  }
});

function applyStatus(status: LiveStatus) {
  showSensitivity(status.settings.sensitivity);
  liveState = status.live;
  liveDisplays = status.displays;
  liveTally = status.tally;
  renderLive();
  renderList();
}

const liveQuestionId = () =>
  liveState?.mode === "question" ? (liveState.question?.id ?? null) : null;

function liveNeighbours() {
  const anchorId =
    liveState?.mode === "question" ? (liveState.question?.id ?? null) : (liveState?.lastQuestionId ?? null);
  const anchor = anchorId === null ? -1 : questions.findIndex((q) => q.id === anchorId);
  const showing = liveState?.mode === "question";
  const next = questions.find((q, i) => q.enabled && i > anchor) ?? null;
  const before = questions.filter((q, i) => q.enabled && (showing ? i < anchor : i <= anchor));
  const prev = anchor === -1 ? null : (before[before.length - 1] ?? null);
  return { next, prev, started: anchorId !== null };
}

function renderLive() {
  const s = liveState;
  livePanel.dataset.mode = s?.mode ?? "waiting";
  liveScreens.textContent = !liveConnected
    ? "Reconnecting…"
    : liveDisplays === 0
      ? "No screens connected"
      : `${liveDisplays} screen${liveDisplays === 1 ? "" : "s"} connected`;

  if (!s || s.mode === "waiting" || !s.question) {
    const after = s?.lastQuestionId ? questions.findIndex((q) => q.id === s.lastQuestionId) : -1;
    liveNow.textContent = after >= 0 ? `Waiting screen, after question ${after + 1}` : "Waiting screen";
    livePrompt.hidden = true;
  } else {
    const i = questions.findIndex((q) => q.id === s.question?.id);
    liveNow.textContent = `${i >= 0 ? `Question ${i + 1}` : "A deleted question"}: ${s.question.options[0].label} / ${s.question.options[1].label}`;
    livePrompt.textContent = s.question.prompt;
    livePrompt.hidden = s.question.prompt.length === 0;
  }

  const { next, prev, started } = liveNeighbours();
  const nextIndex = next ? questions.indexOf(next) : -1;
  liveUpnext.textContent = next
    ? `Up next: ${nextIndex + 1}. ${next.prompt}`
    : questions.length > 0
      ? "That was the last question."
      : "Add a question to start.";
  tabCount.textContent = String(questions.length);
  liveNext.textContent = started ? "Next" : "Start";
  liveNext.disabled = !next;
  liveNext.title = next ? "" : "No more questions to show";
  livePrev.disabled = !prev;
  liveWait.disabled = !s || s.mode === "waiting";

  const t = liveTally;
  if (s?.mode === "question" && s.question && t && t.revision === s.revision) {
    const answered = t.option0 + t.option1 + t.timedOut;
    tallyEl.hidden = false;
    tallyHead.textContent = `${answered} of ${Math.max(answered, liveDisplays)} answered`;
    const rows: [string, number][] = [
      [s.question.options[0].label, t.option0],
      [s.question.options[1].label, t.option1],
      ["Time ran out", t.timedOut],
    ];
    tallyRows.replaceChildren(
      ...rows.map(([label, count]) => {
        const li = document.createElement("li");
        li.className = "tally-row";
        li.style.setProperty("--share", String(answered ? count / answered : 0));
        const name = document.createElement("span");
        name.textContent = label;
        const value = document.createElement("span");
        value.className = "tally-count";
        value.textContent = String(count);
        li.append(name, value);
        return li;
      }),
    );
  } else {
    tallyEl.hidden = true;
  }
}

async function liveAction(body: Record<string, unknown>) {
  buzz();
  try {
    applyStatus(await api<LiveStatus>("/api/admin/live", { method: "POST", body: JSON.stringify(body) }));
    setStatus(body.action === "show" ? "Sent to the screens" : body.action === "reset" ? "Back to the start" : "Showing the waiting screen");
  } catch (err) {
    handleError(err);
  }
}

liveNext.addEventListener("click", () => {
  const { next } = liveNeighbours();
  if (next) void liveAction({ action: "show", id: next.id });
});
livePrev.addEventListener("click", () => {
  const { prev } = liveNeighbours();
  if (prev) void liveAction({ action: "show", id: prev.id });
});
liveWait.addEventListener("click", () => void liveAction({ action: "waiting" }));
$<HTMLButtonElement>("#live-reset").addEventListener("click", () => {
  if (!window.confirm("Go back to the start? Screens will show \"Waiting to start\".")) return;
  void liveAction({ action: "reset" });
});

const field = <T extends HTMLElement = HTMLInputElement>(name: string) =>
  form.elements.namedItem(name) as unknown as T;

function readForm(): QuestionInput {
  const value = (name: string) => field<HTMLInputElement | HTMLTextAreaElement>(name).value;
  const option = (i: number) => ({
    label: value(`options.${i}.label`),
    sub: value(`options.${i}.sub`),
    toast: value(`options.${i}.toast`),
    resultSub: value(`options.${i}.resultSub`),
  });
  const timeout = form.querySelector<HTMLInputElement>('input[name="timeoutOption"]:checked');
  return {
    enabled: field("enabled").checked,
    prompt: value("prompt"),
    durationSeconds: Number(value("durationSeconds")),
    lowSeconds: Number(value("lowSeconds")),
    timeoutOption: timeout?.value === "1" ? 1 : 0,
    timeoutToast: value("timeoutToast"),
    resultTitle: value("resultTitle"),
    options: [option(0), option(1)],
  };
}

function writeForm(q: QuestionInput) {
  const set = (name: string, v: string | number) => {
    field<HTMLInputElement | HTMLTextAreaElement>(name).value = String(v);
  };
  field("enabled").checked = q.enabled;
  set("prompt", q.prompt);
  set("durationSeconds", q.durationSeconds);
  set("lowSeconds", q.lowSeconds);
  set("timeoutToast", q.timeoutToast);
  set("resultTitle", q.resultTitle);
  q.options.forEach((o, i) => {
    set(`options.${i}.label`, o.label);
    set(`options.${i}.sub`, o.sub);
    set(`options.${i}.toast`, o.toast);
    set(`options.${i}.resultSub`, o.resultSub);
  });
  for (const radio of form.querySelectorAll<HTMLInputElement>('input[name="timeoutOption"]')) {
    radio.checked = radio.value === String(q.timeoutOption);
  }
  updateCounts();
}

const snapshot = () => JSON.stringify(readForm());
const isDirty = () => current !== null && (current.id === null || snapshot() !== savedSnapshot);

function updateDirty() {
  dirtyEl.hidden = !isDirty();
}

function updateCounts() {
  for (const input of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-limit]")) {
    const max = LIMITS[input.dataset.limit as keyof typeof LIMITS];
    input.maxLength = max;
    const counter = form.querySelector<HTMLElement>(`.count[data-for="${input.name}"]`);
    if (!counter) continue;
    const n = input.value.trim().length;
    counter.textContent = `${n}/${max}`;
    counter.classList.toggle("near", n > max * 0.85);
  }
}

function showErrors(errors: string[]) {
  errorsEl.replaceChildren(
    ...errors.map((msg) => {
      const li = document.createElement("li");
      li.textContent = msg;
      return li;
    }),
  );
}

function previewQuestion(): Question {
  const q = readForm();
  const titleLines = q.resultTitle.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3);
  const duration = Number.isInteger(q.durationSeconds) && q.durationSeconds >= 3 ? Math.min(q.durationSeconds, LIMITS.durationMax) : 10;
  return {
    ...q,
    id: current?.id ?? 0,
    position: 0,
    durationSeconds: duration,
    lowSeconds: Math.max(0, Math.min(Number.isInteger(q.lowSeconds) ? q.lowSeconds : 3, duration - 1)),
    resultTitle: titleLines.join("\n"),
    options: [
      { ...q.options[0], label: q.options[0].label.trim() },
      { ...q.options[1], label: q.options[1].label.trim() },
    ],
  };
}

function sendPreview() {
  if (!previewReady || !current) return;
  preview.contentWindow?.postMessage({ type: "preview", question: previewQuestion() }, location.origin);
}

const schedulePreview = () => {
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(sendPreview, 600);
};

window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || (e.data as { type?: string })?.type !== "preview-ready") return;
  previewReady = true;
  sendPreview();
});

$<HTMLButtonElement>("#replay").addEventListener("click", sendPreview);

form.addEventListener("input", () => {
  updateCounts();
  updateDirty();
  schedulePreview();
  if (current?.id === null) renderList();
});

const summary = (q: QuestionInput) =>
  `${q.options[0].label || "Option 1"} / ${q.options[1].label || "Option 2"}`;

function renderList() {
  const items: HTMLLIElement[] = questions.map((q, i) => {
    const li = document.createElement("li");
    li.className = "item";
    li.classList.toggle("is-current", current?.id === q.id);
    li.classList.toggle("is-hidden", !q.enabled);

    const open = document.createElement("button");
    open.type = "button";
    open.className = "item-open";
    open.innerHTML = `<span class="item-prompt"></span><span class="item-meta"><span class="item-time"></span><span class="item-options"></span></span>`;
    open.querySelector(".item-prompt")!.textContent = q.prompt || "No question text";
    open.querySelector(".item-time")!.textContent = `${q.durationSeconds}s`;
    open.querySelector(".item-options")!.textContent = q.enabled ? summary(q) : `Hidden: ${summary(q)}`;
    open.addEventListener("click", () => {
      select({ id: q.id, data: q });
      if (current?.id === q.id && phone.matches) setView("edit");
    });

    const isLive = liveQuestionId() === q.id;
    li.classList.toggle("is-live", isLive);
    const show = document.createElement("button");
    show.type = "button";
    show.className = "show-btn";
    show.textContent = isLive ? "Restart" : "Show";
    show.setAttribute("aria-label", `${isLive ? "Restart" : "Show"} question ${i + 1} on the screens`);
    show.addEventListener("click", () => void liveAction({ action: "show", id: q.id }));

    const move = document.createElement("div");
    move.className = "item-move";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "icon-btn";
    up.textContent = "↑";
    up.setAttribute("aria-label", `Move question ${i + 1} up`);
    up.disabled = i === 0;
    up.addEventListener("click", () => void reorder(i, i - 1));
    const down = document.createElement("button");
    down.type = "button";
    down.className = "icon-btn";
    down.textContent = "↓";
    down.setAttribute("aria-label", `Move question ${i + 1} down`);
    down.disabled = i === questions.length - 1;
    down.addEventListener("click", () => void reorder(i, i + 1));
    move.append(up, down);

    li.append(open, show, move);
    return li;
  });

  if (current && current.id === null) {
    const li = document.createElement("li");
    li.className = "item is-current is-draft";
    li.innerHTML = `<span class="item-open"><span class="item-prompt"></span><span class="item-options">Not saved yet</span></span>`;
    li.querySelector(".item-prompt")!.textContent = readForm().prompt || "New question";
    items.push(li);
  }

  list.replaceChildren(...items);
  renderLive();
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No questions yet. Add one to put it in the game.";
    list.append(empty);
  }
}

function select(draft: Draft) {
  if (current && isDirty() && !window.confirm("Discard unsaved changes?")) return;
  current = { id: draft.id, data: structuredClone(draft.data) };
  writeForm(current.data);
  savedSnapshot = snapshot();
  showErrors([]);
  deleteBtn.textContent = draft.id === null ? "Discard" : "Delete";
  const index = draft.id === null ? -1 : questions.findIndex((q) => q.id === draft.id);
  editorTitle.textContent = index >= 0 ? `Question ${index + 1}` : "New question";
  duplicateBtn.disabled = draft.id === null;
  updateDirty();
  renderList();
  sendPreview();
}

async function refresh(selectId?: number | null) {
  setStatus("Loading…");
  try {
    const data = await api<{ questions: Question[] }>("/api/admin/questions");
    questions = data.questions;
    setStatus(`${questions.length} question${questions.length === 1 ? "" : "s"}`);
  } catch (err) {
    handleError(err);
    return;
  }
  const wanted = selectId !== undefined ? selectId : current?.id;
  const match = questions.find((q) => q.id === wanted) ?? questions[0];
  current = null;
  if (match) select({ id: match.id, data: match });
  else select({ id: null, data: structuredClone(BLANK_QUESTION) });
}

function handleError(err: unknown) {
  if (err instanceof ApiError && err.status === 401) {
    showLock("Your key stopped working. Enter it again.");
    return;
  }
  const message = err instanceof Error ? err.message : "Something went wrong.";
  setStatus(message);
  showErrors(err instanceof ApiError && err.errors.length > 0 ? err.errors : [message]);
}

async function withBusy(label: string, task: () => Promise<void>) {
  if (busy) return;
  busy = true;
  app.dataset.busy = "";
  setStatus(label);
  try {
    await task();
  } catch (err) {
    handleError(err);
  } finally {
    busy = false;
    delete app.dataset.busy;
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void save();
});

document.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement | null;
  const typing = !!target?.closest("input, textarea, select, [contenteditable]");
  if (!typing && !app.hidden && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
    const key = e.key.toLowerCase();
    if (key === "arrowright" || key === "pagedown") {
      e.preventDefault();
      if (!liveNext.disabled) liveNext.click();
      return;
    }
    if (key === "arrowleft" || key === "pageup") {
      e.preventDefault();
      if (!livePrev.disabled) livePrev.click();
      return;
    }
    if (key === "w") {
      e.preventDefault();
      if (!liveWait.disabled) liveWait.click();
      return;
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && !app.hidden) {
    e.preventDefault();
    void save();
  }
});

async function save() {
  if (!current) return;
  const result = validateQuestion(readForm());
  if (!result.ok) {
    showErrors(result.errors);
    setStatus("Fix the problems below, then save again.");
    return;
  }
  const id = current.id;
  await withBusy("Saving…", async () => {
    const res =
      id === null
        ? await api<{ question: Question }>("/api/admin/questions", {
            method: "POST",
            body: JSON.stringify(result.value),
          })
        : await api<{ question: Question }>(`/api/admin/questions/${id}`, {
            method: "PUT",
            body: JSON.stringify(result.value),
          });
    current = null;
    await refresh(res.question.id);
    setStatus("Saved");
    buzz(25);
  });
}

deleteBtn.addEventListener("click", () => {
  if (!current) return;
  if (current.id === null) {
    current = null;
    void refresh();
    if (phone.matches) setView("questions");
    return;
  }
  if (!window.confirm("Delete this question? This can't be undone.")) return;
  const id = current.id;
  void withBusy("Deleting…", async () => {
    await api(`/api/admin/questions/${id}`, { method: "DELETE" });
    current = null;
    await refresh(null);
    setStatus("Deleted");
    if (phone.matches) setView("questions");
  });
});

duplicateBtn.addEventListener("click", () => {
  if (!current || current.id === null) return;
  const copy = readForm();
  if (isDirty() && !window.confirm("Duplicate without saving your changes to this question first?")) return;
  current = null;
  select({ id: null, data: copy });
});

$<HTMLButtonElement>("#new-question").addEventListener("click", () => {
  select({ id: null, data: structuredClone(BLANK_QUESTION) });
  if (phone.matches) setView("edit");
  field<HTMLTextAreaElement>("prompt").focus();
});

async function reorder(from: number, to: number) {
  if (to < 0 || to >= questions.length) return;
  const next = [...questions];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  questions = next;
  renderList();
  await withBusy("Saving order…", async () => {
    await api("/api/admin/reorder", {
      method: "POST",
      body: JSON.stringify({ ids: next.map((q) => q.id) }),
    });
    setStatus("Order saved");
  });
}

window.addEventListener("beforeunload", (e) => {
  if (isDirty()) e.preventDefault();
});

if (adminKey) void unlock(adminKey);
else showLock();
