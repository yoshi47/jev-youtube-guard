import { describe, expect, it, vi } from "vitest";
import {
  buildJevRequest,
  classifyVideo,
  getVideoKey,
  isAuthorized,
  normalizeJevResponse,
  toLogDescriptionPrefix,
  writeClassificationLog,
  type Env,
  type JevResponse,
  type VideoMetadata,
} from "./index";
import worker from "./index";
// oxlint-disable-next-line import/no-unassigned-import
import "../../userscripts/jev-youtube-guard.user.js";

const video: VideoMetadata = {
  url: "https://www.youtube.com/watch?v=abc",
  title: "東大入試数学を解説します",
  channel: "数学解説チャンネル",
  description: "大学受験向けの数学講義です",
};

describe("isAuthorized", () => {
  it("accepts only the configured bearer token", () => {
    expect(isAuthorized("Bearer personal-token", "personal-token")).toBe(true);
    expect(isAuthorized("Bearer wrong-token", "personal-token")).toBe(false);
    expect(isAuthorized(undefined, "personal-token")).toBe(false);
  });
});

describe("buildJevRequest", () => {
  it("asks Jev to classify a video into the supported categories", () => {
    expect(buildJevRequest(video)).toEqual({
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
    });
  });
});

describe("normalizeJevResponse", () => {
  it("returns the category, probabilities, and confidence", () => {
    const response: JevResponse = {
      answers: {
        category: {
          choice: "entertainment",
          probabilities: { study: 0.01, entertainment: 0.98, other: 0.01 },
          confidence: 0.92,
        },
      },
    };

    expect(normalizeJevResponse(response)).toEqual({
      category: "entertainment",
      probabilities: { study: 0.01, entertainment: 0.98, other: 0.01 },
      confidence: 0.92,
    });
  });

  it("rejects an unknown category instead of allowing an unsafe response", () => {
    expect(() =>
      normalizeJevResponse({
        answers: {
          category: {
            choice: "unknown",
            probabilities: {},
            confidence: 0.9,
          },
        },
      }),
    ).toThrow("Invalid Jev category");
  });
});

describe("classifyVideo", () => {
  it("calls Jev with the API key and normalizes the response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            category: {
              choice: "study",
              probabilities: { study: 0.9, entertainment: 0.05, other: 0.05 },
              confidence: 0.8,
            },
          },
        }),
        { status: 200 },
      ),
    );

    await expect(classifyVideo(video, "jev-key", fetcher)).resolves.toMatchObject({
      category: "study",
      confidence: 0.8,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.typesafe.ai/v1/systemone",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer jev-key",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it("throws on an unsuccessful Jev response", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("upstream failure", { status: 503 }));

    await expect(classifyVideo(video, "jev-key", fetcher)).rejects.toThrow(
      "Jev request failed: 503",
    );
  });
});

describe("Env", () => {
  it("documents the Worker secret boundary", () => {
    const env: Env = { TYPESAFE_API_KEY: "jev-key", CLIENT_TOKEN: "client" };
    expect(env.TYPESAFE_API_KEY).toBe("jev-key");
  });
});

describe("Worker fetch handler", () => {
  it("answers CORS preflight without calling Jev", async () => {
    const response = await worker.fetch(
      new Request("https://guard.example/classify", { method: "OPTIONS" }),
      { TYPESAFE_API_KEY: "jev-key", CLIENT_TOKEN: "client" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("rejects a request without the client token", async () => {
    const response = await worker.fetch(
      new Request("https://guard.example/classify", {
        method: "POST",
        body: JSON.stringify(video),
      }),
      { TYPESAFE_API_KEY: "jev-key", CLIENT_TOKEN: "client" },
    );

    expect(response.status).toBe(401);
  });

  it("classifies an authorized video through Jev", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          answers: {
            category: {
              choice: "entertainment",
              probabilities: { study: 0.02, entertainment: 0.96, other: 0.02 },
              confidence: 0.88,
            },
          },
        }),
        { status: 200 },
      ),
    );

    try {
      const response = await worker.fetch(
        new Request("https://guard.example/classify", {
          method: "POST",
          headers: {
            Authorization: "Bearer client",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(video),
        }),
        { TYPESAFE_API_KEY: "jev-key", CLIENT_TOKEN: "client" },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        category: "entertainment",
        confidence: 0.88,
      });
    } finally {
      fetcher.mockRestore();
    }
  });
});

