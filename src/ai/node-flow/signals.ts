export type NodeExecutionSignal =
  | { __signal: "completed"; output: unknown }
  | { __signal: "blocking" }
  | {
      __signal: "child_flow_started";
      childFlowId: string;
      configId: string;
      parentNodeId: string;
      itemIndex?: number;
    }
  | { __signal: "poll_initiated"; jobId: string; attempt: number; response: unknown }
  | { __signal: "poll_incomplete"; jobId: string; attempt: number; response: unknown }
  | { __signal: "poll_complete"; result: unknown }
  | { __signal: "retry_poll" };

export function isSignal(v: unknown): v is NodeExecutionSignal {
  return (
    typeof v === "object" &&
    v !== null &&
    "__signal" in (v as object) &&
    typeof (v as { __signal: unknown }).__signal === "string"
  );
}
