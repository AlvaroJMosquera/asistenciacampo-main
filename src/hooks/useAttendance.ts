import { useState, useCallback, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { useGeolocation } from './useGeolocation';
import { useOnlineStatus } from './useOnlineStatus';

// ✅ Offline DB
import {
  savePendingRecord,
  type PendingRecord,
  getPendingRecordsByUserAndDate,
  getDB, // ✅ autocuración al iniciar
} from '@/lib/offline-db';

// ✅ FECHA LOCAL (NO UTC)
function toIsoDateLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface AttendanceRecord {
  id: string;
  user_id: string;
  fecha: string;
  tipo_registro: 'entrada' | 'salida';
  timestamp: string;
  latitud: number | null;
  longitud: number | null;
  precision_gps: number | null;
  fuera_zona: boolean;
  foto_url: string | null;
  estado_sync?: string;
  es_inconsistente: boolean;
  nota_inconsistencia: string | null;

  // ✅ columnas que YA EXISTEN en tu tabla (NO requiere cambios DB)
  hac_ste?: string | null;
  suerte_nom?: string | null;

  horario_inicio?: string | null;
  horario_fin?: string | null;
  llegada_estado?: 'temprano_o_a_tiempo' | 'tarde' | null;
  minutos_vs_inicio?: number | null;
  salida_estado?: 'a_tiempo' | 'se_fue_antes_30' | 'se_fue_antes_mas_30' | null;
  minutos_antes_fin?: number | null;
  motivo_salida_temprano?: string | null;
  permiso_foto_url?: string | null;
}

interface AttendanceState {
  isSubmitting: boolean;
  error: string | null;
  lastRecord: AttendanceRecord | null;
  todayRecords: AttendanceRecord[];
}

type GeoResult = { nom: string; hac_ste: string } | null;

type MarkAttendanceResult = {
  success: boolean;
  hoursWorked?: number | null;
  coords?: { lat: number | null; lon: number | null; accuracy: number | null };
  geo?: GeoResult;
  error?: string | null;
};

type AttendanceMeta = {
  client_timestamp?: string; // ISO string
  horario_inicio?: string;
  horario_fin?: string;
  llegada_estado?: 'temprano_o_a_tiempo' | 'tarde';
  minutos_vs_inicio?: number;

  salida_estado?: 'a_tiempo' | 'se_fue_antes_30' | 'se_fue_antes_mas_30';
  minutos_antes_fin?: number;

  motivo_salida_temprano?: string;
  permiso_firmado_blob?: Blob; // si lo envías, se guarda en permiso_foto_url
};

type PendingFollowUp = {
  id: string;
  entrada_id: string;
  user_id: string;
  evidencia_n: 1 | 2;
  timestamp: string;
  foto_base64: string;
};

const PENDING_FOLLOWUPS_KEY = 'pending_followups_v2';

/**
 * ✅ Cache local de registros (metadata)
 */
const TODAY_CACHE_PREFIX = 'today_records_cache_v1';
function cacheKey(userId: string, isoDate: string) {
  return `${TODAY_CACHE_PREFIX}:${userId}:${isoDate}`;
}
function readTodayCache(userId: string, isoDate: string): AttendanceRecord[] {
  try {
    const raw = localStorage.getItem(cacheKey(userId, isoDate));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AttendanceRecord[]) : [];
  } catch {
    return [];
  }
}
function writeTodayCache(userId: string, isoDate: string, records: AttendanceRecord[]) {
  try {
    localStorage.setItem(cacheKey(userId, isoDate), JSON.stringify(records));
  } catch {
    // ignore
  }
}

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

async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function readPendingFollowups(): PendingFollowUp[] {
  try {
    const raw = localStorage.getItem(PENDING_FOLLOWUPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingFollowUp[]) : [];
  } catch {
    return [];
  }
}

function writePendingFollowups(items: PendingFollowUp[]) {
  try {
    localStorage.setItem(PENDING_FOLLOWUPS_KEY, JSON.stringify(items));
  } catch {}
}

function base64ToBlob(b64: string): Blob {
  const byteChars = atob(b64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: 'image/jpeg' });
}

/**
 * ✅ "Sesión abierta" persistente
 */
