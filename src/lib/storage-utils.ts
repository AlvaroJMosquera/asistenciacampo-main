// ============================================================
// FIX BUG 3: localStorage seguro con notificación al usuario
// FIX BUG 6: blobToBase64 eficiente (no bloquea hilo principal)
// ============================================================
// Crea este archivo en: src/lib/storage-utils.ts

/**
 * ✅ FIX BUG 3: localStorage wrapper seguro.
 * Notifica al usuario si el storage está lleno en vez de fallar silenciosamente.
 */
export function safeLocalStorageSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    // QuotaExceededError — storage lleno (común en móviles con poco espacio)
    if (
      e instanceof DOMException &&
      (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED')
    ) {
      console.warn(`[storage] localStorage lleno. No se pudo guardar: ${key}`);
      // Notificar al usuario via evento custom (capturarlo en App.tsx o un toast)
      window.dispatchEvent(
        new CustomEvent('storage-quota-exceeded', {
          detail: { key, message: 'Espacio de almacenamiento local lleno. Algunos datos pueden no guardarse.' },
        })
      );
    } else {
      console.error(`[storage] Error inesperado guardando ${key}:`, e);
    }
    return false;
  }
}

export function safeLocalStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    console.error(`[storage] Error leyendo ${key}:`, e);
    return null;
  }
}

export function safeLocalStorageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (e) {
    console.error(`[storage] Error eliminando ${key}:`, e);
  }
}

/**
 * ✅ FIX BUG 6: blobToBase64 eficiente usando FileReader.
 * No bloquea el hilo principal (vs el loop byte-a-byte anterior).
 * Con fotos de 2-5MB es ~10x más rápido.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // result es "data:image/jpeg;base64,XXXX" — extraemos solo la parte base64
      const base64 = result.split(',')[1];
      if (base64) resolve(base64);
      else reject(new Error('blobToBase64: resultado vacío'));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Utilidad para limpiar cache viejo del localStorage
 * (llamar ocasionalmente para liberar espacio)
 */
export function cleanOldLocalStorageCache(daysOld = 7): void {
  try {
    const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
    const keysToRemove: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;

      // Limpiar caches de records viejos
      if (key.startsWith('today_records_cache_v1:')) {
        // formato: today_records_cache_v1:userId:YYYY-MM-DD
        const parts = key.split(':');
        const dateStr = parts[parts.length - 1];
        if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          const cacheDate = new Date(dateStr).getTime();
          if (cacheDate < cutoff) keysToRemove.push(key);
        }
      }

      // Limpiar geo caches viejos
      if (key.startsWith('implemento_geo_cache:') || key.startsWith('revision_geo_cache:')) {
        try {
          const raw = localStorage.getItem(key);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed.at && new Date(parsed.at).getTime() < cutoff) {
              keysToRemove.push(key);
            }
          }
        } catch {}
      }
    }

    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }

    if (keysToRemove.length > 0) {
      console.log(`[storage] Limpiados ${keysToRemove.length} items de cache viejos`);
    }
  } catch (e) {
    console.error('[storage] Error limpiando cache:', e);
  }
}