describe("Userscript policy", () => {
  const policy = globalThis.JevYouTubeGuardPolicy;

  it("targets only YouTube video and Shorts pages", () => {
    expect(policy.isTargetPage("https://www.youtube.com/watch?v=abc")).toBe(true);
    expect(policy.isTargetPage("https://www.youtube.com/shorts/abc")).toBe(true);
    expect(policy.isTargetPage("https://m.youtube.com/watch?v=abc")).toBe(true);
    expect(policy.isTargetPage("https://www.youtube.com/")).toBe(false);
    expect(policy.isTargetPage("https://www.youtube.com/results?search_query=math")).toBe(false);
  });

  it("blocks only high-confidence entertainment results", () => {
    expect(policy.shouldBlock({ category: "entertainment", confidence: 0.6 })).toBe(true);
    expect(policy.shouldBlock({ category: "entertainment", confidence: 0.59 })).toBe(false);
    expect(policy.shouldBlock({ category: "study", confidence: 0.99 })).toBe(false);
  });

  it("enables debug mode via query, hash, or localStorage flag", () => {
    expect(policy.isDebugEnabled("https://www.youtube.com/watch?v=abc&jevdebug=1")).toBe(true);
    expect(policy.isDebugEnabled("https://www.youtube.com/watch?v=abc#jevdebug")).toBe(true);
    expect(policy.isDebugEnabled("https://www.youtube.com/watch?v=abc")).toBe(false);
    expect(policy.isDebugEnabled("not a url")).toBe(false);
  });
});

function jevSuccessResponse() {
  return new Response(
    JSON.stringify({
      answers: {
        category: {
          choice: "entertainment",
          probabilities: { study: 0.02, entertainment: 0.96, other: 0.02 },
          confidence: 0.88,
        },
      },
    }),
    { status: 200 },
  );
}

function classifyRequest(body: unknown, token = "Bearer client") {
  return new Request("https://guard.example/classify", {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface MockDb {
  db: D1Database;
  run: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  statements: Array<{ sql: string; params: Array<unknown> }>;
}

function createMockDb(
  firstResult: unknown = { total: 0 },
  allResult: unknown = { results: [] },
): MockDb {
  const statements: Array<{ sql: string; params: Array<unknown> }> = [];
  const run = vi.fn().mockResolvedValue({ success: true });
  const first = vi.fn().mockResolvedValue(firstResult);
  const all = vi.fn().mockResolvedValue(allResult);
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...params: Array<unknown>) => {
        statements.push({ sql, params });
        return { run, first, all };
      },
    })),
  } as unknown as D1Database;
  return { db, run, first, all, statements };
}

describe("getVideoKey", () => {
  it("extracts watch and shorts keys", () => {
    expect(getVideoKey("https://www.youtube.com/watch?v=abc123")).toBe("abc123");
    expect(getVideoKey("https://www.youtube.com/shorts/xyz")).toBe("xyz");
    expect(getVideoKey("https://www.youtube.com/")).toBe("");
    expect(getVideoKey("not a url")).toBe("");
  });
});

describe("toLogDescriptionPrefix", () => {
  it("keeps only the first 500 characters", () => {
    expect(toLogDescriptionPrefix("a".repeat(600))).toHaveLength(500);
    expect(toLogDescriptionPrefix("short")).toBe("short");
  });
});

