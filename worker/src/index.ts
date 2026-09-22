const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_TIMEOUT_MS = 10_000;
const MAX_DESCRIPTION_LENGTH = 8_000;
const MAX_URL_LENGTH = 2_000;
const MAX_TITLE_LENGTH = 500;
const MAX_CHANNEL_LENGTH = 200;
const MAX_OFFSET = 100_000;
const LOG_DESCRIPTION_PREFIX_LENGTH = 500;
// Server-side Jev result cache: same videoKey + policy reuses the last
// judgment instead of burning Jev credit. 30 days balances cost against
// model drift (jev-latest moves under us); POLICY_VERSION bumps force a miss.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LOGS_LIMIT = 50;
const MAX_LOGS_LIMIT = 200;

// Bump this whenever the classification criteria change. Cached results and
// log rows are keyed by it so old judgments stay distinguishable.
export const POLICY_VERSION = "2";

export type Category =
  | "study_tech"
  | "study_exam"
  | "study_culture"
  | "ent_game"
  | "ent_variety"
  | "ent_music"
  | "ent_sports"
  | "info_news"
  | "useful_review"
  | "other_other";

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
  probabilitiesJson: string;
}

export interface ClassificationResponse extends ClassificationResult {
  policyVersion: string;
  cached: boolean;
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
  policyVersion: string;
  probabilitiesJson: string | null;
}

export interface OverrideLogEntry {
  videoKey: string;
  url: string;
  title: string;
  channel: string;
  clientVersion: string;
}

export type FeedbackKind = "false-negative" | "false-positive";

export interface FeedbackLogEntry {
  videoKey: string;
  url: string;
  title: string;
  channel: string;
  clientVersion: string;
  category: string;
  confidence: number | null;
  kind: FeedbackKind;
  note: string;
}

const YOUTUBE_HOSTNAMES = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);

// The userscript calls us cross-origin from youtube.com. Echo the origin only
// for YouTube hosts; anything else (curl, etc.) keeps the wildcard.
function corsHeadersFor(request: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": "*",
  };
  try {
    const origin = request.headers.get("Origin") ?? "";
    if (YOUTUBE_HOSTNAMES.has(new URL(origin).hostname)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Vary"] = "Origin";
    }
  } catch {
    // No (or unparseable) Origin header: keep the wildcard.
  }
  return headers;
}

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
          study_tech: "プログラミング・技術解説・仕事術・開発",
          study_exam: "受験・資格勉強・語学学習",
          study_culture:
            "体系的な教養・科学・歴史・ドキュメンタリ・大学講義レベルの解説（雑学・トリビア・豆知識などの暇つぶしは除く）",
          ent_game: "ゲーム実況・配信・eスポーツ・攻略",
          ent_variety:
            "バラエティ・お笑い・切り抜き・リアクション・ドラマ/アニメ・Vlog雑談・雑学・トリビア・豆知識",
          ent_music: "音楽・MV・ライブ・歌ってみた・演奏",
          ent_sports: "スポーツ観戦・ハイライト・実況",
          info_news: "ニュース・時事・速報・政治・経済",
          useful_review: "ガジェット・商品レビュー・HowTo・DIY・比較検証",
          other_other: "上記のいずれにも当てはまらない",
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

  if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence)) {
    throw new Error("Invalid Jev confidence");
  }

  const probs = answer.probabilities ?? {};
  const probabilities = {
    study_tech: toProbability(probs.study_tech),
    study_exam: toProbability(probs.study_exam),
    study_culture: toProbability(probs.study_culture),
    ent_game: toProbability(probs.ent_game),
    ent_variety: toProbability(probs.ent_variety),
    ent_music: toProbability(probs.ent_music),
    ent_sports: toProbability(probs.ent_sports),
    info_news: toProbability(probs.info_news),
    useful_review: toProbability(probs.useful_review),
    other_other: toProbability(probs.other_other),
  };
  return {
    category: answer.choice,
    probabilities,
    confidence: answer.confidence,
    probabilitiesJson: JSON.stringify(probabilities),
  };
}

function toProbability(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
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
    signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
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
         jev_latency_ms, error, http_status, policy_version, probabilities_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      entry.policyVersion,
      entry.probabilitiesJson,
    )
    .run();
}

