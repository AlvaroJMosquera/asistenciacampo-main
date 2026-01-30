import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import { ProtectedRoute, SupervisorRoute, PublicRoute } from "@/components/RouteGuards";

import Auth from "./pages/Auth";
import OperarioHome from "./pages/OperarioHome";
import SupervisorDashboard from "./pages/SupervisorDashboard";
import SupervisorTracking from "./pages/SupervisorTracking"; // ✅ NUEVO
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

function AppContent() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/auth"
          element={
            <PublicRoute>
              <Auth />
            </PublicRoute>
          }
        />

        <Route
          path="/"
          element={
            <ProtectedRoute>
              <OperarioHome />
            </ProtectedRoute>
          }
        />

        <Route
          path="/supervisor"
          element={
            <ProtectedRoute>
              <SupervisorRoute>
                <SupervisorDashboard />
              </SupervisorRoute>
            </ProtectedRoute>
          }
        />

        {/* ✅ NUEVA RUTA MAPA TRACKING */}
        <Route
          path="/supervisor/tracking"
          element={
            <ProtectedRoute>
              <SupervisorRoute>
                <SupervisorTracking />
              </SupervisorRoute>
            </ProtectedRoute>
          }
        />

        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <AppContent />
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
