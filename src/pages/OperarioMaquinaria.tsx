// src/pages/OperarioMaquinaria.tsx
import { useEffect, useMemo, useState, useCallback } from 'react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { LogIn, LogOut, User, Leaf, Settings, Camera, MapPin, ClipboardCheck } from 'lucide-react';
import { useNavigate, Link } from 'react-router-dom';

import { useAuth } from '@/hooks/useAuth';
import { useAttendance } from '@/hooks/useAttendance';
import { supabase } from '@/integrations/supabase/client';

import { SyncStatusBadge } from '@/components/SyncStatusBadge';
import { AttendanceButton } from '@/components/AttendanceButton';
import { LastRecordCard } from '@/components/LastRecordCard';
import { HoursWorkedCard } from '@/components/HoursWorkedCard';
import { ConfirmationModal } from '@/components/ConfirmationModal';
import { Button } from '@/components/ui/button';
import { useCamera } from '@/hooks/useCamera';
import { useLocationTracking } from '@/hooks/useLocationTracking';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

type RevisionTipo = 'inicio' | 'fin';

type RevisionState = {
  loading: boolean;
  inicioComplete: boolean;
  finComplete: boolean;
  inicioCount: number;
  finCount: number;
  required: number;
};

// ✅ Requeridas por revisión: 5 (frente, lado_der, lado_izq, trasera, cabina)
const REQUIRED_MAQUINARIA_PHOTOS = 5;

function revisionLocalKey(userId: string, dateISO: string, tipo: RevisionTipo) {
  return `maq_revision_complete:${userId}:${dateISO}:${tipo}`;
}
function readLocalRevisionComplete(userId: string, dateISO: string, tipo: RevisionTipo) {
  try {
    return localStorage.getItem(revisionLocalKey(userId, dateISO, tipo)) === '1';
  } catch {
    return false;
  }
}

