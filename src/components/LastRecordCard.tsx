import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { Clock, MapPin, AlertTriangle, Camera } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

interface LastRecordCardProps {
  record: {
    tipo_registro: 'entrada' | 'salida';
    timestamp: string;
    latitud: number | null;
    longitud: number | null;
    precision_gps: number | null;
    es_inconsistente: boolean;
    foto_url: string | null;
  } | null;
}

export function LastRecordCard({ record }: LastRecordCardProps) {
  if (!record) {
    return (
      <Card className="bg-muted/50 border-dashed">
        <CardContent className="p-4 text-center text-muted-foreground">
          <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>Sin registros hoy</p>
        </CardContent>
      </Card>
    );
  }

  const isEntrada = record.tipo_registro === 'entrada';
  const time = format(new Date(record.timestamp), 'HH:mm', { locale: es });
  const hasLocation = record.latitud && record.longitud;

  return (
    <Card className={isEntrada ? 'border-success/30 bg-success/5' : 'border-destructive/30 bg-destructive/5'}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium uppercase ${
                  isEntrada ? 'bg-success/20 text-success' : 'bg-destructive/20 text-destructive'
                }`}
              >
                {record.tipo_registro}
              </span>
              {record.es_inconsistente && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-warning/20 text-warning text-xs">
                  <AlertTriangle className="h-3 w-3" />
                  Inconsistente
                </span>
              )}
            </div>

            <p className="text-2xl font-bold text-foreground">{time}</p>

            <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
              {hasLocation && (
                <span className="flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" />
                  GPS ±{Math.round(record.precision_gps || 0)}m
                </span>
              )}
              {record.foto_url && (
                <span className="flex items-center gap-1">
                  <Camera className="h-3.5 w-3.5" />
                  Foto
                </span>
              )}
            </div>
          </div>

          {record.foto_url && (
            <div className="ml-4">
              <img
                src={record.foto_url}
                alt="Foto de registro"
                className="h-16 w-16 rounded-lg object-cover border"
              />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
