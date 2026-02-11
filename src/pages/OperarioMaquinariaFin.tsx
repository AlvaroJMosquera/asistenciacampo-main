// src/pages/OperarioMaquinariaFin.tsx
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Camera, CheckCircle, ArrowLeft } from "lucide-react";
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

// ✅ cache local geo para que no repita GPS/RPC
type GeoInfo = {
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  hac_ste: string | null;
  suerte_nom: string | null;
  fuera_zona: boolean;
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
async function resolveGeo(lat: number, lon: number): Promise<{ hac_ste: string; suerte_nom: string } | null> {
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

  const completas = useMemo(
    () => FOTO_TIPOS.filter((f) => subidas[f.key]).length,
    [subidas]
  );

  /* ---------------------------------------------------------
   * 1️⃣ Crear o recuperar revisión FIN
   * ✅ arregla el error "multiple rows returned" evitando maybeSingle()
   * ✅ guarda ubicación + nombre (hac_ste/suerte_nom) + hora (recorded_at)
   * ---------------------------------------------------------*/
  useEffect(() => {
    if (!user?.id || !entradaId) return;

    const loadOrCreateRevision = async () => {
      try {
        setLoading(true);

        // 1) Buscar existente (si hay duplicadas, toma la más reciente)
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

        if (existing && existing.length > 0 && existing[0]?.id) {
          setRevisionId(existing[0].id);
          return;
        }

        // 2) Geo best-effort
        let geoPayload: GeoInfo = {
          lat: null,
          lon: null,
          accuracy: null,
          hac_ste: null,
          suerte_nom: null,
          fuera_zona: false,
        };

        const cached = readGeoCache(user.id, entradaId, "fin");
        if (cached) {
          geoPayload = cached;
        } else {
          try {
            const pos = await getCurrentPosition();
            const hasCoords = pos?.latitude != null && pos?.longitude != null;

            if (hasCoords) {
              const resolved = navigator.onLine
                ? await resolveGeo(pos.latitude, pos.longitude)
                : null;

              geoPayload = {
                lat: pos.latitude,
                lon: pos.longitude,
                accuracy: pos.accuracy ?? null,
                hac_ste: resolved?.hac_ste ?? null,
                suerte_nom: resolved?.suerte_nom ?? null,
                fuera_zona: resolved ? false : true,
              };
            }
          } catch {
            // si GPS falla no rompe
          }

          writeGeoCache(user.id, entradaId, "fin", geoPayload);
        }

        // 3) Crear revisión FIN (con ubicación + hora)
        // ⚠️ Si aún NO has agregado estas columnas a revision_maquinaria,
        // comenta los campos geo* hasta hacer la migración.
        const { data: created, error: insErr } = await supabase
          .from("revision_maquinaria")
          .insert({
            user_id: user.id,
            entrada_id: entradaId,
            tipo: "fin",
            equipo_codigo: "SIN_DEFINIR",
            // ✅ hora
            recorded_at: new Date().toISOString(),
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
        setLoading(false);
      }
    };

    loadOrCreateRevision();
  }, [user?.id, entradaId, getCurrentPosition]);

  /* ---------------------------------------------------------
   * 2️⃣ Cargar estado de fotos ya subidas (si vuelve a entrar)
   * ---------------------------------------------------------*/
  useEffect(() => {
    if (!revisionId || !user?.id) return;

    const loadUploaded = async () => {
      const { data, error } = await supabase
        .from("revision_maquinaria_fotos")
        .select("foto_tipo")
        .eq("revision_id", revisionId);

      if (error) return;

      const next: Record<FotoTipo, boolean> = {} as any;
      for (const row of data || []) {
        const k = row.foto_tipo as FotoTipo;
        next[k] = true;
      }
      setSubidas((prev) => ({ ...prev, ...next }));
    };

    loadUploaded();
  }, [revisionId, user?.id]);

  /* ---------------------------------------------------------
   * 3️⃣ Capturar y subir foto (UPLOAD + METADATA)
   * ✅ path incluye revisionId para evitar colisiones
   * ---------------------------------------------------------*/
  const handleCapture = async (tipo: FotoTipo) => {
    if (!revisionId || !user?.id) return;

    try {
      setLoading(true);

      const blob = await capturePhoto();
      if (!blob) {
        console.error("capturePhoto() no devolvió imagen");
        return;
      }

      const today = new Date().toISOString().split("T")[0];

      // ✅ IMPORTANTE: /fin/ + revisionId
      const filePath = `${user.id}/maquinaria/${today}/fin/${revisionId}/${tipo}.webp`;

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

      const { error: upsertErr } = await supabase
        .from("revision_maquinaria_fotos")
        .upsert(
          {
            revision_id: revisionId,
            user_id: user.id,
            foto_tipo: tipo,
            foto_path: filePath,
            foto_url: null, // ✅ mantener null
          },
          // ⚠️ Requiere UNIQUE(revision_id, foto_tipo) en DB
          { onConflict: "revision_id,foto_tipo" } as any
        );

      if (upsertErr) {
        console.error("[revision_maquinaria_fotos upsert]", upsertErr.message);
        return;
      }

      setSubidas((prev) => ({ ...prev, [tipo]: true }));
    } finally {
      setLoading(false);
    }
  };

  /* ---------------------------------------------------------
   * 4️⃣ Finalizar revisión FIN (offline OK)
   * ---------------------------------------------------------*/
  const finalizar = () => {
    if (completas !== FOTO_TIPOS.length) return;

    const today = new Date().toISOString().split("T")[0];
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

      <Button
        className="w-full"
        disabled={completas !== FOTO_TIPOS.length}
        onClick={finalizar}
      >
        Finalizar revisión fin
      </Button>
    </div>
  );
}
