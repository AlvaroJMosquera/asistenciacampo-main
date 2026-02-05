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

// ✅ Solo forzamos home especial a operario_maquinaria
function getHomeByRole(isOperarioMaquinaria: boolean) {
  return isOperarioMaquinaria ? "/OperarioMaquinaria" : "/";
}

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, isOperarioMaquinaria } = useAuth();
  const location = useLocation();

  if (isLoading) return <LoadingSpinner />;
  if (!user) return <Navigate to="/auth" replace />;

  // ✅ Si entra a "/" y es operario_maquinaria, lo mandamos a su home
  if (location.pathname === "/") {
    const home = getHomeByRole(isOperarioMaquinaria);
    if (home !== "/") return <Navigate to={home} replace />;
  }

  return <>{children}</>;
}

export function SupervisorRoute({ children }: { children: React.ReactNode }) {
  const { isSupervisor, isLoading } = useAuth();

  if (isLoading) return <LoadingSpinner />;

  // ✅ Si no es supervisor, lo devolvemos a home común "/"
  if (!isSupervisor) return <Navigate to="/" replace />;

  return <>{children}</>;
}

export function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, isOperarioMaquinaria } = useAuth();

  if (isLoading) return <LoadingSpinner />;

  if (user) {
    // ✅ Si ya está logueado: solo operario_maquinaria se va a su home especial
    const home = getHomeByRole(isOperarioMaquinaria);
    return <Navigate to={home} replace />;
  }

  return <>{children}</>;
}
