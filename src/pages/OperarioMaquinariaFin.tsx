// src/pages/OperarioMaquinariaFin.tsx
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { format } from "date-fns";
import { Camera, CheckCircle, ArrowLeft, ChevronsUpDown, Check, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useCamera } from "@/hooks/useCamera";
import { useGeolocation } from "@/hooks/useGeolocation";

import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from "@/components/ui/command";

type FotoTipo = "frente" | "lado_derecho" | "lado_izquierdo" | "trasera" | "cabina";

// ─── Checklist types ──────────────────────────────────────────────────────────
type EstadoLlantas = "malas" | "regulares" | "buen_estado";
type NivelFluidos  = "bajo"  | "medio"     | "alto";
type PresentaFugas = "si"    | "no";

type Checklist = {
  estado_llantas:  EstadoLlantas  | null;
  nivel_fluidos:   NivelFluidos   | null;
  presenta_fugas:  PresentaFugas  | null;
};

const CHECKLIST_INITIAL: Checklist = {
  estado_llantas: null,
  nivel_fluidos:  null,
  presenta_fugas: null,
};

const LLANTAS_OPCIONES: { value: EstadoLlantas; label: string; color: string }[] = [
  { value: "malas",       label: "Malas",       color: "border-red-400 bg-red-50 text-red-700 data-[sel=true]:bg-red-500 data-[sel=true]:text-white" },
  { value: "regulares",   label: "Regulares",   color: "border-amber-400 bg-amber-50 text-amber-700 data-[sel=true]:bg-amber-500 data-[sel=true]:text-white" },
  { value: "buen_estado", label: "Buen estado", color: "border-green-400 bg-green-50 text-green-700 data-[sel=true]:bg-green-500 data-[sel=true]:text-white" },
];

const FLUIDOS_OPCIONES: { value: NivelFluidos; label: string; color: string }[] = [
  { value: "bajo",  label: "Bajo",  color: "border-red-400 bg-red-50 text-red-700 data-[sel=true]:bg-red-500 data-[sel=true]:text-white" },
  { value: "medio", label: "Medio", color: "border-amber-400 bg-amber-50 text-amber-700 data-[sel=true]:bg-amber-500 data-[sel=true]:text-white" },
  { value: "alto",  label: "Alto",  color: "border-green-400 bg-green-50 text-green-700 data-[sel=true]:bg-green-500 data-[sel=true]:text-white" },
];

const FUGAS_OPCIONES: { value: PresentaFugas; label: string; color: string }[] = [
  { value: "si", label: "Sí", color: "border-red-400 bg-red-50 text-red-700 data-[sel=true]:bg-red-500 data-[sel=true]:text-white" },
  { value: "no", label: "No", color: "border-green-400 bg-green-50 text-green-700 data-[sel=true]:bg-green-500 data-[sel=true]:text-white" },
];

// ─── localStorage checklist ───────────────────────────────────────────────────
function checklistLocalKey(userId: string, entradaId: string) {
  return `maq_checklist:${userId}:${entradaId}:fin`;
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
  return `maq_checklist_pending:${userId}:${entradaId}:fin`;
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

const FOTO_TIPOS: { key: FotoTipo; label: string }[] = [
  { key: "frente",         label: "Foto frontal maquina" },
  { key: "lado_derecho",   label: "Foto lado derecho maquina" },
  { key: "lado_izquierdo", label: "Foto lado izquierdo maquina" },
  { key: "trasera",        label: "Foto trasera maquina" },
  { key: "cabina",         label: "Foto interior de cabina" },
];

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
  return `maq_geo_cache:${userId}:${entradaId}:fin`;
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
  return `maq_fotos_local:${userId}:${entradaId}:fin`;
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
  return `maq_revision_id:${userId}:${entradaId}:fin`;
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

const PENDING_PHOTOS_KEY = "maq_pending_photos_fin_v1";

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
  id: string; userId: string; entradaId: string; equipoCodigo: string;
  timestamp: string; latitud: number | null; longitud: number | null;
  precision_gps: number | null; fuera_zona: boolean;
  hac_ste: string | null; suerte_nom: string | null;
};

const PENDING_REVISION_KEY = "maq_pending_revision_fin_v1";

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
    localStorage.setItem(
      PENDING_REVISION_KEY,
      JSON.stringify(all.filter((x) => !(x.userId === userId && x.entradaId === entradaId)))
    );
  } catch {}
}

