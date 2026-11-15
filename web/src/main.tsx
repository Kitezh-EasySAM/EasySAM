import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "@fontsource/ibm-plex-sans/cyrillic-400.css";
import "@fontsource/ibm-plex-sans/cyrillic-500.css";
import "@fontsource/ibm-plex-sans/cyrillic-600.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles/app.css";
import Layout from "./components/Layout.tsx";
import { AuthGate } from "./api/auth.tsx";
import Agents from "./pages/Agents.tsx";
import AgentDetail from "./pages/AgentDetail.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import Catalog from "./pages/Catalog.tsx";
import CatalogDetail from "./pages/CatalogDetail.tsx";
import Purchases from "./pages/Purchases.tsx";
import Events from "./pages/Events.tsx";
import Settings from "./pages/Settings.tsx";
import Assistant from "./pages/Assistant.tsx";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="agents" element={<Agents />} />
            <Route path="agents/setup" element={<Agents />} />
            <Route path="agents/:id/:tab?" element={<AgentDetail />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="catalog" element={<Catalog />} />
            <Route path="catalog/unmatched" element={<Catalog />} />
            <Route path="catalog/:id" element={<CatalogDetail />} />
            <Route path="purchases" element={<Purchases />} />
            <Route path="unmatched" element={<Navigate to="/catalog/unmatched" replace />} />
            <Route path="events" element={<Events />} />
            <Route path="settings/:tab?" element={<Settings />} />
            {/* старые адреса «Ввода данных»: программы и закупки — на своих страницах, остальное — в «Настройках» */}
            <Route path="data" element={<Navigate to="/settings" replace />} />
            <Route path="data/catalog" element={<Navigate to="/catalog" replace />} />
            <Route path="data/purchases" element={<Navigate to="/purchases" replace />} />
            {["employees", "keys", "installs", "users"].map((t) => (
              <Route key={t} path={`data/${t}`} element={<Navigate to={`/settings/${t}`} replace />} />
            ))}
            <Route path="assistant" element={<Assistant />} />
            <Route path="*" element={<Navigate to="/agents" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthGate>
  </React.StrictMode>,
);
