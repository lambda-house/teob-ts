const BASE = "/api";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch<T>(url: string): Promise<T> {
  return request<T>(url, { method: "PATCH" });
}

function del<T>(url: string): Promise<T> {
  return request<T>(url, { method: "DELETE" });
}

// Gift Card
export const giftCard = {
  issue: (id: string, amount: number) =>
    post<{ status: string }>(`${BASE}/gift-cards/${id}/issue`, { amount }),
  redeem: (id: string, amount: number) =>
    post<{ status: string }>(`${BASE}/gift-cards/${id}/redeem`, { amount }),
  cancel: (id: string) =>
    post<{ status: string }>(`${BASE}/gift-cards/${id}/cancel`, {}),
  get: (id: string) =>
    request<{ id: string; balance: number; status: string }>(`${BASE}/gift-cards/${id}`),
};

// Todo
export interface TodoItem {
  itemId: string;
  title: string;
  completed: boolean;
  createdAt: string;
}

export const todo = {
  addItem: (listId: string, title: string) =>
    post<{ itemId: string }>(`${BASE}/todos/${listId}/items`, { title }),
  complete: (listId: string, itemId: string) =>
    patch<{ status: string }>(`${BASE}/todos/${listId}/items/${itemId}/complete`),
  uncomplete: (listId: string, itemId: string) =>
    patch<{ status: string }>(`${BASE}/todos/${listId}/items/${itemId}/uncomplete`),
  remove: (listId: string, itemId: string) =>
    del<{ status: string }>(`${BASE}/todos/${listId}/items/${itemId}`),
  get: (listId: string) =>
    request<{ listId: string; items: TodoItem[] }>(`${BASE}/todos/${listId}`),
};

// Signup
export interface SignupFlowState {
  flowId: string;
  places: Record<string, Array<{ tag: string; [key: string]: unknown }>>;
  transitions: Record<string, string>;
  outcome?: string;
}

export const signup = {
  start: (email: string, password: string) =>
    post<{ flowId: string; status: string }>(`${BASE}/signup`, { email, password }),
  getState: (flowId: string) =>
    request<SignupFlowState>(`${BASE}/signup/${flowId}`),
};

// Chat
export interface ChatResponse {
  response: string;
  toolCalls?: Array<{ name: string; result: unknown }>;
}

export const chat = {
  createSession: (systemPrompt?: string) =>
    post<{ sessionId: string }>(`${BASE}/chat/sessions`, { systemPrompt }),
  sendMessage: (sessionId: string, message: string) =>
    post<ChatResponse>(`${BASE}/chat/sessions/${sessionId}/messages`, { message }),
  getMessages: (sessionId: string) =>
    request<{ messages: Array<{ role: string; content: string }> }>(
      `${BASE}/chat/sessions/${sessionId}/messages`,
    ),
  deleteSession: (sessionId: string) =>
    del<{ status: string }>(`${BASE}/chat/sessions/${sessionId}`),
};

// System
export const system = {
  describe: () =>
    request<{
      aggregates: Array<{ category: string; commands: string[] }>;
      aiEnabled: boolean;
    }>(`${BASE}/describe`),
};
