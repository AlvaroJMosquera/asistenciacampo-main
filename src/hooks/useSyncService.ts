import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  getPendingRecords,
  deletePendingRecord,
  getPendingCount,
  PendingRecord,
} from '@/lib/offline-db';
import { useOnlineStatus } from './useOnlineStatus';
import { useAuth } from './useAuth';

interface SyncState {
  pendingCount: number;
  isSyncing: boolean;
  lastSyncTime: Date | null;
  error: string | null;
}

export function useSyncService() {
  const { isOnline } = useOnlineStatus();
  const { user } = useAuth();

  const [state, setState] = useState<SyncState>({
    pendingCount: 0,
    isSyncing: false,
    lastSyncTime: null,
    error: null,
  });

  const updatePendingCount = useCallback(async () => {
    const count = await getPendingCount();
    setState((prev) => ({ ...prev, pendingCount: count }));
  }, []);

  const uploadPhoto = async (record: PendingRecord): Promise<string | null> => {
    if (!record.foto_blob || !user) return record.foto_url ?? null;

    const fileName = `${user.id}/${record.id}.jpg`;
    const { data, error } = await supabase.storage
      .from('attendance-photos')
      .upload(fileName, record.foto_blob, {
        contentType: 'image/jpeg',
        upsert: true,
      });

    if (error) {
      console.error('Error uploading photo:', error);
      return null;
    }

    const { data: urlData } = supabase.storage.from('attendance-photos').getPublicUrl(data.path);
    return urlData.publicUrl ?? null;
  };

  /**
   * ✅ Si el registro NO trae hac_ste/suerte_nom (porque se marcó offline),
   * y sí trae lat/lon, aquí (ya online) resolvemos con RPC antes de insertar.
   */
  const resolveGeoIfMissing = async (record: PendingRecord): Promise<{
    hac_ste: string | null;
    suerte_nom: string | null;
  }> => {
    const hac_ste = (record as any).hac_ste ?? null;
    const suerte_nom = (record as any).suerte_nom ?? null;

    // ya viene completo
    if (hac_ste || suerte_nom) {
      return { hac_ste, suerte_nom };
    }

    // no hay coords
    if (record.latitud == null || record.longitud == null) {
      return { hac_ste: null, suerte_nom: null };
    }

    try {
      const { data, error } = await supabase.rpc('get_hacienda_by_point', {
        lat: record.latitud,
        lon: record.longitud,
      });

      if (error || !data || data.length === 0) {
        return { hac_ste: null, suerte_nom: null };
      }

      return {
        hac_ste: data[0].hac_ste ?? null,
        suerte_nom: data[0].nom ?? null,
      };
    } catch (e) {
      console.error('resolveGeoIfMissing error:', e);
      return { hac_ste: null, suerte_nom: null };
    }
  };

  const syncRecord = async (record: PendingRecord): Promise<boolean> => {
    try {
      // 1) Subir foto
      const fotoUrl = await uploadPhoto(record);

      // 2) Resolver geo si falta (ya online)
      const geo = await resolveGeoIfMissing(record);

      // 3) Insertar en DB (incluye ubicacion)
      const { error } = await supabase.from('registros_asistencia').insert({
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

        // ✅ NUEVO: ubicación persistida para CSV supervisor
        hac_ste: geo.hac_ste,
        suerte_nom: geo.suerte_nom,
      });

      if (error) {
        // Duplicate = ya estaba sincronizado
        // @ts-ignore
        if (error.code === '23505') {
          await deletePendingRecord(record.id);
          return true;
        }
        console.error('Error syncing record:', error);
        return false;
      }

      // 4) Eliminar de pendientes
      await deletePendingRecord(record.id);
      return true;
    } catch (error) {
      console.error('Error in syncRecord:', error);
      return false;
    }
  };

  const syncAll = useCallback(async () => {
    if (!isOnline || !user) return;

    setState((prev) => ({ ...prev, isSyncing: true, error: null }));

    try {
      const pendingRecords = await getPendingRecords();

      let successCount = 0;
      let failCount = 0;

      for (const record of pendingRecords) {
        const success = await syncRecord(record);
        if (success) successCount++;
        else failCount++;
      }

      await updatePendingCount();

      setState((prev) => ({
        ...prev,
        isSyncing: false,
        lastSyncTime: new Date(),
        error: failCount > 0 ? `${failCount} registros no se pudieron sincronizar` : null,
      }));

      console.log(`Sync complete: ${successCount} success, ${failCount} failed`);
    } catch (error) {
      console.error('Error in syncAll:', error);
      setState((prev) => ({
        ...prev,
        isSyncing: false,
        error: 'Error durante la sincronización',
      }));
    }
  }, [isOnline, user, updatePendingCount]);

  // Auto-sync cuando vuelve internet
  useEffect(() => {
    if (isOnline && user) {
      syncAll();
    }
  }, [isOnline, user, syncAll]);

  // actualizar contador al montar y cuando cambia usuario
  useEffect(() => {
    updatePendingCount();
  }, [user, updatePendingCount]);

  // sync periódico cada 30s cuando hay internet
  useEffect(() => {
    if (!isOnline || !user) return;

    const interval = setInterval(() => {
      syncAll();
    }, 30000);

    return () => clearInterval(interval);
  }, [isOnline, user, syncAll]);

  return {
    ...state,
    syncAll,
    updatePendingCount,
  };
}
