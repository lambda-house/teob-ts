import type { SlackApiResponse } from "./types.js";

export interface SlackClientOpts {
  botToken: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  logger?: (level: "warn" | "error", message: string, meta?: unknown) => void;
}

export class SlackClient {
  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly logger: (level: "warn" | "error", message: string, meta?: unknown) => void;

  constructor(opts: SlackClientOpts) {
    this.botToken = opts.botToken;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.baseUrl = opts.baseUrl ?? "https://slack.com/api";
    this.logger = opts.logger ?? ((level, msg, meta) => {
      const m = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
      if (level === "error") console.error(`[slack] ${msg}${m}`);
      else console.warn(`[slack] ${msg}${m}`);
    });
  }

  private async call(method: string, body: Record<string, unknown>): Promise<SlackApiResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.botToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger("error", `${method} network error`, { error: String(err) });
      return { ok: false, error: `network_error: ${String(err)}` };
    }

    if (!res.ok) {
      this.logger("error", `${method} HTTP ${res.status}`);
      return { ok: false, error: `http_${res.status}` };
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      this.logger("error", `${method} parse error`, { error: String(err) });
      return { ok: false, error: "parse_error" };
    }

    if (typeof parsed !== "object" || parsed === null) {
      this.logger("error", `${method} unexpected response shape`);
      return { ok: false, error: "bad_response" };
    }

    const r = parsed as SlackApiResponse;
    if (!r.ok) {
      this.logger("error", `${method} api error: ${r.error ?? "unknown"}`);
    }
    return r;
  }

  async postMessage(channel: string, text: string, threadTs?: string): Promise<string | undefined> {
    const body: Record<string, unknown> = { channel, text };
    if (threadTs) body.thread_ts = threadTs;
    const r = await this.call("chat.postMessage", body);
    return r.ok ? r.ts : undefined;
  }

  async updateMessage(channel: string, ts: string, text: string): Promise<boolean> {
    const r = await this.call("chat.update", { channel, ts, text });
    return r.ok;
  }

  async postEphemeral(channel: string, user: string, text: string): Promise<boolean> {
    const r = await this.call("chat.postEphemeral", { channel, user, text });
    return r.ok;
  }

  async addReaction(channel: string, ts: string, emoji: string): Promise<boolean> {
    const r = await this.call("reactions.add", { channel, timestamp: ts, name: emoji });
    return r.ok;
  }

  async authTest(): Promise<unknown> {
    return await this.call("auth.test", {});
  }
}