export async function writeOverrideLog(db: D1Database, entry: OverrideLogEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO override_logs
        (created_at, video_key, url, title, channel, client_version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      new Date().toISOString(),
      entry.videoKey,
      entry.url,
      entry.title,
      entry.channel,
      entry.clientVersion,
    )
    .run();
}

export async function writeFeedbackLog(db: D1Database, entry: FeedbackLogEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO feedback_logs
        (created_at, video_key, url, title, channel, client_version,
         category, confidence, kind, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      new Date().toISOString(),
      entry.videoKey,
      entry.url,
      entry.title,
      entry.channel,
      entry.clientVersion,
      entry.category,
      entry.confidence,
      entry.kind,
      entry.note,
    )
    .run();
}

interface ClassificationCacheRow {
  video_key: string;
  category: string;
  confidence: number | null;
  prob_study: number | null;
  prob_entertainment: number | null;
  prob_other: number | null;
  policy_version: string;
  updated_at: string;
  probabilities_json: string | null;
}

export async function readClassificationCache(
  db: D1Database,
  videoKey: string,
): Promise<ClassificationResult | null> {
  if (!videoKey) return null;
  let row: ClassificationCacheRow | null;
  try {
    row = await db
      .prepare(
        `SELECT video_key, category, confidence,
                prob_study, prob_entertainment, prob_other,
                probabilities_json,
                policy_version, updated_at
           FROM classification_cache
          WHERE video_key = ?`,
      )
      .bind(videoKey)
      .first<ClassificationCacheRow>();
  } catch {
    // Table missing (pre-migration DB) or D1 hiccup: fail open to Jev.
    return null;
  }
  if (!row || row.policy_version !== POLICY_VERSION || !isCategory(row.category)) {
    return null;
  }
  const updatedAt = Date.parse(row.updated_at ?? "");
  if (Number.isNaN(updatedAt) || Date.now() - updatedAt > CACHE_TTL_MS) {
    return null;
  }
  if (typeof row.confidence !== "number" || !Number.isFinite(row.confidence)) {
    return null;
  }
  // Prefer probabilities_json if available (new format), fall back to legacy columns
  let probabilities: Record<Category, number>;
  if (row.probabilities_json) {
    try {
      probabilities = JSON.parse(row.probabilities_json);
    } catch {
      probabilities = buildLegacyProbabilities(row);
    }
  } else {
    probabilities = buildLegacyProbabilities(row);
  }
  return {
    category: row.category,
    probabilities,
    confidence: row.confidence,
    probabilitiesJson: row.probabilities_json ?? JSON.stringify(probabilities),
  };
}

function buildLegacyProbabilities(row: ClassificationCacheRow): Record<Category, number> {
  return {
    study_tech: toProbability(row.prob_study),
    study_exam: 0,
    study_culture: 0,
    ent_game: 0,
    ent_variety: toProbability(row.prob_entertainment),
    ent_music: 0,
    ent_sports: 0,
    info_news: 0,
    useful_review: 0,
    other_other: toProbability(row.prob_other),
  };
}

