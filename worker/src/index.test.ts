import { describe, expect, it, vi } from "vitest";
import {
  buildJevRequest,
  classifyVideo,
  isAuthorized,
  normalizeJevResponse,
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
});
