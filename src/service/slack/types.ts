export interface SlackPostMessage {
  channel: string;
  text: string;
  thread_ts?: string;
}

export interface SlackUpdateMessage {
  channel: string;
  ts: string;
  text: string;
}

export interface SlackPostEphemeral {
  channel: string;
  user: string;
  text: string;
}

export interface SlackAddReaction {
  channel: string;
  timestamp: string;
  name: string;
}

export interface SlackApiResponse {
  ok: boolean;
  ts?: string;
  error?: string;
  [key: string]: unknown;
}
