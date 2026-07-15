// Client routing (§4.2): real routes so the 4 remaining pages drop in as route components.
// Registration is generated from ROUTES (src/routes/index.ts) — add a page there, not here.
import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "./components/shell/AppShell.tsx";
import { ROUTES, DEFAULT_ROUTE } from "./routes/index.ts";

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to={DEFAULT_ROUTE} replace /> },
      ...ROUTES.map(({ path, element: Element }) => ({ path, element: <Element /> })),
      { path: "*", element: <Navigate to={DEFAULT_ROUTE} replace /> },
    ],
  },
]);
