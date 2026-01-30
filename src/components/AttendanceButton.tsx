import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface AttendanceButtonProps {
  type: 'entrada' | 'salida';
  onClick: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  children: ReactNode;
}

export function AttendanceButton({
  type,
  onClick,
  disabled = false,
  isLoading = false,
  children,
}: AttendanceButtonProps) {
  const isEntrada = type === 'entrada';

  return (
    <button
      onClick={onClick}
      disabled={disabled || isLoading}
      className={cn(
        'btn-field w-full flex items-center justify-center gap-3 px-6 py-6',
        'text-xl font-bold uppercase tracking-wide',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        'focus:outline-none focus:ring-4 focus:ring-offset-2',
        isEntrada
          ? 'bg-success text-success-foreground hover:bg-success/90 focus:ring-success/50'
          : 'bg-destructive text-destructive-foreground hover:bg-destructive/90 focus:ring-destructive/50'
      )}
    >
      {isLoading ? (
        <div className="flex items-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-current border-t-transparent" />
          <span>Procesando...</span>
        </div>
      ) : (
        children
      )}
    </button>
  );
}
