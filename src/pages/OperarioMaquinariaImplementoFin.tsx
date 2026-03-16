// src/pages/OperarioMaquinariaImplementoFin.tsx
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { format } from "date-fns";
import { Camera, CheckCircle, ArrowLeft, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useCamera } from "@/hooks/useCamera";
import { useGeolocation } from "@/hooks/useGeolocation";
import { cn } from "@/lib/utils";

type FotoTipo = "implemento_frente" | "implemento_lateral";

const FOTO_TIPOS: { key: FotoTipo; label: string }[] = [
  { key: "implemento_frente",  label: "Foto frontal del implemento" },
  { key: "implemento_lateral", label: "Foto lateral del implemento" },
];

// ─── Checklist types ──────────────────────────────────────────────────────────
type EstadoSoldadura = "mal_estado" | "buen_estado";
type FugasAceite     = "si"         | "no";

type Checklist = {
  estado_soldadura: EstadoSoldadura | null;
  fugas_aceite:     FugasAceite     | null;
};

const CHECKLIST_INITIAL: Checklist = {
  estado_soldadura: null,
  fugas_aceite:     null,
};

const SOLDADURA_OPCIONES: { value: EstadoSoldadura; label: string; color: string }[] = [
  { value: "mal_estado",  label: "Mal estado",  color: "border-red-400 bg-red-50 text-red-700 data-[sel=true]:bg-red-500 data-[sel=true]:text-white" },
  { value: "buen_estado", label: "Buen estado", color: "border-green-400 bg-green-50 text-green-700 data-[sel=true]:bg-green-500 data-[sel=true]:text-white" },
];

const FUGAS_OPCIONES: { value: FugasAceite; label: string; color: string }[] = [
  { value: "si", label: "Sí", color: "border-red-400 bg-red-50 text-red-700 data-[sel=true]:bg-red-500 data-[sel=true]:text-white" },
  { value: "no", label: "No", color: "border-green-400 bg-green-50 text-green-700 data-[sel=true]:bg-green-500 data-[sel=true]:text-white" },
];

// ─── localStorage checklist ───────────────────────────────────────────────────
function checklistLocalKey(userId: string, entradaId: string) {
  return `implemento_checklist:${userId}:${entradaId}:fin`;
}
function readLocalChecklist(userId: string, entradaId: string): Checklist {
  try {
    const raw = localStorage.getItem(checklistLocalKey(userId, entradaId));
    return raw ? (JSON.parse(raw) as Checklist) : CHECKLIST_INITIAL;
  } catch { return CHECKLIST_INITIAL; }
}
function writeLocalChecklist(userId: string, entradaId: string, cl: Checklist) {
  try { localStorage.setItem(checklistLocalKey(userId, entradaId), JSON.stringify(cl)); } catch {}
}