export async function writeClassificationCache(
  db: D1Database,
  video: VideoMetadata,
  videoKey: string,
  result: ClassificationResult,
): Promise<void> {
  if (!videoKey) return;
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO classification_cache
         (video_key, url, title, channel, category, confidence,
          prob_study, prob_entertainment, prob_other,
          probabilities_json,
          policy_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(video_key) DO UPDATE SET
         url = excluded.url,
         title = excluded.title,
         channel = excluded.channel,
         category = excluded.category,
         confidence = excluded.confidence,
         prob_study = excluded.prob_study,
         prob_entertainment = excluded.prob_entertainment,
         prob_other = excluded.prob_other,
         probabilities_json = excluded.probabilities_json,
         policy_version = excluded.policy_version,
         updated_at = excluded.updated_at`,
    )
    .bind(
      videoKey,
      video.url,
      video.title,
      video.channel,
      result.category,
      result.confidence,
      result.probabilities.study_tech,
      result.probabilities.ent_variety,
      result.probabilities.other_other,
      result.probabilitiesJson,
      POLICY_VERSION,
      now,
      now,
    )
    .run();
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeadersFor(request) });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/logs") {
      return handleGetLogs(request, env);
    }

    if (request.method === "GET" && url.pathname === "/overrides") {
      return handleGetOverrides(request, env);
    }

    if (request.method === "POST" && url.pathname === "/allow") {
      if (!isAuthorized(request.headers.get("Authorization") ?? undefined, env.CLIENT_TOKEN)) {
        // Auth failures outside /classify are not written to classification_logs
        // so the classification history stays free of unrelated noise.
        return json({ error: "Unauthorized" }, 401, request);
      }
      return handleAllow(request, env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/feedback") {
      if (!isAuthorized(request.headers.get("Authorization") ?? undefined, env.CLIENT_TOKEN)) {
        return json({ error: "Unauthorized" }, 401, request);
      }
      return handleFeedback(request, env, ctx);
    }

    if (request.method === "GET" && url.pathname === "/feedback") {
      return handleGetFeedback(request, env);
    }

    if (request.method !== "POST" || url.pathname !== "/classify") {
      return json({ error: "Not found" }, 404, request);
    }

    if (!isAuthorized(request.headers.get("Authorization") ?? undefined, env.CLIENT_TOKEN)) {
      return unauthorized(request, env, ctx);
    }

    return handleClassify(request, env, ctx);
  },
};

async function unauthorized(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
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
  return json({ error: "Unauthorized" }, 401, request);
}

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
    return json({ error: message }, status, request);
  }

  const startedAt = Date.now();
  const videoKey = getVideoKey(video.url);

  if (videoKey && env.DB) {
    const cached = await readClassificationCache(env.DB, videoKey);
    if (cached) {
      const response: ClassificationResponse = {
        ...cached,
        policyVersion: POLICY_VERSION,
        cached: true,
      };
      console.log("jev_classification", {
        videoKey,
        title: video.title,
        channel: video.channel,
        clientVersion: video.clientVersion ?? "unknown",
        category: cached.category,
        confidence: cached.confidence,
        policyVersion: POLICY_VERSION,
        cached: true,
      });
      await flushLog(logSuccess(env, video, videoKey, cached, Date.now() - startedAt), ctx);
      return json(response, 200, request);
    }
  }

  try {
    const result = await classifyVideo(video, env.TYPESAFE_API_KEY);
    const response: ClassificationResponse = {
      ...result,
      policyVersion: POLICY_VERSION,
      cached: false,
    };
    console.log("jev_classification", {
      videoKey,
      title: video.title,
      channel: video.channel,
      clientVersion: video.clientVersion ?? "unknown",
      category: result.category,
      confidence: result.confidence,
      policyVersion: POLICY_VERSION,
      cached: false,
    });
    await flushLog(
      (async () => {
        await logSuccess(env, video, videoKey, result, Date.now() - startedAt);
        if (env.DB) {
          try {
            await writeClassificationCache(env.DB, video, videoKey, result);
          } catch (error) {
            console.error("jev_cache_write_error", {
              error: error instanceof Error ? error.message : "Unknown error",
            });
          }
        }
      })(),
      ctx,
    );
    return json(response, 200, request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
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
    // classifyVideo never throws "Invalid request": any failure here is upstream.
    return json({ error: message }, 502, request);
  }
}

async function handleGetLogs(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request.headers.get("Authorization") ?? undefined, env.CLIENT_TOKEN)) {
    return json({ error: "Unauthorized" }, 401, request);
  }

  if (!env.DB) {
    return json({ error: "Log store is not configured" }, 503, request);
  }

  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get("limit"), DEFAULT_LOGS_LIMIT, 1, MAX_LOGS_LIMIT);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, MAX_OFFSET);
  const category = url.searchParams.get("category") ?? "";
  const policyVersion = url.searchParams.get("policyVersion") ?? "";
  const videoKey = url.searchParams.get("videoKey") ?? "";
  const query = url.searchParams.get("q") ?? "";

  if (category !== "" && !isCategory(category)) {
    return json({ error: "Invalid category filter" }, 400, request);
  }

  const conditions: string[] = [];
  const bindings: Array<string | number> = [];
  if (category !== "") {
    conditions.push("category = ?");
    bindings.push(category);
  }
  if (policyVersion !== "") {
    conditions.push("policy_version = ?");
    bindings.push(policyVersion);
  }
  const search = buildSearchFilter(videoKey, query);
  conditions.push(...search.conditions);
  bindings.push(...search.bindings);
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
              prob_other, jev_latency_ms, error, http_status, policy_version
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
      request,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("jev_logs_error", { error: message });
    return json({ error: "Failed to read logs" }, 500, request);
  }
}

async function handleAllow(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (!env.DB) {
    return json({ error: "Log store is not configured" }, 503, request);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request JSON" }, 400, request);
  }

  if (!isRecord(body)) {
    return json({ error: "Invalid request body" }, 400, request);
  }

  const videoKey = stringField(body, "videoKey");
  const url = stringField(body, "url");
  const title = stringField(body, "title");
  const channel = stringField(body, "channel");
  const clientVersion = stringField(body, "clientVersion");

  if (!videoKey && !url) {
    return json({ error: "Invalid override payload" }, 400, request);
  }

  await flushLog(
    (async () => {
      try {
        await writeOverrideLog(env.DB as D1Database, {
          videoKey: videoKey || getVideoKey(url),
          url,
          title,
          channel,
          clientVersion,
        });
      } catch (error) {
        console.error("jev_log_write_error", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    })(),
    ctx,
  );
  return json({ ok: true }, 200, request);
}

async function handleGetOverrides(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request.headers.get("Authorization") ?? undefined, env.CLIENT_TOKEN)) {
    return json({ error: "Unauthorized" }, 401, request);
  }

  if (!env.DB) {
    return json({ error: "Log store is not configured" }, 503, request);
  }

  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get("limit"), DEFAULT_LOGS_LIMIT, 1, MAX_LOGS_LIMIT);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, MAX_OFFSET);
  const search = buildSearchFilter(
    url.searchParams.get("videoKey") ?? "",
    url.searchParams.get("q") ?? "",
  );
  const where = search.conditions.length > 0 ? `WHERE ${search.conditions.join(" AND ")}` : "";

  try {
    const countRow = (await env.DB.prepare(`SELECT COUNT(*) AS total FROM override_logs ${where}`)
      .bind(...search.bindings)
      .first<{ total: number }>()) ?? { total: 0 };
    const rows = await env.DB.prepare(
      `SELECT id, created_at, video_key, url, title, channel, client_version
         FROM override_logs ${where}
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
    )
      .bind(...search.bindings, limit, offset)
      .all<OverrideLogRow>();

    return json(
      {
        overrides: (rows.results ?? []).map(toOverrideApiEntry),
        total: countRow.total ?? 0,
        limit,
        offset,
      },
      200,
      request,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("jev_logs_error", { error: message });
    return json({ error: "Failed to read logs" }, 500, request);
  }
}

