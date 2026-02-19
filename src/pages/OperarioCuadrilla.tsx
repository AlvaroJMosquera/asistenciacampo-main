import { useEffect, useMemo, useState, useCallback } from 'react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { LogIn, LogOut, Settings, Camera, MapPin, AlertTriangle, CheckCircle2, Clock3 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useAttendance } from '@/hooks/useAttendance';
import { supabase } from '@/integrations/supabase/client';
import { SyncStatusBadge } from '@/components/SyncStatusBadge';
import { AttendanceButton } from '@/components/AttendanceButton';
import { LastRecordCard } from '@/components/LastRecordCard';
import { HoursWorkedCard } from '@/components/HoursWorkedCard';
import { ConfirmationModal } from '@/components/ConfirmationModal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
const FOLLOWUP_REQUIRED_MS = 60 * 1000;

/** =========================
 *  Horarios / reglas
 *  Lun-Jue: 06:00 - 13:00
 *  Vie-Sab: 06:00 - 14:00
 *  Entrada: a tiempo si <= 06:10
 *  Salida: puede salir 30 min antes sin permiso.
 *  Si sale > 30 min antes => motivo + foto permiso firmado
 *  ========================= */

type DaySchedule = {
  startHHMM: string; // "06:00"
  endHHMM: string; // "13:00" | "14:00"
  inGraceMinutes: number; // 10 (hasta 06:10)
  earlyLeaveFreeMinutes: number; // 30
};

type ArrivalStatus = 'temprano_o_a_tiempo' | 'tarde';
type ExitStatus = 'a_tiempo' | 'se_fue_antes_30' | 'se_fue_antes_mas_30';

function toDateAtHHMM(base: Date, hhmm: string) {
  const [hh, mm] = hhmm.split(':').map(Number);
  const d = new Date(base);
  d.setHours(hh, mm, 0, 0);
  return d;
}

function getSchedule(date: Date): DaySchedule {
  const day = date.getDay(); // 0=Dom,1=Lun,...6=Sáb

  if (day >= 1 && day <= 4) {
    // Lun-Jue
    return { startHHMM: '06:00', endHHMM: '13:00', inGraceMinutes: 10, earlyLeaveFreeMinutes: 30 };
  }
  if (day === 5 || day === 6) {
    // Vie-Sáb
    return { startHHMM: '06:00', endHHMM: '14:00', inGraceMinutes: 10, earlyLeaveFreeMinutes: 30 };
  }

  // Domingo (ajusta si NO trabajan)
  return { startHHMM: '06:00', endHHMM: '13:00', inGraceMinutes: 10, earlyLeaveFreeMinutes: 30 };
}

function evaluateArrival(ts: Date) {
  const sch = getSchedule(ts);
  const start = toDateAtHHMM(ts, sch.startHHMM);
  const graceLimit = new Date(start.getTime() + sch.inGraceMinutes * 60 * 1000);

  const diffMin = Math.round((ts.getTime() - start.getTime()) / (60 * 1000)); // + tarde, - temprano
  const status: ArrivalStatus = ts.getTime() <= graceLimit.getTime() ? 'temprano_o_a_tiempo' : 'tarde';

  return { status, diffMin, start, graceLimit, sch };
}

function evaluateExit(ts: Date) {
  const sch = getSchedule(ts);
  const end = toDateAtHHMM(ts, sch.endHHMM);
  const freeEarlyLimit = new Date(end.getTime() - sch.earlyLeaveFreeMinutes * 60 * 1000);

  const diffMinToEnd = Math.round((end.getTime() - ts.getTime()) / (60 * 1000)); // + faltan min, 0 exacto, negativo si se pasó
  let status: ExitStatus = 'a_tiempo';

  if (ts.getTime() < freeEarlyLimit.getTime()) status = 'se_fue_antes_mas_30';
  else if (ts.getTime() < end.getTime()) status = 'se_fue_antes_30';
  else status = 'a_tiempo';

  return { status, diffMinToEnd, end, freeEarlyLimit, sch };
}

/** =========================
 *  LocalStorage followups
 *  ========================= */
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

/** ✅ Detecta iOS (Safari/Chrome iOS) */
function isIOS() {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1)
  );
}

