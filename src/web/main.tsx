import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { AuthProvider, RequireAuth } from "./auth";
import { AppShell } from "./components/app-shell";
import { CustomersPage } from "./pages/customers";
import { DashboardPage } from "./pages/dashboard";
import { InboxPage } from "./pages/inbox";
import { LoginPage } from "./pages/login";
import { PlaceholderPage } from "./pages/placeholder";
import { SignupPage } from "./pages/signup";
import { TeamPage } from "./pages/team";
import "./styles.css";

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/signup", element: <SignupPage /> },
  {
    element: <RequireAuth />,
    children: [{
      element: <AppShell />,
      children: [
        { index: true, element: <Navigate to="/inbox" replace /> },
        { path: "/dashboard", element: <DashboardPage /> },
        { path: "/inbox/:ticketId?", element: <InboxPage /> },
        { path: "/tickets", element: <Navigate to="/inbox" replace /> },
        { path: "/customers", element: <CustomersPage /> },
        { path: "/knowledge-base", element: <PlaceholderPage title="Knowledge Base" description="Turn repeat answers into dependable customer documentation." /> },
        { path: "/reports", element: <PlaceholderPage title="Reports" description="Operational reporting will grow from real ticket and activity data." /> },
        { path: "/automations", element: <PlaceholderPage title="Automations" description="Rules will arrive after the core support workflow is proven." /> },
        { path: "/team", element: <TeamPage /> },
        { path: "/settings", element: <PlaceholderPage title="Settings" description="Workspace identity, mail providers, security, and support preferences." /> },
      ],
    }],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
