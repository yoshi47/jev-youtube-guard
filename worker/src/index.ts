const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_DESCRIPTION_LENGTH = 8_000;

export type Category = "study" | "entertainment" | "other";

export interface Env {
  TYPESAFE_API_KEY: string;
  CLIENT_TOKEN: string;
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

const corsHeaders = {
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST" || new URL(request.url).pathname !== "/classify") {
      return json({ error: "Not found" }, 404);
    }

    if (!isAuthorized(request.headers.get("Authorization") ?? undefined, env.CLIENT_TOKEN)) {
      return json({ error: "Unauthorized" }, 401);
    }

    try {
      const video = await parseVideoMetadata(request);
      const result = await classifyVideo(video, env.TYPESAFE_API_KEY);
      console.warn("jev_classification", {
        clientVersion: video.clientVersion ?? "unknown",
        category: result.category,
        confidence: result.confidence,
      });
      return json(result, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status = message.startsWith("Invalid request") ? 400 : 502;
      return json({ error: message }, status);
    }
  },
};

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