export default function OperarioCuadrilla() {
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
    error?: string | null; // aquí lo usas también como "mensaje" informativo
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

  // ✅ ticker para contador offline
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // ✅ refresca registros al montar
  useEffect(() => {
    getTodayRecords();
  }, [getTodayRecords]);

  // ✅ cuando vuelve internet: sincroniza pendientes y refresca
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

  // ✅ Estado de llegada basado en la entrada activa (si existe)
  const arrivalInfo = useMemo(() => {
    if (!activeEntrada?.timestamp) return null;
    const ts = new Date(activeEntrada.timestamp);
    const arr = evaluateArrival(ts);
    return arr;
  }, [activeEntrada?.timestamp]);

  const scheduleLabel = useMemo(() => {
    const now = new Date();
    const sch = getSchedule(now);
    return `${sch.startHHMM} - ${sch.endHHMM}`;
  }, []);

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
    for (const f of remoteFollowups) map.set(`${f.evidencia_n}`, f);
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

  /** helper: abre modal de error con mensaje útil */
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

  /** =========================
   *  Salida temprana: motivo + permiso firmado
   *  ========================= */
  const [earlyExitOpen, setEarlyExitOpen] = useState(false);
  const [earlyExitMotivo, setEarlyExitMotivo] = useState('');
  const [pendingExit, setPendingExit] = useState<{
    salidaPhotoBlob: Blob;
    exitEval: ReturnType<typeof evaluateExit>;
    exitTimestampISO: string;
  } | null>(null);

  const confirmEarlyExit = useCallback(async () => {
    if (!pendingExit) return;

    if (!earlyExitMotivo.trim()) {
      showError('salida', 'Debes escribir el motivo de salida temprana.');
      return;
    }

    try {
      // Foto del permiso firmado
      const permisoBlob = await capturePhoto();

      // ✅ Llamada al hook con metadata (si tu hook aún no soporta meta, lo recibe como "extra" sin romper con any)
      const result = await (markAttendance as any)(
        'salida',
        pendingExit.salidaPhotoBlob,
        {
          // Estado salida
          salida_estado: pendingExit.exitEval.status,
          minutos_antes_fin: pendingExit.exitEval.diffMinToEnd,
          // Motivo/permiso
          motivo_salida_temprano: earlyExitMotivo.trim(),
          permiso_firmado_blob: permisoBlob,
          // Timestamp que evaluamos (por consistencia)
          client_timestamp: pendingExit.exitTimestampISO,
        }
      );

      setEarlyExitOpen(false);
      setPendingExit(null);

      setModalState({
        isOpen: true,
        type: 'salida',
        success: result?.success,
        hoursWorked: result?.hoursWorked,
        error: result?.success ? null : (result?.error ?? error ?? 'No se pudo registrar'),
      });

      if (result?.success) {
        await getTodayRecords();
        await loadFollowups();
      }
    } catch (err: any) {
      console.error(err);
      const msg =
        err?.message ||
        cameraError ||
        'Error registrando salida temprana. Revisa permisos de Cámara/Storage.';
      showError('salida', msg);
    }
  }, [pendingExit, earlyExitMotivo, capturePhoto, markAttendance, error, cameraError, showError, getTodayRecords, loadFollowups]);

  /** =========================
   *  Marcar asistencia (entrada/salida)
   *  ========================= */
  const handleMarkAttendance = async (tipo: 'entrada' | 'salida') => {
    try {
      // 🔒 Salida requiere Registro 1
      if (tipo === 'salida' && !hasFollow1) {
        showError('salida', 'Debes completar el Registro 1 de seguimiento antes de marcar la salida.');
        return;
      }

      // ✅ Antes de tomar la foto y registrar salida, validamos horario
      if (tipo === 'salida') {
        const now = new Date();
        const ex = evaluateExit(now);

        // Si sale más de 30 min antes => motivo + permiso firmado
        if (ex.status === 'se_fue_antes_mas_30') {
          const salidaBlob = await capturePhoto(); // foto normal de salida
          setPendingExit({
            salidaPhotoBlob: salidaBlob,
            exitEval: ex,
            exitTimestampISO: now.toISOString(),
          });
          setEarlyExitMotivo('');
          setEarlyExitOpen(true);
          return;
        }
      }

      // ✅ Captura foto (entrada o salida normal)
      const photoBlob = await capturePhoto();

      // ✅ Meta de horario (llegada/salida a tiempo / antes)
      const now = new Date();
      const meta: any = { client_timestamp: now.toISOString() };

      if (tipo === 'entrada') {
        const arr = evaluateArrival(now);
        meta.llegada_estado = arr.status;
        meta.minutos_vs_inicio = arr.diffMin; // + tarde, - temprano
        meta.horario_inicio = arr.sch.startHHMM;
        meta.horario_fin = arr.sch.endHHMM;
      } else {
        const ex = evaluateExit(now);
        meta.salida_estado = ex.status;
        meta.minutos_antes_fin = ex.diffMinToEnd; // + faltaban minutos
        meta.horario_inicio = ex.sch.startHHMM;
        meta.horario_fin = ex.sch.endHHMM;
      }

      // ✅ Marca asistencia (online/offline)
      const result = await (markAttendance as any)(tipo, photoBlob, meta);

      setModalState({
        isOpen: true,
        type: tipo,
        success: result?.success,
        hoursWorked: result?.hoursWorked,
        error: result?.success ? null : (result?.error ?? error ?? 'No se pudo registrar'),
      });

      if (!result?.success) return;

      await getTodayRecords();
      await loadFollowups();

      // ✅ Mensaje de llegada (no bloquea)
      if (tipo === 'entrada') {
        const arr = evaluateArrival(new Date(meta.client_timestamp));
        if (arr.status === 'tarde') {
          setModalState({
            isOpen: true,
            type: 'entrada',
            success: true,
            hoursWorked: result?.hoursWorked,
            error: `Llegaste tarde (${arr.diffMin} min). Límite: 06:10.`,
          });
        } else {
          // opcional: si quieres, también avisa cuando llega a tiempo
          // setModalState({ isOpen:true, type:'entrada', success:true, hoursWorked: result?.hoursWorked, error:`Llegaste a tiempo ✅ (${arr.diffMin < 0 ? `${Math.abs(arr.diffMin)} min temprano` : 'en hora'})` })
        }
      }

      // ✅ Geo modal SOLO en entrada exitosa
      if (tipo === 'entrada') {
        setGeoCoords(result?.coords ?? null);
        setGeoInfo(result?.geo ?? null);

        if (!result?.coords?.lat || !result?.coords?.lon) {
          setGeoMsg('No se pudo obtener ubicación. Debes permitir GPS para identificar la hacienda/suerte.');
        } else if (!result?.geo) {
          setGeoMsg('Ubicación obtenida, pero no estás dentro de ninguna suerte/hacienda (según el mapa).');
        } else {
          setGeoMsg(null);
        }

        if (isIOS()) setTimeout(() => setGeoOpen(true), 50);
        else setGeoOpen(true);
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

  /** =========================
   *  Followups (Labor inicio/fin)
   *  ========================= */
  const handleFollowUp = async (n: 1 | 2) => {
    try {
      if (!activeEntrada?.id || !user?.id) {
        showError('entrada', 'Primero debes marcar la entrada.');
        return;
      }

      if (n === 1 && !follow1EnabledInfo.enabled) return;
      if (n === 2 && !hasFollow1) return;

      const blob = await capturePhoto();

      // ✅ UX OFFLINE: marcar local primero
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

      // ✅ Guarda remoto si online, si no guarda pendiente (en useAttendance)
      const res = await markFollowUp(n, blob, activeEntrada.id);

      if (!res?.success) {
        showError('entrada', 'No se pudo guardar la evidencia. Intenta de nuevo.');
        return;
      }

      // ✅ Si hay red, intenta sincronizar pendientes
      if (navigator.onLine) {
        try {
          await syncPendingFollowups?.();
        } catch (e) {
          console.error(e);
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

  // ✅ Badge de salida (si ya hay salida hoy)
  const lastTodaySorted = useMemo(() => {
    const sorted = [...todayRecords].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return sorted[sorted.length - 1] ?? null;
  }, [todayRecords]);

  // (solo informativo) si el último registro fue salida, mostramos cómo fue según horario, con el timestamp del último registro
  const lastExitInfo = useMemo(() => {
    if (!lastTodaySorted || lastTodaySorted.tipo_registro !== 'salida') return null;
    const ex = evaluateExit(new Date(lastTodaySorted.timestamp));
    return ex;
  }, [lastTodaySorted]);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-card border-b px-4 py-3 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src="/logo_ipsa.JPG.jpeg"
              alt="Logo IPSA"
              className="h-14 w-auto object-contain"
            />

            <div className="flex flex-col">
              <p className="text-base font-semibold text-foreground leading-tight">
                {profile?.nombre || 'Usuario'}
              </p>
              <p className="text-sm text-muted-foreground capitalize leading-tight">
                {today}
              </p>
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                <Clock3 className="h-3.5 w-3.5" />
                Horario hoy: <span className="font-medium">{scheduleLabel}</span> (entrada hasta 06:10)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isSupervisor && (
              <Link to="/supervisor/cuadrilla">
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

        {/* ✅ Estado llegada/salida (informativo) */}
        <div className="space-y-2">
          {arrivalInfo && (
            <div
              className={`flex items-center gap-2 p-3 rounded-lg border ${
                arrivalInfo.status === 'tarde' ? 'border-destructive/30 bg-destructive/5' : 'border-emerald-500/30 bg-emerald-500/5'
              }`}
            >
              {arrivalInfo.status === 'tarde' ? (
                <AlertTriangle className="h-4 w-4 text-destructive" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              )}
              <div className="text-sm">
                {arrivalInfo.status === 'tarde' ? (
                  <span>
                    Llegaste <b>tarde</b> ({arrivalInfo.diffMin} min). Límite: 06:10.
                  </span>
                ) : (
                  <span>
                    Llegaste <b>a tiempo</b>
                    {arrivalInfo.diffMin < 0 ? ` (${Math.abs(arrivalInfo.diffMin)} min temprano)` : ''}.
                  </span>
                )}
              </div>
            </div>
          )}

          {lastExitInfo && (
            <div className="flex items-center gap-2 p-3 rounded-lg border border-muted bg-muted/30">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <div className="text-sm text-muted-foreground">
                Salida hoy:{" "}
                {lastExitInfo.status === 'a_tiempo' && <b className="text-foreground">a tiempo</b>}
                {lastExitInfo.status === 'se_fue_antes_30' && <b className="text-foreground">antes (≤ 30 min)</b>}
                {lastExitInfo.status === 'se_fue_antes_mas_30' && <b className="text-foreground">antes (&gt; 30 min)</b>}
                {" "}· fin esperado {format(lastExitInfo.end, 'HH:mm')}
              </div>
            </div>
          )}
        </div>

        <HoursWorkedCard hours={hoursWorked} />

        <div>
          <h2 className="text-sm font-medium text-muted-foreground mb-2">Último registro hoy</h2>
          <LastRecordCard record={lastRecord} />
        </div>

        {/* ✅ Botones: Entrada -> Evidencia -> Salida */}
        <div className="space-y-3 pt-4">
          <AttendanceButton
            type="entrada"
            onClick={() => handleMarkAttendance('entrada')}
            disabled={isSubmitting || !!activeEntrada}
          >
            <LogIn className="h-7 w-7" />
            <span>{activeEntrada ? 'Entrada ya registrada' : 'Marcar Entrada Cuadrilla'}</span>
          </AttendanceButton>

          {/* ✅ Evidencia obligatoria */}
          <Button
            className="w-full"
            onClick={() => handleFollowUp(1)}
            disabled={isSubmitting || hasFollow1 || !follow1EnabledInfo.enabled || !activeEntrada}
          >
            <Camera className="h-4 w-4 mr-2" />
            {hasFollow1 ? 'Labor iniciada ✅' : `Para iniciar labor ${follow1EnabledInfo.remainingText}`}
          </Button>

          {/* ✅ Evidencia adicional opcional */}
          <Button
            className="w-full"
            variant="outline"
            onClick={() => handleFollowUp(2)}
            disabled={isSubmitting || hasFollow2 || !hasFollow1 || !activeEntrada}
          >
            <Camera className="h-4 w-4 mr-2" />
            {hasFollow2 ? 'Labor completada ✅' : 'Fin labor'}
          </Button>

          <AttendanceButton
            type="salida"
            onClick={() => handleMarkAttendance('salida')}
            disabled={isSubmitting || !hasFollow1}
          >
            <LogOut className="h-7 w-7" />
            <span>{hasFollow1 ? 'Marcar Salida' : 'Marcar Salida (Completa primero la labor)'}</span>
          </AttendanceButton>

          {isLoadingFollowups ? (
            <p className="text-xs text-muted-foreground">Iniciando labor...</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Estado: {hasFollow1 ? 'Labor Iniciada✅ ' : 'Labor sin iniciar❌'} / {hasFollow2 ? 'Labor Finalizada✅' : 'Labor sin finalizar❌'}
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
                  <span className="text-sm text-muted-foreground">
                    {format(new Date(record.timestamp), 'HH:mm')}
                  </span>
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
                <p className="text-xs text-muted-foreground">
                  Precisión GPS: ±{Math.round(geoCoords.accuracy)} m
                </p>
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

      {/* ✅ Modal: salida temprana > 30 min (motivo + permiso) */}
      <Dialog open={earlyExitOpen} onOpenChange={setEarlyExitOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Salida temprana (más de 30 min)
            </DialogTitle>
            <DialogDescription>
              Debes registrar el motivo y luego tomar una foto del permiso firmado.
            </DialogDescription>
          </DialogHeader>

          {pendingExit?.exitEval && (
            <div className="p-3 rounded-lg bg-muted text-sm space-y-1">
              <div>
                Hora fin esperada: <b>{format(pendingExit.exitEval.end, 'HH:mm')}</b>
              </div>
              <div>
                Sales con: <b>{pendingExit.exitEval.diffMinToEnd} min</b> antes del fin
              </div>
              <div className="text-xs text-muted-foreground">
                (Si es más de 30 min antes, el permiso es obligatorio)
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Motivo</Label>
            <Input
              value={earlyExitMotivo}
              onChange={(e) => setEarlyExitMotivo(e.target.value)}
              placeholder="Ej: cita médica, permiso de jefe, calamidad..."
            />
            <p className="text-xs text-muted-foreground">
              Al confirmar, se abrirá la cámara para tomar el permiso firmado.
            </p>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEarlyExitOpen(false);
                setPendingExit(null);
              }}
            >
              Cancelar
            </Button>
            <Button onClick={confirmEarlyExit}>Confirmar y tomar permiso</Button>
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