// ─── [NUEVO] Pending checklist para sync offline ──────────────────────────────
function pendingChecklistKey(userId: string, entradaId: string) {
  return `implemento_checklist_pending:${userId}:${entradaId}:fin`;
}
function readPendingChecklist(userId: string, entradaId: string): Partial<Checklist> | null {
  try {
    const raw = localStorage.getItem(pendingChecklistKey(userId, entradaId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function writePendingChecklist(userId: string, entradaId: string, cl: Partial<Checklist>) {
  try { localStorage.setItem(pendingChecklistKey(userId, entradaId), JSON.stringify(cl)); } catch {}
}
function clearPendingChecklist(userId: string, entradaId: string) {
  try { localStorage.removeItem(pendingChecklistKey(userId, entradaId)); } catch {}
}

// ─── Subcomponente: fila de opciones ─────────────────────────────────────────
function OpcionFila<T extends string>({
  opciones,
  valor,
  onChange,
}: {
  opciones: { value: T; label: string; color: string }[];
  valor: T | null;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-2">
      {opciones.map((op) => {
        const sel = valor === op.value;
        return (
          <button
            key={op.value}
            type="button"
            data-sel={sel}
            onClick={() => onChange(op.value)}
            className={cn(
              "flex-1 rounded-lg border-2 py-2 text-sm font-medium transition-all duration-150",
              op.color,
              sel ? "ring-2 ring-offset-1 ring-current" : "opacity-80 hover:opacity-100"
            )}
          >
            {sel && <span className="mr-1">✓</span>}
            {op.label}
          </button>
        );
      })}
    </div>
  );
}

function getLocalDateISO() {
  return format(new Date(), "yyyy-MM-dd");
}

function safeUUID(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {}
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

type GeoInfo = {
  lat: number | null; lon: number | null; accuracy: number | null;
  hac_ste: string | null; suerte_nom: string | null;
  fuera_zona: boolean; at: string;
};

function geoCacheKey(userId: string, entradaId: string) {
  return `implemento_geo_cache:${userId}:${entradaId}:fin`;
}
function readGeoCache(userId: string, entradaId: string): GeoInfo | null {
  try {
    const raw = localStorage.getItem(geoCacheKey(userId, entradaId));
    return raw ? (JSON.parse(raw) as GeoInfo) : null;
  } catch { return null; }
}
function writeGeoCache(userId: string, entradaId: string, geo: GeoInfo) {
  try { localStorage.setItem(geoCacheKey(userId, entradaId), JSON.stringify(geo)); } catch {}
}

async function resolveGeoRPC(lat: number, lon: number): Promise<{ nom: string; hac_ste: string } | null> {
  const { data, error } = await supabase.rpc("get_hacienda_by_point", { lat, lon });
  if (error || !data || data.length === 0) return null;
  return { nom: data[0].nom, hac_ste: data[0].hac_ste };
}

function fotosLocalKey(userId: string, entradaId: string) {
  return `implemento_fotos_local:${userId}:${entradaId}:fin`;
}
function readLocalSubidas(userId: string, entradaId: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(fotosLocalKey(userId, entradaId));
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch { return {}; }
}
function writeLocalSubidas(userId: string, entradaId: string, subidas: Record<string, boolean>) {
  try { localStorage.setItem(fotosLocalKey(userId, entradaId), JSON.stringify(subidas)); } catch {}
}

function revisionIdLocalKey(userId: string, entradaId: string) {
  return `implemento_revision_id:${userId}:${entradaId}:fin`;
}
function readLocalRevisionId(userId: string, entradaId: string): string | null {
  try { return localStorage.getItem(revisionIdLocalKey(userId, entradaId)); } catch { return null; }
}
function writeLocalRevisionId(userId: string, entradaId: string, id: string) {
  try { localStorage.setItem(revisionIdLocalKey(userId, entradaId), id); } catch {}
}

type PendingPhoto = {
  revisionId: string; userId: string; entradaId: string;
  tipo: FotoTipo; filePath: string; blobBase64: string;
  contentType: string; timestamp: string;
};

const PENDING_PHOTOS_KEY = "implemento_pending_photos_fin_v1";

function readPendingPhotos(): PendingPhoto[] {
  try {
    const raw = localStorage.getItem(PENDING_PHOTOS_KEY);
    return raw ? (JSON.parse(raw) as PendingPhoto[]) : [];
  } catch { return []; }
}
function writePendingPhotos(items: PendingPhoto[]) {
  try { localStorage.setItem(PENDING_PHOTOS_KEY, JSON.stringify(items)); } catch {}
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res((r.result as string).split(",")[1]);
    r.onerror = () => rej(new Error("FileReader error"));
    r.readAsDataURL(blob);
  });
}
function base64ToBlob(b64: string, contentType: string): Blob {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: contentType });
}

type PendingRevision = {
  id: string; userId: string; entradaId: string; timestamp: string;
  latitud: number | null; longitud: number | null; precision_gps: number | null;
  fuera_zona: boolean; hac_ste: string | null; suerte_nom: string | null;
};

const PENDING_REVISION_KEY = "implemento_pending_revision_fin_v1";

function readPendingRevision(userId: string, entradaId: string): PendingRevision | null {
  try {
    const raw = localStorage.getItem(PENDING_REVISION_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as PendingRevision[];
    return all.find((x) => x.userId === userId && x.entradaId === entradaId) ?? null;
  } catch { return null; }
}
function upsertPendingRevision(item: PendingRevision) {
  try {
    const raw = localStorage.getItem(PENDING_REVISION_KEY);
    const all: PendingRevision[] = raw ? JSON.parse(raw) : [];
    const next = [
      ...all.filter((x) => !(x.userId === item.userId && x.entradaId === item.entradaId)),
      item,
    ];
    localStorage.setItem(PENDING_REVISION_KEY, JSON.stringify(next));
  } catch {}
}
function removePendingRevision(userId: string, entradaId: string) {
  try {
    const raw = localStorage.getItem(PENDING_REVISION_KEY);
    if (!raw) return;
    const all = JSON.parse(raw) as PendingRevision[];
    localStorage.setItem(PENDING_REVISION_KEY, JSON.stringify(
      all.filter((x) => !(x.userId === userId && x.entradaId === entradaId))
    ));
  } catch {}
}

async function syncPendingData(userId: string, entradaId: string, revisionId: string) {
  if (!navigator.onLine) return;

  const pending = readPendingRevision(userId, entradaId);
  if (pending) {
    const { error } = await supabase.from("revision_implemento").upsert(
      {
        id: pending.id, user_id: pending.userId, entrada_id: pending.entradaId,
        tipo: "fin", timestamp: pending.timestamp,
        latitud: pending.latitud, longitud: pending.longitud,
        precision_gps: pending.precision_gps, fuera_zona: pending.fuera_zona,
        hac_ste: pending.hac_ste, suerte_nom: pending.suerte_nom,
      },
      { onConflict: "id" } as any
    );
    if (!error) removePendingRevision(userId, entradaId);
    else console.error("[sync implemento fin revision]", error.message);
  }

  // ── [NUEVO] Sync checklist pendiente ──────────────────────────────────
  const pendingCl = readPendingChecklist(userId, entradaId);
  if (pendingCl && Object.keys(pendingCl).length > 0) {
    const { error } = await supabase
      .from("revision_implemento")
      .update(pendingCl)
      .eq("id", revisionId);
    if (!error) clearPendingChecklist(userId, entradaId);
    else console.error("[sync checklist implemento fin]", error.message);
  }

  const allPhotos = readPendingPhotos();
  const mine = allPhotos.filter((p) => p.revisionId === revisionId && p.userId === userId);
  const keep: PendingPhoto[] = allPhotos.filter((p) => !(p.revisionId === revisionId && p.userId === userId));

  for (const photo of mine) {
    try {
      const blob = base64ToBlob(photo.blobBase64, photo.contentType);
      const { error: upErr } = await supabase.storage
        .from("attendance-photos")
        .upload(photo.filePath, blob, { upsert: true, contentType: photo.contentType });
      if (upErr) throw upErr;

      const { error: upsErr } = await supabase.from("revision_implemento_fotos").upsert(
        { revision_id: photo.revisionId, user_id: photo.userId, foto_tipo: photo.tipo, foto_path: photo.filePath, foto_url: null },
        { onConflict: "revision_id,foto_tipo" } as any
      );
      if (upsErr) throw upsErr;
    } catch (e) {
      console.error("[sync implemento fin photo]", e);
      keep.push(photo);
    }
  }

  writePendingPhotos(keep);
}

function revisionCompleteKey(userId: string, dateISO: string) {
  return `implemento_revision_complete:${userId}:${dateISO}:fin`;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function OperarioMaquinariaImplementoFin() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const entradaId = params.get("entrada_id");

  const { user, userSlug } = useAuth();
  const { capturePhoto } = useCamera();
  const { getCurrentPosition } = useGeolocation();

  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [subidas, setSubidas]       = useState<Record<FotoTipo, boolean>>({} as Record<FotoTipo, boolean>);
  const [loading, setLoading]       = useState(false);
  const [creating, setCreating]     = useState(false);
  const [geoMsg, setGeoMsg]         = useState<string | null>(null);
  const [isOffline, setIsOffline]   = useState(!navigator.onLine);

  // Checklist
  const [checklist, setChecklist] = useState<Checklist>(CHECKLIST_INITIAL);

  const checklistCompleto =
    checklist.estado_soldadura !== null &&
    checklist.fugas_aceite     !== null;

  // ── [MODIFICADO] Guarda en DB + local + acumula pending si offline ─────
  const updateChecklist = async (field: keyof Checklist, value: any) => {
    const next = { ...checklist, [field]: value };
    setChecklist(next);
    if (!user?.id || !entradaId) return;

    writeLocalChecklist(user.id, entradaId, next);

    if (revisionId && navigator.onLine) {
      const { error } = await supabase
        .from("revision_implemento")
        .update({ [field]: value })
        .eq("id", revisionId);
      if (error) {
        console.error("[checklist update implemento fin]", error.message);
        const pend = readPendingChecklist(user.id, entradaId) ?? {};
        writePendingChecklist(user.id, entradaId, { ...pend, [field]: value });
      }
    } else {
      // Sin red o sin revisionId aún: acumular en pending
      const pend = readPendingChecklist(user.id, entradaId) ?? {};
      writePendingChecklist(user.id, entradaId, { ...pend, [field]: value });
    }
  };

  const completas = useMemo(() => FOTO_TIPOS.filter((f) => subidas[f.key]).length, [subidas]);

  const puedeFinalizar =
    completas === FOTO_TIPOS.length &&
    checklistCompleto &&
    !!revisionId &&
    !loading &&
    !creating;

  // ── Monitor online/offline ────────────────────────────────────────────────
  useEffect(() => {
    const onOnline = async () => {
      setIsOffline(false);
      if (user?.id && entradaId && revisionId) await syncPendingData(user.id, entradaId, revisionId);
    };
    const onOffline = () => setIsOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [user?.id, entradaId, revisionId]);

  // ── Cargar estado local de subidas + checklist ────────────────────────────
  useEffect(() => {
    if (!user?.id || !entradaId) return;
    const local = readLocalSubidas(user.id, entradaId);
    const next: Record<FotoTipo, boolean> = {} as any;
    for (const f of FOTO_TIPOS) if (local[f.key]) next[f.key] = true;
    if (Object.keys(next).length > 0) setSubidas((prev) => ({ ...prev, ...next }));

    const cl = readLocalChecklist(user.id, entradaId);
    setChecklist(cl);
  }, [user?.id, entradaId]);

  // ── Helper geo ────────────────────────────────────────────────────────────
  const getGeoPayload = async (userId: string, entradaId: string): Promise<GeoInfo> => {
    const cached = readGeoCache(userId, entradaId);
    if (cached) return cached;

    const empty: GeoInfo = {
      lat: null, lon: null, accuracy: null,
      hac_ste: null, suerte_nom: null, fuera_zona: false, at: new Date().toISOString(),
    };

    try {
      const pos = await getCurrentPosition();
      if (!pos?.latitude) { setGeoMsg("No se pudo obtener GPS."); writeGeoCache(userId, entradaId, empty); return empty; }
      const resolved = navigator.onLine ? await resolveGeoRPC(pos.latitude, pos.longitude) : null;
      const geo: GeoInfo = {
        lat: pos.latitude, lon: pos.longitude, accuracy: pos.accuracy ?? null,
        hac_ste: resolved?.hac_ste ?? null, suerte_nom: resolved?.nom ?? null,
        fuera_zona: !resolved, at: new Date().toISOString(),
      };
      if (!resolved) setGeoMsg("GPS OK, pero no se resolvió suerte/hacienda.");
      else setGeoMsg(null);
      writeGeoCache(userId, entradaId, geo);
      return geo;
    } catch {
      setGeoMsg("No se pudo obtener GPS. Revisa permisos.");
      writeGeoCache(userId, entradaId, empty);
      return empty;
    }
  };

  // ── Crear o recuperar revisión implemento FIN ─────────────────────────────
  useEffect(() => {
    if (!user?.id || !entradaId) return;

    const loadOrCreateRevision = async () => {
      setCreating(true);
      try {
        const localId = readLocalRevisionId(user.id, entradaId);

        if (navigator.onLine) {
          const { data: existing, error: selErr } = await supabase
            .from("revision_implemento")
            // ── [MODIFICADO] añadir columnas checklist al select ──────────
            .select("id, latitud, longitud, hac_ste, suerte_nom, precision_gps, fuera_zona, estado_soldadura, fugas_aceite, updated_at, created_at")
            .eq("user_id", user.id).eq("tipo", "fin").eq("entrada_id", entradaId)
            .order("updated_at", { ascending: false }).order("created_at", { ascending: false })
            .limit(1);

          if (!selErr && existing?.[0]?.id) {
            const row = existing[0];
            setRevisionId(row.id);
            writeLocalRevisionId(user.id, entradaId, row.id);

            // ── [NUEVO] Recuperar checklist de DB y merge con local ───────
            const dbCl: Checklist = {
              estado_soldadura: (row.estado_soldadura as EstadoSoldadura) ?? null,
              fugas_aceite:     (row.fugas_aceite     as FugasAceite)     ?? null,
            };
            const localCl = readLocalChecklist(user.id, entradaId);
            // DB gana para campos no-nulos; local cubre lo que DB aún no tiene
            const mergedCl: Checklist = {
              estado_soldadura: dbCl.estado_soldadura ?? localCl.estado_soldadura,
              fugas_aceite:     dbCl.fugas_aceite     ?? localCl.fugas_aceite,
            };
            setChecklist(mergedCl);
            writeLocalChecklist(user.id, entradaId, mergedCl);

            const { data: fotosExistentes } = await supabase
              .from("revision_implemento_fotos").select("foto_tipo").eq("revision_id", row.id);

            if (fotosExistentes && fotosExistentes.length > 0) {
              const next: Record<FotoTipo, boolean> = {} as any;
              for (const ft of fotosExistentes) {
                if (FOTO_TIPOS.some((f) => f.key === ft.foto_tipo)) next[ft.foto_tipo as FotoTipo] = true;
              }
              const localSubidas = readLocalSubidas(user.id, entradaId);
              const merged = { ...next, ...localSubidas };
              setSubidas(merged as Record<FotoTipo, boolean>);
              writeLocalSubidas(user.id, entradaId, merged);
            }

            if (row.latitud == null || row.longitud == null) {
              const geo = await getGeoPayload(user.id, entradaId);
              if (geo.lat != null) {
                await supabase.from("revision_implemento").update({
                  latitud: geo.lat, longitud: geo.lon, precision_gps: geo.accuracy,
                  fuera_zona: geo.fuera_zona, hac_ste: geo.hac_ste, suerte_nom: geo.suerte_nom,
                }).eq("id", row.id);
              }
            }
            return;
          }

          const geo = await getGeoPayload(user.id, entradaId);
          const { data: created, error: insErr } = await supabase
            .from("revision_implemento")
            .insert({
              user_id: user.id, entrada_id: entradaId, tipo: "fin",
              timestamp: new Date().toISOString(),
              latitud: geo.lat, longitud: geo.lon, precision_gps: geo.accuracy,
              fuera_zona: geo.fuera_zona, hac_ste: geo.hac_ste, suerte_nom: geo.suerte_nom,
            } as any)
            .select("id").single();

          if (!insErr && created) {
            setRevisionId(created.id);
            writeLocalRevisionId(user.id, entradaId, created.id);
          }
          return;
        }

        if (localId) { setRevisionId(localId); return; }

        const newId = safeUUID();
        const geo = await getGeoPayload(user.id, entradaId);
        upsertPendingRevision({
          id: newId, userId: user.id, entradaId, timestamp: new Date().toISOString(),
          latitud: geo.lat, longitud: geo.lon, precision_gps: geo.accuracy,
          fuera_zona: geo.fuera_zona, hac_ste: geo.hac_ste, suerte_nom: geo.suerte_nom,
        });
        setRevisionId(newId);
        writeLocalRevisionId(user.id, entradaId, newId);
      } finally {
        setCreating(false);
      }
    };

    loadOrCreateRevision();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, entradaId]);

  // ── Capturar y subir foto ─────────────────────────────────────────────────
  const handleCapture = async (tipo: FotoTipo) => {
    if (!revisionId || !user?.id || !entradaId) return;
    try {
      setLoading(true);
      const blob = await capturePhoto();
      if (!blob) return;

      const today = getLocalDateISO();
      const filePath = `${userSlug}/implemento/${today}/fin/${revisionId}/${tipo}.webp`;

      if (navigator.onLine) {
        const { error: uploadErr } = await supabase.storage
          .from("attendance-photos")
          .upload(filePath, blob, { upsert: true, contentType: "image/webp" });

        if (uploadErr) {
          console.error("[storage upload implemento fin]", uploadErr.message);
          await savePhotoOffline(blob, tipo, filePath, revisionId, user.id, entradaId);
        } else {
          const { error: upsertErr } = await supabase.from("revision_implemento_fotos").upsert(
            { revision_id: revisionId, user_id: user.id, foto_tipo: tipo, foto_path: filePath, foto_url: null },
            { onConflict: "revision_id,foto_tipo" } as any
          );
          if (upsertErr) console.error("[implemento fotos upsert fin]", upsertErr.message);
        }
      } else {
        await savePhotoOffline(blob, tipo, filePath, revisionId, user.id, entradaId);
      }

      const next = { ...subidas, [tipo]: true } as Record<FotoTipo, boolean>;
      setSubidas(next);
      writeLocalSubidas(user.id, entradaId, next);
    } finally {
      setLoading(false);
    }
  };

  const savePhotoOffline = async (
    blob: Blob, tipo: FotoTipo, filePath: string,
    revisionId: string, userId: string, entradaId: string
  ) => {
    try {
      const b64 = await blobToBase64(blob);
      const all = readPendingPhotos();
      const next = [
        ...all.filter((p) => !(p.revisionId === revisionId && p.tipo === tipo)),
        { revisionId, userId, entradaId, tipo, filePath, blobBase64: b64, contentType: "image/webp", timestamp: new Date().toISOString() },
      ];
      writePendingPhotos(next);
    } catch (e) { console.error("[savePhotoOffline implemento fin]", e); }
  };

  // ── Finalizar ─────────────────────────────────────────────────────────────
  const finalizar = () => {
    if (!puedeFinalizar) return;
    const dateISO = getLocalDateISO();
    localStorage.setItem(revisionCompleteKey(user?.id ?? "", dateISO), "1");
    navigate("/OperarioMaquinaria", { replace: true });
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="p-4 max-w-lg mx-auto space-y-4">

      {/* Header */}
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="icon" onClick={() => navigate(-1)} disabled={loading}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl font-semibold">Revisión implemento — fin turno</h1>
        {isOffline && (
          <span className="ml-auto flex items-center gap-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-2 py-1 rounded-full">
            <WifiOff className="h-3 w-3" /> Sin red
          </span>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        Captura las <strong>2 fotos obligatorias</strong> y completa el checklist del implemento para cerrar el turno.
        {isOffline && (
          <span className="block mt-1 text-amber-600 font-medium">
            Modo offline: las fotos se sincronizarán cuando vuelva la conexión.
          </span>
        )}
      </p>

      {geoMsg && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">{geoMsg}</div>
      )}
      {creating && (
        <div className="text-sm text-muted-foreground text-center py-2">Preparando revisión…</div>
      )}

      {/* Fotos */}
      <div className="space-y-3">
        {FOTO_TIPOS.map((f) => (
          <Button
            type="button" key={f.key}
            className="w-full justify-start"
            variant={subidas[f.key] ? "secondary" : "outline"}
            disabled={loading || !revisionId || creating}
            onClick={() => handleCapture(f.key)}
          >
            {subidas[f.key] ? <CheckCircle className="h-4 w-4 mr-2 text-success" /> : <Camera className="h-4 w-4 mr-2" />}
            {f.label}
            {subidas[f.key] && isOffline
              ? <span className="ml-auto text-xs text-amber-500">pendiente sync</span>
              : null}
          </Button>
        ))}
      </div>

      <p className="text-xs text-muted-foreground text-center">
        Fotos: {completas} / {FOTO_TIPOS.length}
      </p>

      {/* ── CHECKLIST ─────────────────────────────────────────────────────── */}
      <div className="rounded-lg border-2 border-dashed border-muted-foreground/30 p-4 space-y-4">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded-full bg-primary/10 flex items-center justify-center">
            <CheckCircle className="h-3 w-3 text-primary" />
          </div>
          <h2 className="text-sm font-semibold">Revisión Implemento Fin</h2>
          {checklistCompleto && (
            <span className="ml-auto text-xs text-green-600 font-medium bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">
              ✓ Completo
            </span>
          )}
        </div>

        {/* Estado de soldadura */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Estado de soldadura</label>
            {checklist.estado_soldadura === null && <span className="text-xs text-muted-foreground">Requerido</span>}
          </div>
          <OpcionFila
            opciones={SOLDADURA_OPCIONES}
            valor={checklist.estado_soldadura}
            onChange={(v) => updateChecklist("estado_soldadura", v)}
          />
        </div>

        {/* Fugas de aceite */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Fugas de aceite</label>
            {checklist.fugas_aceite === null && <span className="text-xs text-muted-foreground">Requerido</span>}
          </div>
          <OpcionFila
            opciones={FUGAS_OPCIONES}
            valor={checklist.fugas_aceite}
            onChange={(v) => updateChecklist("fugas_aceite", v)}
          />
        </div>
      </div>

      {/* Botón finalizar */}
      <Button
        type="button" className="w-full"
        disabled={!puedeFinalizar}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); finalizar(); }}
      >
        {creating
          ? "Preparando revisión..."
          : !checklistCompleto
          ? "Completa el checklist para finalizar"
          : completas < FOTO_TIPOS.length
          ? `Faltan ${FOTO_TIPOS.length - completas} foto(s)`
          : "Finalizar revisión implemento fin"}
      </Button>

    </div>
  );
}