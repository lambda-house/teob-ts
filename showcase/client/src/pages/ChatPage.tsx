import { useState, useRef, useEffect } from "react";
import { chat } from "../api.js";

interface Message {
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{ name: string; result: unknown }>;
}

export function ChatPage({ aiEnabled }: { aiEnabled: boolean }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function startSession() {
    try {
      const result = await chat.createSession();
      setSessionId(result.sessionId);
      setMessages([]);
    } catch {}
  }

  async function sendMessage() {
    if (!sessionId || !input.trim() || loading) return;
    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setLoading(true);

    try {
      const result = await chat.sendMessage(sessionId, userMsg);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: result.response, toolCalls: result.toolCalls },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${err instanceof Error ? err.message : String(err)}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  if (!aiEnabled) {
    return (
      <div>
        <h2 style={{ marginTop: 0 }}>AI Chat</h2>
        <div style={{ background: "#fff3cd", border: "1px solid #ffc107", borderRadius: 8, padding: 16 }}>
          <strong>AI not configured.</strong> Set <code>OPENAI_API_KEY</code> or{" "}
          <code>OPENROUTER_API_KEY</code> environment variable and restart the server.
          <p style={{ marginBottom: 0, fontSize: 14, color: "#666", marginTop: 8 }}>
            The AI chat can query gift card balances, todo lists, and search framework documentation
            using tool calls.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>AI Chat</h2>
      <p style={{ color: "#666", fontSize: 14 }}>
        Chat with an AI that can query your entities. Try: "What's the balance on card-1?"
        or "What is TEOB?"
      </p>

      {!sessionId ? (
        <button style={btnStyle} onClick={startSession}>Start Chat Session</button>
      ) : (
        <div>
          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: 8,
              height: 400,
              overflowY: "auto",
              padding: 12,
              marginBottom: 12,
              background: "#fafafa",
            }}
          >
            {messages.length === 0 && (
              <p style={{ color: "#999", textAlign: "center", marginTop: 160 }}>
                Start a conversation...
              </p>
            )}
            {messages.map((msg, i) => (
              <div key={i} style={{ marginBottom: 12 }}>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: 12,
                    color: msg.role === "user" ? "#1976d2" : "#388e3c",
                    marginBottom: 2,
                  }}
                >
                  {msg.role === "user" ? "You" : "Assistant"}
                </div>
                <div style={{ fontSize: 14, whiteSpace: "pre-wrap" }}>{msg.content}</div>
                {msg.toolCalls && msg.toolCalls.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    {msg.toolCalls.map((tc, j) => (
                      <div
                        key={j}
                        style={{
                          fontSize: 11,
                          fontFamily: "monospace",
                          background: "#e8eaf6",
                          borderRadius: 4,
                          padding: "4px 8px",
                          marginTop: 4,
                        }}
                      >
                        tool: {tc.name} → {JSON.stringify(tc.result).slice(0, 100)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {loading && (
              <div style={{ color: "#999", fontSize: 13 }}>Thinking...</div>
            )}
            <div ref={messagesEnd} />
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              placeholder="Type a message..."
              disabled={loading}
              style={{ ...inputStyle, flex: 1 }}
            />
            <button style={btnStyle} onClick={sendMessage} disabled={loading}>
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #ccc",
  borderRadius: 4,
  fontSize: 14,
};

const btnStyle: React.CSSProperties = {
  padding: "6px 14px",
  border: "1px solid #ccc",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 14,
  background: "#fff",
};
