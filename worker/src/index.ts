const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_DESCRIPTION_LENGTH = 8_000;
const LOG_DESCRIPTION_PREFIX_LENGTH = 500;
const DEFAULT_LOGS_LIMIT = 50;
const MAX_LOGS_LIMIT = 200;

export type Category = "study" | "entertainment" | "other";

export interface Env {
  TYPESAFE_API_KEY: string;
  CLIENT_TOKEN: string;
  DB?: D1Database;
}

export interface VideoMetadata {
  url: string;
  title: string;
  channel: string;
  description: string;
  clientVersion?: string;
}

export interface ClassificationResult {
  category: Category;
  probabilities: Record<Category, number>;
  confidence: number;
}

export interface JevResponse {
  answers: {
    category: {
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    };
  };
}

interface JevRequest {
  state: string;
  model: "jev-latest";
  questions: {
    category: {
      type: "choice";
      instructions: string;
      criteria: Record<Category, string>;
    };
  };
}

export interface ClassificationLogEntry {
  videoKey: string;
  url: string;
  title: string;
  channel: string;
  descriptionPrefix: string;
  clientVersion: string;
  category: string;
  confidence: number | null;
  probStudy: number | null;
  probEntertainment: number | null;
  probOther: number | null;
  jevLatencyMs: number | null;
  error: string | null;
  httpStatus: number;
}

const corsHeaders = {
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8",
};

export function isAuthorized(authorization: string | undefined, clientToken: string): boolean {
  return authorization === `Bearer ${clientToken}`;
}

export function buildJevRequest(video: VideoMetadata): JevRequest {
  return {
    state: JSON.stringify(video),
    model: "jev-latest",
    questions: {
      category: {
        type: "choice",
        instructions: "このコンテンツの主目的は何ですか？",
        criteria: {
          study: "学習・教育・仕事・技術習得",
          entertainment: "娯楽・暇つぶし",
          other: "それ以外",
        },
      },
    },
  };
}

export function normalizeJevResponse(response: JevResponse): ClassificationResult {
  const answer = response.answers?.category;
  if (!answer || !isCategory(answer.choice)) {
    throw new Error("Invalid Jev category");
  }

  return {
    category: answer.choice,
    probabilities: {
      study: answer.probabilities.study ?? 0,
      entertainment: answer.probabilities.entertainment ?? 0,
      other: answer.probabilities.other ?? 0,
    },
    confidence: answer.confidence,
  };
}

export async function classifyVideo(
  video: VideoMetadata,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ClassificationResult> {
  const response = await fetcher(JEV_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildJevRequest(video)),
  });

  if (!response.ok) {
    throw new Error(`Jev request failed: ${response.status}`);
  }

  return normalizeJevResponse((await response.json()) as JevResponse);
}

export function getVideoKey(urlString: string): string {
  try {
    const url = new URL(urlString);
    if (url.pathname === "/watch") return url.searchParams.get("v") || "";
    if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || "";
    return "";
  } catch {
    return "";
  }
}

export function toLogDescriptionPrefix(description: string): string {
  return description.slice(0, LOG_DESCRIPTION_PREFIX_LENGTH);
}

export async function writeClassificationLog(
  db: D1Database,
  entry: ClassificationLogEntry,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO classification_logs
        (created_at, video_key, url, title, channel, description_prefix, client_version,
         category, confidence, prob_study, prob_entertainment, prob_other,
         jev_latency_ms, error, http_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      new Date().toISOString(),
      entry.videoKey,
      entry.url,
      entry.title,
      entry.channel,
      entry.descriptionPrefix,
      entry.clientVersion,
      entry.category,
      entry.confidence,
      entry.probStudy,
      entry.probEntertainment,
      entry.probOther,
      entry.jevLatencyMs,
      entry.error,
      entry.httpStatus,
    )
    .run();
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/logs") {
      return handleGetLogs(request, env);
    }

    if (request.method !== "POST" || url.pathname !== "/classify") {
      return json({ error: "Not found" }, 404);
    }

    if (!isAuthorized(request.headers.get("Authorization") ?? undefined, env.CLIENT_TOKEN)) {
      await flushLog(
        logFailure(env, {
          videoKey: "",
          url: "",
          title: "",
          channel: "",
          descriptionPrefix: "",
          clientVersion: "",
          error: "Unauthorized",
          httpStatus: 401,
        }),
        ctx,
      );
      return json({ error: "Unauthorized" }, 401);
    }

    return handleClassify(request, env, ctx);
  },
};