describe("writeClassificationLog", () => {
  it("inserts a log row with bound values", async () => {
    const { db, run, statements } = createMockDb();
    await writeClassificationLog(db, {
      videoKey: "abc",
      url: "https://www.youtube.com/watch?v=abc",
      title: "title",
      channel: "channel",
      descriptionPrefix: "desc",
      clientVersion: "0.1.3",
      category: "study",
      confidence: 0.9,
      probStudy: 0.9,
      probEntertainment: 0.05,
      probOther: 0.05,
      jevLatencyMs: 123,
      error: null,
      httpStatus: 200,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(statements[0]?.sql).toContain("INSERT INTO classification_logs");
    expect(statements[0]?.params).toEqual(expect.arrayContaining(["abc", "study", 0.9, 200]));
  });
});

describe("Classification logging on /classify", () => {
  it("writes a success log with video metadata and the result", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(jevSuccessResponse());
    const { db, run, statements } = createMockDb();
    try {
      const response = await worker.fetch(classifyRequest(video), {
        TYPESAFE_API_KEY: "jev-key",
        CLIENT_TOKEN: "client",
        DB: db,
      });

      expect(response.status).toBe(200);
      expect(run).toHaveBeenCalledTimes(1);
      expect(statements[0]?.params).toEqual(
        expect.arrayContaining([
          "abc",
          "https://www.youtube.com/watch?v=abc",
          "東大入試数学を解説します",
          "entertainment",
          0.88,
          200,
        ]),
      );
    } finally {
      fetcher.mockRestore();
    }
  });

  it("writes an error log when Jev fails", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("upstream failure", { status: 503 }));
    const { db, run, statements } = createMockDb();
    try {
      const response = await worker.fetch(classifyRequest(video), {
        TYPESAFE_API_KEY: "jev-key",
        CLIENT_TOKEN: "client",
        DB: db,
      });

      expect(response.status).toBe(502);
      expect(run).toHaveBeenCalledTimes(1);
      expect(statements[0]?.params).toEqual(expect.arrayContaining(["abc", 502]));
      const errorIndex = (statements[0]?.params.length ?? 0) - 2;
      expect(statements[0]?.params[errorIndex]).toMatch(/Jev request failed/);
    } finally {
      fetcher.mockRestore();
    }
  });

  it("writes an error log for invalid request metadata", async () => {
    const { db, run, statements } = createMockDb();
    const response = await worker.fetch(classifyRequest({ title: "only" }), {
      TYPESAFE_API_KEY: "jev-key",
      CLIENT_TOKEN: "client",
      DB: db,
    });

    expect(response.status).toBe(400);
    expect(run).toHaveBeenCalledTimes(1);
    expect(statements[0]?.params).toEqual(expect.arrayContaining([400]));
  });

  it("writes an unauthorized log when the token is wrong", async () => {
    const { db, run, statements } = createMockDb();
    const response = await worker.fetch(classifyRequest(video, "Bearer wrong"), {
      TYPESAFE_API_KEY: "jev-key",
      CLIENT_TOKEN: "client",
      DB: db,
    });

    expect(response.status).toBe(401);
    expect(run).toHaveBeenCalledTimes(1);
    expect(statements[0]?.params).toEqual(expect.arrayContaining(["Unauthorized", 401]));
  });

  it("still classifies when no log store is configured", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(jevSuccessResponse());
    try {
      const response = await worker.fetch(classifyRequest(video), {
        TYPESAFE_API_KEY: "jev-key",
        CLIENT_TOKEN: "client",
      });

      expect(response.status).toBe(200);
    } finally {
      fetcher.mockRestore();
    }
  });
});

describe("GET /logs", () => {
  it("rejects a request without the client token", async () => {
    const { db } = createMockDb();
    const response = await worker.fetch(new Request("https://guard.example/logs"), {
      TYPESAFE_API_KEY: "jev-key",
      CLIENT_TOKEN: "client",
      DB: db,
    });

    expect(response.status).toBe(401);
  });

  it("returns 503 when no log store is configured", async () => {
    const response = await worker.fetch(
      new Request("https://guard.example/logs", {
        headers: { Authorization: "Bearer client" },
      }),
      { TYPESAFE_API_KEY: "jev-key", CLIENT_TOKEN: "client" },
    );

    expect(response.status).toBe(503);
  });

  it("rejects an invalid category filter", async () => {
    const { db, all } = createMockDb();
    const response = await worker.fetch(
      new Request("https://guard.example/logs?category=bogus", {
        headers: { Authorization: "Bearer client" },
      }),
      { TYPESAFE_API_KEY: "jev-key", CLIENT_TOKEN: "client", DB: db },
    );

    expect(response.status).toBe(400);
    expect(all).not.toHaveBeenCalled();
  });

  it("returns logs with total, limit, and offset", async () => {
    const row = {
      id: 1,
      created_at: "2026-09-20T00:00:00.000Z",
      video_key: "abc",
      url: "https://www.youtube.com/watch?v=abc",
      title: "title",
      channel: "channel",
      description_prefix: "desc",
      client_version: "0.1.3",
      category: "entertainment",
      confidence: 0.88,
      prob_study: 0.02,
      prob_entertainment: 0.96,
      prob_other: 0.02,
      jev_latency_ms: 100,
      error: null,
      http_status: 200,
    };
    const { db } = createMockDb({ total: 1 }, { results: [row] });
    const response = await worker.fetch(
      new Request("https://guard.example/logs?limit=10&category=entertainment", {
        headers: { Authorization: "Bearer client" },
      }),
      { TYPESAFE_API_KEY: "jev-key", CLIENT_TOKEN: "client", DB: db },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      limit: 10,
      offset: 0,
      logs: [
        expect.objectContaining({ videoKey: "abc", category: "entertainment", httpStatus: 200 }),
      ],
    });
  });
});

