import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";

function LoadingSpinner() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
    </div>
  );
}

/**
 * ✅ Home por rol (single source of truth)
 * - operario: "/"
 * - operario_maquinaria: "/OperarioMaquinaria"
 * - operario_cuadrilla: "/OperarioCuadrilla"
 * - supervisor: "/supervisor"
 * - supervisor_cuadrilla: "/supervisor/cuadrilla"
 */
function getHomeByRole(role: string | null) {
  switch (role) {
    case "operario_maquinaria":
      return "/OperarioMaquinaria";
    case "operario_cuadrilla":
      return "/OperarioCuadrilla";
    case "supervisor":
      return "/supervisor";
    case "supervisor_cuadrilla":
      return "/supervisor/cuadrilla";
    case "operario":
    default:
      return "/";
  }
}

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, role } = useAuth();
  const location = useLocation();

  if (isLoading) return <LoadingSpinner />;
  if (!user) return <Navigate to="/auth" replace />;

  // ✅ Si entra a "/" redirigimos según rol (excepto operario normal)
  if (location.pathname === "/") {
    const home = getHomeByRole(role ?? null);
    if (home !== "/") return <Navigate to={home} replace />;
  }

  return <>{children}</>;
}

export function SupervisorRoute({ children }: { children: React.ReactNode }) {
  const { role, isLoading } = useAuth();

  if (isLoading) return <LoadingSpinner />;

  // ✅ Permite supervisor y supervisor_cuadrilla
  const isAllowed = role === "supervisor" || role === "supervisor_cuadrilla";
  if (!isAllowed) return <Navigate to="/" replace />;

  return <>{children}</>;
}

export function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, role } = useAuth();

  if (isLoading) return <LoadingSpinner />;

  if (user) {
    const home = getHomeByRole(role);
    return <Navigate to={home} replace />;
  }

  return <>{children}</>;
}