async function handleClassify(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  let video: VideoMetadata;
  try {
    video = await parseVideoMetadata(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("Invalid request") ? 400 : 502;
    await flushLog(
      logFailure(env, {
        videoKey: "",
        url: "",
        title: "",
        channel: "",
        descriptionPrefix: "",
        clientVersion: "",
        error: message,
        httpStatus: status,
      }),
      ctx,
    );
    console.error("jev_classification_error", { error: message, httpStatus: status });
    return json({ error: message }, status);
  }

  const startedAt = Date.now();
  try {
    const result = await classifyVideo(video, env.TYPESAFE_API_KEY);
    const videoKey = getVideoKey(video.url);
    console.warn("jev_classification", {
      videoKey,
      title: video.title,
      channel: video.channel,
      clientVersion: video.clientVersion ?? "unknown",
      category: result.category,
      confidence: result.confidence,
    });
    await flushLog(logSuccess(env, video, videoKey, result, Date.now() - startedAt), ctx);
    return json(result, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const videoKey = getVideoKey(video.url);
    console.error("jev_classification_error", {
      videoKey,
      title: video.title,
      channel: video.channel,
      error: message,
    });
    await flushLog(
      logFailure(env, {
        videoKey,
        url: video.url,
        title: video.title,
        channel: video.channel,
        descriptionPrefix: toLogDescriptionPrefix(video.description),
        clientVersion: video.clientVersion ?? "",
        error: message,
        httpStatus: 502,
      }),
      ctx,
    );
    const status = message.startsWith("Invalid request") ? 400 : 502;
    return json({ error: message }, status);
  }
}

async function handleGetLogs(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request.headers.get("Authorization") ?? undefined, env.CLIENT_TOKEN)) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (!env.DB) {
    return json({ error: "Log store is not configured" }, 503);
  }

  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get("limit"), DEFAULT_LOGS_LIMIT, 1, MAX_LOGS_LIMIT);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const category = url.searchParams.get("category") ?? "";
  const videoKey = url.searchParams.get("videoKey") ?? "";
  const query = url.searchParams.get("q") ?? "";

  if (category !== "" && !isCategory(category)) {
    return json({ error: "Invalid category filter" }, 400);
  }

  const conditions: string[] = [];
  const bindings: Array<string | number> = [];
  if (category !== "") {
    conditions.push("category = ?");
    bindings.push(category);
  }
  if (videoKey !== "") {
    conditions.push("video_key = ?");
    bindings.push(videoKey);
  }
  if (query !== "") {
    conditions.push("(title LIKE ? OR channel LIKE ? OR url LIKE ?)");
    const pattern = `%${query}%`;
    bindings.push(pattern, pattern, pattern);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const countRow = (await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM classification_logs ${where}`,
    )
      .bind(...bindings)
      .first<{ total: number }>()) ?? { total: 0 };
    const rows = await env.DB.prepare(
      `SELECT id, created_at, video_key, url, title, channel, description_prefix,
              client_version, category, confidence, prob_study, prob_entertainment,
              prob_other, jev_latency_ms, error, http_status
         FROM classification_logs ${where}
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
    )
      .bind(...bindings, limit, offset)
      .all<ClassificationLogRow>();

    return json(
      {
        logs: (rows.results ?? []).map(toLogApiEntry),
        total: countRow.total ?? 0,
        limit,
        offset,
      },
      200,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("jev_logs_error", { error: message });
    return json({ error: "Failed to read logs" }, 500);
  }
}