function allowRequest(body: unknown, token = "Bearer client") {
  return new Request("https://guard.example/allow", {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /allow", () => {
  it("rejects a request without the client token and logs it", async () => {
    const { db, run, statements } = createMockDb();
    const response = await worker.fetch(allowRequest({ videoKey: "abc" }, "Bearer wrong"), {
      TYPESAFE_API_KEY: "jev-key",
      CLIENT_TOKEN: "client",
      DB: db,
    });

    expect(response.status).toBe(401);
    expect(run).toHaveBeenCalledTimes(1);
    expect(statements[0]?.params).toEqual(expect.arrayContaining(["Unauthorized", 401]));
  });

  it("returns 503 when no log store is configured", async () => {
    const response = await worker.fetch(allowRequest({ videoKey: "abc" }), {
      TYPESAFE_API_KEY: "jev-key",
      CLIENT_TOKEN: "client",
    });

    expect(response.status).toBe(503);
  });

  it("rejects an override without videoKey or url", async () => {
    const { db, run } = createMockDb();
    const response = await worker.fetch(allowRequest({ title: "only" }), {
      TYPESAFE_API_KEY: "jev-key",
      CLIENT_TOKEN: "client",
      DB: db,
    });

    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("writes an override log row", async () => {
    const { db, run, statements } = createMockDb();
    const response = await worker.fetch(
      allowRequest({
        videoKey: "abc",
        url: "https://www.youtube.com/watch?v=abc",
        title: "title",
        channel: "channel",
        clientVersion: "0.3.0",
      }),
      { TYPESAFE_API_KEY: "jev-key", CLIENT_TOKEN: "client", DB: db },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(statements[0]?.sql).toContain("INSERT INTO override_logs");
    expect(statements[0]?.params).toEqual(
      expect.arrayContaining(["abc", "title", "channel", "0.3.0"]),
    );
  });
});

describe("GET /overrides", () => {
  it("rejects a request without the client token", async () => {
    const { db } = createMockDb();
    const response = await worker.fetch(new Request("https://guard.example/overrides"), {
      TYPESAFE_API_KEY: "jev-key",
      CLIENT_TOKEN: "client",
      DB: db,
    });

    expect(response.status).toBe(401);
  });

  it("returns 503 when no log store is configured", async () => {
    const response = await worker.fetch(
      new Request("https://guard.example/overrides", {
        headers: { Authorization: "Bearer client" },
      }),
      { TYPESAFE_API_KEY: "jev-key", CLIENT_TOKEN: "client" },
    );

    expect(response.status).toBe(503);
  });

  it("returns overrides with total, limit, and offset", async () => {
    const row = {
      id: 2,
      created_at: "2026-09-20T01:00:00.000Z",
      video_key: "abc",
      url: "https://www.youtube.com/watch?v=abc",
      title: "title",
      channel: "channel",
      client_version: "0.3.0",
    };
    const { db } = createMockDb({ total: 1 }, { results: [row] });
    const response = await worker.fetch(
      new Request("https://guard.example/overrides?limit=10&videoKey=abc", {
        headers: { Authorization: "Bearer client" },
      }),
      { TYPESAFE_API_KEY: "jev-key", CLIENT_TOKEN: "client", DB: db },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      limit: 10,
      offset: 0,
      overrides: [expect.objectContaining({ videoKey: "abc", title: "title" })],
    });
  });
});
