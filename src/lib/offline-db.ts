import { openDB, deleteDB, IDBPDatabase, DBSchema } from 'idb';

export interface PendingRecord {
  id: string;
  user_id: string;
  fecha: string; // YYYY-MM-DD
  tipo_registro: 'entrada' | 'salida';
  timestamp: string; // ISO
  latitud: number | null;
  longitud: number | null;
  precision_gps: number | null;
  fuera_zona: boolean;
  foto_blob: Blob | null;
  foto_url: string | null;
  es_inconsistente: boolean;
  nota_inconsistencia: string | null;
  created_at: string; // ISO
  hac_ste?: string | null;
  suerte_nom?: string | null;
}

export interface PendingTrackPoint {
  id: string;
  user_id: string;
  fecha: string; // YYYY-MM-DD
  entrada_id: string | null;
  recorded_at: string; // ISO
  latitud: number | null;
  longitud: number | null;
  precision_gps: number | null;
  hac_ste: string | null;
  suerte_nom: string | null;
  fuera_zona: boolean;
  source: 'hourly' | 'entrada' | 'salida' | 'manual';
  created_at: string; // ISO
}

const DB_NAME = 'asistencia-agricola';

/**
 * ✅ IMPORTANTE:
 * Tu navegador ya tiene la DB en versión 4 (por eso fallaba con 2).
 * IndexedDB NO permite bajar versión, solo subir.
 */
const DB_VERSION = 4;

const STORE_PENDING = 'pending-records';
const STORE_TRACKING = 'pending-track-points';

interface AsistenciaDB extends DBSchema {
  [STORE_PENDING]: {
    key: string;
    value: PendingRecord;
    indexes: {
      user_id: string;
      fecha: string;
      timestamp: string;
      user_fecha: [string, string];
    };
  };
  [STORE_TRACKING]: {
    key: string;
    value: PendingTrackPoint;
    indexes: {
      user_id: string;
      fecha: string;
      recorded_at: string;
      user_fecha: [string, string];
      entrada_id: string;
    };
  };
}

let dbInstance: IDBPDatabase<AsistenciaDB> | null = null;
let isRepairing = false;

