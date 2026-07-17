import { useState, useEffect, useRef } from "react";
import { signup, type SignupFlowState } from "../api.js";
import { FlowDiagram } from "../components/FlowDiagram.js";

export function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [flowId, setFlowId] = useState<string | null>(null);
  const [flowState, setFlowState] = useState<SignupFlowState | null>(null);
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  useEffect(() => () => stopPolling(), []);

  async function doSignup() {
    if (!email || !password) return;
    setError("");
    setFlowState(null);
    try {
      const result = await signup.start(email, password);
      setFlowId(result.flowId);

      // Poll for flow state
      stopPolling();
      let pollCount = 0;
      const poll = async () => {
        try {
          const state = await signup.getState(result.flowId);
          setFlowState(state);
          if (state.outcome || pollCount > 20) stopPolling();
          pollCount++;
        } catch {}
      };
      await poll();
      pollRef.current = setInterval(poll, 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Signup Flow</h2>
      <p style={{ color: "#666", fontSize: 14 }}>
        Petri Net driven workflow. Tokens flow through places; transitions fire automatically.
        Try signing up with the same email twice to see the rejection path.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          style={inputStyle}
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          type="password"
          style={inputStyle}
        />
        <button style={btnStyle} onClick={doSignup}>Sign Up</button>
      </div>

      {error && <div style={{ color: "red", marginBottom: 12, fontSize: 14 }}>{error}</div>}

      {flowState && (
        <div>
          <div style={{ marginBottom: 12, fontSize: 14 }}>
            <strong>Flow:</strong> {flowId}
            {flowState.outcome && (
              <span
                style={{
                  marginLeft: 12,
                  padding: "2px 8px",
                  borderRadius: 4,
                  fontSize: 12,
                  fontWeight: 600,
                  background: flowState.outcome === "completed" ? "#d4edda" : "#f8d7da",
                  color: flowState.outcome === "completed" ? "#155724" : "#721c24",
                }}
              >
                {flowState.outcome}
              </span>
            )}
          </div>
          <FlowDiagram state={flowState} />
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
