import type { ReactNode } from "react";

type Page = "gift-card" | "todo" | "signup" | "chat";

const navItems: Array<{ id: Page; label: string; concept: string }> = [
  { id: "gift-card", label: "Gift Card", concept: "Pure Aggregate" },
  { id: "todo", label: "Todo List", concept: "List Aggregate" },
  { id: "signup", label: "Signup Flow", concept: "Petri Net" },
  { id: "chat", label: "AI Chat", concept: "LLM + Tools" },
];

export function Layout({
  currentPage,
  onNavigate,
  aiEnabled,
  children,
}: {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  aiEnabled: boolean;
  children: ReactNode;
}) {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 900, margin: "0 auto", padding: "20px" }}>
      <header style={{ marginBottom: 32 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>TEOB-TS Showcase</h1>
        <p style={{ margin: "4px 0 0", color: "#666", fontSize: 14 }}>
          Event-sourcing framework demo
          {aiEnabled ? " \u2022 AI enabled" : " \u2022 AI disabled"}
        </p>
      </header>

      <nav style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            style={{
              padding: "8px 16px",
              border: currentPage === item.id ? "2px solid #333" : "1px solid #ccc",
              borderRadius: 6,
              background: currentPage === item.id ? "#f0f0f0" : "white",
              cursor: "pointer",
              fontWeight: currentPage === item.id ? 600 : 400,
            }}
          >
            {item.label}
            <span style={{ display: "block", fontSize: 11, color: "#888" }}>{item.concept}</span>
          </button>
        ))}
      </nav>

      <main>{children}</main>
    </div>
  );
}
