import type { SignupFlowState } from "../api.js";

const placeColors: Record<string, string> = {
  Pending: "#a8d5e2",
  EmailChecked: "#ccc",
  Completed: "#c8e6c9",
  Rejected: "#ffcdd2",
};

const transitionColors: Record<string, string> = {
  NotStarted: "#eee",
  Ongoing: "#fff9c4",
  Completed: "#c8e6c9",
  Failed: "#ffcdd2",
};

export function FlowDiagram({ state }: { state: SignupFlowState }) {
  const places = Object.entries(state.places);
  const transitions = Object.entries(state.transitions);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Places */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {places.map(([pid, tokens]) => (
          <div
            key={pid}
            style={{
              border: "2px solid #999",
              borderRadius: 8,
              padding: 12,
              minWidth: 140,
              background: placeColors[pid] ?? "#f8f8f8",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{pid}</div>
            {tokens.length === 0 ? (
              <div style={{ fontSize: 11, color: "#999" }}>empty</div>
            ) : (
              tokens.map((token, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 11,
                    background: "rgba(255,255,255,0.7)",
                    borderRadius: 4,
                    padding: "2px 6px",
                    marginTop: 2,
                  }}
                >
                  {token.tag}
                  {token.email ? ` (${token.email})` : ""}
                </div>
              ))
            )}
          </div>
        ))}
      </div>

      {/* Transitions */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {transitions.map(([tid, status]) => (
          <div
            key={tid}
            style={{
              border: "1px solid #999",
              borderRadius: 4,
              padding: "8px 12px",
              background: transitionColors[status] ?? "#f8f8f8",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background:
                  status === "Completed" ? "#4caf50" :
                  status === "Ongoing" ? "#ff9800" :
                  status === "Failed" ? "#f44336" : "#bbb",
              }}
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{tid}</div>
              <div style={{ fontSize: 11, color: "#666" }}>{status}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
