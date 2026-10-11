import { StrictMode, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Loading } from "./components/ui";
import { AppProvider, useApp } from "./lib/app";
import { Admin } from "./pages/Admin";
import { Archive } from "./pages/Archive";
import { ArticlePage } from "./pages/Article";
import { Auth } from "./pages/Auth";
import { Live } from "./pages/Live";
import { QuickReads } from "./pages/QuickReads";
import { Saved } from "./pages/Saved";
import { SearchPage } from "./pages/Search";
import { Section } from "./pages/Section";
import { Settings } from "./pages/Settings";
import { Sources } from "./pages/Sources";
import { StoryPage } from "./pages/Story";
import { TopicPage, Topics } from "./pages/Topics";
import { Today } from "./pages/Today";
import "./styles.css";

function ScrollAndFocus() {
  const loc = useLocation();
  useEffect(() => {
    if (loc.hash) {
      const el = document.getElementById(loc.hash.slice(1));
      if (el) {
        el.scrollIntoView();
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [loc.pathname, loc.hash]);
  return null;
}

function Gate({ children }: { children: ReactNode }) {
  const { session } = useApp();
  if (!session) {
    return (
      <div className="auth">
        <div className="box">
          <Loading lines={3} />
        </div>
      </div>
    );
  }
  if (!session.user) return <Auth />;
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="page">
      <h1 className="hl hl-l">Page not found</h1>
      <p className="page-sub">That page does not exist. Use the navigation to find your way back.</p>
    </div>
  );
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { session } = useApp();
  return session?.user?.isAdmin ? <>{children}</> : <Navigate to="/" replace />;
}

function App() {
  return (
    <Gate>
      <Layout>
        <ScrollAndFocus />
        <Routes>
          <Route path="/" element={<Today />} />
          <Route path="/quick-reads" element={<QuickReads />} />
          <Route path="/quick-reads/:id" element={<QuickReads />} />
          <Route path="/live" element={<Live />} />
          <Route path="/section/:key" element={<Section />} />
          <Route path="/story/:id" element={<StoryPage />} />
          <Route path="/article/:id" element={<ArticlePage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/topics" element={<Topics />} />
          <Route path="/topics/:id" element={<TopicPage />} />
          <Route path="/saved" element={<Saved />} />
          <Route path="/archive" element={<Archive />} />
          <Route path="/sources" element={<Sources />} />
          <Route path="/settings" element={<Settings />} />
          <Route
            path="/admin/*"
            element={
              <AdminOnly>
                <Admin />
              </AdminOnly>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Layout>
    </Gate>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </StrictMode>,
);
