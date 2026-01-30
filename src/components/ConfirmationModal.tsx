import { forwardRef } from 'react';
import { CheckCircle, XCircle, Clock } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  type: 'entrada' | 'salida';
  success: boolean;
  hoursWorked?: number | null;
  error?: string | null;
}

export const ConfirmationModal = forwardRef<HTMLDivElement, ConfirmationModalProps>(
  function ConfirmationModal({ isOpen, onClose, type, success, hoursWorked, error }, ref) {
    const isEntrada = type === 'entrada';

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-center">
          {success ? (
            <>
              <div
                className={`mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full ${
                  isEntrada ? 'bg-success/20' : 'bg-destructive/20'
                }`}
              >
                <CheckCircle
                  className={`h-10 w-10 ${isEntrada ? 'text-success' : 'text-destructive'}`}
                />
              </div>
              <DialogTitle className="text-xl">
                {isEntrada ? '¡Entrada Registrada!' : '¡Salida Registrada!'}
              </DialogTitle>
              <DialogDescription className="text-base">
                Tu {type} ha sido registrada correctamente.
              </DialogDescription>

              {!isEntrada && hoursWorked !== null && hoursWorked !== undefined && (
                <div className="mt-4 p-4 rounded-lg bg-accent/20 border border-accent/30">
                  <div className="flex items-center justify-center gap-2 text-foreground">
                    <Clock className="h-5 w-5" />
                    <span className="text-lg font-semibold">
                      Tiempo trabajado: {hoursWorked.toFixed(1)} horas
                    </span>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/20">
                <XCircle className="h-10 w-10 text-destructive" />
              </div>
              <DialogTitle className="text-xl">Error al Registrar</DialogTitle>
              <DialogDescription className="text-base">
                {error || 'Ha ocurrido un error. Por favor, intenta de nuevo.'}
              </DialogDescription>
            </>
          )}
        </DialogHeader>

        <div className="mt-4">
          <Button onClick={onClose} className="w-full" size="lg">
            Aceptar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
  }
);
