import { describe, it, expect } from "vitest";
import { SlackClient } from "../../../src/service/slack/client.js";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function makeFetchMock(handler: (req: CapturedRequest) => Response | Promise<Response>) {
  const captured: CapturedRequest[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = { url: String(input), init: init ?? {} };
    captured.push(req);
    return await handler(req);
  };
  return { fn: fn as typeof fetch, captured };
}

const silentLogger = () => {};

describe("SlackClient", () => {
  it("postMessage happy path returns ts", async () => {
    const { fn } = makeFetchMock(() =>
      new Response(JSON.stringify({ ok: true, ts: "1234.5678" }), { status: 200 }),
    );
    const c = new SlackClient({ botToken: "xoxb-test", fetch: fn, logger: silentLogger });
    const ts = await c.postMessage("C123", "hello");
    expect(ts).toBe("1234.5678");
  });

  it("postMessage 4xx returns undefined", async () => {
    const { fn } = makeFetchMock(() => new Response("bad", { status: 401 }));
    const c = new SlackClient({ botToken: "xoxb-test", fetch: fn, logger: silentLogger });
    const ts = await c.postMessage("C123", "hello");
    expect(ts).toBeUndefined();
  });

  it("postMessage 5xx returns undefined", async () => {
    const { fn } = makeFetchMock(() => new Response("err", { status: 502 }));
    const c = new SlackClient({ botToken: "xoxb-test", fetch: fn, logger: silentLogger });
    const ts = await c.postMessage("C123", "hello");
    expect(ts).toBeUndefined();
  });

  it("postMessage threads correctly when thread_ts provided", async () => {
    const { fn, captured } = makeFetchMock(() =>
      new Response(JSON.stringify({ ok: true, ts: "9.9" }), { status: 200 }),
    );
    const c = new SlackClient({ botToken: "xoxb-test", fetch: fn, logger: silentLogger });
    await c.postMessage("C123", "hello", "999.000");
    expect(captured).toHaveLength(1);
    const body = JSON.parse(String(captured[0].init.body));
    expect(body.thread_ts).toBe("999.000");
  });

  it("postMessage omits thread_ts when not provided", async () => {
    const { fn, captured } = makeFetchMock(() =>
      new Response(JSON.stringify({ ok: true, ts: "1.0" }), { status: 200 }),
    );
    const c = new SlackClient({ botToken: "xoxb-test", fetch: fn, logger: silentLogger });
    await c.postMessage("C123", "hello");
    const body = JSON.parse(String(captured[0].init.body));
    expect(body.thread_ts).toBeUndefined();
  });

  it("updateMessage happy returns true", async () => {
    const { fn } = makeFetchMock(() =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const c = new SlackClient({ botToken: "xoxb-test", fetch: fn, logger: silentLogger });
    expect(await c.updateMessage("C123", "1.0", "edited")).toBe(true);
  });

  it("addReaction happy returns true", async () => {
    const { fn } = makeFetchMock(() =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const c = new SlackClient({ botToken: "xoxb-test", fetch: fn, logger: silentLogger });
    expect(await c.addReaction("C123", "1.0", "thumbsup")).toBe(true);
  });

  it("addReaction already_reacted returns false", async () => {
    const { fn } = makeFetchMock(() =>
      new Response(JSON.stringify({ ok: false, error: "already_reacted" }), { status: 200 }),
    );
    const c = new SlackClient({ botToken: "xoxb-test", fetch: fn, logger: silentLogger });
    expect(await c.addReaction("C123", "1.0", "thumbsup")).toBe(false);
  });

  it("authTest returns raw response body", async () => {
    const { fn } = makeFetchMock(() =>
      new Response(JSON.stringify({ ok: true, user: "bot", team: "T1" }), { status: 200 }),
    );
    const c = new SlackClient({ botToken: "xoxb-test", fetch: fn, logger: silentLogger });
    const r = (await c.authTest()) as { ok: boolean; user: string; team: string };
    expect(r.ok).toBe(true);
    expect(r.user).toBe("bot");
    expect(r.team).toBe("T1");
  });

  it("sets Bearer token in Authorization header", async () => {
    const { fn, captured } = makeFetchMock(() =>
      new Response(JSON.stringify({ ok: true, ts: "1.0" }), { status: 200 }),
    );
    const c = new SlackClient({ botToken: "xoxb-mytoken", fetch: fn, logger: silentLogger });
    await c.postMessage("C123", "hi");
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xoxb-mytoken");
    expect(headers["Content-Type"]).toContain("application/json");
  });

  it("invalid JSON response returns falsy", async () => {
    const { fn } = makeFetchMock(() => new Response("not-json", { status: 200 }));
    const c = new SlackClient({ botToken: "xoxb-test", fetch: fn, logger: silentLogger });
    expect(await c.postMessage("C", "h")).toBeUndefined();
    expect(await c.updateMessage("C", "1.0", "x")).toBe(false);
  });

  it("postEphemeral happy returns true", async () => {
    const { fn } = makeFetchMock(() =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const c = new SlackClient({ botToken: "xoxb-test", fetch: fn, logger: silentLogger });
    expect(await c.postEphemeral("C123", "U1", "private")).toBe(true);
  });

  it("postEphemeral on api-level !ok returns false", async () => {
    const { fn } = makeFetchMock(() =>
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }),
    );
    const c = new SlackClient({ botToken: "xoxb-test", fetch: fn, logger: silentLogger });
    expect(await c.postEphemeral("C123", "U1", "x")).toBe(false);
  });

  it("network error returns falsy", async () => {
    const fn = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const c = new SlackClient({ botToken: "xoxb-test", fetch: fn, logger: silentLogger });
    expect(await c.postMessage("C", "h")).toBeUndefined();
  });
});
