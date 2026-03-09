import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AttendanceButton } from "./AttendanceButton";

describe("AttendanceButton", () => {
  it("renders correctly with 'entrada' type", () => {
    const onClickMock = vi.fn();
    render(
      <AttendanceButton type="entrada" onClick={onClickMock}>
        Entrada
      </AttendanceButton>
    );

    const button = screen.getByRole("button", { name: /entrada/i });
    expect(button).toBeInTheDocument();
    expect(button).not.toBeDisabled();
    
    // Check specific class applied for entrada
    expect(button.className).toContain("bg-success");
  });

  it("renders correctly with 'salida' type", () => {
    const onClickMock = vi.fn();
    render(
      <AttendanceButton type="salida" onClick={onClickMock}>
        Salida
      </AttendanceButton>
    );

    const button = screen.getByRole("button", { name: /salida/i });
    expect(button).toBeInTheDocument();
    
    // Check specific class applied for salida
    expect(button.className).toContain("bg-destructive");
  });

  it("calls onClick handler when clicked", () => {
    const onClickMock = vi.fn();
    render(
      <AttendanceButton type="entrada" onClick={onClickMock}>
        Entrar
      </AttendanceButton>
    );

    const button = screen.getByRole("button", { name: /entrar/i });
    fireEvent.click(button);
    expect(onClickMock).toHaveBeenCalledTimes(1);
  });

  it("shows loading state and disables button when isLoading is true", () => {
    const onClickMock = vi.fn();
    render(
      <AttendanceButton type="entrada" onClick={onClickMock} isLoading={true}>
        Entrar
      </AttendanceButton>
    );

    const button = screen.getByRole("button", { name: /procesando/i });
    expect(button).toBeInTheDocument();
    expect(button).toBeDisabled();

    // The text 'Entrar' should not be present when loading
    expect(screen.queryByText("Entrar")).not.toBeInTheDocument();
  });

  it("is disabled when disabled prop is true", () => {
    const onClickMock = vi.fn();
    render(
      <AttendanceButton type="entrada" onClick={onClickMock} disabled={true}>
        Entrar
      </AttendanceButton>
    );

    const button = screen.getByRole("button", { name: /entrar/i });
    expect(button).toBeDisabled();
    
    // Still allows clicks on disabled buttons theoretically but disabled attr prevents it at DOM level
    fireEvent.click(button);
    expect(onClickMock).not.toHaveBeenCalled();
  });
});
