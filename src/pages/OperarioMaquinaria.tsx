import { useEffect, useMemo, useState, useCallback } from 'react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import {
  LogIn,
  LogOut,
  User,
  Leaf,
  Settings,
  Camera,
  MapPin,
  ClipboardCheck,
} from 'lucide-react';
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

type FollowUpRow = { evidencia_n: 1 | 2; foto_url: string; timestamp: string };

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

// ✅ Evidencia 1 habilitada tras X tiempo (cambia aquí)
const FOLLOWUP_REQUIRED_MS = 60 * 1000;

// ---------- Local storage: evidencias ----------
function followupStorageKey(userId: string, entradaId: string) {
  return `followups:maq:${userId}:${entradaId}`;
}
function readLocalFollowups(userId: string, entradaId: string): FollowUpRow[] {
  try {
    const raw = localStorage.getItem(followupStorageKey(userId, entradaId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FollowUpRow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function writeLocalFollowups(userId: string, entradaId: string, rows: FollowUpRow[]) {
  try {
    localStorage.setItem(followupStorageKey(userId, entradaId), JSON.stringify(rows));
  } catch {}
}

// ---------- Local storage: revisiones (estado completo) ----------
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
function writeLocalRevisionComplete(userId: string, dateISO: string, tipo: RevisionTipo, complete: boolean) {
  try {
    localStorage.setItem(revisionLocalKey(userId, dateISO, tipo), complete ? '1' : '0');
  } catch {}
}

// ---------- Local storage: revisiones (pendientes offline) ----------
type PendingRevision = {
  id: string; // uuid local
  user_id: string;
  entrada_id: string;
  tipo: RevisionTipo;
  equipo_codigo: string;
  timestamp: string;

  // GPS + ubicación (si se pudo)
  latitud: number | null;
  longitud: number | null;
  precision_gps: number | null;
  fuera_zona: boolean;
  hac_ste: string | null;
  suerte_nom: string | null;

  // fotos tomadas (paths locales o marcador)
  photos: Array<{
    foto_tipo: 'frente' | 'lado_derecho' | 'lado_izquierdo' | 'trasera' | 'cabina';
    foto_url: string; // 'local://pending' si todavía no está en storage
    timestamp: string;
  }>;
};

const PENDING_REV_KEY = 'pending_revisions_v1';

function readPendingRevisions(): PendingRevision[] {
  try {
    const raw = localStorage.getItem(PENDING_REV_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingRevision[]) : [];
  } catch {
    return [];
  }
}

function writePendingRevisions(items: PendingRevision[]) {
  try {
    localStorage.setItem(PENDING_REV_KEY, JSON.stringify(items));
  } catch {}
}

// ---------- Helpers ----------
function safeUUID() {
  try {
    // @ts-ignore
    if (typeof crypto !== 'undefined' && crypto?.randomUUID) return crypto.randomUUID();
  } catch {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function isIOS() {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1)
  );
}

type GeoResult = { nom: string; hac_ste: string } | null;

async function resolveGeo(lat: number, lon: number): Promise<GeoResult> {
  const { data, error } = await supabase.rpc('get_hacienda_by_point', { lat, lon });
  if (error || !data || data.length === 0) return null;
  return { nom: data[0].nom, hac_ste: data[0].hac_ste };
}

/**
 * ✅ Sync de revisiones pendientes (metadata) cuando vuelve internet.
 * OJO: aquí sincronizamos la tabla revision_maquinaria (no las fotos, porque tú las subes en la pantalla de /inicio o /fin).
 * Si tus pantallas de revisión ya suben fotos directo a storage+tabla revision_maquinaria_fotos, entonces:
 * - solo necesitamos crear el registro en revision_maquinaria al iniciar.
 * - si estás offline, guardamos pendiente aquí, y al volver online lo insertamos.
 */
async function syncPendingRevisions(userId: string): Promise<{ synced: number; failed: number }> {
  if (!navigator.onLine) return { synced: 0, failed: 0 };

  const all = readPendingRevisions();
  const mine = all.filter((x) => x.user_id === userId);
  if (mine.length === 0) return { synced: 0, failed: 0 };

  let synced = 0;
  let failed = 0;

  const keep: PendingRevision[] = [];
  const others = all.filter((x) => x.user_id !== userId);

  for (const item of mine) {
    try {
      // insertar revision_maquinaria (requiere que agregaste columnas: timestamp, latitud, longitud, precision_gps, fuera_zona, hac_ste, suerte_nom)
      const payload: any = {
        id: item.id,
        user_id: item.user_id,
        entrada_id: item.entrada_id,
        tipo: item.tipo,
        equipo_codigo: item.equipo_codigo,
        timestamp: item.timestamp,
        latitud: item.latitud,
        longitud: item.longitud,
        precision_gps: item.precision_gps,
        fuera_zona: item.fuera_zona,
        hac_ste: item.hac_ste,
        suerte_nom: item.suerte_nom,
      };

      const { error } = await supabase.from('revision_maquinaria').insert(payload);
      if (error) {
        // duplicado (ya se insertó) -> lo damos por sincronizado
        // @ts-ignore
        if (error.code === '23505') {
          synced++;
          continue;
        }
        throw error;
      }

      synced++;
    } catch (e) {
      console.error('[syncPendingRevisions] failed', item, e);
      failed++;
      keep.push(item);
    }
  }

  writePendingRevisions([...others, ...keep]);
  return { synced, failed };
}

/**
 * ✅ Crea (o deja pendiente) el registro revision_maquinaria al momento de arrancar la revisión
 * Esto asegura: ubicación + nombre guardados SIEMPRE que se pueda.
 */
async function createRevisionRecord(params: {
  userId: string;
  entradaId: string;
  tipo: RevisionTipo;
  equipoCodigo: string;
  getCurrentPosition: () => Promise<{ latitude: number; longitude: number; accuracy: number }>;
}): Promise<{ success: boolean; revisionId?: string; coords?: any; geo?: GeoResult; error?: string }> {
  const { userId, entradaId, tipo, equipoCodigo, getCurrentPosition } = params;

  try {
    // GPS best effort
    let location: { latitude: number; longitude: number; accuracy: number } | null = null;
    try {
      location = await getCurrentPosition();
    } catch {}

    const hasCoords = location?.latitude != null && location?.longitude != null;

    // Geo solo online
    let geo: GeoResult = null;
    if (navigator.onLine && hasCoords) {
      geo = await resolveGeo(location!.latitude, location!.longitude);
    }

    const fueraZona = hasCoords ? !geo : false;

    const revisionId = safeUUID();
    const payload: any = {
      id: revisionId,
      user_id: userId,
      entrada_id: entradaId,
      tipo,
      equipo_codigo: equipoCodigo,
      timestamp: new Date().toISOString(),

      latitud: location?.latitude ?? null,
      longitud: location?.longitude ?? null,
      precision_gps: location?.accuracy ?? null,
      fuera_zona: fueraZona,
      hac_ste: geo?.hac_ste ?? null,
      suerte_nom: geo?.nom ?? null,
    };

    if (navigator.onLine) {
      const { error } = await supabase.from('revision_maquinaria').insert(payload);
      if (error) throw new Error(error.message);
      return {
        success: true,
        revisionId,
        coords: {
          lat: location?.latitude ?? null,
          lon: location?.longitude ?? null,
          accuracy: location?.accuracy ?? null,
        },
        geo,
      };
    }

    // OFFLINE: guardar pendiente para sync luego
    const pending = readPendingRevisions();
    const next: PendingRevision[] = [
      ...pending.filter(
        (x) => !(x.user_id === userId && x.entrada_id === entradaId && x.tipo === tipo)
      ),
      {
        id: revisionId,
        user_id: userId,
        entrada_id: entradaId,
        tipo,
        equipo_codigo: equipoCodigo,
        timestamp: payload.timestamp,

        latitud: payload.latitud,
        longitud: payload.longitud,
        precision_gps: payload.precision_gps,
        fuera_zona: payload.fuera_zona,
        hac_ste: payload.hac_ste,
        suerte_nom: payload.suerte_nom,
        photos: [],
      },
    ];

    writePendingRevisions(next);

    return {
      success: true,
      revisionId,
      coords: {
        lat: location?.latitude ?? null,
        lon: location?.longitude ?? null,
        accuracy: location?.accuracy ?? null,
      },
      geo,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ? String(err.message) : 'Error creando revisión' };
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
    markFollowUp,
    syncPendingFollowups,
  } = useAttendance();

  const { capturePhoto, error: cameraError } = useCamera();
  const { getCurrentPosition } = useLocationTracking(null) as any; // ❗ si tu hook NO expone esto, quítalo
  // ✅ Si tu useGeolocation ya existe (en useAttendance), usa ese hook aquí también:
  // import { useGeolocation } from '@/hooks/useGeolocation';
  // const { getCurrentPosition } = useGeolocation();

  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    type: 'entrada' | 'salida';
    success: boolean;
    hoursWorked?: number | null;
    error?: string | null;
  }>({ isOpen: false, type: 'entrada', success: false });

  // Geo modal
  const [geoOpen, setGeoOpen] = useState(false);
  const [geoInfo, setGeoInfo] = useState<GeoResult>(null);
  const [geoCoords, setGeoCoords] = useState<{
    lat: number | null;
    lon: number | null;
    accuracy: number | null;
  } | null>(null);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);

  // Revisiones
  const dateISO = format(new Date(), 'yyyy-MM-dd');
  const [rev, setRev] = useState<RevisionState>({
    loading: false,
    inicioComplete: false,
    finComplete: false,
    inicioCount: 0,
    finCount: 0,
    required: REQUIRED_MAQUINARIA_PHOTOS,
  });

  // Evidencias
  const [remoteFollowups, setRemoteFollowups] = useState<FollowUpRow[]>([]);
  const [localFollowups, setLocalFollowups] = useState<FollowUpRow[]>([]);
  const [isLoadingFollowups, setIsLoadingFollowups] = useState(false);

  // equipo seleccionado (si tú lo seleccionas en otra pantalla, cámbialo)
  const [equipoCodigo, setEquipoCodigo] = useState<string>('EQ-000');

  // Ticker (contador offline)
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const today = format(new Date(), "EEEE, d 'de' MMMM", { locale: es });
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

  // “entrada activa”
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

  const activeEntradaId = activeEntrada?.id ?? null;

  // Tracking ubicación mientras hay entrada abierta
  useLocationTracking(activeEntradaId);

  // Cargar registros al montar
  useEffect(() => {
    getTodayRecords();
  }, [getTodayRecords]);

  // --------------------- Revisiones: status remoto + fallback local ---------------------
  const loadRevisionStatus = useCallback(async () => {
    if (!user?.id) return;

    const localInicio = readLocalRevisionComplete(user.id, dateISO, 'inicio');
    const localFin = readLocalRevisionComplete(user.id, dateISO, 'fin');

    // si offline: solo local
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

    const { data: revisions, error: revErr } = await supabase
      .from('revision_maquinaria')
      .select('id, tipo, created_at')
      .eq('user_id', user.id)
      .gte('created_at', startOfDay)
      .lte('created_at', endOfDay);

    if (revErr) {
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

    // ✅ persistir local (fallback)
    writeLocalRevisionComplete(user.id, dateISO, 'inicio', inicioCompleteRemote || localInicio);
    writeLocalRevisionComplete(user.id, dateISO, 'fin', finCompleteRemote || localFin);

    setRev({
      loading: false,
      inicioCount,
      finCount,
      required: REQUIRED_MAQUINARIA_PHOTOS,
      inicioComplete: inicioCompleteRemote || localInicio,
      finComplete: finCompleteRemote || localFin,
    });
  }, [user?.id, dateISO]);

  // --------------------- Evidencias: remoto + local ---------------------
  const loadFollowups = useCallback(async () => {
    if (!activeEntrada?.id || !user?.id) {
      setRemoteFollowups([]);
      setLocalFollowups([]);
      return;
    }

    // local siempre
    setLocalFollowups(readLocalFollowups(user.id, activeEntrada.id));

    // remoto solo si hay red
    if (!navigator.onLine) {
      setRemoteFollowups([]);
      return;
    }

    setIsLoadingFollowups(true);
    const { data, error: qErr } = await supabase
      .from('seguimiento_fotos')
      .select('evidencia_n, foto_url, timestamp')
      .eq('entrada_id', activeEntrada.id)
      .order('evidencia_n', { ascending: true });

    if (!qErr) setRemoteFollowups((data || []) as FollowUpRow[]);
    setIsLoadingFollowups(false);
  }, [activeEntrada?.id, user?.id]);

  useEffect(() => {
    loadRevisionStatus();
  }, [loadRevisionStatus]);

  useEffect(() => {
    loadFollowups();
  }, [loadFollowups]);

  // Cuando vuelve internet: sync + refresh
  useEffect(() => {
    const onOnline = async () => {
      if (!user?.id) return;

      try {
        // ✅ sync evidencias
        await syncPendingFollowups?.();

        // ✅ sync revisiones (metadata)
        await syncPendingRevisions(user.id);
      } catch (e) {
        console.error(e);
      } finally {
        await getTodayRecords();
        await loadRevisionStatus();
        await loadFollowups();
      }
    };

    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [user?.id, syncPendingFollowups, getTodayRecords, loadRevisionStatus, loadFollowups]);

  // Unificar evidencias (local pisa remoto)
  const followups = useMemo(() => {
    const map = new Map<string, FollowUpRow>();
    for (const f of remoteFollowups) map.set(`${f.evidencia_n}`, f);
    for (const f of localFollowups) map.set(`${f.evidencia_n}`, f);
    return Array.from(map.values()).sort((a, b) => a.evidencia_n - b.evidencia_n);
  }, [remoteFollowups, localFollowups]);

  const hasFollow1 = followups.some((f) => f.evidencia_n === 1);
  const hasFollow2 = followups.some((f) => f.evidencia_n === 2);

  // Evidencia 1 habilitada a las X desde la entrada (solo si revisión inicio completa)
  const follow1EnabledInfo = useMemo(() => {
    void tick;

    if (!activeEntrada) return { enabled: false, remainingText: 'Primero marca entrada' };
    if (!rev.inicioComplete) return { enabled: false, remainingText: 'Completa revisión INICIO' };

    const start = new Date(activeEntrada.timestamp).getTime();
    const now = Date.now();
    const diffMs = now - start;

    if (diffMs >= FOLLOWUP_REQUIRED_MS) return { enabled: true, remainingText: '' };

    const remaining = FOLLOWUP_REQUIRED_MS - diffMs;
    const mins = Math.floor(remaining / (60 * 1000));
    const secs = Math.max(0, Math.ceil((remaining % (60 * 1000)) / 1000));

    return { enabled: false, remainingText: `${mins}m ${secs}s` };
  }, [activeEntrada, tick, rev.inicioComplete]);

  // Evidencia 2: solo después de evidencia 1, y revisión inicio completa
  const follow2Enabled = !!activeEntrada && rev.inicioComplete && hasFollow1;

  // Revisión FIN: solo después de ev1 y ev2
  const finRevisionEnabled = !!activeEntrada && rev.inicioComplete && hasFollow1 && hasFollow2;

  // ✅ Crear registro revision_maquinaria (online u offline) antes de navegar
  const goRevision = async (tipo: RevisionTipo) => {
    if (!activeEntrada?.id || !user?.id) {
      showError('entrada', 'Primero debes marcar la ENTRADA para iniciar.');
      return;
    }

    // secuencia
    if (tipo === 'fin') {
      if (!rev.inicioComplete) {
        showError('entrada', 'Debes completar la revisión de INICIO antes de la revisión de FIN.');
        return;
      }
      if (!hasFollow1 || !hasFollow2) {
        showError('entrada', 'Debes completar Evidencia 1 y Evidencia 2 antes de la revisión de FIN.');
        return;
      }
    }

    // ✅ aquí se crea el registro con GPS+ubicación y se obtiene revisionId
    const created = await createRevisionRecord({
      userId: user.id,
      entradaId: activeEntrada.id,
      tipo,
      equipoCodigo,
      // ⚠️ si no tienes hook de geolocalización aquí, importa useGeolocation y pásalo
      getCurrentPosition: async () => {
        // fallback mínimo: sin GPS
        return { latitude: 0, longitude: 0, accuracy: 0 };
      },
    });

    if (!created.success) {
      showError('entrada', created.error || 'No se pudo iniciar la revisión.');
      return;
    }

    // navegar con revision_id (IMPORTANTE para que la pantalla de fotos use ese id)
    navigate(`/OperarioMaquinaria/${tipo}?entrada_id=${activeEntrada.id}&revision_id=${created.revisionId}`);
  };

  // Marcar entrada/salida
  const handleMarkAttendance = async (tipo: 'entrada' | 'salida') => {
    try {
      // 🔒 Salida requiere: inicio + ev1 + ev2 + fin
      if (tipo === 'salida') {
        if (!rev.inicioComplete) {
          showError('salida', 'Debes completar la Revisión de INICIO antes de marcar la salida.');
          return;
        }
        if (!hasFollow1 || !hasFollow2) {
          showError('salida', 'Debes completar Evidencia 1 y Evidencia 2 antes de marcar la salida.');
          return;
        }
        if (!rev.finComplete) {
          showError('salida', 'Debes completar la Revisión de FIN antes de marcar la salida.');
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
      await loadFollowups();

      // Geo modal solo en entrada
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

  // Registrar evidencias 1/2
  const handleFollowUp = async (n: 1 | 2) => {
    try {
      if (!activeEntrada?.id || !user?.id) {
        showError('entrada', 'Primero debes marcar la entrada.');
        return;
      }

      // 🔒 Reglas secuencia
      if (!rev.inicioComplete) {
        showError('entrada', 'Debes completar la revisión de INICIO antes de registrar evidencias.');
        return;
      }
      if (n === 1 && !follow1EnabledInfo.enabled) return;
      if (n === 2 && !follow2Enabled) return;

      const blob = await capturePhoto();

      // OFFLINE: primero local
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

      const res = await markFollowUp(n, blob, activeEntrada.id);
      if (!res?.success) {
        showError('entrada', 'No se pudo guardar la evidencia. Intenta de nuevo.');
        return;
      }

      // si hay red, intenta sync inmediato
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

  const canExit = rev.inicioComplete && hasFollow1 && hasFollow2 && rev.finComplete;

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

        <div className="space-y-3 pt-4">
          {/* 1) ENTRADA */}
          <AttendanceButton
            type="entrada"
            onClick={() => handleMarkAttendance('entrada')}
            disabled={isSubmitting || !!activeEntrada}
          >
            <LogIn className="h-7 w-7" />
            <span>{activeEntrada ? 'Entrada ya registrada' : 'Marcar Entrada'}</span>
          </AttendanceButton>

          {/* 2) REVISION INICIO */}
          <Button
            className="w-full"
            onClick={() => void goRevision('inicio')}
            disabled={isSubmitting || !activeEntrada || rev.inicioComplete}
          >
            <ClipboardCheck className="h-4 w-4 mr-2" />
            {rev.inicioComplete
              ? `Revisión INICIO completa ✅ (${rev.required}/${rev.required})`
              : `Revisión INICIO (fotos máquina) (${Math.min(rev.inicioCount, rev.required)}/${rev.required})`}
          </Button>

          {/* 3) EVIDENCIA 1 */}
          <Button
            className="w-full"
            onClick={() => void handleFollowUp(1)}
            disabled={isSubmitting || !activeEntrada || hasFollow1 || !follow1EnabledInfo.enabled}
          >
            <Camera className="h-4 w-4 mr-2" />
            {hasFollow1
              ? 'Evidencia 1 completada ✅'
              : rev.inicioComplete
                ? follow1EnabledInfo.enabled
                  ? 'Registrar evidencia 1'
                  : `Registrar evidencia 1 en ${follow1EnabledInfo.remainingText}`
                : 'Evidencia 1 (requiere revisión INICIO)'}
          </Button>

          {/* 4) EVIDENCIA 2 */}
          <Button
            className="w-full"
            variant="outline"
            onClick={() => void handleFollowUp(2)}
            disabled={isSubmitting || !activeEntrada || hasFollow2 || !follow2Enabled}
          >
            <Camera className="h-4 w-4 mr-2" />
            {hasFollow2 ? 'Evidencia 2 completada ✅' : 'Registrar evidencia 2'}
          </Button>

          {/* 5) REVISION FIN */}
          <Button
            className="w-full"
            variant="outline"
            onClick={() => void goRevision('fin')}
            disabled={isSubmitting || !activeEntrada || rev.finComplete || !finRevisionEnabled}
          >
            <ClipboardCheck className="h-4 w-4 mr-2" />
            {rev.finComplete
              ? `Revisión FIN completa ✅ (${rev.required}/${rev.required})`
              : `Revisión FIN (fotos máquina) (${Math.min(rev.finCount, rev.required)}/${rev.required})`}
          </Button>

          {/* 6) SALIDA */}
          <AttendanceButton type="salida" onClick={() => handleMarkAttendance('salida')} disabled={isSubmitting || !canExit}>
            <LogOut className="h-7 w-7" />
            <span>{canExit ? 'Marcar Salida' : 'Marcar Salida (completa todo el flujo)'}</span>
          </AttendanceButton>

          <div className="text-xs text-muted-foreground space-y-1">
            <p>
              Revisión INICIO: {rev.inicioComplete ? '✅' : '❌'} {rev.loading ? ' • Actualizando…' : ''}
            </p>
            <p>
              Evidencias: {hasFollow1 ? '✅ 1' : '❌ 1'} / {hasFollow2 ? '✅ 2' : '❌ 2'}
              {isLoadingFollowups ? ' • Cargando…' : ''}
            </p>
            <p>Revisión FIN: {rev.finComplete ? '✅' : '❌'}</p>
          </div>
        </div>

        {todayRecords.length > 0 && (
          <div className="pt-4">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">Registros de hoy ({todayRecords.length})</h3>
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

      {/* Modal Georreferenciación */}
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