async function handleFeedback(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (!env.DB) {
    return json({ error: "Log store is not configured" }, 503, request);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request JSON" }, 400, request);
  }

  if (!isRecord(body)) {
    return json({ error: "Invalid request body" }, 400, request);
  }

  const videoKey = stringField(body, "videoKey");
  const url = stringField(body, "url");
  const title = stringField(body, "title");
  const channel = stringField(body, "channel");
  const clientVersion = stringField(body, "clientVersion");
  const category = stringField(body, "category");
  const note = stringField(body, "note");
  const kind = parseFeedbackKind(stringField(body, "kind"));
  const confidence = parseConfidence(body["confidence"]);

  if (!videoKey && !url) {
    return json({ error: "Invalid feedback payload" }, 400, request);
  }

  // Log-only: never auto-blocks. Triage happens by reading GET /feedback.
  await flushLog(
    (async () => {
      try {
        await writeFeedbackLog(env.DB as D1Database, {
          videoKey: videoKey || getVideoKey(url),
          url,
          title,
          channel,
          clientVersion,
          category,
          confidence,
          kind,
          note,
        });
      } catch (error) {
        console.error("jev_log_write_error", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    })(),
    ctx,
  );
  return json({ ok: true }, 200, request);
}

async function handleGetFeedback(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request.headers.get("Authorization") ?? undefined, env.CLIENT_TOKEN)) {
    return json({ error: "Unauthorized" }, 401, request);
  }

  if (!env.DB) {
    return json({ error: "Log store is not configured" }, 503, request);
  }

  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get("limit"), DEFAULT_LOGS_LIMIT, 1, MAX_LOGS_LIMIT);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, MAX_OFFSET);
  const search = buildSearchFilter(
    url.searchParams.get("videoKey") ?? "",
    url.searchParams.get("q") ?? "",
  );
  const where = search.conditions.length > 0 ? `WHERE ${search.conditions.join(" AND ")}` : "";

  try {
    const countRow = (await env.DB.prepare(`SELECT COUNT(*) AS total FROM feedback_logs ${where}`)
      .bind(...search.bindings)
      .first<{ total: number }>()) ?? { total: 0 };
    const rows = await env.DB.prepare(
      `SELECT id, created_at, video_key, url, title, channel, client_version,
              category, confidence, kind, note
         FROM feedback_logs ${where}
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
    )
      .bind(...search.bindings, limit, offset)
      .all<FeedbackLogRow>();

    return json(
      {
        feedbacks: (rows.results ?? []).map(toFeedbackApiEntry),
        total: countRow.total ?? 0,
        limit,
        offset,
      },
      200,
      request,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("jev_logs_error", { error: message });
    return json({ error: "Failed to read logs" }, 500, request);
  }
}

function parseFeedbackKind(value: string): FeedbackKind {
  return value === "false-positive" ? "false-positive" : "false-negative";
}

function parseConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function buildSearchFilter(
  videoKey: string,
  query: string,
): { conditions: string[]; bindings: Array<string | number> } {
  const conditions: string[] = [];
  const bindings: Array<string | number> = [];
  if (videoKey !== "") {
    conditions.push("video_key = ?");
    bindings.push(videoKey);
  }
  if (query !== "") {
    conditions.push(
      "(title LIKE ? ESCAPE '\\' OR channel LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')",
    );
    const pattern = `%${escapeLike(query)}%`;
    bindings.push(pattern, pattern, pattern);
  }
  return { conditions, bindings };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

interface OverrideLogRow {
  id: number;
  created_at: string;
  video_key: string;
  url: string;
  title: string;
  channel: string;
  client_version: string;
}

function toOverrideApiEntry(row: OverrideLogRow): Record<string, unknown> {
  return {
    id: row.id,
    createdAt: row.created_at,
    videoKey: row.video_key,
    url: row.url,
    title: row.title,
    channel: row.channel,
    clientVersion: row.client_version,
  };
}

interface FeedbackLogRow {
  id: number;
  created_at: string;
  video_key: string;
  url: string;
  title: string;
  channel: string;
  client_version: string;
  category: string;
  confidence: number | null;
  kind: string;
  note: string;
}

function toFeedbackApiEntry(row: FeedbackLogRow): Record<string, unknown> {
  return {
    id: row.id,
    createdAt: row.created_at,
    videoKey: row.video_key,
    url: row.url,
    title: row.title,
    channel: row.channel,
    clientVersion: row.client_version,
    category: row.category,
    confidence: row.confidence,
    kind: row.kind,
    note: row.note,
  };
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
  policy_version: string;
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
    policyVersion: row.policy_version,
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
    probStudy: result.probabilities.study_tech,
    probEntertainment: result.probabilities.ent_variety,
    probOther: result.probabilities.other_other,
    jevLatencyMs,
    error: null,
    httpStatus: 200,
    policyVersion: POLICY_VERSION,
    probabilitiesJson: result.probabilitiesJson,
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
    | "confidence"
    | "probStudy"
    | "probEntertainment"
    | "probOther"
    | "jevLatencyMs"
    | "category"
    | "policyVersion"
    | "probabilitiesJson"
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
      policyVersion: POLICY_VERSION,
      probabilitiesJson: null,
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
  return (
    value === "study_tech" ||
    value === "study_exam" ||
    value === "study_culture" ||
    value === "ent_game" ||
    value === "ent_variety" ||
    value === "ent_music" ||
    value === "ent_sports" ||
    value === "info_news" ||
    value === "useful_review" ||
    value === "other_other"
  );
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
  if (url.length > MAX_URL_LENGTH) {
    throw new Error("Invalid request metadata");
  }

  return {
    url,
    title: title.slice(0, MAX_TITLE_LENGTH),
    channel: channel.slice(0, MAX_CHANNEL_LENGTH),
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

function json(body: unknown, status: number, request: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeadersFor(request),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