function hasRequiredSchema(db: IDBPDatabase<AsistenciaDB>): boolean {
  const pendingOk = db.objectStoreNames.contains(STORE_PENDING);
  const trackingOk = db.objectStoreNames.contains(STORE_TRACKING);
  if (!pendingOk || !trackingOk) return false;

  try {
    const tx = db.transaction([STORE_PENDING, STORE_TRACKING], 'readonly');

    const pendingStore = tx.objectStore(STORE_PENDING);
    const trackingStore = tx.objectStore(STORE_TRACKING);

    const pendingIndexes = pendingStore.indexNames;
    const trackingIndexes = trackingStore.indexNames;

    const pendingNeed = ['user_id', 'fecha', 'timestamp', 'user_fecha'];
    const trackingNeed = ['user_id', 'fecha', 'recorded_at', 'user_fecha', 'entrada_id'];

    for (const idx of pendingNeed) if (!pendingIndexes.contains(idx)) return false;
    for (const idx of trackingNeed) if (!trackingIndexes.contains(idx)) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * ✅ Crea/asegura stores + índices de forma segura.
 * IMPORTANTE: en upgrade NO se debe usar (db as any).transaction...,
 * se debe usar el `tx` que te provee idb.
 */
function ensureSchema(db: any, tx: any) {
  // ===== STORE: pending-records =====
  const pending =
    db.objectStoreNames.contains(STORE_PENDING)
      ? tx.objectStore(STORE_PENDING)
      : db.createObjectStore(STORE_PENDING, { keyPath: 'id' });

  if (!pending.indexNames.contains('user_id')) pending.createIndex('user_id', 'user_id');
  if (!pending.indexNames.contains('fecha')) pending.createIndex('fecha', 'fecha');
  if (!pending.indexNames.contains('timestamp')) pending.createIndex('timestamp', 'timestamp');
  if (!pending.indexNames.contains('user_fecha')) pending.createIndex('user_fecha', ['user_id', 'fecha']);

  // ===== STORE: pending-track-points =====
  const track =
    db.objectStoreNames.contains(STORE_TRACKING)
      ? tx.objectStore(STORE_TRACKING)
      : db.createObjectStore(STORE_TRACKING, { keyPath: 'id' });

  if (!track.indexNames.contains('user_id')) track.createIndex('user_id', 'user_id');
  if (!track.indexNames.contains('fecha')) track.createIndex('fecha', 'fecha');
  if (!track.indexNames.contains('recorded_at')) track.createIndex('recorded_at', 'recorded_at');
  if (!track.indexNames.contains('user_fecha')) track.createIndex('user_fecha', ['user_id', 'fecha']);
  if (!track.indexNames.contains('entrada_id')) track.createIndex('entrada_id', 'entrada_id');
}

export async function getDB(): Promise<IDBPDatabase<AsistenciaDB>> {
  if (dbInstance) return dbInstance;

  const open = async () =>
    openDB<AsistenciaDB>(DB_NAME, DB_VERSION, {
      /**
       * oldVersion/newVersion existen para upgrades escalonados.
       * Aquí simplemente “aseguramos esquema” para cualquier versión previa.
       */
      upgrade(db, oldVersion, _newVersion, tx) {
        // Si vienes desde versiones viejas o incompletas, creamos lo necesario.
        // Esto también funciona si ya estabas en v4: no se ejecuta upgrade.
        ensureSchema(db as any, tx as any);
      },
      // (opcional) si tienes bloqueos por otra pestaña abierta
      blocked() {
        console.warn(`[offline-db] Open blocked: cierra otras pestañas de la app (DB: ${DB_NAME}).`);
      },
      blocking() {
        // Si esta pestaña está bloqueando un upgrade en otra, cerramos
        try {
          dbInstance?.close();
        } catch {}
        dbInstance = null;
        console.warn('[offline-db] Closing DB because another tab needs an upgrade.');
      },
      terminated() {
        dbInstance = null;
        console.warn('[offline-db] DB connection terminated (browser policy). Will reopen on demand.');
      },
    });

  // 1) Abrimos (si el navegador ya tiene v4, abre sin error)
  dbInstance = await open();

  // 2) Validamos schema. Si está roto (casos raros), reparamos.
  //    ⚠️ Importante: esto NO se ejecuta por el VersionError; ya no existirá.
  if (!hasRequiredSchema(dbInstance) && !isRepairing) {
    isRepairing = true;
    try {
      dbInstance.close();
    } catch {}
    dbInstance = null;

    // borrar solo si de verdad está corrupto/incompleto
    await deleteDB(DB_NAME);

    dbInstance = await open();
    isRepairing = false;
  }

  isRepairing = false;
  return dbInstance!;
}

// ======================= PENDING RECORDS =======================

export async function savePendingRecord(record: PendingRecord): Promise<void> {
  const db = await getDB();
  await db.put(STORE_PENDING, record);
}

export async function getPendingRecords(): Promise<PendingRecord[]> {
  const db = await getDB();
  return db.getAll(STORE_PENDING);
}

export async function getPendingRecordsByUser(userId: string): Promise<PendingRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex(STORE_PENDING, 'user_id', userId);
}

export async function getPendingRecordsByUserAndDate(userId: string, fecha: string): Promise<PendingRecord[]> {
  const db = await getDB();
  try {
    return db.getAllFromIndex(STORE_PENDING, 'user_fecha', [userId, fecha]);
  } catch {
    const all = await db.getAll(STORE_PENDING);
    return all.filter((r) => r.user_id === userId && r.fecha === fecha);
  }
}

export async function deletePendingRecord(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_PENDING, id);
}

// ======================= TRACK POINTS =======================

export async function savePendingTrackPoint(p: PendingTrackPoint): Promise<void> {
  const db = await getDB();
  await db.put(STORE_TRACKING, p);
}

export async function getPendingTrackPoints(): Promise<PendingTrackPoint[]> {
  const db = await getDB();
  return db.getAll(STORE_TRACKING);
}

export async function getPendingTrackPointsByUserAndDate(userId: string, fecha: string): Promise<PendingTrackPoint[]> {
  const db = await getDB();
  try {
    return db.getAllFromIndex(STORE_TRACKING, 'user_fecha', [userId, fecha]);
  } catch {
    const all = await db.getAll(STORE_TRACKING);
    return all.filter((r) => r.user_id === userId && r.fecha === fecha);
  }
}

export async function deletePendingTrackPoint(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_TRACKING, id);
}

export async function clearAllOffline(): Promise<void> {
  const db = await getDB();
  await db.clear(STORE_PENDING);
  await db.clear(STORE_TRACKING);
}

export async function getPendingCount(): Promise<number> {
  const db = await getDB();
  return db.count(STORE_PENDING);
}
