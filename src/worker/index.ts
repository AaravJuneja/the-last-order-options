import { createClient, type Client, type Row } from "@libsql/client/web";
import { validateQuestion, type Question, type QuestionInput } from "../shared/question";
import { LiveRoom } from "./live";

export { LiveRoom };

interface Env {
  readonly ASSETS: Fetcher;
  readonly TURSO_DATABASE_URL: string;
  readonly TURSO_AUTH_TOKEN: string;
  readonly ADMIN_KEY: string;
  readonly BUILD_ID?: string;
  readonly LIVE: DurableObjectNamespace<LiveRoom>;
}

const liveRoom = (env: Env) => env.LIVE.get(env.LIVE.idFromName("live"));

const COLUMNS =
  "id, position, enabled, prompt, duration_seconds, low_seconds, timeout_option, timeout_toast, result_title, options, updated_at";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const fail = (status: number, message: string, errors?: string[]) =>
  json({ error: message, ...(errors ? { errors } : {}) }, status);

const toQuestion = (row: Row): Question => ({
  id: Number(row.id),
  position: Number(row.position),
  enabled: Number(row.enabled) === 1,
  prompt: String(row.prompt),
  durationSeconds: Number(row.duration_seconds),
  lowSeconds: Number(row.low_seconds),
  timeoutOption: Number(row.timeout_option) === 1 ? 1 : 0,
  timeoutToast: String(row.timeout_toast),
  resultTitle: String(row.result_title),
  options: JSON.parse(String(row.options)),
  updatedAt: String(row.updated_at),
});

const params = (q: QuestionInput) => [
  q.enabled ? 1 : 0,
  q.prompt,
  q.durationSeconds,
  q.lowSeconds,
  q.timeoutOption,
  q.timeoutToast,
  q.resultTitle,
  JSON.stringify(q.options),
];

const sameKey = async (given: string, expected: string) => {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 && expected.length > 0;
};

const readJson = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    return null;
  }
};

async function getQuestion(db: Client, id: number) {
  const rs = await db.execute({ sql: `SELECT ${COLUMNS} FROM questions WHERE id = ?`, args: [id] });
  return rs.rows[0] ? toQuestion(rs.rows[0]) : null;
}

async function handleAdmin(request: Request, db: Client, path: string, env: Env): Promise<Response> {
  const method = request.method;

  if (path === "/api/admin/live" && method === "GET") return json(await liveRoom(env).status());

  if (path === "/api/admin/live" && method === "POST") {
    const body = (await readJson(request)) as {
      action?: unknown;
      id?: unknown;
      sensitivity?: unknown;
    } | null;
    const room = liveRoom(env);
    if (body?.action === "waiting") await room.show(null);
    else if (body?.action === "settings" && typeof body.sensitivity === "number") {
      await room.setSensitivity(body.sensitivity);
    }
    else if (body?.action === "reset") await room.reset();
    else if (body?.action === "show" && Number.isInteger(body.id)) {
      const q = await getQuestion(db, body.id as number);
      if (!q) return fail(404, `Question ${body.id} doesn't exist.`);
      await room.show(q);
    } else return fail(400, 'Send { action: "show", id }, { action: "waiting" }, { action: "reset" } or { action: "settings", sensitivity }.');
    return json(await room.status());
  }

  if (path === "/api/admin/check" && method === "GET") return new Response(null, { status: 204 });

  if (path === "/api/admin/questions" && method === "GET") {
    const rs = await db.execute(`SELECT ${COLUMNS} FROM questions ORDER BY position, id`);
    return json({ questions: rs.rows.map(toQuestion) });
  }

  if (path === "/api/admin/questions" && method === "POST") {
    const result = validateQuestion(await readJson(request));
    if (!result.ok) return fail(400, "The question wasn't saved.", result.errors);
    const rs = await db.execute({
      sql: `INSERT INTO questions (position, enabled, prompt, duration_seconds, low_seconds, timeout_option, timeout_toast, result_title, options)
            VALUES ((SELECT COALESCE(MAX(position), -1) + 1 FROM questions), ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING ${COLUMNS}`,
      args: params(result.value),
    });
    return json({ question: toQuestion(rs.rows[0]) }, 201);
  }

  if (path === "/api/admin/reorder" && method === "POST") {
    const body = await readJson(request);
    const ids = (body as { ids?: unknown })?.ids;
    if (!Array.isArray(ids) || !ids.every((id) => Number.isInteger(id))) {
      return fail(400, "Send the new order as { ids: [question ids] }.");
    }
    await db.batch(
      ids.map((id, position) => ({
        sql: "UPDATE questions SET position = ? WHERE id = ?",
        args: [position, id as number],
      })),
      "write",
    );
    return new Response(null, { status: 204 });
  }

  const match = path.match(/^\/api\/admin\/questions\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (method === "PUT") {
      const result = validateQuestion(await readJson(request));
      if (!result.ok) return fail(400, "The question wasn't saved.", result.errors);
      const rs = await db.execute({
        sql: `UPDATE questions SET enabled = ?, prompt = ?, duration_seconds = ?, low_seconds = ?, timeout_option = ?,
              timeout_toast = ?, result_title = ?, options = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? RETURNING ${COLUMNS}`,
        args: [...params(result.value), id],
      });
      if (!rs.rows[0]) return fail(404, `Question ${id} doesn't exist.`);
      return json({ question: toQuestion(rs.rows[0]) });
    }
    if (method === "DELETE") {
      const rs = await db.execute({ sql: "DELETE FROM questions WHERE id = ?", args: [id] });
      if (rs.rowsAffected === 0) return fail(404, `Question ${id} doesn't exist.`);
      return new Response(null, { status: 204 });
    }
    if (method === "GET") {
      const q = await getQuestion(db, id);
      return q ? json({ question: q }) : fail(404, `Question ${id} doesn't exist.`);
    }
  }

  return fail(404, "No such admin endpoint.");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

    if (path === "/api/live") return liveRoom(env).fetch(request);

    if (path === "/api/version") return json({ build: env.BUILD_ID ?? "dev" });

    const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

    try {
      if (path === "/api/questions" && request.method === "GET") {
        const rs = await db.execute(
          `SELECT ${COLUMNS} FROM questions WHERE enabled = 1 ORDER BY position, id`,
        );
        return json({ questions: rs.rows.map(toQuestion) });
      }

      if (path.startsWith("/api/admin/")) {
        const auth = request.headers.get("authorization") ?? "";
        const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!(await sameKey(key, env.ADMIN_KEY))) return fail(401, "That key isn't right.");
        return await handleAdmin(request, db, path, env);
      }

      return fail(404, "No such endpoint.");
    } catch (err) {
      console.error(err);
      return fail(500, "The database request failed. Try again in a moment.");
    } finally {
      db.close();
    }
  },
} satisfies ExportedHandler<Env>;
