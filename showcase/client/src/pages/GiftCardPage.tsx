import { useState } from "react";
import { giftCard } from "../api.js";

export function GiftCardPage() {
  const [cardId, setCardId] = useState("card-1");
  const [amount, setAmount] = useState(100);
  const [card, setCard] = useState<{ id: string; balance: number; status: string } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState("");

  function addLog(msg: string) {
    setLog((prev) => [...prev, `${new Date().toLocaleTimeString()} ${msg}`]);
    setError("");
  }

  async function doAction(action: () => Promise<unknown>, label: string) {
    try {
      await action();
      addLog(label);
      const state = await giftCard.get(cardId);
      setCard(state);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refresh() {
    try {
      const state = await giftCard.get(cardId);
      setCard(state);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Gift Card</h2>
      <p style={{ color: "#666", fontSize: 14 }}>
        Stateful aggregate with lifecycle: Empty → Active → Cancelled/Empty.
        Invariants enforce non-negative balance.
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "end", marginBottom: 16 }}>
        <label>
          <span style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Card ID</span>
          <input
            value={cardId}
            onChange={(e) => setCardId(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label>
          <span style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Amount</span>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            style={{ ...inputStyle, width: 80 }}
          />
        </label>
        <button style={btnStyle} onClick={() => doAction(() => giftCard.issue(cardId, amount), `Issued $${amount}`)}>
          Issue
        </button>
        <button style={btnStyle} onClick={() => doAction(() => giftCard.redeem(cardId, amount), `Redeemed $${amount}`)}>
          Redeem
        </button>
        <button style={{ ...btnStyle, background: "#fee" }} onClick={() => doAction(() => giftCard.cancel(cardId), "Cancelled")}>
          Cancel
        </button>
        <button style={{ ...btnStyle, background: "#eef" }} onClick={refresh}>
          Refresh
        </button>
      </div>

      {error && <div style={{ color: "red", marginBottom: 12, fontSize: 14 }}>{error}</div>}

      {card && (
        <div style={{ background: "#f8f8f8", padding: 16, borderRadius: 8, marginBottom: 16 }}>
          <div style={{ fontSize: 20, fontWeight: 600 }}>${card.balance.toFixed(2)}</div>
          <div style={{ fontSize: 12, color: "#666" }}>
            {card.id} — {card.status}
          </div>
        </div>
      )}

      {log.length > 0 && (
        <div>
          <h4 style={{ margin: "0 0 8px" }}>Event Log</h4>
          <div style={{ fontFamily: "monospace", fontSize: 12, lineHeight: 1.6 }}>
            {log.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
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
