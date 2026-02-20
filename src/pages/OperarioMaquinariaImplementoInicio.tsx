// src/pages/OperarioMaquinariaImplementoInicio.tsx
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { format } from "date-fns";
import { Camera, CheckCircle, ArrowLeft } from "lucide-react";
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

// ---------- Geo cache ----------
type GeoInfo = {
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  hac_ste: string | null;
  suerte_nom: string | null;
  fuera_zona: boolean;
  at: string;
};

function geoCacheKey(userId: string, entradaId: string, tipo: "inicio" | "fin") {
  return `implemento_geo_cache:${userId}:${entradaId}:${tipo}`;
}
function readGeoCache(userId: string, entradaId: string, tipo: "inicio" | "fin"): GeoInfo | null {
  try {
    const raw = localStorage.getItem(geoCacheKey(userId, entradaId, tipo));
    if (!raw) return null;
    return JSON.parse(raw) as GeoInfo;
  } catch {
    return null;
  }
}
function writeGeoCache(userId: string, entradaId: string, tipo: "inicio" | "fin", geo: GeoInfo) {
  try {
    localStorage.setItem(geoCacheKey(userId, entradaId, tipo), JSON.stringify(geo));
  } catch {}
}

async function resolveGeoRPC(lat: number, lon: number): Promise<{ nom: string; hac_ste: string } | null> {
  const { data, error } = await supabase.rpc("get_hacienda_by_point", { lat, lon });
  if (error || !data || data.length === 0) return null;
  return { nom: data[0].nom, hac_ste: data[0].hac_ste };
}

// ---------- Local state for photo completion ----------
function fotosLocalKey(userId: string, entradaId: string, tipo: "inicio" | "fin") {
  return `implemento_fotos_local:${userId}:${entradaId}:${tipo}`;
}
function readLocalSubidas(userId: string, entradaId: string, tipo: "inicio" | "fin") {
  try {
    const raw = localStorage.getItem(fotosLocalKey(userId, entradaId, tipo));
    if (!raw) return null;
    return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    return null;
  }
}
function writeLocalSubidas(
  userId: string,
  entradaId: string,
  tipo: "inicio" | "fin",
  subidas: Record<string, boolean>
) {
  try {
    localStorage.setItem(fotosLocalKey(userId, entradaId, tipo), JSON.stringify(subidas));
  } catch {}
}

// ---------- Local revision complete ----------
function revisionLocalKey(userId: string, dateISO: string, tipo: "inicio" | "fin") {
  return `implemento_revision_complete:${userId}:${dateISO}:${tipo}`;
}

