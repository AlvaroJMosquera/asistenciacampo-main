import { useEffect, useMemo, useState, useCallback } from 'react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { LogIn, LogOut, User, Leaf, Settings, Camera, MapPin } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useAttendance } from '@/hooks/useAttendance';
import { supabase } from '@/integrations/supabase/client';
import { SyncStatusBadge } from '@/components/SyncStatusBadge';
import { AttendanceButton } from '@/components/AttendanceButton';
import { LastRecordCard } from '@/components/LastRecordCard';
import { HoursWorkedCard } from '@/components/HoursWorkedCard';
import { ConfirmationModal } from '@/components/ConfirmationModal';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
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

type FollowUpRow = { evidencia_n: 1 | 2; foto_url: string; timestamp: string };



// ✅ pruebas: 1 minuto (cambia a 3*60*60*1000 en prod)
const FOLLOWUP_REQUIRED_MS = 3*60 * 60 * 1000;

function storageKey(userId: string, entradaId: string) {
  return `followups:${userId}:${entradaId}`;
}

function readLocalFollowups(userId: string, entradaId: string): FollowUpRow[] {
  try {
    const raw = localStorage.getItem(storageKey(userId, entradaId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FollowUpRow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalFollowups(userId: string, entradaId: string, rows: FollowUpRow[]) {
  localStorage.setItem(storageKey(userId, entradaId), JSON.stringify(rows));
}

/**
 * ✅ Detecta iOS (Safari/Chrome iOS) para ajustar UX si hace falta
 */
function isIOS() {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1);
}

export default function OperarioHome() {
  const { profile, isSupervisor, signOut, user } = useAuth();

  const {
    isSubmitting,
    error,
    lastRecord,
    todayRecords,
    markAttendance,
    getTodayRecords,
    calculateHoursWorked,
    markFollowUp,
    syncPendingFollowups, // ✅ debe existir en tu hook useAttendance
  } = useAttendance();

  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    type: 'entrada' | 'salida';
    success: boolean;
    hoursWorked?: number | null;
    error?: string | null;
  }>({ isOpen: false, type: 'entrada', success: false });

  const { capturePhoto, error: cameraError } = useCamera();

  // Seguimiento: estado (remoto + local)
  const [remoteFollowups, setRemoteFollowups] = useState<FollowUpRow[]>([]);
  const [localFollowups, setLocalFollowups] = useState<FollowUpRow[]>([]);
  const [isLoadingFollowups, setIsLoadingFollowups] = useState(false);

  // ✅ Geo modal
  const [geoOpen, setGeoOpen] = useState(false);
  const [geoInfo, setGeoInfo] = useState<{ nom: string; hac_ste: string } | null>(null);
  const [geoCoords, setGeoCoords] = useState<{
    lat: number | null;
    lon: number | null;
    accuracy: number | null;
  } | null>(null);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);

  // ✅ ticker para que el contador se actualice offline
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // ✅ refresca registros al montar
  useEffect(() => {
    getTodayRecords();
  }, [getTodayRecords]);

  // ✅ cuando vuelve internet: sincroniza pendientes (evidencias y registros) y refresca
  useEffect(() => {
    const onOnline = async () => {
      try {
        await syncPendingFollowups?.();
      } catch (e) {
        console.error(e);
      } finally {
        await getTodayRecords();
        await loadFollowups();
      }
    };

    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncPendingFollowups, getTodayRecords]);

  const today = format(new Date(), "EEEE, d 'de' MMMM", { locale: es });
  const hoursWorked = calculateHoursWorked({ includeOpenSession: false });

  const closeModal = () => setModalState((prev) => ({ ...prev, isOpen: false }));

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

  // ✅ carga de followups: remoto (si hay red) + local (siempre)
  const loadFollowups = useCallback(async () => {
    if (!activeEntrada?.id || !user?.id) {
      setRemoteFollowups([]);
      setLocalFollowups([]);
      return;
    }

    // Local siempre (offline-friendly)
    setLocalFollowups(readLocalFollowups(user.id, activeEntrada.id));

    // Remoto solo si hay red
    if (!navigator.onLine) {
      setRemoteFollowups([]);
      return;
    }

    setIsLoadingFollowups(true);
    const { data, error } = await supabase
      .from('seguimiento_fotos')
      .select('evidencia_n, foto_url, timestamp')
      .eq('entrada_id', activeEntrada.id)
      .order('evidencia_n', { ascending: true });

    if (!error) setRemoteFollowups((data || []) as FollowUpRow[]);
    setIsLoadingFollowups(false);
  }, [activeEntrada?.id, user?.id]);

  useEffect(() => {
    loadFollowups();
  }, [loadFollowups]);

  // ✅ Unificar: remoto + local (local pisa para habilitar offline)
  const followups = useMemo(() => {
    const map = new Map<string, FollowUpRow>();

    // remoto
    for (const f of remoteFollowups) map.set(`${f.evidencia_n}`, f);

    // local pisa si existe
    for (const f of localFollowups) map.set(`${f.evidencia_n}`, f);

    return Array.from(map.values()).sort((a, b) => a.evidencia_n - b.evidencia_n);
  }, [remoteFollowups, localFollowups]);

  const hasFollow1 = followups.some((f) => f.evidencia_n === 1);
  const hasFollow2 = followups.some((f) => f.evidencia_n === 2);

  // ✅ Regla de habilitación Registro 1 (offline): depende SOLO del timestamp de la entrada
  const follow1EnabledInfo = useMemo(() => {
    void tick;

    if (!activeEntrada) return { enabled: false, remainingText: 'Primero marca entrada' };

    const start = new Date(activeEntrada.timestamp).getTime();
    const now = Date.now();
    const diffMs = now - start;

    if (diffMs >= FOLLOWUP_REQUIRED_MS) return { enabled: true, remainingText: '' };

    const remaining = FOLLOWUP_REQUIRED_MS - diffMs;
    const mins = Math.floor(remaining / (60 * 1000));
    const secs = Math.max(0, Math.ceil((remaining % (60 * 1000)) / 1000));

    return { enabled: false, remainingText: ` ${mins}m ${secs}s` };
  }, [activeEntrada, tick]);

  /**
   * ✅ helper: abre modal de error con mensaje útil (iPhone/Android sin consola)
   */
  const showError = useCallback(
    (type: 'entrada' | 'salida', message: string) => {
      setModalState({
        isOpen: true,
        type,
        success: false,
        hoursWorked: null,
        error: message,
      });
    },
    []
  );

  const handleMarkAttendance = async (tipo: 'entrada' | 'salida') => {
    try {
      // 🔒 Salida requiere Registro 1 (funciona offline por localStorage)
      if (tipo === 'salida' && !hasFollow1) {
        showError('salida', 'Debes completar el Registro 1 de seguimiento antes de marcar la salida.');
        return;
      }

      // ✅ Captura foto (input file) -> estable en iPhone/Android
      const photoBlob = await capturePhoto();

      // ✅ Marca asistencia (sube a storage si online, o guarda pending si offline)
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
      await loadFollowups();

      // ✅ Geo modal SOLO en entrada exitosa
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

        // iOS: a veces conviene abrir modal después de un micro-delay
        if (isIOS()) setTimeout(() => setGeoOpen(true), 50);
        else setGeoOpen(true);
      }
    } catch (err: any) {
      console.error(err);

      // ✅ Mensaje útil para celular
      const msg =
        err?.message ||
        cameraError ||
        'Error en móvil. Verifica permisos de Cámara/Ubicación o que Storage tenga permisos para subir fotos.';

      showError(tipo, msg);
    }
  };

  const handleFollowUp = async (n: 1 | 2) => {
    try {
      if (!activeEntrada?.id || !user?.id) {
        showError('entrada', 'Primero debes marcar la entrada.');
        return;
      }

      if (n === 1 && !follow1EnabledInfo.enabled) return;
      if (n === 2 && !hasFollow1) return;

      const blob = await capturePhoto();

      // ✅ UX OFFLINE: marcar local primero para habilitar salida incluso offline
      const localRow: FollowUpRow = {
        evidencia_n: n,
        foto_url: 'local://pending',
        timestamp: new Date().toISOString(),
      };

      const current = readLocalFollowups(user.id, activeEntrada.id);
      const next = [...current.filter((x) => x.evidencia_n !== n), localRow].sort(
        (a, b) => a.evidencia_n - b.evidencia_n
      );
      writeLocalFollowups(user.id, activeEntrada.id, next);
      setLocalFollowups(next);

      // ✅ Guarda remoto si online, si no guarda base64 pendiente (en useAttendance)
      const res = await markFollowUp(n, blob, activeEntrada.id);

      if (!res?.success) {
        showError('entrada', 'No se pudo guardar la evidencia. Intenta de nuevo.');
        return;
      }

      // ✅ Si hay red, intenta sincronizar pendientes inmediatamente (por flapping)
      if (navigator.onLine) {
        try {
          await syncPendingFollowups?.();
        } catch (e) {
          console.error(e);
          // no bloquea
        }
      }

      await loadFollowups();
    } catch (err: any) {
      console.error(err);
      const msg =
        err?.message ||
        cameraError ||
        'Error registrando evidencia. Revisa permisos de Cámara y almacenamiento.';
      showError('entrada', msg);
    }
  };
  const activeEntradaId = activeEntrada?.id ?? null;
  useLocationTracking(activeEntradaId);
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

        {/* ✅ Botones en orden UX: Entrada -> Evidencia -> Salida */}
        <div className="space-y-3 pt-4">
          <AttendanceButton
            type="entrada"
            onClick={() => handleMarkAttendance('entrada')}
            disabled={isSubmitting || !!activeEntrada}
          >
            <LogIn className="h-7 w-7" />
            <span>{activeEntrada ? 'Entrada ya registrada' : 'Marcar Entrada'}</span>
          </AttendanceButton>

          {/* ✅ Evidencia obligatoria */}
          <Button
            className="w-full"
            onClick={() => handleFollowUp(1)}
            disabled={isSubmitting || hasFollow1 || !follow1EnabledInfo.enabled || !activeEntrada}
          >
            <Camera className="h-4 w-4 mr-2" />
            {hasFollow1
              ? 'Registro de evidencia completado ✅'
              : `Registrar evidencia en ${follow1EnabledInfo.remainingText}`}
          </Button>

          {/* ✅ Evidencia adicional opcional */}
          <Button
            className="w-full"
            variant="outline"
            onClick={() => handleFollowUp(2)}
            disabled={isSubmitting || hasFollow2 || !hasFollow1 || !activeEntrada}
          >
            <Camera className="h-4 w-4 mr-2" />
            {hasFollow2 ? 'Evidencia adicional completada ✅' : 'Registrar evidencia adicional'}
          </Button>

          <AttendanceButton
            type="salida"
            onClick={() => handleMarkAttendance('salida')}
            disabled={isSubmitting || !hasFollow1}
          >
            <LogOut className="h-7 w-7" />
            <span>{hasFollow1 ? 'Marcar Salida' : 'Marcar Salida (requiere evidencia)'}</span>
          </AttendanceButton>

          {isLoadingFollowups ? (
            <p className="text-xs text-muted-foreground">Cargando evidencias...</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Evidencias: {hasFollow1 ? '✅ 1' : '❌ 1'} / {hasFollow2 ? '✅ 2' : '— 2'}
            </p>
          )}
        </div>

        {/* Resumen */}
        {todayRecords.length > 0 && (
          <div className="pt-4">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">
              Registros de hoy ({todayRecords.length})
            </h3>
            <div className="space-y-2">
              {todayRecords.slice(0, 4).map((record) => (
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
