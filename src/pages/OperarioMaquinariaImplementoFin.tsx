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

type FotoTipo = "implemento_frente" | "implemento_lateral";

const FOTO_TIPOS: { key: FotoTipo; label: string }[] = [
  { key: "implemento_frente", label: "Foto frontal del implemento" },
  { key: "implemento_lateral", label: "Foto lateral del implemento" },
];

function getLocalDateISO() {
  return format(new Date(), "yyyy-MM-dd");
}

// ─── UUID offline ─────────────────────────────────────────────────────────────
function safeUUID(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID)
      return crypto.randomUUID();
  } catch {}
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ─── Geo cache ────────────────────────────────────────────────────────────────
type GeoInfo = {
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  hac_ste: string | null;
  suerte_nom: string | null;
  fuera_zona: boolean;
  at: string;
};

function geoCacheKey(userId: string, entradaId: string) {
  return `implemento_geo_cache:${userId}:${entradaId}:fin`;
}
function readGeoCache(userId: string, entradaId: string): GeoInfo | null {
  try {
    const raw = localStorage.getItem(geoCacheKey(userId, entradaId));
    return raw ? (JSON.parse(raw) as GeoInfo) : null;
  } catch {
    return null;
  }
}
function writeGeoCache(userId: string, entradaId: string, geo: GeoInfo) {
  try {
    localStorage.setItem(geoCacheKey(userId, entradaId), JSON.stringify(geo));
  } catch {}
}

async function resolveGeoRPC(
  lat: number,
  lon: number,
): Promise<{ nom: string; hac_ste: string } | null> {
  const { data, error } = await supabase.rpc("get_hacienda_by_point", {
    lat,
    lon,
  });
  if (error || !data || data.length === 0) return null;
  return { nom: data[0].nom, hac_ste: data[0].hac_ste };
}

// ─── Local: fotos subidas ─────────────────────────────────────────────────────
function fotosLocalKey(userId: string, entradaId: string) {
  return `implemento_fotos_local:${userId}:${entradaId}:fin`;
}
function readLocalSubidas(
  userId: string,
  entradaId: string,
): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(fotosLocalKey(userId, entradaId));
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}
function writeLocalSubidas(
  userId: string,
  entradaId: string,
  subidas: Record<string, boolean>,
) {
  try {
    localStorage.setItem(
      fotosLocalKey(userId, entradaId),
      JSON.stringify(subidas),
    );
  } catch {}
}

// ─── Local: revisionId persistido ────────────────────────────────────────────
function revisionIdLocalKey(userId: string, entradaId: string) {
  return `implemento_revision_id:${userId}:${entradaId}:fin`;
}
function readLocalRevisionId(userId: string, entradaId: string): string | null {
  try {
    return localStorage.getItem(revisionIdLocalKey(userId, entradaId));
  } catch {
    return null;
  }
}
function writeLocalRevisionId(userId: string, entradaId: string, id: string) {
  try {
    localStorage.setItem(revisionIdLocalKey(userId, entradaId), id);
  } catch {}
}

// ─── Local: fotos pendientes de sync ─────────────────────────────────────────
type PendingPhoto = {
  revisionId: string;
  userId: string;
  entradaId: string;
  tipo: FotoTipo;
  filePath: string;
  blobBase64: string;
  contentType: string;
  timestamp: string;
};

const PENDING_PHOTOS_KEY = "implemento_pending_photos_fin_v1";

