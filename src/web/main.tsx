import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { AuthProvider, RequireAuth } from "./auth";
import { AppShell } from "./components/app-shell";
import { InboxPage } from "./pages/inbox";
import { LoginPage } from "./pages/login";
import { SignupPage } from "./pages/signup";
import "./styles.css";

const DashboardPage = lazy(() => import("./pages/dashboard").then((module) => ({ default: module.DashboardPage })));
const CustomersPage = lazy(() => import("./pages/customers").then((module) => ({ default: module.CustomersPage })));
const TeamPage = lazy(() => import("./pages/team").then((module) => ({ default: module.TeamPage })));
const SettingsPage = lazy(() => import("./pages/settings").then((module) => ({ default: module.SettingsPage })));
const PlaceholderPage = lazy(() => import("./pages/placeholder").then((module) => ({ default: module.PlaceholderPage })));
const AcceptInvitePage = lazy(() => import("./pages/accept-invite").then((module) => ({ default: module.AcceptInvitePage })));
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: true, retry: 1 } } });
const deferred = (element: React.ReactNode) => <Suspense fallback={<div className="route-loading" aria-label="Loading page" />}>{element}</Suspense>;

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/signup", element: <SignupPage /> },
  { path: "/accept-invite", element: deferred(<AcceptInvitePage />) },
  {
    element: <RequireAuth />,
    children: [{
      element: <AppShell />,
      children: [
        { index: true, element: <Navigate to="/inbox" replace /> },
        { path: "/dashboard", element: deferred(<DashboardPage />) },
        { path: "/inbox/:ticketId?", element: <InboxPage /> },
        { path: "/tickets", element: <Navigate to="/inbox" replace /> },
        { path: "/customers", element: deferred(<CustomersPage />) },
        { path: "/knowledge-base", element: deferred(<PlaceholderPage title="Knowledge Base" description="Turn repeat answers into dependable customer documentation." />) },
        { path: "/reports", element: deferred(<PlaceholderPage title="Reports" description="Operational reporting will grow from real ticket and activity data." />) },
        { path: "/automations", element: deferred(<PlaceholderPage title="Automations" description="Rules will arrive after the core support workflow is proven." />) },
        { path: "/team", element: deferred(<TeamPage />) },
        { path: "/settings", element: deferred(<SettingsPage />) },
      ],
    }],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>
    </AuthProvider>
  </StrictMode>,
);
