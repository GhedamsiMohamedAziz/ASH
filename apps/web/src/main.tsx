import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import "./globals.css";
import { router } from "./router.tsx";

// The design system is dark (control-room aesthetic, §4.5) — there is no light theme to toggle.
document.documentElement.classList.add("dark");

createRoot(document.getElementById("root")!).render(
  <RouterProvider router={router} future={{ v7_startTransition: true }} />
);
