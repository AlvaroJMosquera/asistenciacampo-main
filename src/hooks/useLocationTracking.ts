import { useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useGeolocation } from '@/hooks/useGeolocation';
import { savePendingTrackPoint, PendingTrackPoint } from '@/lib/offline-db';

type GeoResult = { nom: string; hac_ste: string } | null;

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

function toIsoDate(d = new Date()) {
  return d.toISOString().split('T')[0];
}

export function useLocationTracking(activeEntradaId: string | null) {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();
  const { getCurrentPosition } = useGeolocation();

  const timerRef = useRef<number | null>(null);

  const resolveGeo = useCallback(async (lat: number, lon: number): Promise<GeoResult> => {
    const { data, error } = await supabase.rpc('get_hacienda_by_point', { lat, lon });
    if (error || !data || data.length === 0) return null;
    return { nom: data[0].nom, hac_ste: data[0].hac_ste };
  }, []);

  const pushPoint = useCallback(
    async (source: 'hourly' | 'entrada' | 'salida' | 'manual' = 'hourly') => {
      if (!user) return;
      if (!activeEntradaId) return;

      // GPS best-effort
      let location: { latitude: number; longitude: number; accuracy: number } | null = null;
      try {
        location = await getCurrentPosition();
      } catch {
        // sin gps, igual puedes guardar un punto "vacío" si quieres
      }

      const now = new Date();
      const id = safeUUID();

      let geo: GeoResult = null;
      if (isOnline && location?.latitude != null && location?.longitude != null) {
        geo = await resolveGeo(location.latitude, location.longitude);
      }

      const hasCoords = location?.latitude != null && location?.longitude != null;
      const fueraZona = hasCoords ? !geo : false;

      const payload = {
        id,
        user_id: user.id,
        fecha: toIsoDate(now),
        entrada_id: activeEntradaId,
        recorded_at: now.toISOString(),
        latitud: location?.latitude ?? null,
        longitud: location?.longitude ?? null,
        precision_gps: location?.accuracy ?? null,
        fuera_zona: fueraZona,
        hac_ste: geo?.hac_ste ?? null,
        suerte_nom: geo?.nom ?? null,
        source,
      };

      if (isOnline) {
        const { error } = await supabase.from('tracking_ubicaciones').insert(payload);
        if (error) {
          // si falla online, lo mandamos a offline para no perderlo
          const p: PendingTrackPoint = { ...payload, created_at: now.toISOString() };
          await savePendingTrackPoint(p);
        }
      } else {
        const p: PendingTrackPoint = { ...payload, created_at: now.toISOString() };
        await savePendingTrackPoint(p);
      }
    },
    [user, activeEntradaId, isOnline, getCurrentPosition, resolveGeo]
  );

  const stop = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleNext = useCallback(() => {
    stop();
    if (!activeEntradaId || !user) return;

    // ✅ Opción A: “cada 60 min desde ahora”
    // const delayMs = 60 * 60 * 1000;

    // ✅ Opción B: “alineado a la hora exacta” (recomendado)
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    next.setHours(now.getHours() + 1);
    const delayMs = next.getTime() - now.getTime();

    timerRef.current = window.setTimeout(async () => {
      await pushPoint('hourly');
      scheduleNext(); // reprograma
    }, delayMs) as unknown as number;
  }, [activeEntradaId, user, pushPoint, stop]);

  useEffect(() => {
    if (!activeEntradaId) {
      stop();
      return;
    }

    // al arrancar tracking, registra un punto inmediato (opcional)
    pushPoint('manual');
    scheduleNext();

    // si el usuario vuelve a la pestaña, intenta capturar + reprogramar
    const onVis = () => {
      if (document.visibilityState === 'visible' && activeEntradaId) {
        pushPoint('manual');
        scheduleNext();
      }
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      document.removeEventListener('visibilitychange', onVis);
      stop();
    };
  }, [activeEntradaId, pushPoint, scheduleNext, stop]);

  return { pushPointNow: () => pushPoint('manual'), stopTracking: stop };
}