export default function OperarioMaquinaria() {
  const navigate = useNavigate();
  const { profile, isSupervisor, signOut, user } = useAuth();

  const {
    isSubmitting,
    error,
    lastRecord,
    todayRecords,
    markAttendance,
    getTodayRecords,
    calculateHoursWorked,
  } = useAttendance();

  const { capturePhoto, error: cameraError } = useCamera();

  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    type: 'entrada' | 'salida';
    success: boolean;
    hoursWorked?: number | null;
    error?: string | null;
  }>({ isOpen: false, type: 'entrada', success: false });

  // ✅ Geo modal
  const [geoOpen, setGeoOpen] = useState(false);
  const [geoInfo, setGeoInfo] = useState<{ nom: string; hac_ste: string } | null>(null);
  const [geoCoords, setGeoCoords] = useState<{
    lat: number | null;
    lon: number | null;
    accuracy: number | null;
  } | null>(null);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);

  // ✅ Estado de revisiones maquinaria (inicio/fin)
  const [rev, setRev] = useState<RevisionState>({
    loading: false,
    inicioComplete: false,
    finComplete: false,
    inicioCount: 0,
    finCount: 0,
    required: REQUIRED_MAQUINARIA_PHOTOS,
  });

  const today = format(new Date(), "EEEE, d 'de' MMMM", { locale: es });
  const dateISO = format(new Date(), 'yyyy-MM-dd');
  const hoursWorked = calculateHoursWorked({ includeOpenSession: false });

  const closeModal = () => setModalState((prev) => ({ ...prev, isOpen: false }));

  const showError = useCallback((type: 'entrada' | 'salida', message: string) => {
    setModalState({
      isOpen: true,
      type,
      success: false,
      hoursWorked: null,
      error: message,
    });
  }, []);

  // ✅ “entrada activa”
  const activeEntrada = useMemo(() => {
    const sorted = [...todayRecords].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    let currentEntrada: any = null;
    for (const r of sorted) {
      if (r.tipo_registro === 'entrada') currentEntrada = r;
      if (r.tipo_registro === 'salida') currentEntrada = null;
    }
    return currentEntrada;
  }, [todayRecords]);

  // ✅ Tracking ubicación
  const activeEntradaId = activeEntrada?.id ?? null;
  useLocationTracking(activeEntradaId);

  // ✅ Cargar registros al montar
  useEffect(() => {
    getTodayRecords();
  }, [getTodayRecords]);

  // ✅ Cargar estado de revisiones (remoto + fallback local)
  const loadRevisionStatus = useCallback(async () => {
    if (!user?.id) return;

    const localInicio = readLocalRevisionComplete(user.id, dateISO, 'inicio');
    const localFin = readLocalRevisionComplete(user.id, dateISO, 'fin');

    // Offline → solo local
    if (!navigator.onLine) {
      setRev((prev) => ({
        ...prev,
        loading: false,
        inicioComplete: localInicio,
        finComplete: localFin,
      }));
      return;
    }

    setRev((prev) => ({ ...prev, loading: true }));

    const startOfDay = `${dateISO} 00:00:00`;
    const endOfDay = `${dateISO} 23:59:59`;

    // 1) Traer revisiones del día (inicio/fin)
    const { data: revisions, error: revErr } = await supabase
      .from('revision_maquinaria')
      .select('id, tipo, created_at')
      .eq('user_id', user.id)
      .gte('created_at', startOfDay)
      .lte('created_at', endOfDay);

    if (revErr) {
      // Todavía no creas tablas → no rompas UI
      console.warn('[revision_maquinaria] error:', revErr.message);
      setRev((prev) => ({
        ...prev,
        loading: false,
        inicioComplete: localInicio,
        finComplete: localFin,
      }));
      return;
    }

    const inicioId = (revisions || []).find((r: any) => r.tipo === 'inicio')?.id ?? null;
    const finId = (revisions || []).find((r: any) => r.tipo === 'fin')?.id ?? null;

    const countFotos = async (revisionId: string | null) => {
      if (!revisionId) return 0;

      const { count, error: cErr } = await supabase
        .from('revision_maquinaria_fotos')
        .select('id', { count: 'exact', head: true })
        .eq('revision_id', revisionId);

      if (cErr) {
        console.warn('[revision_maquinaria_fotos] error:', cErr.message);
        return 0;
      }

      return count ?? 0;
    };

    const inicioCount = await countFotos(inicioId);
    const finCount = await countFotos(finId);

    const inicioCompleteRemote = inicioCount >= REQUIRED_MAQUINARIA_PHOTOS;
    const finCompleteRemote = finCount >= REQUIRED_MAQUINARIA_PHOTOS;

    setRev({
      loading: false,
      inicioCount,
      finCount,
      required: REQUIRED_MAQUINARIA_PHOTOS,
      inicioComplete: inicioCompleteRemote || localInicio,
      finComplete: finCompleteRemote || localFin,
    });
  }, [user?.id, dateISO]);

  useEffect(() => {
    loadRevisionStatus();
  }, [loadRevisionStatus]);

  // ✅ Cuando vuelve internet: refrescar
  useEffect(() => {
    const onOnline = async () => {
      await getTodayRecords();
      await loadRevisionStatus();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [getTodayRecords, loadRevisionStatus]);

  // ✅ Navegación (CORREGIDA para tu Router: /OperarioMaquinaria/...)
  const goRevision = (tipo: RevisionTipo) => {
    if (!activeEntrada?.id) {
      showError('entrada', 'Primero debes marcar la ENTRADA para iniciar la revisión de maquinaria.');
      return;
    }

    // 🔥 IMPORTANTE: coincide con App.tsx (mayúsculas)
    navigate(`/OperarioMaquinaria/${tipo}?entrada_id=${activeEntrada.id}`);
  };

  const handleMarkAttendance = async (tipo: 'entrada' | 'salida') => {
    try {
      // 🔒 Salida requiere revisiones completas
      if (tipo === 'salida') {
        if (!rev.inicioComplete) {
          showError('salida', 'Debes completar la Revisión de INICIO (fotos de maquinaria) antes de marcar la salida.');
          return;
        }
        if (!rev.finComplete) {
          showError('salida', 'Debes completar la Revisión de FIN (fotos de maquinaria) antes de marcar la salida.');
          return;
        }
      }

      const photoBlob = await capturePhoto();
      const result = await markAttendance(tipo, photoBlob);

      setModalState({
        isOpen: true,
        type: tipo,
        success: result.success,
        hoursWorked: result.hoursWorked,
        error: result.success ? null : (result.error ?? error ?? 'No se pudo registrar'),
      });

      if (!result.success) return;

      await getTodayRecords();
      await loadRevisionStatus();

      if (tipo === 'entrada') {
        setGeoCoords(result.coords ?? null);
        setGeoInfo(result.geo ?? null);

        if (!result.coords?.lat || !result.coords?.lon) {
          setGeoMsg('No se pudo obtener ubicación. Debes permitir GPS para identificar la hacienda/suerte.');
        } else if (!result.geo) {
          setGeoMsg('Ubicación obtenida, pero no estás dentro de ninguna suerte/hacienda (según el mapa).');
        } else {
          setGeoMsg(null);
        }

        setGeoOpen(true);
      }
    } catch (err: any) {
      console.error(err);
      const msg =
        err?.message ||
        cameraError ||
        'Error en móvil. Verifica permisos de Cámara/Ubicación o que Storage tenga permisos para subir fotos.';
      showError(tipo, msg);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-card border-b px-4 py-3 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary">
              <Leaf className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="font-semibold text-foreground flex items-center gap-2">
                <User className="h-4 w-4" />
                {profile?.nombre || 'Usuario'}
              </h1>
              <p className="text-sm text-muted-foreground capitalize">{today}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isSupervisor && (
              <Link to="/supervisor">
                <Button variant="outline" size="icon">
                  <Settings className="h-4 w-4" />
                </Button>
              </Link>
            )}
            <Button variant="ghost" size="sm" onClick={signOut}>
              Salir
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 p-4 space-y-4 max-w-lg mx-auto w-full">
        <div className="flex justify-center">
          <SyncStatusBadge />
        </div>

        <HoursWorkedCard hours={hoursWorked} />

        <div>
          <h2 className="text-sm font-medium text-muted-foreground mb-2">Último registro hoy</h2>
          <LastRecordCard record={lastRecord} />
        </div>

        {/* ✅ Botones */}
        <div className="space-y-3 pt-4">
          <AttendanceButton
            type="entrada"
            onClick={() => handleMarkAttendance('entrada')}
            disabled={isSubmitting || !!activeEntrada}
          >
            <LogIn className="h-7 w-7" />
            <span>{activeEntrada ? 'Entrada ya registrada' : 'Marcar Entrada'}</span>
          </AttendanceButton>

          <Button
            className="w-full"
            onClick={() => goRevision('inicio')}
            disabled={isSubmitting || !activeEntrada || rev.inicioComplete}
          >
            <ClipboardCheck className="h-4 w-4 mr-2" />
            {rev.inicioComplete
              ? `Revisión inicio completa ✅ (${rev.required}/${rev.required})`
              : `Revisión inicio turno (${Math.min(rev.inicioCount, rev.required)}/${rev.required})`}
          </Button>

          <Button
            className="w-full"
            variant="outline"
            onClick={() => goRevision('fin')}
            disabled={isSubmitting || !activeEntrada || rev.finComplete}
          >
            <Camera className="h-4 w-4 mr-2" />
            {rev.finComplete
              ? `Revisión fin completa ✅ (${rev.required}/${rev.required})`
              : `Revisión fin turno (${Math.min(rev.finCount, rev.required)}/${rev.required})`}
          </Button>

          <AttendanceButton
            type="salida"
            onClick={() => handleMarkAttendance('salida')}
            disabled={isSubmitting || !rev.inicioComplete || !rev.finComplete}
          >
            <LogOut className="h-7 w-7" />
            <span>
              {rev.inicioComplete && rev.finComplete
                ? 'Marcar Salida'
                : 'Marcar Salida (requiere revisiones)'}
            </span>
          </AttendanceButton>

          <p className="text-xs text-muted-foreground">
            Revisión inicio: {rev.inicioComplete ? '✅' : '❌'} / Revisión fin:{' '}
            {rev.finComplete ? '✅' : '❌'}
            {rev.loading ? ' • Actualizando…' : ''}
          </p>
        </div>

        {/* Resumen */}
        {todayRecords.length > 0 && (
          <div className="pt-4">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">
              Registros de hoy ({todayRecords.length})
            </h3>
            <div className="space-y-2">
              {todayRecords.slice(0, 6).map((record) => (
                <div key={record.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                  <span
                    className={`text-sm font-medium ${
                      record.tipo_registro === 'entrada' ? 'text-success' : 'text-destructive'
                    }`}
                  >
                    {record.tipo_registro === 'entrada' ? '🟢' : '🔴'} {record.tipo_registro.toUpperCase()}
                  </span>
                  <span className="text-sm text-muted-foreground">{format(new Date(record.timestamp), 'HH:mm')}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* ✅ Modal Georreferenciación */}
      <Dialog open={geoOpen} onOpenChange={setGeoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5" />
              Ubicación al iniciar turno
            </DialogTitle>
            <DialogDescription>Ubicación capturada al registrar la entrada.</DialogDescription>
          </DialogHeader>

          {geoInfo ? (
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-muted">
                <p className="text-xs text-muted-foreground">Suerte</p>
                <p className="text-base font-semibold">{geoInfo.nom}</p>
              </div>
              <div className="p-3 rounded-lg bg-muted">
                <p className="text-xs text-muted-foreground">Hacienda/Suerte</p>
                <p className="text-base font-semibold">{geoInfo.hac_ste}</p>
              </div>
              {geoCoords?.accuracy != null && (
                <p className="text-xs text-muted-foreground">Precisión GPS: ±{Math.round(geoCoords.accuracy)} m</p>
              )}
            </div>
          ) : (
            <div className="p-3 rounded-lg bg-muted text-sm">{geoMsg ?? 'Consultando...'}</div>
          )}

          <DialogFooter>
            <Button onClick={() => setGeoOpen(false)}>Aceptar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmationModal
        isOpen={modalState.isOpen}
        onClose={closeModal}
        type={modalState.type}
        success={modalState.success}
        hoursWorked={modalState.hoursWorked}
        error={modalState.error}
      />
    </div>
  );
}
