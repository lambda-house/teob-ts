import { useState } from "react";
import { todo, type TodoItem } from "../api.js";

export function TodoPage() {
  const [listId, setListId] = useState("my-list");
  const [title, setTitle] = useState("");
  const [items, setItems] = useState<TodoItem[]>([]);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      const data = await todo.get(listId);
      setItems(data.items);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function addItem() {
    if (!title.trim()) return;
    try {
      await todo.addItem(listId, title.trim());
      setTitle("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleItem(item: TodoItem) {
    try {
      if (item.completed) {
        await todo.uncomplete(listId, item.itemId);
      } else {
        await todo.complete(listId, item.itemId);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeItem(itemId: string) {
    try {
      await todo.remove(listId, itemId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Todo List</h2>
      <p style={{ color: "#666", fontSize: 14 }}>
        List-bearing aggregate. Each add/complete/remove is an event, and the list
        is reconstructed by replaying events.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <label>
          <span style={{ display: "block", fontSize: 12, marginBottom: 4 }}>List ID</span>
          <input
            value={listId}
            onChange={(e) => setListId(e.target.value)}
            style={inputStyle}
          />
        </label>
        <button style={{ ...btnStyle, alignSelf: "end" }} onClick={refresh}>
          Load
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addItem()}
          placeholder="Add a todo item..."
          style={{ ...inputStyle, flex: 1 }}
        />
        <button style={btnStyle} onClick={addItem}>Add</button>
      </div>

      {error && <div style={{ color: "red", marginBottom: 12, fontSize: 14 }}>{error}</div>}

      <div>
        {items.length === 0 && (
          <p style={{ color: "#999", fontSize: 14 }}>No items. Click "Load" to fetch or add items above.</p>
        )}
        {items.map((item) => (
          <div
            key={item.itemId}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "8px 0",
              borderBottom: "1px solid #eee",
            }}
          >
            <input
              type="checkbox"
              checked={item.completed}
              onChange={() => toggleItem(item)}
              style={{ cursor: "pointer" }}
            />
            <span style={{ flex: 1, textDecoration: item.completed ? "line-through" : "none", color: item.completed ? "#999" : "#333" }}>
              {item.title}
            </span>
            <span style={{ fontSize: 11, color: "#aaa" }}>{item.itemId.slice(0, 8)}</span>
            <button
              onClick={() => removeItem(item.itemId)}
              style={{ ...btnStyle, padding: "2px 8px", fontSize: 12, color: "red", borderColor: "#fcc" }}
            >
              remove
            </button>
          </div>
        ))}
      </div>
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
