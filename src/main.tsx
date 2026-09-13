import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthGuard } from "./components/AuthGuard";
import "./styles.css";

// Route-level code splitting: the login page must not download the app bundle
// (assistant UI, markdown, ontology panels) and the app must not download the login page.
const App = lazy(() => import("./App"));
const LoginPage = lazy(() => import("./components/LoginPage").then((m) => ({ default: m.LoginPage })));
const SharedConversationPage = lazy(() => import("./components/SharedConversationPage"));
const KnowledgeInviteAcceptPage = lazy(() => import("./components/KnowledgeInviteAcceptPage"));

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/share/chat/:token" element={<SharedConversationPage />} />
            <Route path="/share/invite" element={<AuthGuard><KnowledgeInviteAcceptPage /></AuthGuard>} />
            <Route path="/*" element={<AuthGuard><App /></AuthGuard>} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