function readPendingPhotos(): PendingPhoto[] {
  try {
    const raw = localStorage.getItem(PENDING_PHOTOS_KEY);
    return raw ? (JSON.parse(raw) as PendingPhoto[]) : [];
  } catch {
    return [];
  }
}
function writePendingPhotos(items: PendingPhoto[]) {
  try {
    localStorage.setItem(PENDING_PHOTOS_KEY, JSON.stringify(items));
  } catch {}
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

// ─── Local: revisión pendiente de sync ───────────────────────────────────────
type PendingRevision = {
  id: string;
  userId: string;
  entradaId: string;
  timestamp: string;
  latitud: number | null;
  longitud: number | null;
  precision_gps: number | null;
  fuera_zona: boolean;
  hac_ste: string | null;
  suerte_nom: string | null;
};

const PENDING_REVISION_KEY = "implemento_pending_revision_fin_v1";

function readPendingRevision(
  userId: string,
  entradaId: string,
): PendingRevision | null {
  try {
    const raw = localStorage.getItem(PENDING_REVISION_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as PendingRevision[];
    return (
      all.find((x) => x.userId === userId && x.entradaId === entradaId) ?? null
    );
  } catch {
    return null;
  }
}
function upsertPendingRevision(item: PendingRevision) {
  try {
    const raw = localStorage.getItem(PENDING_REVISION_KEY);
    const all: PendingRevision[] = raw ? JSON.parse(raw) : [];
    const next = [
      ...all.filter(
        (x) => !(x.userId === item.userId && x.entradaId === item.entradaId),
      ),
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
      JSON.stringify(
        all.filter((x) => !(x.userId === userId && x.entradaId === entradaId)),
      ),
    );
  } catch {}
}

// ─── Sync cuando vuelve internet ──────────────────────────────────────────────
async function syncPendingData(
  userId: string,
  entradaId: string,
  revisionId: string,
) {
  if (!navigator.onLine) return;

  // 1) Sync revisión metadata
  const pending = readPendingRevision(userId, entradaId);
  if (pending) {
    const { error } = await supabase.from("revision_implemento").upsert(
      {
        id: pending.id,
        user_id: pending.userId,
        entrada_id: pending.entradaId,
        tipo: "fin",
        timestamp: pending.timestamp,
        latitud: pending.latitud,
        longitud: pending.longitud,
        precision_gps: pending.precision_gps,
        fuera_zona: pending.fuera_zona,
        hac_ste: pending.hac_ste,
        suerte_nom: pending.suerte_nom,
      },
      { onConflict: "id" } as any,
    );
    if (!error) removePendingRevision(userId, entradaId);
    else console.error("[sync implemento fin revision]", error.message);
  }

  // 2) Sync fotos pendientes
  const allPhotos = readPendingPhotos();
  const mine = allPhotos.filter(
    (p) => p.revisionId === revisionId && p.userId === userId,
  );
  const keep: PendingPhoto[] = allPhotos.filter(
    (p) => !(p.revisionId === revisionId && p.userId === userId),
  );

  for (const photo of mine) {
    try {
      const blob = base64ToBlob(photo.blobBase64, photo.contentType);

      const { error: upErr } = await supabase.storage
        .from("attendance-photos")
        .upload(photo.filePath, blob, {
          upsert: true,
          contentType: photo.contentType,
        });
      if (upErr) throw upErr;

      const { error: upsErr } = await supabase
        .from("revision_implemento_fotos")
        .upsert(
          {
            revision_id: photo.revisionId,
            user_id: photo.userId,
            foto_tipo: photo.tipo,
            foto_path: photo.filePath,
            foto_url: null,
          },
          { onConflict: "revision_id,foto_tipo" } as any,
        );
      if (upsErr) throw upsErr;
    } catch (e) {
      console.error("[sync implemento fin photo]", e);
      keep.push(photo);
    }
  }

  writePendingPhotos(keep);
}

// ─── Local: revision complete key ────────────────────────────────────────────
function revisionCompleteKey(userId: string, dateISO: string) {
  return `implemento_revision_complete:${userId}:${dateISO}:fin`;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function OperarioMaquinariaImplementoFin() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const entradaId = params.get("entrada_id");

  const { user } = useAuth();
  const { capturePhoto } = useCamera();
  const { getCurrentPosition } = useGeolocation();

  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [subidas, setSubidas] = useState<Record<FotoTipo, boolean>>(
    {} as Record<FotoTipo, boolean>,
  );
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  const completas = useMemo(
    () => FOTO_TIPOS.filter((f) => subidas[f.key]).length,
    [subidas],
  );

  const puedeFinalizar =
    completas === FOTO_TIPOS.length && !!revisionId && !loading && !creating;

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

  // ── Cargar estado local de subidas ────────────────────────────────────────
  useEffect(() => {
    if (!user?.id || !entradaId) return;
    const local = readLocalSubidas(user.id, entradaId);
    const next: Record<FotoTipo, boolean> = {} as any;
    for (const f of FOTO_TIPOS) if (local[f.key]) next[f.key] = true;
    if (Object.keys(next).length > 0)
      setSubidas((prev) => ({ ...prev, ...next }));
  }, [user?.id, entradaId]);

  // ── Helper: GPS + geo con cache ───────────────────────────────────────────
  const getGeoPayload = async (
    userId: string,
    entradaId: string,
  ): Promise<GeoInfo> => {
    const cached = readGeoCache(userId, entradaId);
    if (cached) return cached;

    const empty: GeoInfo = {
      lat: null,
      lon: null,
      accuracy: null,
      hac_ste: null,
      suerte_nom: null,
      fuera_zona: false,
      at: new Date().toISOString(),
    };

    try {
      const pos = await getCurrentPosition();
      if (!pos?.latitude) {
        setGeoMsg("No se pudo obtener GPS.");
        writeGeoCache(userId, entradaId, empty);
        return empty;
      }

      const resolved = navigator.onLine
        ? await resolveGeoRPC(pos.latitude, pos.longitude)
        : null;

      const geo: GeoInfo = {
        lat: pos.latitude,
        lon: pos.longitude,
        accuracy: pos.accuracy ?? null,
        hac_ste: resolved?.hac_ste ?? null,
        suerte_nom: resolved?.nom ?? null,
        fuera_zona: !resolved,
        at: new Date().toISOString(),
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

  // ── Crear o recuperar revisión implemento FIN (con soporte offline) ───────
  useEffect(() => {
    if (!user?.id || !entradaId) return;

    const loadOrCreateRevision = async () => {
      setCreating(true);
      try {
        const localId = readLocalRevisionId(user.id, entradaId);

        if (navigator.onLine) {
          const { data: existing, error: selErr } = await supabase
            .from("revision_implemento")
            .select(
              "id, latitud, longitud, hac_ste, suerte_nom, precision_gps, fuera_zona, updated_at, created_at",
            )
            .eq("user_id", user.id)
            .eq("tipo", "fin")
            .eq("entrada_id", entradaId)
            .order("updated_at", { ascending: false })
            .order("created_at", { ascending: false })
            .limit(1);

          if (!selErr && existing?.[0]?.id) {
            const row = existing[0];
            setRevisionId(row.id);
            writeLocalRevisionId(user.id, entradaId, row.id);

            // Fotos DB + merge local
            const { data: fotosExistentes } = await supabase
              .from("revision_implemento_fotos")
              .select("foto_tipo")
              .eq("revision_id", row.id);

            if (fotosExistentes && fotosExistentes.length > 0) {
              const next: Record<FotoTipo, boolean> = {} as any;
              for (const ft of fotosExistentes) {
                if (FOTO_TIPOS.some((f) => f.key === ft.foto_tipo)) {
                  next[ft.foto_tipo as FotoTipo] = true;
                }
              }
              const localSubidas = readLocalSubidas(user.id, entradaId);
              const merged = { ...next, ...localSubidas };
              setSubidas(merged as Record<FotoTipo, boolean>);
              writeLocalSubidas(user.id, entradaId, merged);
            }

            // Actualizar geo si falta
            if (row.latitud == null || row.longitud == null) {
              const geo = await getGeoPayload(user.id, entradaId);
              if (geo.lat != null) {
                await supabase
                  .from("revision_implemento")
                  .update({
                    latitud: geo.lat,
                    longitud: geo.lon,
                    precision_gps: geo.accuracy,
                    fuera_zona: geo.fuera_zona,
                    hac_ste: geo.hac_ste,
                    suerte_nom: geo.suerte_nom,
                  })
                  .eq("id", row.id);
              }
            }
            return;
          }

          // No existe en DB -> crear
          const geo = await getGeoPayload(user.id, entradaId);
          const { data: created, error: insErr } = await supabase
            .from("revision_implemento")
            .insert({
              user_id: user.id,
              entrada_id: entradaId,
              tipo: "fin",
              timestamp: new Date().toISOString(),
              latitud: geo.lat,
              longitud: geo.lon,
              precision_gps: geo.accuracy,
              fuera_zona: geo.fuera_zona,
              hac_ste: geo.hac_ste,
              suerte_nom: geo.suerte_nom,
            } as any)
            .select("id")
            .single();

          if (!insErr && created) {
            setRevisionId(created.id);
            writeLocalRevisionId(user.id, entradaId, created.id);
          }
          return;
        }

        // ── SIN RED ───────────────────────────────────────────────────────
        if (localId) {
          setRevisionId(localId);
          return;
        }

        // Primera vez offline: generar ID local y guardar pendiente
        const newId = safeUUID();
        const geo = await getGeoPayload(user.id, entradaId);

        upsertPendingRevision({
          id: newId,
          userId: user.id,
          entradaId,
          timestamp: new Date().toISOString(),
          latitud: geo.lat,
          longitud: geo.lon,
          precision_gps: geo.accuracy,
          fuera_zona: geo.fuera_zona,
          hac_ste: geo.hac_ste,
          suerte_nom: geo.suerte_nom,
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

  // ── Capturar y subir foto (con soporte offline) ───────────────────────────
  const handleCapture = async (tipo: FotoTipo) => {
    if (!revisionId || !user?.id || !entradaId) return;

    try {
      setLoading(true);
      const blob = await capturePhoto();
      if (!blob) return;

      const today = getLocalDateISO();
      const filePath = `${user.id}/implemento/${today}/fin/${revisionId}/${tipo}.webp`;

      if (navigator.onLine) {
        const { error: uploadErr } = await supabase.storage
          .from("attendance-photos")
          .upload(filePath, blob, { upsert: true, contentType: "image/webp" });

        if (uploadErr) {
          console.error("[storage upload implemento fin]", uploadErr.message);
          await savePhotoOffline(
            blob,
            tipo,
            filePath,
            revisionId,
            user.id,
            entradaId,
          );
        } else {
          const { error: upsertErr } = await supabase
            .from("revision_implemento_fotos")
            .upsert(
              {
                revision_id: revisionId,
                user_id: user.id,
                foto_tipo: tipo,
                foto_path: filePath,
                foto_url: null,
              },
              { onConflict: "revision_id,foto_tipo" } as any,
            );
          if (upsertErr)
            console.error("[implemento fotos upsert fin]", upsertErr.message);
        }
      } else {
        await savePhotoOffline(
          blob,
          tipo,
          filePath,
          revisionId,
          user.id,
          entradaId,
        );
      }

      // Marcar localmente siempre
      const next = { ...subidas, [tipo]: true } as Record<FotoTipo, boolean>;
      setSubidas(next);
      writeLocalSubidas(user.id, entradaId, next);
    } finally {
      setLoading(false);
    }
  };

  const savePhotoOffline = async (
    blob: Blob,
    tipo: FotoTipo,
    filePath: string,
    revisionId: string,
    userId: string,
    entradaId: string,
  ) => {
    try {
      const b64 = await blobToBase64(blob);
      const all = readPendingPhotos();
      const next = [
        ...all.filter((p) => !(p.revisionId === revisionId && p.tipo === tipo)),
        {
          revisionId,
          userId,
          entradaId,
          tipo,
          filePath,
          blobBase64: b64,
          contentType: "image/webp",
          timestamp: new Date().toISOString(),
        },
      ];
      writePendingPhotos(next);
    } catch (e) {
      console.error("[savePhotoOffline implemento fin]", e);
    }
  };

  // ── Finalizar ─────────────────────────────────────────────────────────────
  const finalizar = () => {
    if (!puedeFinalizar) return;
    const dateISO = getLocalDateISO();
    localStorage.setItem(revisionCompleteKey(user?.id ?? "", dateISO), "1");
    navigate("/OperarioMaquinaria", { replace: true });
  };

  return (
    <div className="p-4 max-w-lg mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => navigate(-1)}
          disabled={loading}
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl font-semibold">
          Revisión implemento — fin turno
        </h1>
        {isOffline && (
          <span className="ml-auto flex items-center gap-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-2 py-1 rounded-full">
            <WifiOff className="h-3 w-3" /> Sin red
          </span>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        Captura las <strong>2 fotos obligatorias</strong> del implemento para
        cerrar el turno.
        {isOffline && (
          <span className="block mt-1 text-amber-600 font-medium">
            Modo offline: las fotos se sincronizarán cuando vuelva la conexión.
          </span>
        )}
      </p>

      {geoMsg && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          {geoMsg}
        </div>
      )}

      {creating && (
        <div className="text-sm text-muted-foreground text-center py-2">
          Preparando revisión…
        </div>
      )}

      <div className="space-y-3">
        {FOTO_TIPOS.map((f) => (
          <Button
            type="button"
            key={f.key}
            className="w-full justify-start"
            variant={subidas[f.key] ? "secondary" : "outline"}
            disabled={loading || !revisionId || creating}
            onClick={() => handleCapture(f.key)}
          >
            {subidas[f.key] ? (
              <CheckCircle className="h-4 w-4 mr-2 text-success" />
            ) : (
              <Camera className="h-4 w-4 mr-2" />
            )}
            {f.label}
            {subidas[f.key] && isOffline ? (
              <span className="ml-auto text-xs text-amber-500">
                pendiente sync
              </span>
            ) : null}
          </Button>
        ))}
      </div>

      <p className="text-xs text-muted-foreground text-center">
        Progreso: {completas} / {FOTO_TIPOS.length}
      </p>

      <Button
        type="button"
        className="w-full"
        disabled={!puedeFinalizar}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          finalizar();
        }}
      >
        {creating
          ? "Preparando revisión..."
          : "Finalizar revisión implemento fin"}
      </Button>
    </div>
  );
}
