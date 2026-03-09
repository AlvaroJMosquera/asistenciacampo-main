import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { ProtectedRoute, SupervisorRoute, PublicRoute } from "./RouteGuards";
import { useAuth } from "@/hooks/useAuth";
import React from "react";

// Mock useAuth
vi.mock("@/hooks/useAuth", () => ({
  useAuth: vi.fn(),
}));

const LocationDisplay = () => {
  const location = useLocation();
  return <div data-testid="location-display">{location.pathname}</div>;
};

describe("RouteGuards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderGuard = (GuardComponent: React.FC<{children: React.ReactNode}>, initialRoute: string = "/") => {
    return render(
      <MemoryRouter initialEntries={[initialRoute]}>
        <Routes>
          <Route path={initialRoute} element={
            <GuardComponent>
              <div data-testid="protected-content">Content</div>
            </GuardComponent>
          } />
          {/* Catch unhandled routes resulting from redirects */}
          <Route path="*" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
  };

  describe("ProtectedRoute", () => {
    it("shows loading spinner when isLoading is true", () => {
      vi.mocked(useAuth).mockReturnValue({ isLoading: true, user: null, role: null } as any);
      const { container } = renderGuard(ProtectedRoute);
      expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
      // Spinner div should be present
      expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    });

    it("redirects to /auth when user is not authenticated", () => {
      vi.mocked(useAuth).mockReturnValue({ isLoading: false, user: null, role: null } as any);
      renderGuard(ProtectedRoute);
      expect(screen.getByTestId("location-display").textContent).toBe("/auth");
    });

    it("renders children when authenticated correctly without role redirection", () => {
      // test with operario role, should stay on "/"
      vi.mocked(useAuth).mockReturnValue({ isLoading: false, user: { id: "1" }, role: "operario" } as any);
      renderGuard(ProtectedRoute, "/");
      expect(screen.getByTestId("protected-content")).toBeInTheDocument();
    });

    it("redirects supervisor_maquinaria to /supervisor/maquinaria from root", () => {
      vi.mocked(useAuth).mockReturnValue({ isLoading: false, user: { id: "1" }, role: "supervisor_maquinaria" } as any);
      renderGuard(ProtectedRoute, "/");
      expect(screen.getByTestId("location-display").textContent).toBe("/supervisor/maquinaria");
    });
  });

  describe("SupervisorRoute", () => {
    it("redirects to / when user is not a supervisor", () => {
      vi.mocked(useAuth).mockReturnValue({ isLoading: false, user: { id: "1" }, role: "operario" } as any);
      renderGuard(SupervisorRoute, "/supervisor");
      expect(screen.getByTestId("location-display").textContent).toBe("/");
    });

    it("renders children when user is a supervisor", () => {
      vi.mocked(useAuth).mockReturnValue({ isLoading: false, user: { id: "1" }, role: "supervisor" } as any);
      renderGuard(SupervisorRoute, "/supervisor");
      expect(screen.getByTestId("protected-content")).toBeInTheDocument();
    });
  });

  describe("PublicRoute", () => {
    it("redirects authenticated user to their role home", () => {
      vi.mocked(useAuth).mockReturnValue({ isLoading: false, user: { id: "1" }, role: "operario_maquinaria" } as any);
      renderGuard(PublicRoute, "/auth");
      expect(screen.getByTestId("location-display").textContent).toBe("/OperarioMaquinaria");
    });

    it("renders children for unauthenticated user", () => {
      vi.mocked(useAuth).mockReturnValue({ isLoading: false, user: null, role: null } as any);
      renderGuard(PublicRoute, "/auth");
      expect(screen.getByTestId("protected-content")).toBeInTheDocument();
    });
  });
});