export default function OperarioMaquinariaImplementoInicio() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const entradaId = params.get("entrada_id");

  const { user } = useAuth();
  const { capturePhoto } = useCamera();
  const { getCurrentPosition } = useGeolocation();

  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [subidas, setSubidas] = useState<Record<FotoTipo, boolean>>({} as Record<FotoTipo, boolean>);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);

  const completas = useMemo(() => FOTO_TIPOS.filter((f) => subidas[f.key]).length, [subidas]);

  const puedeFinalizar =
    completas === FOTO_TIPOS.length &&
    !!revisionId &&
    !loading &&
    !creating;

  // Carga estado local de subidas
  useEffect(() => {
    if (!user?.id || !entradaId) return;
    const local = readLocalSubidas(user.id, entradaId, "inicio");
    if (!local) return;
    const next: Record<FotoTipo, boolean> = {} as any;
    for (const f of FOTO_TIPOS) if (local[f.key]) next[f.key] = true;
    setSubidas((prev) => ({ ...prev, ...next }));
  }, [user?.id, entradaId]);

  // 1) Crear o recuperar revisión implemento INICIO
  useEffect(() => {
    if (!user?.id || !entradaId) return;

    const loadOrCreateRevision = async () => {
      setCreating(true);
      try {
        const { data: existing, error: selErr } = await supabase
          .from("revision_implemento")
          .select("id, created_at, updated_at, latitud, longitud, hac_ste, suerte_nom, precision_gps, fuera_zona")
          .eq("user_id", user.id)
          .eq("tipo", "inicio")
          .eq("entrada_id", entradaId)
          .order("updated_at", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(1);

        if (selErr) {
          console.error("[revision_implemento select]", selErr.message);
          return;
        }

        const getGeoPayload = async (): Promise<GeoInfo> => {
          const cached = readGeoCache(user.id!, entradaId, "inicio");
          if (cached) return cached;

          let geoPayload: GeoInfo = {
            lat: null, lon: null, accuracy: null,
            hac_ste: null, suerte_nom: null,
            fuera_zona: false, at: new Date().toISOString(),
          };

          try {
            const pos = await getCurrentPosition();
            const hasCoords = pos?.latitude != null && pos?.longitude != null;

            if (!hasCoords) {
              setGeoMsg("No se pudo obtener GPS (sin coordenadas).");
              writeGeoCache(user.id!, entradaId, "inicio", geoPayload);
              return geoPayload;
            }

            const resolved = navigator.onLine
              ? await resolveGeoRPC(pos.latitude, pos.longitude)
              : null;

            geoPayload = {
              lat: pos.latitude,
              lon: pos.longitude,
              accuracy: pos.accuracy ?? null,
              hac_ste: resolved?.hac_ste ?? null,
              suerte_nom: resolved?.nom ?? null,
              fuera_zona: resolved ? false : true,
              at: new Date().toISOString(),
            };

            if (!resolved) setGeoMsg("GPS OK, pero no se resolvió suerte/hacienda.");
            else setGeoMsg(null);

            writeGeoCache(user.id!, entradaId, "inicio", geoPayload);
            return geoPayload;
          } catch {
            setGeoMsg("No se pudo obtener GPS. Revisa permisos de ubicación.");
            writeGeoCache(user.id!, entradaId, "inicio", geoPayload);
            return geoPayload;
          }
        };

        // SI EXISTE
        if (existing?.[0]?.id) {
          const row = existing[0];
          setRevisionId(row.id);

          const faltaGeo =
            row.latitud == null || row.longitud == null ||
            row.hac_ste == null || row.suerte_nom == null;

          if (faltaGeo) {
            const geoPayload = await getGeoPayload();
            if (geoPayload.lat != null && geoPayload.lon != null) {
              const { error: updErr } = await supabase
                .from("revision_implemento")
                .update({
                  timestamp: new Date().toISOString(),
                  latitud: geoPayload.lat,
                  longitud: geoPayload.lon,
                  precision_gps: geoPayload.accuracy,
                  fuera_zona: geoPayload.fuera_zona,
                  hac_ste: geoPayload.hac_ste,
                  suerte_nom: geoPayload.suerte_nom,
                })
                .eq("id", row.id);
              if (updErr) console.error("[revision_implemento update geo]", updErr.message);
            }
          }

          // Cargar fotos ya subidas
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
            setSubidas((prev) => ({ ...prev, ...next }));
            if (user?.id) writeLocalSubidas(user.id, entradaId, "inicio", next);
          }

          return;
        }

        // NO EXISTE -> crear con geo
        const geoPayload = await getGeoPayload();

        const { data: created, error: insErr } = await supabase
          .from("revision_implemento")
          .insert({
            user_id: user.id,
            entrada_id: entradaId,
            tipo: "inicio",
            timestamp: new Date().toISOString(),
            latitud: geoPayload.lat,
            longitud: geoPayload.lon,
            precision_gps: geoPayload.accuracy,
            fuera_zona: geoPayload.fuera_zona,
            hac_ste: geoPayload.hac_ste,
            suerte_nom: geoPayload.suerte_nom,
          } as any)
          .select("id")
          .single();

        if (insErr) {
          console.error("[revision_implemento insert]", insErr.message);
          return;
        }
        setRevisionId(created.id);
      } finally {
        setCreating(false);
      }
    };

    loadOrCreateRevision();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, entradaId]);

  // 2) Capturar y subir foto
  const handleCapture = async (tipo: FotoTipo) => {
    if (!revisionId || !user?.id || !entradaId) return;
    try {
      setLoading(true);
      const { data: s } = await supabase.auth.getSession();
      if (!s.session) {
        console.error("No hay session -> request está yendo como anon");
        return;
      }
      const blob = await capturePhoto();
      if (!blob) {
        console.error("capturePhoto() no devolvió imagen");
        return;
      }

      const today = getLocalDateISO();
      const filePath = `${user.id}/implemento/${today}/inicio/${revisionId}/${tipo}.webp`;

      const { error: uploadErr } = await supabase.storage
        .from("attendance-photos")
        .upload(filePath, blob, { upsert: true, contentType: "image/webp" });
      if (uploadErr) {
        console.error("[storage upload implemento]", uploadErr.message);
        return;
      }

      const { error: upsertErr } = await supabase.from("revision_implemento_fotos").upsert(
        { revision_id: revisionId, user_id: user.id, foto_tipo: tipo, foto_path: filePath, foto_url: null },
        { onConflict: "revision_id,foto_tipo" } as any
      );
      if (upsertErr) {
        console.error("[revision_implemento_fotos upsert]", upsertErr.message);
        return;
      }

      const next = { ...subidas, [tipo]: true } as Record<FotoTipo, boolean>;
      setSubidas(next);
      writeLocalSubidas(user.id, entradaId, "inicio", next);
    } finally {
      setLoading(false);
    }
  };

  const finalizar = () => {
    if (!puedeFinalizar) return;
    const dateISO = getLocalDateISO();
    localStorage.setItem(revisionLocalKey(user?.id ?? "", dateISO, "inicio"), "1");
    navigate("/OperarioMaquinaria", { replace: true });
  };

  return (
    <div className="p-4 max-w-lg mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="icon" onClick={() => navigate(-1)} disabled={loading}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl font-semibold">Revisión implemento — inicio turno</h1>
      </div>

      <p className="text-sm text-muted-foreground">
        Captura las <strong>2 fotos obligatorias</strong> del implemento antes de continuar.
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
        {creating ? "Preparando revisión..." : "Finalizar revisión implemento inicio"}
      </Button>
    </div>
  );
}