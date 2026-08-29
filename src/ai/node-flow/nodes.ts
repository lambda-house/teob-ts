// 19 node kinds for NodeFlow DAG flows. Cf. docs/porting/04-node-flow.md.

export type ErrorPolicy =
  | { kind: "fail_flow" }
  | { kind: "skip" }
  | { kind: "retry"; maxAttempts: number; backoffMs: number }
  | { kind: "compensate"; nodeId: string };

export interface ModelConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
}

export interface HttpRequestConfig {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  urlTemplate: string;
  headers?: Record<string, string>;
  bodyTemplate?: string;
}

export type NodeDef =
  | {
      kind: "http_call";
      method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
      urlTemplate: string;
      headers?: Record<string, string>;
      bodyTemplate?: string;
      responseMapping: Record<string, string>;
      errorPolicy: ErrorPolicy;
    }
  | { kind: "receive_message"; adapterIds: string[]; timeoutMs?: number }
  | {
      kind: "send_message";
      adapterId: string;
      templateId?: string;
      contentTemplate: string;
    }
  | {
      kind: "knowledge_lookup";
      queryTemplate: string;
      sources: string[];
      topK: number;
      resultAttribute: string;
      errorPolicy: ErrorPolicy;
    }
  | {
      kind: "llm_call";
      systemPromptTemplate?: string;
      userPromptTemplate: string;
      responseSchema?: unknown;
      tools: string[];
      maxToolIterations: number;
      modelConfig: ModelConfig;
      responseMapping: Record<string, string>;
      contextWindow?: number;
      thinkFirst?: boolean;
      backendId?: string;
      extraParams?: Record<string, unknown>;
    }
  | { kind: "attribute_op"; reads: string[]; writes: Record<string, string> }
  | {
      kind: "mcp_tool_exec";
      toolName: string;
      inputMapping: Record<string, string>;
      outputMapping: Record<string, string>;
      errorPolicy: ErrorPolicy;
    }
  | {
      kind: "human_approval";
      promptTemplate: string;
      approverRoles: string[];
      timeoutMs?: number;
      escalationPolicy?: "reject" | "auto_approve";
    }
  | {
      kind: "branch";
      predicateAttribute: string;
      branches: Map<unknown, string>;
    }
  | {
      kind: "sub_flow_start";
      flowDefinitionId: string;
      inputMapping: Record<string, string>;
      forEach?: string;
      concurrency?: number;
    }
  | { kind: "sub_flow_join"; flowDefinitionIds: string[]; timeoutMs?: number }
  | {
      kind: "user_choice";
      promptTemplate: string;
      optionTemplates: string[];
      timeoutMs?: number;
      resultAttribute: string;
    }
  | {
      kind: "plan";
      plannerPromptTemplate: string;
      goalTemplate: string;
      availableNodeTypes: string[];
      maxSteps: number;
      modelConfig: ModelConfig;
      responseMapping: Record<string, string>;
      errorPolicy: ErrorPolicy;
    }
  | {
      kind: "verify";
      promptTemplate: string;
      failAction: "retry" | "flag" | "block";
      maxRetries: number;
      modelConfig: ModelConfig;
      responseMapping: Record<string, string>;
      errorPolicy: ErrorPolicy;
    }
  | {
      kind: "merge";
      strategy: "concatenate" | "llm_synthesize" | "select_best";
      promptTemplate?: string;
      modelConfig?: ModelConfig;
      responseMapping: Record<string, string>;
      errorPolicy: ErrorPolicy;
    }
  | { kind: "delay"; durationMs: number }
  | {
      kind: "poll_until";
      submitRequest: HttpRequestConfig;
      jobIdPath: string;
      pollRequest: HttpRequestConfig;
      completionCondition: string;
      resultPath: string;
      pollIntervalMs: number;
      maxAttempts: number;
      timeoutMs?: number;
      errorPolicy: ErrorPolicy;
    }
  | {
      kind: "llm_extract";
      promptTemplate: string;
      outputSchema: unknown;
      modelConfig: ModelConfig;
      responseMapping: Record<string, string>;
      errorPolicy: ErrorPolicy;
    }
  | { kind: "wait_until"; cron?: string; durationMs?: number };

export type NodeKind = NodeDef["kind"];
