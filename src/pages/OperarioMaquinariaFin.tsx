// src/pages/OperarioMaquinariaFin.tsx
import { useEffect, useMemo, useState, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Camera, CheckCircle, ArrowLeft, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useCamera } from "@/hooks/useCamera";
import { useGeolocation } from "@/hooks/useGeolocation";

type FotoTipo =
  | "frente"
  | "lado_derecho"
  | "lado_izquierdo"
  | "trasera"
  | "cabina";

const FOTO_TIPOS: { key: FotoTipo; label: string }[] = [
  { key: "frente", label: "Foto frontal" },
  { key: "lado_derecho", label: "Foto lado derecho" },
  { key: "lado_izquierdo", label: "Foto lado izquierdo" },
  { key: "trasera", label: "Foto trasera" },
  { key: "cabina", label: "Foto interior de cabina" },
];

// ------------------ Helpers ------------------
function toIsoDate(d = new Date()) {
  return d.toISOString().split("T")[0];
}

// ✅ cache local geo para que no repita GPS/RPC (y sirve offline)
type GeoInfo = {
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  hac_ste: string | null;
  suerte_nom: string | null;
  fuera_zona: boolean;
  at: string; // timestamp cuando se capturó
};

function geoCacheKey(userId: string, entradaId: string, tipo: "inicio" | "fin") {
  return `maq_geo_cache:${userId}:${entradaId}:${tipo}`;
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

async function resolveGeoRPC(lat: number, lon: number): Promise<{ hac_ste: string; suerte_nom: string } | null> {
  const { data, error } = await supabase.rpc("get_hacienda_by_point", { lat, lon });
  if (error || !data || data.length === 0) return null;
  return { suerte_nom: data[0].nom, hac_ste: data[0].hac_ste };
}

export default function OperarioMaquinariaFin() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const entradaId = params.get("entrada_id");

  const { user } = useAuth();
  const { capturePhoto } = useCamera();
  const { getCurrentPosition } = useGeolocation();

  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [subidas, setSubidas] = useState<Record<FotoTipo, boolean>>(
    {} as Record<FotoTipo, boolean>
  );
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const [geo, setGeo] = useState<GeoInfo | null>(null);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);

  const completas = useMemo(
    () => FOTO_TIPOS.filter((f) => subidas[f.key]).length,
    [subidas]
  );

  /**
   * 1) Crear o recuperar revisión FIN
   * - Evita maybeSingle() para no caer en "multiple rows returned"
   * - Guarda hora + ubicación + nombre (hac_ste / suerte_nom)
   */
  useEffect(() => {
    if (!user?.id || !entradaId) return;

    const loadOrCreateRevision = async () => {
      setCreating(true);
      try {
        // 1) buscar existente (toma la más reciente si hay duplicadas)
        const { data: existing, error: selErr } = await supabase
          .from("revision_maquinaria")
          .select("id, created_at, updated_at")
          .eq("user_id", user.id)
          .eq("tipo", "fin")
          .eq("entrada_id", entradaId)
          .order("updated_at", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(1);

        if (selErr) {
          console.error("[revision_maquinaria select]", selErr.message);
          return;
        }

        if (existing?.[0]?.id) {
          setRevisionId(existing[0].id);

          // si hay geo cache, lo mostramos
          const cached = readGeoCache(user.id, entradaId, "fin");
          if (cached) setGeo(cached);

          return;
        }

        // 2) Geo best-effort + cache
        let geoPayload: GeoInfo = {
          lat: null,
          lon: null,
          accuracy: null,
          hac_ste: null,
          suerte_nom: null,
          fuera_zona: false,
          at: new Date().toISOString(),
        };

        const cached = readGeoCache(user.id, entradaId, "fin");
        if (cached) {
          geoPayload = cached;
        } else {
          try {
            const pos = await getCurrentPosition();
            const hasCoords = pos?.latitude != null && pos?.longitude != null;

            if (hasCoords) {
              // ⚠️ Resolver nombre SOLO si hay internet (RPC)
              const resolved = navigator.onLine
                ? await resolveGeoRPC(pos.latitude, pos.longitude)
                : null;

              geoPayload = {
                lat: pos.latitude,
                lon: pos.longitude,
                accuracy: pos.accuracy ?? null,
                hac_ste: resolved?.hac_ste ?? null,
                suerte_nom: resolved?.suerte_nom ?? null,
                fuera_zona: resolved ? false : true,
                at: new Date().toISOString(),
              };

              if (!resolved) setGeoMsg("GPS OK, pero fuera de una suerte/hacienda (o sin internet para resolver nombre).");
              else setGeoMsg(null);
            } else {
              setGeoMsg("No se pudo obtener GPS (sin coordenadas).");
            }
          } catch {
            setGeoMsg("No se pudo obtener GPS. Revisa permisos de ubicación.");
          }

          writeGeoCache(user.id, entradaId, "fin", geoPayload);
        }

        setGeo(geoPayload);

        // 3) Crear revisión FIN con las columnas que SÍ existen en tu tabla:
        // timestamp, latitud, longitud, precision_gps, fuera_zona, hac_ste, suerte_nom
        const { data: created, error: insErr } = await supabase
          .from("revision_maquinaria")
          .insert({
            user_id: user.id,
            entrada_id: entradaId,
            tipo: "fin",
            equipo_codigo: "SIN_DEFINIR",
            // ✅ hora real del registro de inicio de revisión
            timestamp: new Date().toISOString(),
            // ✅ ubicación + nombre
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
          console.error("[revision_maquinaria insert]", insErr.message);
          return;
        }

        setRevisionId(created.id);
      } finally {
        setCreating(false);
      }
    };

    loadOrCreateRevision();
  }, [user?.id, entradaId, getCurrentPosition]);

  /**
   * 2) NO cargamos fotos desde DB (porque operario NO debe tener SELECT).
   * Si quieres "persistencia visual" al re-entrar, lo hacemos con localStorage.
   */
  useEffect(() => {
    if (!user?.id || !entradaId) return;

    const key = `maq_fotos_local:${user.id}:${entradaId}:fin`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      const next: Record<FotoTipo, boolean> = {} as any;

      for (const f of FOTO_TIPOS) {
        if (parsed?.[f.key]) next[f.key] = true;
      }
      setSubidas((prev) => ({ ...prev, ...next }));
    } catch {
      // ignore
    }
  }, [user?.id, entradaId]);

  const persistLocalSubidas = useCallback(
    (next: Record<FotoTipo, boolean>) => {
      if (!user?.id || !entradaId) return;
      const key = `maq_fotos_local:${user.id}:${entradaId}:fin`;
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {}
    },
    [user?.id, entradaId]
  );

  /**
   * 3) Capturar y subir foto (UPLOAD + METADATA)
   * - path: userId/.../fin/revisionId/tipo.webp
   * - upsert requiere UNIQUE(revision_id, foto_tipo)
   */
  const handleCapture = async (tipo: FotoTipo) => {
    if (!revisionId || !user?.id) return;

    try {
      setLoading(true);

      // ✅ debug rápido por si viene anon
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

      const today = toIsoDate();
      const filePath = `${user.id}/maquinaria/${today}/fin/${revisionId}/${tipo}.webp`;

      // 1) upload storage
      const { error: uploadErr } = await supabase.storage
        .from("attendance-photos")
        .upload(filePath, blob, {
          upsert: true,
          contentType: "image/webp",
        });

      if (uploadErr) {
        console.error("[storage upload]", uploadErr.message);
        return;
      }

      // 2) metadata DB (sin URL)
      const { error: upsertErr } = await supabase
        .from("revision_maquinaria_fotos")
        .upsert(
          {
            revision_id: revisionId,
            user_id: user.id,
            foto_tipo: tipo,
            foto_path: filePath,
            foto_url: null,
          },
          { onConflict: "revision_id,foto_tipo" } as any
        );

      if (upsertErr) {
        console.error("[revision_maquinaria_fotos upsert]", upsertErr.message);
        return;
      }

      const next = { ...subidas, [tipo]: true } as Record<FotoTipo, boolean>;
      setSubidas(next);
      persistLocalSubidas(next);
    } finally {
      setLoading(false);
    }
  };

  /**
   * 4) Finalizar revisión FIN (offline OK)
   */
  const finalizar = () => {
    if (completas !== FOTO_TIPOS.length) return;

    const today = toIsoDate();
    localStorage.setItem(`maq_revision_complete:${user?.id}:${today}:fin`, "1");
    navigate("/OperarioMaquinaria");
  };

  return (
    <div className="p-4 max-w-lg mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} disabled={loading}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl font-semibold">Revisión fin turno</h1>
      </div>

      <p className="text-sm text-muted-foreground">
        Captura las <strong>5 fotos obligatorias</strong> al entregar la maquinaria.
      </p>

      {/* Ubicación registrada al iniciar revisión FIN */}
      <div className="rounded-lg border p-3 text-sm">
        <div className="flex items-center gap-2 font-medium">
          <MapPin className="h-4 w-4" />
          Ubicación de la revisión
        </div>

        {creating ? (
          <p className="text-muted-foreground mt-1">Guardando ubicación…</p>
        ) : geo?.hac_ste || geo?.suerte_nom ? (
          <div className="mt-2 space-y-1">
            <div>
              <span className="text-muted-foreground">Suerte:</span>{" "}
              {geo?.suerte_nom ?? "—"}
            </div>
            <div>
              <span className="text-muted-foreground">Hacienda/Suerte:</span>{" "}
              {geo?.hac_ste ?? "—"}
            </div>
            {geo?.accuracy != null && (
              <div className="text-xs text-muted-foreground">
                Precisión GPS: ±{Math.round(geo.accuracy)} m
              </div>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground mt-1">{geoMsg ?? "Sin información de ubicación"}</p>
        )}
      </div>

      <div className="space-y-3">
        {FOTO_TIPOS.map((f) => (
          <Button
            key={f.key}
            className="w-full justify-start"
            variant={subidas[f.key] ? "secondary" : "outline"}
            disabled={loading || !revisionId}
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

      <Button className="w-full" disabled={completas !== FOTO_TIPOS.length} onClick={finalizar}>
        Finalizar revisión fin
      </Button>
    </div>
  );
}
