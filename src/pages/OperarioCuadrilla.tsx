import { useEffect, useMemo, useState, useCallback } from 'react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import {
  LogIn, LogOut, Settings, Camera, MapPin,
  AlertTriangle, CheckCircle2, Clock3, Timer,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useAttendance } from '@/hooks/useAttendance';
import { supabase } from '@/integrations/supabase/client';
import { SyncStatusBadge } from '@/components/SyncStatusBadge';
import { AttendanceButton } from '@/components/AttendanceButton';
import { LastRecordCard } from '@/components/LastRecordCard';
import { HoursWorkedCard } from '@/components/HoursWorkedCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Link } from 'react-router-dom';
import { useCamera } from '@/hooks/useCamera';
import { useLocationTracking } from '@/hooks/useLocationTracking';
import {
  Dialog, DialogContent, DialogHeader,
  DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';

type FollowUpRow = { evidencia_n: 1 | 2; foto_url: string; timestamp: string };

const FOLLOWUP_REQUIRED_MS = 60 * 1000;

// ---------- Horarios ----------
type DaySchedule = {
  startHHMM: string;
  endHHMM: string;
  inGraceMinutes: number;
  earlyLeaveFreeMinutes: number;
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
  const day = date.getDay();
  if (day >= 1 && day <= 4)
    return { startHHMM: '06:00', endHHMM: '13:00', inGraceMinutes: 10, earlyLeaveFreeMinutes: 30 };
  if (day === 5 || day === 6)
    return { startHHMM: '06:00', endHHMM: '14:00', inGraceMinutes: 10, earlyLeaveFreeMinutes: 30 };
  return { startHHMM: '06:00', endHHMM: '13:00', inGraceMinutes: 10, earlyLeaveFreeMinutes: 30 };
}

function evaluateArrival(ts: Date) {
  const sch = getSchedule(ts);
  const start = toDateAtHHMM(ts, sch.startHHMM);
  const graceLimit = new Date(start.getTime() + sch.inGraceMinutes * 60 * 1000);
  const diffMin = Math.round((ts.getTime() - start.getTime()) / (60 * 1000));
  const status: ArrivalStatus = ts.getTime() <= graceLimit.getTime() ? 'temprano_o_a_tiempo' : 'tarde';
  return { status, diffMin, start, graceLimit, sch };
}

function evaluateExit(ts: Date) {
  const sch = getSchedule(ts);
  const end = toDateAtHHMM(ts, sch.endHHMM);
  const freeEarlyLimit = new Date(end.getTime() - sch.earlyLeaveFreeMinutes * 60 * 1000);
  const diffMinToEnd = Math.round((end.getTime() - ts.getTime()) / (60 * 1000));
  let status: ExitStatus = 'a_tiempo';
  if (ts.getTime() < freeEarlyLimit.getTime()) status = 'se_fue_antes_mas_30';
  else if (ts.getTime() < end.getTime()) status = 'se_fue_antes_30';
  return { status, diffMinToEnd, end, freeEarlyLimit, sch };
}

// ---------- LocalStorage ----------
function storageKey(userId: string, entradaId: string) {
  return `followups:${userId}:${entradaId}`;
}
function readLocalFollowups(userId: string, entradaId: string): FollowUpRow[] {
  try {
    const raw = localStorage.getItem(storageKey(userId, entradaId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FollowUpRow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function writeLocalFollowups(userId: string, entradaId: string, rows: FollowUpRow[]) {
  try { localStorage.setItem(storageKey(userId, entradaId), JSON.stringify(rows)); } catch {}
}

function isIOS() {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1);
}

function formatDuration(ms: number) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`;
  return `${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`;
}

type AttendanceResult = {
  isOpen: boolean;
  tipo: 'entrada' | 'salida';
  success: boolean;
  hoursWorked?: number | null;
  arrivalStatus?: ArrivalStatus;
  diffMin?: number;
  exitStatus?: ExitStatus;
  diffMinToEnd?: number;
  endHHMM?: string;
  errorMsg?: string | null;
};

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
    syncPendingFollowups,
  } = useAttendance();

  const { capturePhoto, error: cameraError } = useCamera();

  const [remoteFollowups, setRemoteFollowups] = useState<FollowUpRow[]>([]);
  const [localFollowups, setLocalFollowups] = useState<FollowUpRow[]>([]);
  const [isLoadingFollowups, setIsLoadingFollowups] = useState(false);

  const [geoOpen, setGeoOpen] = useState(false);
  const [geoInfo, setGeoInfo] = useState<{ nom: string; hac_ste: string } | null>(null);
  const [geoCoords, setGeoCoords] = useState<{ lat: number | null; lon: number | null; accuracy: number | null } | null>(null);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);

  const [attendanceResult, setAttendanceResult] = useState<AttendanceResult>({
    isOpen: false, tipo: 'entrada', success: false,
  });

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const [earlyExitOpen, setEarlyExitOpen] = useState(false);
  const [earlyExitMotivo, setEarlyExitMotivo] = useState('');
  const [pendingExit, setPendingExit] = useState<{
    salidaPhotoBlob: Blob;
    exitEval: ReturnType<typeof evaluateExit>;
    exitTimestampISO: string;
  } | null>(null);

  const today = format(new Date(), "EEEE, d 'de' MMMM", { locale: es });
  const hoursWorked = calculateHoursWorked({ includeOpenSession: false });

  const scheduleLabel = useMemo(() => {
    const sch = getSchedule(new Date());
    return `${sch.startHHMM} - ${sch.endHHMM}`;
  }, []);

  useEffect(() => { getTodayRecords(); }, [getTodayRecords]);

  useEffect(() => {
    const onOnline = async () => {
      try { await syncPendingFollowups?.(); } catch (e) { console.error(e); }
      finally { await getTodayRecords(); await loadFollowups(); }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncPendingFollowups, getTodayRecords]);

  const activeEntrada = useMemo(() => {
    const sorted = [...todayRecords].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    let current: any = null;
    for (const r of sorted) {
      if (r.tipo_registro === 'entrada') current = r;
      if (r.tipo_registro === 'salida') current = null;
    }
    return current;
  }, [todayRecords]);

  const activeEntradaId = activeEntrada?.id ?? null;
  useLocationTracking(activeEntradaId);

  const loadFollowups = useCallback(async () => {
    if (!activeEntrada?.id || !user?.id) {
      setRemoteFollowups([]); setLocalFollowups([]); return;
    }
    setLocalFollowups(readLocalFollowups(user.id, activeEntrada.id));
    if (!navigator.onLine) { setRemoteFollowups([]); return; }
    setIsLoadingFollowups(true);
    const { data, error: qErr } = await supabase
      .from('seguimiento_fotos')
      .select('evidencia_n, foto_url, timestamp')
      .eq('entrada_id', activeEntrada.id)
      .order('evidencia_n', { ascending: true });
    if (!qErr) setRemoteFollowups((data || []) as FollowUpRow[]);
    setIsLoadingFollowups(false);
  }, [activeEntrada?.id, user?.id]);

  useEffect(() => { loadFollowups(); }, [loadFollowups]);

  const followups = useMemo(() => {
    const map = new Map<string, FollowUpRow>();
    for (const f of remoteFollowups) map.set(`${f.evidencia_n}`, f);
    for (const f of localFollowups) map.set(`${f.evidencia_n}`, f);
    return Array.from(map.values()).sort((a, b) => a.evidencia_n - b.evidencia_n);
  }, [remoteFollowups, localFollowups]);

  const hasFollow1 = followups.some((f) => f.evidencia_n === 1);
  const hasFollow2 = followups.some((f) => f.evidencia_n === 2);

  const follow1Timestamp = useMemo(
    () => followups.find((f) => f.evidencia_n === 1)?.timestamp ?? null,
    [followups]
  );
  const follow2Timestamp = useMemo(
    () => followups.find((f) => f.evidencia_n === 2)?.timestamp ?? null,
    [followups]
  );

  const laborDurationMs = useMemo(() => {
    void tick;
    if (!follow1Timestamp) return null;
    const start = new Date(follow1Timestamp).getTime();
    const end = follow2Timestamp ? new Date(follow2Timestamp).getTime() : Date.now();
    return Math.max(0, end - start);
  }, [follow1Timestamp, follow2Timestamp, tick]);

  const follow1EnabledInfo = useMemo(() => {
    void tick;
    if (!activeEntrada) return { enabled: false, remainingText: 'Primero marca entrada' };
    const start = new Date(activeEntrada.timestamp).getTime();
    const diffMs = Date.now() - start;
    if (diffMs >= FOLLOWUP_REQUIRED_MS) return { enabled: true, remainingText: '' };
    const remaining = FOLLOWUP_REQUIRED_MS - diffMs;
    const mins = Math.floor(remaining / (60 * 1000));
    const secs = Math.max(0, Math.ceil((remaining % (60 * 1000)) / 1000));
    return { enabled: false, remainingText: `${mins}m ${secs}s` };
  }, [activeEntrada, tick]);

  // ✅ Salida habilitada solo cuando ambas evidencias están completas
  const canExit = hasFollow1 && hasFollow2;

  const showError = useCallback((tipo: 'entrada' | 'salida', message: string) => {
    setAttendanceResult({ isOpen: true, tipo, success: false, errorMsg: message });
  }, []);

  const confirmEarlyExit = useCallback(async () => {
    if (!pendingExit) return;
    if (!earlyExitMotivo.trim()) {
      showError('salida', 'Debes escribir el motivo de salida temprana.');
      return;
    }
    try {
      const permisoBlob = await capturePhoto();
      const result = await (markAttendance as any)('salida', pendingExit.salidaPhotoBlob, {
        salida_estado: pendingExit.exitEval.status,
        minutos_antes_fin: pendingExit.exitEval.diffMinToEnd,
        motivo_salida_temprano: earlyExitMotivo.trim(),
        permiso_firmado_blob: permisoBlob,
        client_timestamp: pendingExit.exitTimestampISO,
      });
      setEarlyExitOpen(false);
      setPendingExit(null);
      setAttendanceResult({
        isOpen: true,
        tipo: 'salida',
        success: result?.success,
        hoursWorked: result?.hoursWorked,
        exitStatus: pendingExit.exitEval.status,
        diffMinToEnd: pendingExit.exitEval.diffMinToEnd,
        endHHMM: format(pendingExit.exitEval.end, 'HH:mm'),
        errorMsg: result?.success ? null : (result?.error ?? 'No se pudo registrar'),
      });
      if (result?.success) { await getTodayRecords(); await loadFollowups(); }
    } catch (err: any) {
      showError('salida', err?.message || cameraError || 'Error registrando salida temprana.');
    }
  }, [pendingExit, earlyExitMotivo, capturePhoto, markAttendance, cameraError, showError, getTodayRecords, loadFollowups]);

  const handleMarkAttendance = async (tipo: 'entrada' | 'salida') => {
    try {
      if (tipo === 'salida') {
        // ✅ Ambas evidencias obligatorias
        if (!hasFollow1) {
          showError('salida', 'Debes registrar el inicio de labor (Evidencia 1) antes de marcar la salida.');
          return;
        }
        if (!hasFollow2) {
          showError('salida', 'Debes registrar el fin de labor (Evidencia 2) antes de marcar la salida.');
          return;
        }

        const now = new Date();
        const ex = evaluateExit(now);
        if (ex.status === 'se_fue_antes_mas_30') {
          const salidaBlob = await capturePhoto();
          setPendingExit({ salidaPhotoBlob: salidaBlob, exitEval: ex, exitTimestampISO: now.toISOString() });
          setEarlyExitMotivo('');
          setEarlyExitOpen(true);
          return;
        }
      }

      const photoBlob = await capturePhoto();
      const now = new Date();
      const meta: any = { client_timestamp: now.toISOString() };

      if (tipo === 'entrada') {
        const arr = evaluateArrival(now);
        meta.llegada_estado = arr.status;
        meta.minutos_vs_inicio = arr.diffMin;
        meta.horario_inicio = arr.sch.startHHMM;
        meta.horario_fin = arr.sch.endHHMM;
      } else {
        const ex = evaluateExit(now);
        meta.salida_estado = ex.status;
        meta.minutos_antes_fin = ex.diffMinToEnd;
        meta.horario_inicio = ex.sch.startHHMM;
        meta.horario_fin = ex.sch.endHHMM;
      }

      const result = await (markAttendance as any)(tipo, photoBlob, meta);

      if (tipo === 'entrada') {
        const arr = evaluateArrival(new Date(meta.client_timestamp));
        setGeoCoords(result?.coords ?? null);
        setGeoInfo(result?.geo ?? null);
        if (!result?.coords?.lat || !result?.coords?.lon) {
          setGeoMsg('No se pudo obtener ubicación.');
        } else if (!result?.geo) {
          setGeoMsg('GPS OK, pero no se identificó suerte/hacienda.');
        } else {
          setGeoMsg(null);
        }
        setAttendanceResult({
          isOpen: true,
          tipo: 'entrada',
          success: result?.success,
          hoursWorked: result?.hoursWorked,
          arrivalStatus: arr.status,
          diffMin: arr.diffMin,
          errorMsg: result?.success ? null : (result?.error ?? 'No se pudo registrar'),
        });
        if (result?.success) {
          await getTodayRecords();
          await loadFollowups();
          setTimeout(() => setGeoOpen(true), 300);
        }
      } else {
        const ex = evaluateExit(new Date(meta.client_timestamp));
        setAttendanceResult({
          isOpen: true,
          tipo: 'salida',
          success: result?.success,
          hoursWorked: result?.hoursWorked,
          exitStatus: ex.status,
          diffMinToEnd: ex.diffMinToEnd,
          endHHMM: format(ex.end, 'HH:mm'),
          errorMsg: result?.success ? null : (result?.error ?? 'No se pudo registrar'),
        });
        if (result?.success) { await getTodayRecords(); await loadFollowups(); }
      }
    } catch (err: any) {
      console.error(err);
      showError(tipo, err?.message || cameraError || 'Error. Verifica permisos de Cámara/Ubicación.');
    }
  };

  const handleFollowUp = async (n: 1 | 2) => {
    try {
      if (!activeEntrada?.id || !user?.id) { showError('entrada', 'Primero marca la entrada.'); return; }
      if (n === 1 && !follow1EnabledInfo.enabled) return;
      if (n === 2 && !hasFollow1) return;

      const blob = await capturePhoto();
      const localRow: FollowUpRow = { evidencia_n: n, foto_url: 'local://pending', timestamp: new Date().toISOString() };
      const current = readLocalFollowups(user.id, activeEntrada.id);
      const next = [...current.filter((x) => x.evidencia_n !== n), localRow].sort((a, b) => a.evidencia_n - b.evidencia_n);
      writeLocalFollowups(user.id, activeEntrada.id, next);
      setLocalFollowups(next);

      const res = await markFollowUp(n, blob, activeEntrada.id);
      if (!res?.success) { showError('entrada', 'No se pudo guardar la evidencia.'); return; }

      if (navigator.onLine) { try { await syncPendingFollowups?.(); } catch (e) { console.error(e); } }
      await loadFollowups();
    } catch (err: any) {
      showError('entrada', err?.message || cameraError || 'Error registrando evidencia.');
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">

      <header className="sticky top-0 z-10 bg-card border-b px-4 py-3 shadow-sm">
        <div className="max-w-lg mx-auto w-full flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <img
              src="/logo_ipsa.JPG.jpeg"
              alt="Logo IPSA"
              className="h-10 w-auto object-contain shrink-0 sm:h-14"
            />
            <div className="min-w-0 flex flex-col">
              <p className="text-sm font-semibold text-foreground leading-tight truncate sm:text-base">
                {profile?.nombre || 'Usuario'}
              </p>
              <p className="text-xs text-muted-foreground capitalize leading-tight truncate sm:text-sm">
                {today}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {isSupervisor && (
              <Link to="/supervisor/cuadrilla">
                <Button variant="outline" size="icon" className="h-8 w-8 sm:h-9 sm:w-9">
                  <Settings className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                </Button>
              </Link>
            )}
            <Button variant="ghost" size="sm" onClick={signOut} className="text-xs sm:text-sm px-2 sm:px-3">
              Salir
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 p-3 sm:p-4 space-y-3 sm:space-y-4 max-w-lg mx-auto w-full">

        <div className="flex justify-center">
          <SyncStatusBadge />
        </div>

        <HoursWorkedCard hours={hoursWorked} />

        {/* Timer labor */}
        {follow1Timestamp && (
          <div className={`rounded-lg border p-3 sm:p-4 flex items-center gap-3 ${
            follow2Timestamp
              ? 'border-emerald-500/30 bg-emerald-500/5'
              : 'border-blue-500/30 bg-blue-500/5'
          }`}>
            <Timer className={`h-5 w-5 sm:h-6 sm:w-6 shrink-0 ${
              follow2Timestamp ? 'text-emerald-600' : 'text-blue-500'
            }`} />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground">
                {follow2Timestamp ? 'Labor finalizada — duración total' : 'Labor en curso'}
              </p>
              <p className="text-xl sm:text-2xl font-mono font-bold tracking-tight">
                {laborDurationMs !== null ? formatDuration(laborDurationMs) : '—'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                Inicio: {format(new Date(follow1Timestamp), 'HH:mm:ss')}
                {follow2Timestamp && ` · Fin: ${format(new Date(follow2Timestamp), 'HH:mm:ss')}`}
              </p>
            </div>
          </div>
        )}

        <div>
          <h2 className="text-xs sm:text-sm font-medium text-muted-foreground mb-2">
            Último registro hoy
          </h2>
          <LastRecordCard record={lastRecord} />
        </div>

        <div className="space-y-2 sm:space-y-3 pt-1">

          {/* 1) ENTRADA */}
          <AttendanceButton
            type="entrada"
            onClick={() => handleMarkAttendance('entrada')}
            disabled={isSubmitting || !!activeEntrada}
          >
            <LogIn className="h-6 w-6 sm:h-7 sm:w-7" />
            <span className="text-sm sm:text-base">
              {activeEntrada ? 'Entrada ya registrada' : 'Marcar Entrada'}
            </span>
          </AttendanceButton>

          {/* 2) EVIDENCIA 1 — inicio labor */}
          <Button
            className="w-full h-10 sm:h-11 text-sm"
            onClick={() => handleFollowUp(1)}
            disabled={isSubmitting || hasFollow1 || !follow1EnabledInfo.enabled || !activeEntrada}
          >
            <Camera className="h-4 w-4 mr-2 shrink-0" />
            <span className="truncate">
              {hasFollow1
                ? 'Labor iniciada ✅'
                : follow1EnabledInfo.enabled
                  ? 'Oprime para iniciar labor'
                  : `${follow1EnabledInfo.remainingText} para iniciar labor`}
            </span>
          </Button>

          {/* 3) EVIDENCIA 2 — fin labor (OBLIGATORIA para salir) */}
          <Button
            className="w-full h-10 sm:h-11 text-sm"
            variant="outline"
            onClick={() => handleFollowUp(2)}
            disabled={isSubmitting || hasFollow2 || !hasFollow1 || !activeEntrada}
          >
            <Camera className="h-4 w-4 mr-2 shrink-0" />
            <span>
              {hasFollow2
                ? 'Labor finalizada ✅'
                : hasFollow1
                  ? 'Oprime para finalizar labor (obligatorio)'
                  : 'Finalizar labor (requiere iniciar primero)'}
            </span>
          </Button>

          {/* ✅ Aviso visual cuando falta la Evidencia 2 y hay Evidencia 1 */}
          {hasFollow1 && !hasFollow2 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-700">
                Debes finalizar la labor antes de marcar la salida.
              </p>
            </div>
          )}

          {/* 4) SALIDA — requiere Evidencia 1 Y Evidencia 2 */}
          <AttendanceButton
            type="salida"
            onClick={() => handleMarkAttendance('salida')}
            disabled={isSubmitting || !canExit}
          >
            <LogOut className="h-6 w-6 sm:h-7 sm:w-7" />
            <span className="text-sm sm:text-base">
              {canExit
                ? 'Marcar Salida'
                : !hasFollow1
                  ? 'Marcar Salida (inicia labor primero)'
                  : 'Marcar Salida (finaliza labor primero)'}
            </span>
          </AttendanceButton>

          {/* Horario */}
          <div className="rounded-lg border bg-muted/30 px-3 py-2 flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Horario hoy: {scheduleLabel}</span>
              <span className="ml-1">· entrada hasta 06:10</span>
            </div>
          </div>

          <p className="text-xs text-muted-foreground text-center">
            {isLoadingFollowups
              ? 'Cargando...'
              : `${hasFollow1 ? '✅ Labor iniciada' : '❌ Sin iniciar'} · ${hasFollow2 ? '✅ Labor finalizada' : '❌ Sin finalizar'}`}
          </p>
        </div>

        {todayRecords.length > 0 && (
          <div className="pt-1">
            <h3 className="text-xs sm:text-sm font-medium text-muted-foreground mb-2">
              Registros de hoy ({todayRecords.length})
            </h3>
            <div className="space-y-1.5 sm:space-y-2">
              {todayRecords.slice(0, 4).map((record) => (
                <div
                  key={record.id}
                  className="flex items-center justify-between px-3 py-2 rounded-lg bg-muted/50"
                >
                  <span className={`text-xs sm:text-sm font-medium ${
                    record.tipo_registro === 'entrada' ? 'text-success' : 'text-destructive'
                  }`}>
                    {record.tipo_registro === 'entrada' ? '🟢' : '🔴'}{' '}
                    {record.tipo_registro.toUpperCase()}
                  </span>
                  <span className="text-xs sm:text-sm text-muted-foreground">
                    {format(new Date(record.timestamp), 'HH:mm')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Modal resultado entrada/salida */}
      <Dialog
        open={attendanceResult.isOpen}
        onOpenChange={(o) => !o && setAttendanceResult((p) => ({ ...p, isOpen: false }))}
      >
        <DialogContent className="max-w-sm mx-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              {attendanceResult.success
                ? <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
                : <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />}
              {attendanceResult.tipo === 'entrada' ? 'Registro de Entrada' : 'Registro de Salida'}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            {!attendanceResult.success && attendanceResult.errorMsg && (
              <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive">
                {attendanceResult.errorMsg}
              </div>
            )}

            {attendanceResult.success && attendanceResult.tipo === 'entrada' && attendanceResult.arrivalStatus && (
              <div className={`p-3 sm:p-4 rounded-lg border ${
                attendanceResult.arrivalStatus === 'tarde'
                  ? 'border-destructive/30 bg-destructive/5'
                  : 'border-emerald-500/30 bg-emerald-500/5'
              }`}>
                {attendanceResult.arrivalStatus === 'tarde' ? (
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold text-destructive text-sm sm:text-base">Llegaste tarde</p>
                      <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                        {attendanceResult.diffMin !== undefined && attendanceResult.diffMin > 0
                          ? `${attendanceResult.diffMin} min después del límite (06:10)`
                          : 'Fuera del rango permitido'}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold text-emerald-700 text-sm sm:text-base">Llegaste a tiempo ✅</p>
                      {attendanceResult.diffMin !== undefined && attendanceResult.diffMin < 0 && (
                        <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                          {Math.abs(attendanceResult.diffMin)} min antes del inicio
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {attendanceResult.success && attendanceResult.tipo === 'salida' && attendanceResult.exitStatus && (
              <div className={`p-3 sm:p-4 rounded-lg border ${
                attendanceResult.exitStatus === 'a_tiempo'
                  ? 'border-emerald-500/30 bg-emerald-500/5'
                  : 'border-amber-500/30 bg-amber-500/5'
              }`}>
                {attendanceResult.exitStatus === 'a_tiempo' && (
                  <div className="flex items-start gap-2">
                    <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold text-emerald-700 text-sm sm:text-base">Salida a tiempo ✅</p>
                      <p className="text-xs sm:text-sm text-muted-foreground mt-1">Hora fin: {attendanceResult.endHHMM}</p>
                    </div>
                  </div>
                )}
                {attendanceResult.exitStatus === 'se_fue_antes_30' && (
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold text-amber-700 text-sm sm:text-base">Salida anticipada</p>
                      <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                        {attendanceResult.diffMinToEnd} min antes del fin ({attendanceResult.endHHMM}). Dentro del margen.
                      </p>
                    </div>
                  </div>
                )}
                {attendanceResult.exitStatus === 'se_fue_antes_mas_30' && (
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold text-destructive text-sm sm:text-base">Salida temprana registrada</p>
                      <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                        {attendanceResult.diffMinToEnd} min antes. Se registró motivo y permiso.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {attendanceResult.success && attendanceResult.hoursWorked != null && (
              <div className="p-3 rounded-lg bg-muted text-sm flex justify-between items-center">
                <span className="text-muted-foreground text-xs sm:text-sm">Horas trabajadas hoy</span>
                <span className="font-semibold">{attendanceResult.hoursWorked.toFixed(1)} h</span>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              className="w-full sm:w-auto"
              onClick={() => setAttendanceResult((p) => ({ ...p, isOpen: false }))}
            >
              Aceptar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal Geo */}
      <Dialog open={geoOpen} onOpenChange={setGeoOpen}>
        <DialogContent className="max-w-sm mx-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <MapPin className="h-5 w-5 shrink-0" />
              Ubicación al iniciar turno
            </DialogTitle>
            <DialogDescription className="text-xs sm:text-sm">
              Al iniciar el turno te encuentras en
            </DialogDescription>
          </DialogHeader>
          {geoInfo ? (
            <div className="space-y-2">
              <div className="p-3 rounded-lg bg-muted">
                <p className="text-xs text-muted-foreground">Suerte</p>
                <p className="text-sm sm:text-base font-semibold">{geoInfo.nom}</p>
              </div>
              <div className="p-3 rounded-lg bg-muted">
                <p className="text-xs text-muted-foreground">Hacienda/Suerte</p>
                <p className="text-sm sm:text-base font-semibold">{geoInfo.hac_ste}</p>
              </div>
              {geoCoords?.accuracy != null && (
                <p className="text-xs text-muted-foreground">
                  Precisión GPS: ±{Math.round(geoCoords.accuracy)} m
                </p>
              )}
            </div>
          ) : (
            <div className="p-3 rounded-lg bg-muted text-xs sm:text-sm">
              {geoMsg ?? 'Consultando...'}
            </div>
          )}
          <DialogFooter>
            <Button className="w-full sm:w-auto" onClick={() => setGeoOpen(false)}>Aceptar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal salida temprana */}
      <Dialog open={earlyExitOpen} onOpenChange={setEarlyExitOpen}>
        <DialogContent className="max-w-sm mx-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
              Salida temprana
            </DialogTitle>
            <DialogDescription className="text-xs sm:text-sm">
              Registra el motivo y toma foto del permiso firmado.
            </DialogDescription>
          </DialogHeader>

          {pendingExit?.exitEval && (
            <div className="p-3 rounded-lg bg-muted text-xs sm:text-sm space-y-1">
              <div>Hora fin esperada: <b>{format(pendingExit.exitEval.end, 'HH:mm')}</b></div>
              <div>Sales con: <b>{pendingExit.exitEval.diffMinToEnd} min</b> de anticipación</div>
            </div>
          )}

          <div className="space-y-2">
            <Label className="text-sm">Motivo</Label>
            <Input
              value={earlyExitMotivo}
              onChange={(e) => setEarlyExitMotivo(e.target.value)}
              placeholder="Ej: cita médica, permiso de jefe..."
              className="text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Al confirmar se abrirá la cámara para el permiso firmado.
            </p>
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => { setEarlyExitOpen(false); setPendingExit(null); }}
            >
              Cancelar
            </Button>
            <Button className="w-full sm:w-auto" onClick={confirmEarlyExit}>
              Confirmar y tomar permiso
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}