interface ClassificationLogRow {
  id: number;
  created_at: string;
  video_key: string;
  url: string;
  title: string;
  channel: string;
  description_prefix: string;
  client_version: string;
  category: string;
  confidence: number | null;
  prob_study: number | null;
  prob_entertainment: number | null;
  prob_other: number | null;
  jev_latency_ms: number | null;
  error: string | null;
  http_status: number;
}

function toLogApiEntry(row: ClassificationLogRow): Record<string, unknown> {
  return {
    id: row.id,
    createdAt: row.created_at,
    videoKey: row.video_key,
    url: row.url,
    title: row.title,
    channel: row.channel,
    descriptionPrefix: row.description_prefix,
    clientVersion: row.client_version,
    category: row.category,
    confidence: row.confidence,
    probStudy: row.prob_study,
    probEntertainment: row.prob_entertainment,
    probOther: row.prob_other,
    jevLatencyMs: row.jev_latency_ms,
    error: row.error,
    httpStatus: row.http_status,
  };
}

function successEntry(
  video: VideoMetadata,
  videoKey: string,
  result: ClassificationResult,
  jevLatencyMs: number,
): ClassificationLogEntry {
  return {
    videoKey,
    url: video.url,
    title: video.title,
    channel: video.channel,
    descriptionPrefix: toLogDescriptionPrefix(video.description),
    clientVersion: video.clientVersion ?? "",
    category: result.category,
    confidence: result.confidence,
    probStudy: result.probabilities.study,
    probEntertainment: result.probabilities.entertainment,
    probOther: result.probabilities.other,
    jevLatencyMs,
    error: null,
    httpStatus: 200,
  };
}

async function logSuccess(
  env: Env,
  video: VideoMetadata,
  videoKey: string,
  result: ClassificationResult,
  jevLatencyMs: number,
): Promise<void> {
  if (!env.DB) return;
  try {
    await writeClassificationLog(env.DB, successEntry(video, videoKey, result, jevLatencyMs));
  } catch (error) {
    console.error("jev_log_write_error", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function logFailure(
  env: Env,
  entry: Omit<
    ClassificationLogEntry,
    "confidence" | "probStudy" | "probEntertainment" | "probOther" | "jevLatencyMs" | "category"
  > & {
    category?: string;
  },
): Promise<void> {
  if (!env.DB) return;
  try {
    await writeClassificationLog(env.DB, {
      ...entry,
      category: entry.category ?? "",
      confidence: null,
      probStudy: null,
      probEntertainment: null,
      probOther: null,
      jevLatencyMs: null,
    });
  } catch (error) {
    console.error("jev_log_write_error", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function flushLog(promise: Promise<void>, ctx?: ExecutionContext): Promise<void> {
  if (ctx) {
    ctx.waitUntil(promise);
    return;
  }
  await promise;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = raw === null || raw === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function isCategory(value: string): value is Category {
  return value === "study" || value === "entertainment" || value === "other";
}

async function parseVideoMetadata(request: Request): Promise<VideoMetadata> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new Error("Invalid request JSON");
  }

  if (!isRecord(body)) {
    throw new Error("Invalid request body");
  }

  const url = stringField(body, "url");
  const title = stringField(body, "title");
  const channel = stringField(body, "channel");
  const description = stringField(body, "description");
  const clientVersion = stringField(body, "clientVersion");

  if (!url || !title || !channel) {
    throw new Error("Invalid request metadata");
  }

  return {
    url,
    title,
    channel,
    description: description.slice(0, MAX_DESCRIPTION_LENGTH),
    clientVersion: clientVersion || undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? body[key].trim() : "";
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders,
  });
}