function equipoLocalKey(userId: string, entradaId: string) {
  return `maq_equipo_pending:${userId}:${entradaId}:fin`;
}

const MAESTRO_CACHE_KEY = "maq_maestro_cache_v1";
type MaestroEquipo = {
  cod_equipo: string; descripcion_equipo: string | null;
  marca?: string | null; modelo?: string | null;
  potencia_hp?: number | null; seguimiento?: string | null;
};
function readMaestroCache(): MaestroEquipo[] {
  try {
    const raw = localStorage.getItem(MAESTRO_CACHE_KEY);
    return raw ? (JSON.parse(raw) as MaestroEquipo[]) : [];
  } catch { return []; }
}
function writeMaestroCache(items: MaestroEquipo[]) {
  try { localStorage.setItem(MAESTRO_CACHE_KEY, JSON.stringify(items)); } catch {}
}

async function syncPendingData(userId: string, entradaId: string, revisionId: string) {
  if (!navigator.onLine) return;

  const pending = readPendingRevision(userId, entradaId);
  if (pending) {
    const { error } = await supabase.from("revision_maquinaria").upsert(
      {
        id: pending.id, user_id: pending.userId, entrada_id: pending.entradaId,
        tipo: "fin", equipo_codigo: pending.equipoCodigo || "SIN_DEFINIR",
        timestamp: pending.timestamp, latitud: pending.latitud, longitud: pending.longitud,
        precision_gps: pending.precision_gps, fuera_zona: pending.fuera_zona,
        hac_ste: pending.hac_ste, suerte_nom: pending.suerte_nom,
      },
      { onConflict: "id" } as any
    );
    if (!error) removePendingRevision(userId, entradaId);
    else console.error("[sync revision fin]", error.message);
  }

  const pendingEquipo = localStorage.getItem(equipoLocalKey(userId, entradaId));
  if (pendingEquipo) {
    const { error } = await supabase
      .from("revision_maquinaria").update({ equipo_codigo: pendingEquipo }).eq("id", revisionId);
    if (!error) localStorage.removeItem(equipoLocalKey(userId, entradaId));
  }

  // ── [NUEVO] Sync checklist pendiente ──────────────────────────────────
  const pendingCl = readPendingChecklist(userId, entradaId);
  if (pendingCl && Object.keys(pendingCl).length > 0) {
    const { error } = await supabase
      .from("revision_maquinaria")
      .update(pendingCl)
      .eq("id", revisionId);
    if (!error) clearPendingChecklist(userId, entradaId);
    else console.error("[sync checklist fin]", error.message);
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

      const { error: upsErr } = await supabase.from("revision_maquinaria_fotos").upsert(
        { revision_id: photo.revisionId, user_id: photo.userId, foto_tipo: photo.tipo, foto_path: photo.filePath, foto_url: null },
        { onConflict: "revision_id,foto_tipo" } as any
      );
      if (upsErr) throw upsErr;
    } catch (e) {
      console.error("[sync photo fin]", e);
      keep.push(photo);
    }
  }

  writePendingPhotos(keep);
}

// ─────────────────────────────────────────────────────────────────────────────

