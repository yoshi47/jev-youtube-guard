import { describe, expect, it, vi } from "vitest";
import {
  buildJevRequest,
  classifyVideo,
  getVideoKey,
  isAuthorized,
  normalizeJevResponse,
  readClassificationCache,
  toLogDescriptionPrefix,
  writeClassificationCache,
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
    });
  });
});

describe("normalizeJevResponse", () => {
  it("returns the category, probabilities, and confidence", () => {
    const response: JevResponse = {
      answers: {
        category: {
          choice: "ent_variety",
          probabilities: {
            study_tech: 0.01,
            study_exam: 0.01,
            study_culture: 0.01,
            ent_game: 0.01,
            ent_variety: 0.94,
            ent_music: 0.01,
            ent_sports: 0.01,
            info_news: 0.01,
            useful_review: 0.01,
            other_other: 0.01,
          },
          confidence: 0.92,
        },
      },
    };

    expect(normalizeJevResponse(response)).toEqual({
      category: "ent_variety",
      probabilities: {
        study_tech: 0.01,
        study_exam: 0.01,
        study_culture: 0.01,
        ent_game: 0.01,
        ent_variety: 0.94,
        ent_music: 0.01,
        ent_sports: 0.01,
        info_news: 0.01,
        useful_review: 0.01,
        other_other: 0.01,
      },
      confidence: 0.92,
      probabilitiesJson: JSON.stringify({
        study_tech: 0.01,
        study_exam: 0.01,
        study_culture: 0.01,
        ent_game: 0.01,
        ent_variety: 0.94,
        ent_music: 0.01,
        ent_sports: 0.01,
        info_news: 0.01,
        useful_review: 0.01,
        other_other: 0.01,
      }),
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
              choice: "study_tech",
              probabilities: {
                study_tech: 0.9,
                study_exam: 0.02,
                study_culture: 0.02,
                ent_game: 0.01,
                ent_variety: 0.01,
                ent_music: 0.01,
                ent_sports: 0.01,
                info_news: 0.01,
                useful_review: 0.01,
                other_other: 0.01,
              },
              confidence: 0.8,
            },
          },
        }),
        { status: 200 },
      ),
    );

    await expect(classifyVideo(video, "jev-key", fetcher)).resolves.toMatchObject({
      category: "study_tech",
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
              choice: "ent_variety",
              probabilities: {
                study_tech: 0.01,
                study_exam: 0.01,
                study_culture: 0.01,
                ent_game: 0.01,
                ent_variety: 0.94,
                ent_music: 0.01,
                ent_sports: 0.01,
                info_news: 0.01,
                useful_review: 0.01,
                other_other: 0.01,
              },
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
        category: "ent_variety",
        confidence: 0.88,
        policyVersion: "2",
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

  it("blocks only high-confidence blocked categories", () => {
    expect(policy.shouldBlock({ category: "ent_game", confidence: 0.6 })).toBe(true);
    expect(policy.shouldBlock({ category: "ent_variety", confidence: 0.6 })).toBe(true);
    expect(policy.shouldBlock({ category: "ent_sports", confidence: 0.6 })).toBe(true);
    expect(policy.shouldBlock({ category: "useful_review", confidence: 0.6 })).toBe(true);
    expect(policy.shouldBlock({ category: "ent_game", confidence: 0.59 })).toBe(false);
    expect(policy.shouldBlock({ category: "useful_review", confidence: 0.59 })).toBe(false);
    expect(policy.shouldBlock({ category: "study_tech", confidence: 0.99 })).toBe(false);
    expect(policy.shouldBlock({ category: "study_culture", confidence: 0.99 })).toBe(false);
    expect(policy.shouldBlock({ category: "info_news", confidence: 0.99 })).toBe(false);
    expect(policy.shouldBlock({ category: "ent_music", confidence: 0.99 })).toBe(false);
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
          choice: "ent_variety",
          probabilities: {
            study_tech: 0.01,
            study_exam: 0.01,
            study_culture: 0.01,
            ent_game: 0.01,
            ent_variety: 0.94,
            ent_music: 0.01,
            ent_sports: 0.01,
            info_news: 0.01,
            useful_review: 0.01,
            other_other: 0.01,
          },
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
      category: "study_tech",
      confidence: 0.9,
      probStudy: 0.9,
      probEntertainment: 0.05,
      probOther: 0.05,
      jevLatencyMs: 123,
      error: null,
      httpStatus: 200,
      policyVersion: "2",
      probabilitiesJson: JSON.stringify({
        study_tech: 0.9,
        study_exam: 0,
        study_culture: 0,
        ent_game: 0,
        ent_variety: 0.05,
        ent_music: 0,
        ent_sports: 0,
        info_news: 0,
        useful_review: 0,
        other_other: 0.05,
      }),
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(statements[0]?.sql).toContain("INSERT INTO classification_logs");
    expect(statements[0]?.params).toEqual(
      expect.arrayContaining(["abc", "study_tech", 0.9, 0.05, 0.05, 200, "2"]),
    );
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
      await expect(response.json()).resolves.toMatchObject({ cached: false });
      // Log write + cache write.
      expect(run).toHaveBeenCalledTimes(2);
      const logStatement = statements.find((s) =>
        s.sql.includes("INSERT INTO classification_logs"),
      );
      expect(logStatement?.params).toEqual(
        expect.arrayContaining([
          "abc",
          "https://www.youtube.com/watch?v=abc",
          "東大入試数学を解説します",
          "数学解説チャンネル",
          "大学受験向けの数学講義です",
          "",
          "ent_variety",
          0.88,
          0.01,
          0.94,
          0.01,
          200,
          "2",
        ]),
      );
      const cacheStatement = statements.find((s) =>
        s.sql.includes("INSERT INTO classification_cache"),
      );
      expect(cacheStatement?.params).toEqual(expect.arrayContaining(["abc", "ent_variety", 0.88]));
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
      const logStatement = statements.find((s) =>
        s.sql.includes("INSERT INTO classification_logs"),
      );
      expect(logStatement?.params).toEqual(expect.arrayContaining(["abc", 502]));
      const params = logStatement?.params ?? [];
      // [..., jevLatencyMs, error, httpStatus, policyVersion, probabilitiesJson]
      // error is at index params.length - 4
      expect(params[params.length - 4]).toMatch(/Jev request failed/);
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
      category: "ent_variety",
      confidence: 0.88,
      prob_study: 0.02,
      prob_entertainment: 0.96,
      prob_other: 0.02,
      jev_latency_ms: 100,
      error: null,
      http_status: 200,
      policy_version: "2",
      probabilities_json: JSON.stringify({
        study_tech: 0.01,
        study_exam: 0.01,
        study_culture: 0.01,
        ent_game: 0.01,
        ent_variety: 0.94,
        ent_music: 0.01,
        ent_sports: 0.01,
        info_news: 0.01,
        useful_review: 0.01,
        other_other: 0.01,
      }),
    };
    const { db } = createMockDb({ total: 1 }, { results: [row] });
    const response = await worker.fetch(
      new Request("https://guard.example/logs?limit=10&category=ent_variety", {
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
        expect.objectContaining({
          videoKey: "abc",
          category: "ent_variety",
          httpStatus: 200,
          policyVersion: "2",
        }),
      ],
    });
  });

  it("filters logs by policy version", async () => {
    const { db, statements } = createMockDb({ total: 0 }, { results: [] });
    const response = await worker.fetch(
      new Request("https://guard.example/logs?policyVersion=2", {
        headers: { Authorization: "Bearer client" },
      }),
      { TYPESAFE_API_KEY: "jev-key", CLIENT_TOKEN: "client", DB: db },
    );

    expect(response.status).toBe(200);
    expect(statements[0]?.sql).toContain("policy_version = ?");
    expect(statements[0]?.params).toEqual(expect.arrayContaining(["2"]));
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
  it("rejects a request without the client token without touching classification logs", async () => {
    const { db, run } = createMockDb();
    const response = await worker.fetch(allowRequest({ videoKey: "abc" }, "Bearer wrong"), {
      TYPESAFE_API_KEY: "jev-key",
      CLIENT_TOKEN: "client",
      DB: db,
    });

    expect(response.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
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

function feedbackRequest(body: unknown, token = "Bearer client") {
  return new Request("https://guard.example/feedback", {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /feedback", () => {
  it("rejects a request without the client token without touching classification logs", async () => {
    const { db, run } = createMockDb();
    const response = await worker.fetch(feedbackRequest({ videoKey: "abc" }, "Bearer wrong"), {
      TYPESAFE_API_KEY: "jev-key",
      CLIENT_TOKEN: "client",
      DB: db,
    });

    expect(response.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns 503 when no log store is configured", async () => {
    const response = await worker.fetch(feedbackRequest({ videoKey: "abc" }), {
      TYPESAFE_API_KEY: "jev-key",
      CLIENT_TOKEN: "client",
    });

    expect(response.status).toBe(503);
  });

  it("rejects feedback without videoKey or url", async () => {
    const { db, run } = createMockDb();
    const response = await worker.fetch(feedbackRequest({ title: "only" }), {
      TYPESAFE_API_KEY: "jev-key",
      CLIENT_TOKEN: "client",
      DB: db,
    });

    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("writes a false-negative feedback row with the Jev judgment", async () => {
    const { db, run, statements } = createMockDb();
    const response = await worker.fetch(
      feedbackRequest({
        videoKey: "abc",
        url: "https://www.youtube.com/watch?v=abc",
        title: "title",
        channel: "channel",
        clientVersion: "0.5.0",
        category: "study",
        confidence: 0.72,
        kind: "false-negative",
        note: "",
      }),
      { TYPESAFE_API_KEY: "jev-key", CLIENT_TOKEN: "client", DB: db },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(statements[0]?.sql).toContain("INSERT INTO feedback_logs");
    expect(statements[0]?.params).toEqual(
      expect.arrayContaining(["abc", "title", "channel", "0.5.0", "study", 0.72, "false-negative"]),
    );
  });

  it("defaults an unknown kind to false-negative", async () => {
    const { db, run, statements } = createMockDb();
    const response = await worker.fetch(feedbackRequest({ videoKey: "abc", kind: "bogus" }), {
      TYPESAFE_API_KEY: "jev-key",
      CLIENT_TOKEN: "client",
      DB: db,
    });

    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    expect(statements[0]?.params).toEqual(expect.arrayContaining(["false-negative"]));
  });
});

describe("GET /feedback", () => {
  it("rejects a request without the client token", async () => {
    const { db } = createMockDb();
    const response = await worker.fetch(new Request("https://guard.example/feedback"), {
      TYPESAFE_API_KEY: "jev-key",
      CLIENT_TOKEN: "client",
      DB: db,
    });

    expect(response.status).toBe(401);
  });

  it("returns 503 when no log store is configured", async () => {
    const response = await worker.fetch(
      new Request("https://guard.example/feedback", {
        headers: { Authorization: "Bearer client" },
      }),
      { TYPESAFE_API_KEY: "jev-key", CLIENT_TOKEN: "client" },
    );

    expect(response.status).toBe(503);
  });

  it("returns feedbacks with total, limit, and offset", async () => {
    const row = {
      id: 3,
      created_at: "2026-09-21T00:00:00.000Z",
      video_key: "abc",
      url: "https://www.youtube.com/watch?v=abc",
      title: "title",
      channel: "channel",
      client_version: "0.5.0",
      category: "study",
      confidence: 0.72,
      kind: "false-negative",
      note: "",
    };
    const { db } = createMockDb({ total: 1 }, { results: [row] });
    const response = await worker.fetch(
      new Request("https://guard.example/feedback?limit=10&videoKey=abc", {
        headers: { Authorization: "Bearer client" },
      }),
      { TYPESAFE_API_KEY: "jev-key", CLIENT_TOKEN: "client", DB: db },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      limit: 10,
      offset: 0,
      feedbacks: [
        expect.objectContaining({ videoKey: "abc", kind: "false-negative", category: "study" }),
      ],
    });
  });
});

describe("Response hardening", () => {
  it("rejects a non-numeric Jev confidence instead of storing it", () => {
    expect(() =>
      normalizeJevResponse({
        answers: {
          category: { choice: "study_tech", probabilities: {}, confidence: Number.NaN },
        },
      }),
    ).toThrow("Invalid Jev confidence");
  });

  it("defaults missing Jev probabilities to 0", () => {
    expect(
      normalizeJevResponse({
        answers: {
          category: { choice: "study_tech", probabilities: {}, confidence: 0.7 },
        },
      }),
    ).toMatchObject({
      category: "study_tech",
      probabilities: {
        study_tech: 0,
        study_exam: 0,
        study_culture: 0,
        ent_game: 0,
        ent_variety: 0,
        ent_music: 0,
        ent_sports: 0,
        info_news: 0,
        useful_review: 0,
        other_other: 0,
      },
    });
  });

  it("sends an abort signal so a hung Jev cannot hold the Worker forever", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jevSuccessResponse());
    await classifyVideo({ ...video }, "jev-key", fetcher);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("truncates overlong titles before logging", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(jevSuccessResponse());
    const { db, run, statements } = createMockDb();
    try {
      const response = await worker.fetch(classifyRequest({ ...video, title: "x".repeat(600) }), {
        TYPESAFE_API_KEY: "jev-key",
        CLIENT_TOKEN: "client",
        DB: db,
      });

      expect(response.status).toBe(200);
      expect(run).toHaveBeenCalledTimes(2);
      const logStatement = statements.find((s) =>
        s.sql.includes("INSERT INTO classification_logs"),
      );
      expect(logStatement?.params[3]).toHaveLength(500);
    } finally {
      fetcher.mockRestore();
    }
  });

  it("escapes LIKE wildcards in the log search query", async () => {
    const { db, statements } = createMockDb({ total: 0 }, { results: [] });
    const response = await worker.fetch(
      new Request("https://guard.example/logs?q=100%25", {
        headers: { Authorization: "Bearer client" },
      }),
      { TYPESAFE_API_KEY: "jev-key", CLIENT_TOKEN: "client", DB: db },
    );

    expect(response.status).toBe(200);
    expect(statements[0]?.sql).toContain("ESCAPE");
    expect(statements[0]?.params).toEqual(expect.arrayContaining(["%100\\%%"]));
  });

  it("echoes YouTube origins and keeps the wildcard otherwise", async () => {
    const env = { TYPESAFE_API_KEY: "jev-key", CLIENT_TOKEN: "client" } as Env;
    const youtube = await worker.fetch(
      new Request("https://guard.example/logs", {
        headers: { Origin: "https://www.youtube.com" },
      }),
      env,
    );
    const other = await worker.fetch(new Request("https://guard.example/logs"), env);

    expect(youtube.headers.get("Access-Control-Allow-Origin")).toBe("https://www.youtube.com");
    expect(youtube.headers.get("Vary")).toBe("Origin");
    expect(other.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("Classification cache", () => {
  const cachedRow = {
    video_key: "abc",
    category: "study_tech",
    confidence: 0.9,
    prob_study: 0.9,
    prob_entertainment: 0.05,
    prob_other: 0.05,
    probabilities_json: JSON.stringify({
      study_tech: 0.9,
      study_exam: 0,
      study_culture: 0,
      ent_game: 0,
      ent_variety: 0.05,
      ent_music: 0,
      ent_sports: 0,
      info_news: 0,
      useful_review: 0,
      other_other: 0.05,
    }),
    policy_version: "2",
    updated_at: new Date().toISOString(),
  };

  it("serves a fresh same-policy entry without calling Jev", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const { db, run } = createMockDb(cachedRow, { results: [] });
    try {
      const response = await worker.fetch(classifyRequest(video), {
        TYPESAFE_API_KEY: "jev-key",
        CLIENT_TOKEN: "client",
        DB: db,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        category: "study_tech",
        confidence: 0.9,
        policyVersion: "2",
        cached: true,
      });
      expect(fetcher).not.toHaveBeenCalled();
      // Cache read does not write; only the request log writes.
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      fetcher.mockRestore();
    }
  });

  it("ignores a stale entry and refreshes it from Jev", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(jevSuccessResponse());
    const stale = {
      ...cachedRow,
      updated_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const { db } = createMockDb(stale, { results: [] });
    try {
      const response = await worker.fetch(classifyRequest(video), {
        TYPESAFE_API_KEY: "jev-key",
        CLIENT_TOKEN: "client",
        DB: db,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        category: "ent_variety",
        cached: false,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      fetcher.mockRestore();
    }
  });

  it("ignores an entry from a previous policy version", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(jevSuccessResponse());
    const { db } = createMockDb({ ...cachedRow, policy_version: "0" }, { results: [] });
    try {
      const response = await worker.fetch(classifyRequest(video), {
        TYPESAFE_API_KEY: "jev-key",
        CLIENT_TOKEN: "client",
        DB: db,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ cached: false });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      fetcher.mockRestore();
    }
  });

  it("readClassificationCache fails open when the table is missing", async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: () => ({
          first: vi.fn().mockRejectedValue(new Error("no such table")),
        }),
      })),
    } as unknown as D1Database;

    await expect(readClassificationCache(db, "abc")).resolves.toBeNull();
  });

  it("writeClassificationCache upserts by video key", async () => {
    const { db, statements } = createMockDb();
    await writeClassificationCache(db, video, "abc", {
      category: "study_tech",
      probabilities: {
        study_tech: 0.9,
        study_exam: 0,
        study_culture: 0,
        ent_game: 0,
        ent_variety: 0.05,
        ent_music: 0,
        ent_sports: 0,
        info_news: 0,
        useful_review: 0,
        other_other: 0.05,
      },
      confidence: 0.9,
      probabilitiesJson: JSON.stringify({
        study_tech: 0.9,
        study_exam: 0,
        study_culture: 0,
        ent_game: 0,
        ent_variety: 0.05,
        ent_music: 0,
        ent_sports: 0,
        info_news: 0,
        useful_review: 0,
        other_other: 0.05,
      }),
    });

    expect(statements[0]?.sql).toContain("INSERT INTO classification_cache");
    expect(statements[0]?.sql).toContain("ON CONFLICT(video_key)");
    expect(statements[0]?.params).toEqual(expect.arrayContaining(["abc", "study_tech", 0.9, "2"]));
  });
});