const OPEN_SESSION_PREFIX = 'open_session_v1';
type OpenSession = { entrada_id: string; timestamp: string };
function openSessionKey(userId: string) {
  return `${OPEN_SESSION_PREFIX}:${userId}`;
}
function readOpenSession(userId: string): OpenSession | null {
  try {
    const raw = localStorage.getItem(openSessionKey(userId));
    if (!raw) return null;
    return JSON.parse(raw) as OpenSession;
  } catch {
    return null;
  }
}
function writeOpenSession(userId: string, s: OpenSession) {
  try {
    localStorage.setItem(openSessionKey(userId), JSON.stringify(s));
  } catch {}
}
function clearOpenSession(userId: string) {
  try {
    localStorage.removeItem(openSessionKey(userId));
  } catch {}
}

export function useAttendance() {
  const { user, userSlug } = useAuth();
  const { getCurrentPosition } = useGeolocation();
  const { isOnline } = useOnlineStatus();

  const [state, setState] = useState<AttendanceState>({
    isSubmitting: false,
    error: null,
    lastRecord: null,
    todayRecords: [],
  });

  // ✅ AUTOCURACIÓN IndexedDB
  useEffect(() => {
    getDB().catch((e) => console.error('getDB init failed', e));
  }, []);

  /**
   * ✅ Upload foto a bucket attendance-photos
   */
  const uploadPhoto = useCallback(async (path: string, blob: Blob): Promise<string> => {
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('attendance-photos')
      .upload(path, blob, { contentType: 'image/jpeg', upsert: true });

    if (uploadError) {
      console.error('Error uploading photo:', uploadError);
      throw new Error(`No se pudo subir la foto (Storage): ${uploadError.message}`);
    }

    const { data: urlData } = supabase.storage.from('attendance-photos').getPublicUrl(uploadData.path);
    if (!urlData?.publicUrl) throw new Error('No se pudo obtener URL pública de la foto');

    return urlData.publicUrl;
  }, []);

  /**
   * ✅ RPC para suertes
   */
  const resolveGeo = useCallback(async (lat: number, lon: number): Promise<GeoResult> => {
    const { data, error } = await supabase.rpc('get_hacienda_by_point', { lat, lon });
    if (error || !data || data.length === 0) return null;
    return { nom: data[0].nom, hac_ste: data[0].hac_ste };
  }, []);

  /**
   * ✅ Traer registros HOY (local date) mezclando:
   * pending offline + remote (si online) + cache (si offline) + fallback open_session
   */
  const getTodayRecords = useCallback(async (): Promise<AttendanceRecord[]> => {
    if (!user) return [];

    const today = toIsoDateLocal();

    // 1) Pending offline (IndexedDB)
    let pendingTodayRaw: PendingRecord[] = [];
    try {
      pendingTodayRaw = await getPendingRecordsByUserAndDate(user.id, today);
    } catch (e) {
      console.error('getPendingRecordsByUserAndDate failed, fallback:', e);
      try {
        await getDB();
        pendingTodayRaw = await getPendingRecordsByUserAndDate(user.id, today);
      } catch (e2) {
        console.error('fallback retry failed:', e2);
        pendingTodayRaw = [];
      }
    }

    const pendingToday = pendingTodayRaw.map<AttendanceRecord>((r) => ({
      id: r.id,
      user_id: r.user_id,
      fecha: r.fecha,
      tipo_registro: r.tipo_registro,
      timestamp: r.timestamp,
      latitud: r.latitud ?? null,
      longitud: r.longitud ?? null,
      precision_gps: r.precision_gps ?? null,
      fuera_zona: r.fuera_zona ?? false,
      foto_url: r.foto_url ?? null,
      estado_sync: 'pendiente',
      es_inconsistente: r.es_inconsistente ?? false,
      nota_inconsistencia: r.nota_inconsistencia ?? null,

      // extras si tu offline-db los guarda
      hac_ste: (r as any).hac_ste ?? null,
      suerte_nom: (r as any).suerte_nom ?? null,

      horario_inicio: (r as any).horario_inicio ?? null,
      horario_fin: (r as any).horario_fin ?? null,
      llegada_estado: (r as any).llegada_estado ?? null,
      minutos_vs_inicio: (r as any).minutos_vs_inicio ?? null,
      salida_estado: (r as any).salida_estado ?? null,
      minutos_antes_fin: (r as any).minutos_antes_fin ?? null,
      motivo_salida_temprano: (r as any).motivo_salida_temprano ?? null,
      permiso_foto_url: (r as any).permiso_foto_url ?? null,
    }));

    // 2) Remote si online; cache si offline
    let remote: AttendanceRecord[] = [];
    if (isOnline) {
      const { data, error } = await supabase
        .from('registros_asistencia')
        .select('*')
        .eq('user_id', user.id)
        .eq('fecha', today)
        .order('timestamp', { ascending: false });

      if (error) {
        console.error('Error fetching today records:', error);
      } else {
        remote = ((data as AttendanceRecord[]) || []).map((r) => ({
          ...r,
          estado_sync: r.estado_sync ?? 'sincronizado',
        }));
      }
    } else {
      remote = readTodayCache(user.id, today);
    }

    // 3) Merge sin duplicar por id
    const map = new Map<string, AttendanceRecord>();
    for (const r of remote) map.set(r.id, r);
    for (const r of pendingToday) if (!map.has(r.id)) map.set(r.id, r);

    let merged = Array.from(map.values()).sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // 4) Fallback: offline + vacío -> open_session
    if (!isOnline && merged.length === 0) {
      const open = readOpenSession(user.id);
      if (open) {
        merged = [
          {
            id: open.entrada_id,
            user_id: user.id,
            fecha: today,
            tipo_registro: 'entrada',
            timestamp: open.timestamp,
            latitud: null,
            longitud: null,
            precision_gps: null,
            fuera_zona: false,
            foto_url: null,
            estado_sync: 'pendiente',
            es_inconsistente: false,
            nota_inconsistencia: null,
          },
          ...merged,
        ];
      }
    }

    // ✅ guardar cache local siempre
    writeTodayCache(user.id, today, merged);

    setState((prev) => ({
      ...prev,
      todayRecords: merged,
      lastRecord: merged[0] || null,
    }));

    return merged;
  }, [user, isOnline]);

  /**
   * ✅ Reglas básicas de consistencia
   */
  const checkForInconsistency = useCallback(
    async (
      tipo: 'entrada' | 'salida',
      records: AttendanceRecord[]
    ): Promise<{ isInconsistent: boolean; note: string | null }> => {
      const last = records[0];

      if (tipo === 'entrada' && last?.tipo_registro === 'entrada') {
        return { isInconsistent: true, note: 'Entrada marcada sin salida previa' };
      }

      if (tipo === 'salida' && (!last || last.tipo_registro === 'salida')) {
        return { isInconsistent: true, note: 'Salida marcada sin entrada previa' };
      }

      return { isInconsistent: false, note: null };
    },
    []
  );

  /**
   * ✅ Horas trabajadas (desde estado)
   */
  const calculateHoursWorked = useCallback(
    (options?: { includeOpenSession?: boolean }): number | null => {
      const includeOpenSession = options?.includeOpenSession ?? false;

      const records = [...state.todayRecords].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      if (records.length === 0) return null;

      let openStart: number | null = null;
      let totalMs = 0;

      for (const r of records) {
        const t = new Date(r.timestamp).getTime();
        if (r.tipo_registro === 'entrada') {
          openStart = t;
        } else {
          if (openStart != null) {
            const diff = t - openStart;
            if (diff > 0) totalMs += diff;
            openStart = null;
          }
        }
      }

      if (includeOpenSession && openStart != null) {
        const diff = Date.now() - openStart;
        if (diff > 0) totalMs += diff;
      }

      if (totalMs <= 0) return null;
      const hours = totalMs / (1000 * 60 * 60);
      return Math.round(hours * 100) / 100;
    },
    [state.todayRecords]
  );

  /**
   * ✅ FIX PRINCIPAL:
   * markAttendance ahora recibe meta y lo guarda en DB (columnas ya existentes).
   */
  const markAttendance = useCallback(
    async (
      tipo: 'entrada' | 'salida',
      photoBlob: Blob,
      meta: AttendanceMeta = {}
    ): Promise<MarkAttendanceResult> => {
      if (!user) {
        const msg = 'Usuario no autenticado';
        setState((prev) => ({ ...prev, error: msg }));
        return { success: false, error: msg };
      }

      setState((prev) => ({ ...prev, isSubmitting: true, error: null }));

      try {
        // ✅ usar timestamp del cliente si viene (para evitar desfases)
        const nowISO = meta.client_timestamp ?? new Date().toISOString();
        const now = new Date(nowISO);

        // GPS best-effort
        let location: { latitude: number; longitude: number; accuracy: number } | null = null;
        try {
          location = await getCurrentPosition();
        } catch {}

        // refresca registros para validar consistencia
        const records = await getTodayRecords();
        const { isInconsistent, note } = await checkForInconsistency(tipo, records);

        const recordId = safeUUID();

        // Geo (solo online)
        let geo: GeoResult = null;
        const hasCoords = location?.latitude != null && location?.longitude != null;
        if (isOnline && hasCoords) {
          geo = await resolveGeo(location!.latitude, location!.longitude);
        }

        const fueraZona = hasCoords ? !geo : false;

        // Construye PendingRecord (offline)
        const record: PendingRecord = {
          id: recordId,
          user_id: user.id,
          fecha: toIsoDateLocal(now), // ✅ LOCAL
          tipo_registro: tipo,
          timestamp: nowISO,
          latitud: location?.latitude ?? null,
          longitud: location?.longitude ?? null,
          precision_gps: location?.accuracy ?? null,
          fuera_zona: fueraZona,
          foto_blob: photoBlob,
          foto_url: null,
          es_inconsistente: isInconsistent,
          nota_inconsistencia: note,
          created_at: nowISO,
          ...({
            hac_ste: geo?.hac_ste ?? null,
            suerte_nom: geo?.nom ?? null,

            // ✅ guardar meta (columnas ya existen)
            horario_inicio: meta.horario_inicio ?? null,
            horario_fin: meta.horario_fin ?? null,
            llegada_estado: meta.llegada_estado ?? null,
            minutos_vs_inicio: meta.minutos_vs_inicio ?? null,
            salida_estado: meta.salida_estado ?? null,
            minutos_antes_fin: meta.minutos_antes_fin ?? null,
            motivo_salida_temprano: meta.motivo_salida_temprano ?? null,
          } as any),
        };

        // ✅ persistir sesión abierta
        if (tipo === 'entrada') {
          writeOpenSession(user.id, { entrada_id: record.id, timestamp: record.timestamp });
        }

        if (isOnline) {
          // 1) subir foto principal
          const mainPath = `${userSlug}/${recordId}.jpg`;
          const fotoUrl = await uploadPhoto(mainPath, photoBlob);

          // 2) si hay permiso firmado (salida temprana), subirlo
          let permisoUrl: string | null = null;
          if (tipo === 'salida' && meta.permiso_firmado_blob) {
            const permisoPath = `${userSlug}/${recordId}_permiso.jpg`;
            permisoUrl = await uploadPhoto(permisoPath, meta.permiso_firmado_blob);
          }

          // 3) insertar en DB (SIN CAMBIAR DB)
          const payload: any = {
            id: record.id,
            user_id: record.user_id,
            fecha: record.fecha,
            tipo_registro: record.tipo_registro,
            timestamp: record.timestamp,
            latitud: record.latitud,
            longitud: record.longitud,
            precision_gps: record.precision_gps,
            fuera_zona: record.fuera_zona,
            foto_url: fotoUrl,
            estado_sync: 'sincronizado',
            es_inconsistente: record.es_inconsistente,
            nota_inconsistencia: record.nota_inconsistencia,
            hac_ste: geo?.hac_ste ?? null,
            suerte_nom: geo?.nom ?? null,

            // ✅ meta
            horario_inicio: meta.horario_inicio ?? null,
            horario_fin: meta.horario_fin ?? null,
            llegada_estado: meta.llegada_estado ?? null,
            minutos_vs_inicio: meta.minutos_vs_inicio ?? null,
            salida_estado: meta.salida_estado ?? null,
            minutos_antes_fin: meta.minutos_antes_fin ?? null,
            motivo_salida_temprano: meta.motivo_salida_temprano ?? null,
            permiso_foto_url: permisoUrl,
          };

          const { error: insertError } = await supabase.from('registros_asistencia').insert(payload);
          if (insertError) throw new Error(`DB insert failed: ${insertError.message}`);

          // ✅ actualizar cache local inmediatamente
          const today = record.fecha;
          const prevCache = readTodayCache(user.id, today);

          const newLocal: AttendanceRecord = {
            ...(payload as AttendanceRecord),
            foto_url: fotoUrl,
            estado_sync: 'sincronizado',
          };

          const mergedCache = [newLocal, ...prevCache.filter((x) => x.id !== newLocal.id)].sort(
            (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
          );

          writeTodayCache(user.id, today, mergedCache);
        } else {
          // offline
          await savePendingRecord(record);
        }

        // ✅ si es salida, cerrar sesión abierta
        if (tipo === 'salida') {
          clearOpenSession(user.id);
        }

        // refresca estado final
        await getTodayRecords();

        let hoursWorked: number | null = null;
        if (tipo === 'salida') hoursWorked = calculateHoursWorked();

        setState((prev) => ({ ...prev, isSubmitting: false, error: null }));

        return {
          success: true,
          hoursWorked,
          coords: {
            lat: location?.latitude ?? null,
            lon: location?.longitude ?? null,
            accuracy: location?.accuracy ?? null,
          },
          geo,
        };
      } catch (err: any) {
        console.error('Error marking attendance:', err);
        const msg = err?.message ? String(err.message) : 'Error al registrar. Intenta de nuevo.';
        setState((prev) => ({ ...prev, isSubmitting: false, error: msg }));
        return { success: false, error: msg };
      }
    },
    [
      user,
      isOnline,
      getCurrentPosition,
      uploadPhoto,
      resolveGeo,
      getTodayRecords,
      checkForInconsistency,
      calculateHoursWorked,
    ]
  );

  /**
   * ✅ Evidencias seguimiento
   */
  const markFollowUp = useCallback(
    async (evidenciaN: 1 | 2, photoBlob: Blob, entradaId: string): Promise<{ success: boolean }> => {
      if (!user) {
        setState((prev) => ({ ...prev, error: 'Usuario no autenticado' }));
        return { success: false };
      }

      setState((prev) => ({ ...prev, isSubmitting: true, error: null }));

      try {
        const followupId = safeUUID();
        const ts = new Date().toISOString();

        if (!isOnline) {
          const b64 = await blobToBase64(photoBlob);
          const pending = readPendingFollowups();

          const filtered = pending.filter(
            (p) => !(p.user_id === user.id && p.entrada_id === entradaId && p.evidencia_n === evidenciaN)
          );

          filtered.push({
            id: followupId,
            entrada_id: entradaId,
            user_id: user.id,
            evidencia_n: evidenciaN,
            timestamp: ts,
            foto_base64: b64,
          });

          writePendingFollowups(filtered);

          setState((prev) => ({ ...prev, isSubmitting: false, error: null }));
          return { success: true };
        }

        const path = `${userSlug}/${entradaId}_seg_${evidenciaN}.jpg`;
        const fotoUrl = await uploadPhoto(path, photoBlob);

        const { error: insertError } = await supabase.from('seguimiento_fotos').insert({
          id: followupId,
          entrada_id: entradaId,
          user_id: user.id,
          evidencia_n: evidenciaN,
          foto_url: fotoUrl,
          timestamp: ts,
        });

        if (insertError) throw new Error(`DB insert followup failed: ${insertError.message}`);

        setState((prev) => ({ ...prev, isSubmitting: false, error: null }));
        return { success: true };
      } catch (err: any) {
        console.error('Error saving followup:', err);
        const msg = err?.message ? String(err.message) : 'Error al registrar seguimiento. Intenta de nuevo.';
        setState((prev) => ({ ...prev, isSubmitting: false, error: msg }));
        return { success: false };
      }
    },
    [user, isOnline, uploadPhoto]
  );

  /**
   * ✅ Sync evidencias pendientes
   */
  const syncPendingFollowups = useCallback(async (): Promise<{ synced: number; failed: number }> => {
    if (!user || !isOnline) return { synced: 0, failed: 0 };

    const pendingAll = readPendingFollowups();
    const mine = pendingAll.filter((p) => p.user_id === user.id);
    if (mine.length === 0) return { synced: 0, failed: 0 };

    let synced = 0;
    let failed = 0;

    const keepMine: PendingFollowUp[] = [];
    const keepOthers = pendingAll.filter((p) => p.user_id !== user.id);

    for (const item of mine) {
      try {
        const blob = base64ToBlob(item.foto_base64);

        const path = `${userSlug}/${item.entrada_id}_seg_${item.evidencia_n}.jpg`;

        const fotoUrl = await uploadPhoto(path, blob);

        const { error } = await supabase.from('seguimiento_fotos').insert({
          id: item.id,
          entrada_id: item.entrada_id,
          user_id: item.user_id,
          evidencia_n: item.evidencia_n,
          foto_url: fotoUrl,
          timestamp: item.timestamp,
        });

        if (error) {
          // @ts-ignore
          if (error.code === '23505') {
            synced++;
            continue;
          }
          throw error;
        }

        synced++;
      } catch (e) {
        console.error('sync followup failed', item, e);
        failed++;
        keepMine.push(item);
      }
    }

    writePendingFollowups([...keepOthers, ...keepMine]);
    return { synced, failed };
  }, [user, isOnline, uploadPhoto]);

  // refrescar al cambiar online/offline
  useEffect(() => {
    if (user) void getTodayRecords();
  }, [user, isOnline, getTodayRecords]);

  return {
    ...state,
    markAttendance,       // ✅ ahora acepta (tipo, blob, meta)
    markFollowUp,
    getTodayRecords,
    calculateHoursWorked,
    syncPendingFollowups,
  };
}