export default function OperarioMaquinariaFin() {
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
    checklist.estado_llantas !== null &&
    checklist.nivel_fluidos  !== null &&
    checklist.presenta_fugas !== null;

  // ── [MODIFICADO] Guarda en DB + local + acumula pending si offline ─────
  const updateChecklist = async (field: keyof Checklist, value: any) => {
    const next = { ...checklist, [field]: value };
    setChecklist(next);
    if (!user?.id || !entradaId) return;

    writeLocalChecklist(user.id, entradaId, next);

    if (revisionId && navigator.onLine) {
      const { error } = await supabase
        .from("revision_maquinaria")
        .update({ [field]: value })
        .eq("id", revisionId);
      if (error) {
        console.error("[checklist update fin]", error.message);
        const pend = readPendingChecklist(user.id, entradaId) ?? {};
        writePendingChecklist(user.id, entradaId, { ...pend, [field]: value });
      }
    } else {
      // Sin red o sin revisionId aún: acumular en pending
      const pend = readPendingChecklist(user.id, entradaId) ?? {};
      writePendingChecklist(user.id, entradaId, { ...pend, [field]: value });
    }
  };

  // Maestro maquinaria
  const [equipos, setEquipos]               = useState<MaestroEquipo[]>([]);
  const [equiposLoading, setEquiposLoading] = useState(false);
  const [equipoCodigo, setEquipoCodigo]     = useState<string>("");
  const [openEquipo, setOpenEquipo]         = useState(false);

  const equipoSeleccionado = useMemo(
    () => equipos.find((e) => e.cod_equipo === equipoCodigo) ?? null,
    [equipos, equipoCodigo]
  );

  const completas = useMemo(() => FOTO_TIPOS.filter((f) => subidas[f.key]).length, [subidas]);

  const puedeFinalizar =
    completas === FOTO_TIPOS.length &&
    checklistCompleto &&
    !!equipoCodigo &&
    !!revisionId &&
    !loading &&
    !creating;

  // ── Monitor online/offline ────────────────────────────────────────────────
  useEffect(() => {
    const onOnline = async () => {
      setIsOffline(false);
      if (user?.id && entradaId && revisionId) {
        await syncPendingData(user.id, entradaId, revisionId);
      }
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

  // ── Cargar maestro maquinaria ─────────────────────────────────────────────
  useEffect(() => {
    const loadMaestro = async () => {
      const cached = readMaestroCache();
      if (cached.length > 0) setEquipos(cached);
      if (!navigator.onLine) return;
      setEquiposLoading(true);
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        if (!sessionData.session) return;
        const { data, error } = await supabase
          .from("maestro_maquinaria")
          .select("cod_equipo, descripcion_equipo, marca, modelo, potencia_hp, seguimiento")
          .eq("activo", true)
          .order("cod_equipo", { ascending: true });
        if (!error && data) { setEquipos(data as MaestroEquipo[]); writeMaestroCache(data as MaestroEquipo[]); }
      } finally { setEquiposLoading(false); }
    };
    loadMaestro();
  }, []);

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
      if (!pos?.latitude) {
        setGeoMsg("No se pudo obtener GPS.");
        writeGeoCache(userId, entradaId, empty);
        return empty;
      }
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

  // ── Crear o recuperar revisión FIN ────────────────────────────────────────
  useEffect(() => {
    if (!user?.id || !entradaId) return;

    const loadOrCreateRevision = async () => {
      setCreating(true);
      try {
        const localId = readLocalRevisionId(user.id, entradaId);

        if (navigator.onLine) {
          const { data: existing, error: selErr } = await supabase
            .from("revision_maquinaria")
            // ── [MODIFICADO] añadir columnas checklist al select ──────────
            .select("id, equipo_codigo, latitud, longitud, hac_ste, suerte_nom, precision_gps, fuera_zona, estado_llantas, nivel_fluidos, presenta_fugas, updated_at, created_at")
            .eq("user_id", user.id).eq("tipo", "fin").eq("entrada_id", entradaId)
            .order("updated_at", { ascending: false }).order("created_at", { ascending: false })
            .limit(1);

          if (!selErr && existing?.[0]?.id) {
            const row = existing[0];
            setRevisionId(row.id);
            writeLocalRevisionId(user.id, entradaId, row.id);

            if (row.equipo_codigo && row.equipo_codigo !== "SIN_DEFINIR") {
              setEquipoCodigo(row.equipo_codigo);
            } else {
              const pendEquipo = localStorage.getItem(equipoLocalKey(user.id, entradaId));
              if (pendEquipo) setEquipoCodigo(pendEquipo);
            }

            // ── [NUEVO] Recuperar checklist de DB y merge con local ───────
            const dbCl: Checklist = {
              estado_llantas: (row.estado_llantas as EstadoLlantas) ?? null,
              nivel_fluidos:  (row.nivel_fluidos  as NivelFluidos)  ?? null,
              presenta_fugas: (row.presenta_fugas as PresentaFugas) ?? null,
            };
            const localCl = readLocalChecklist(user.id, entradaId);
            // DB gana para campos no-nulos; local cubre lo que DB aún no tiene
            const mergedCl: Checklist = {
              estado_llantas: dbCl.estado_llantas ?? localCl.estado_llantas,
              nivel_fluidos:  dbCl.nivel_fluidos  ?? localCl.nivel_fluidos,
              presenta_fugas: dbCl.presenta_fugas ?? localCl.presenta_fugas,
            };
            setChecklist(mergedCl);
            writeLocalChecklist(user.id, entradaId, mergedCl);

            const { data: fotosExistentes } = await supabase
              .from("revision_maquinaria_fotos").select("foto_tipo").eq("revision_id", row.id);

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
                await supabase.from("revision_maquinaria").update({
                  latitud: geo.lat, longitud: geo.lon, precision_gps: geo.accuracy,
                  fuera_zona: geo.fuera_zona, hac_ste: geo.hac_ste, suerte_nom: geo.suerte_nom,
                }).eq("id", row.id);
              }
            }
            return;
          }

          const geo = await getGeoPayload(user.id, entradaId);
          const { data: created, error: insErr } = await supabase
            .from("revision_maquinaria")
            .insert({
              user_id: user.id, entrada_id: entradaId, tipo: "fin",
              equipo_codigo: "SIN_DEFINIR", timestamp: new Date().toISOString(),
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

        if (localId) {
          setRevisionId(localId);
          const pendEquipo = localStorage.getItem(equipoLocalKey(user.id, entradaId));
          if (pendEquipo) setEquipoCodigo(pendEquipo);
          return;
        }

        const newId = safeUUID();
        const geo = await getGeoPayload(user.id, entradaId);
        upsertPendingRevision({
          id: newId, userId: user.id, entradaId, equipoCodigo: "SIN_DEFINIR",
          timestamp: new Date().toISOString(), latitud: geo.lat, longitud: geo.lon,
          precision_gps: geo.accuracy, fuera_zona: geo.fuera_zona,
          hac_ste: geo.hac_ste, suerte_nom: geo.suerte_nom,
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

  // ── Selección de equipo ───────────────────────────────────────────────────
  const onSelectEquipo = async (cod: string) => {
    setEquipoCodigo(cod);
    if (!revisionId || !user?.id || !entradaId) return;
    if (navigator.onLine) {
      const { error } = await supabase
        .from("revision_maquinaria").update({ equipo_codigo: cod }).eq("id", revisionId);
      if (error) console.error("[update equipo_codigo fin]", error.message);
      else localStorage.removeItem(equipoLocalKey(user.id, entradaId));
    } else {
      localStorage.setItem(equipoLocalKey(user.id, entradaId), cod);
      const pending = readPendingRevision(user.id, entradaId);
      if (pending) upsertPendingRevision({ ...pending, equipoCodigo: cod });
    }
  };

  // ── Capturar y subir foto ─────────────────────────────────────────────────
  const handleCapture = async (tipo: FotoTipo) => {
    if (!revisionId || !user?.id || !entradaId) return;
    if (!equipoCodigo) { console.error("Debe seleccionar equipo antes de subir fotos"); return; }

    try {
      setLoading(true);
      const blob = await capturePhoto();
      if (!blob) return;

      const today = getLocalDateISO();
      const filePath = `${userSlug}/maquinaria/${today}/fin/${revisionId}/${tipo}.webp`;

      if (navigator.onLine) {
        const { error: uploadErr } = await supabase.storage
          .from("attendance-photos")
          .upload(filePath, blob, { upsert: true, contentType: "image/webp" });

        if (uploadErr) {
          console.error("[storage upload fin]", uploadErr.message);
          await savePhotoOffline(blob, tipo, filePath, revisionId, user.id, entradaId);
        } else {
          const { error: upsertErr } = await supabase.from("revision_maquinaria_fotos").upsert(
            { revision_id: revisionId, user_id: user.id, foto_tipo: tipo, foto_path: filePath, foto_url: null },
            { onConflict: "revision_id,foto_tipo" } as any
          );
          if (upsertErr) console.error("[fotos upsert fin]", upsertErr.message);
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
    } catch (e) { console.error("[savePhotoOffline fin]", e); }
  };

  // ── Finalizar ─────────────────────────────────────────────────────────────
  const finalizar = () => {
    if (!puedeFinalizar) return;
    const dateISO = getLocalDateISO();
    localStorage.setItem(`maq_revision_complete:${user?.id}:${dateISO}:fin`, "1");
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
        <h1 className="text-xl font-semibold">Revisión fin turno</h1>
        {isOffline && (
          <span className="ml-auto flex items-center gap-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-2 py-1 rounded-full">
            <WifiOff className="h-3 w-3" /> Sin red
          </span>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        Captura las <strong>5 fotos obligatorias</strong> y completa el checklist de revisión de fin de turno.
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

      {/* Equipo */}
      <div className="rounded-lg border p-3 space-y-2">
        <div className="text-sm font-medium">Equipo</div>
        <Popover open={openEquipo} onOpenChange={setOpenEquipo}>
          <PopoverTrigger asChild>
            <Button
              type="button" variant="outline" role="combobox"
              aria-expanded={openEquipo} className="w-full justify-between"
              disabled={equiposLoading || !revisionId}
            >
              {equipoCodigo
                ? (() => { const e = equipos.find((x) => x.cod_equipo === equipoCodigo); return e ? `${e.cod_equipo} — ${e.descripcion_equipo ?? "—"}` : equipoCodigo; })()
                : equiposLoading ? "Cargando equipos..."
                : equipos.length > 0 ? "Selecciona el equipo..."
                : isOffline ? "Sin red — usa cache"
                : "Cargando equipos..."}
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
            <Command filter={(value, search) => { const v = value.toLowerCase(); const s = search.toLowerCase(); return v.includes(s) ? 1 : 0; }}>
              <CommandInput placeholder="Buscar por código o descripción..." />
              <CommandEmpty>
                {equipos.length === 0 && isOffline ? "Sin red y sin cache. Conéctate para cargar equipos." : "No se encontraron equipos."}
              </CommandEmpty>
              <CommandGroup className="max-h-64 overflow-auto">
                {equipos.map((e) => {
                  const itemValue = `${e.cod_equipo} ${e.descripcion_equipo ?? ""}`;
                  return (
                    <CommandItem key={e.cod_equipo} value={itemValue}
                      onSelect={async () => { await onSelectEquipo(e.cod_equipo); setOpenEquipo(false); }}
                    >
                      <Check className={cn("mr-2 h-4 w-4", equipoCodigo === e.cod_equipo ? "opacity-100" : "opacity-0")} />
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">{e.cod_equipo}</span>
                        <span className="text-xs text-muted-foreground">{e.descripcion_equipo ?? "—"}</span>
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </Command>
          </PopoverContent>
        </Popover>
        <div className="text-xs text-muted-foreground">
          {equipoSeleccionado ? (
            <div className="space-y-1">
              <div><span className="font-medium text-foreground">Descripción: </span>{equipoSeleccionado.descripcion_equipo ?? "—"}</div>
              {(equipoSeleccionado.marca || equipoSeleccionado.modelo) && (
                <div>{equipoSeleccionado.marca ?? "—"} {equipoSeleccionado.modelo ?? ""}</div>
              )}
            </div>
          ) : "Selecciona un equipo para ver la descripción."}
        </div>
      </div>

      {/* Fotos */}
      <div className="space-y-3">
        {FOTO_TIPOS.map((f) => (
          <Button
            type="button" key={f.key}
            className="w-full justify-start"
            variant={subidas[f.key] ? "secondary" : "outline"}
            disabled={loading || !revisionId || !equipoCodigo}
            onClick={() => handleCapture(f.key)}
          >
            {subidas[f.key] ? <CheckCircle className="h-4 w-4 mr-2 text-success" /> : <Camera className="h-4 w-4 mr-2" />}
            {f.label}
            {!equipoCodigo
              ? <span className="ml-auto text-xs text-muted-foreground">(elige equipo)</span>
              : subidas[f.key] && isOffline
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
          <h2 className="text-sm font-semibold">Revisión Máquina Fin</h2>
          {checklistCompleto && (
            <span className="ml-auto text-xs text-green-600 font-medium bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">
              ✓ Completo
            </span>
          )}
        </div>

        {/* Estado de llantas */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Estado de llantas</label>
            {checklist.estado_llantas === null && <span className="text-xs text-muted-foreground">Requerido</span>}
          </div>
          <OpcionFila
            opciones={LLANTAS_OPCIONES}
            valor={checklist.estado_llantas}
            onChange={(v) => updateChecklist("estado_llantas", v)}
          />
        </div>

        {/* Nivel de fluidos */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Nivel de fluidos</label>
            {checklist.nivel_fluidos === null && <span className="text-xs text-muted-foreground">Requerido</span>}
          </div>
          <OpcionFila
            opciones={FLUIDOS_OPCIONES}
            valor={checklist.nivel_fluidos}
            onChange={(v) => updateChecklist("nivel_fluidos", v)}
          />
        </div>

        {/* Presenta fugas */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">¿Presenta fugas?</label>
            {checklist.presenta_fugas === null && <span className="text-xs text-muted-foreground">Requerido</span>}
          </div>
          <OpcionFila
            opciones={FUGAS_OPCIONES}
            valor={checklist.presenta_fugas}
            onChange={(v) => updateChecklist("presenta_fugas", v)}
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
          : "Finalizar revisión fin"}
      </Button>

    </div>
  );
}