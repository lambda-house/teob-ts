import { useState, useEffect } from "react";
import { Layout } from "./components/Layout.js";
import { GiftCardPage } from "./pages/GiftCardPage.js";
import { TodoPage } from "./pages/TodoPage.js";
import { SignupPage } from "./pages/SignupPage.js";
import { ChatPage } from "./pages/ChatPage.js";
import { system } from "./api.js";

type Page = "gift-card" | "todo" | "signup" | "chat";

export function App() {
  const [page, setPage] = useState<Page>("gift-card");
  const [aiEnabled, setAiEnabled] = useState(false);

  useEffect(() => {
    system.describe().then((d) => setAiEnabled(d.aiEnabled)).catch(() => {});
  }, []);

  return (
    <Layout currentPage={page} onNavigate={setPage} aiEnabled={aiEnabled}>
      {page === "gift-card" && <GiftCardPage />}
      {page === "todo" && <TodoPage />}
      {page === "signup" && <SignupPage />}
      {page === "chat" && <ChatPage aiEnabled={aiEnabled} />}
    </Layout>
  );
}
