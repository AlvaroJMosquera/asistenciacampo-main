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

// ✅ cache local para no llamar georpc mil veces si el usuario toma varias fotos
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

export default function OperarioMaquinariaInicio() {
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
   * 1️⃣ Crear o recuperar revisión INICIO
   * ✅ Corrección del error:
   *   - "JSON object requested, multiple (or no) rows returned"
   *   - Evitamos maybeSingle() con riesgo de duplicados.
   *   - Tomamos la última por updated_at/created_at.
   * ✅ Además: guardamos ubicación + nombre (hac_ste/suerte_nom) y hora (recorded_at)
   * ---------------------------------------------------------*/
  useEffect(() => {
    if (!user?.id || !entradaId) return;

    const loadOrCreateRevision = async () => {
      try {
        setLoading(true);

        // 1) Buscar una existente (si hay duplicadas, tomamos la más reciente)
        const { data: existing, error: selErr } = await supabase
          .from("revision_maquinaria")
          .select("id, created_at, updated_at")
          .eq("user_id", user.id)
          .eq("tipo", "inicio")
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

        // 2) Preparar geo (best-effort)
        let geoPayload: GeoInfo = {
          lat: null,
          lon: null,
          accuracy: null,
          hac_ste: null,
          suerte_nom: null,
          fuera_zona: false,
        };

        const cached = readGeoCache(user.id, entradaId, "inicio");
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
            // no rompemos si el GPS falla
          }

          writeGeoCache(user.id, entradaId, "inicio", geoPayload);
        }

        // 3) Crear revisión con ubicación + nombre (si tu tabla ya tiene columnas)
        //    ⚠️ Si aún NO has agregado columnas a revision_maquinaria,
        //    comenta los campos geo* hasta que migres la tabla.
        const { data: created, error: insErr } = await supabase
          .from("revision_maquinaria")
          .insert({
            user_id: user.id,
            entrada_id: entradaId,
            tipo: "inicio",
            equipo_codigo: "SIN_DEFINIR",
            // ✅ hora del registro
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
   * 2️⃣ Cargar estado de fotos ya subidas (si el usuario vuelve a entrar)
   * ✅ si el operario NO tiene SELECT por RLS, esto fallará: en ese caso,
   *    el fallback sigue siendo el localStorage por "finalizar".
   * ---------------------------------------------------------*/
  useEffect(() => {
    if (!revisionId || !user?.id) return;

    const loadUploaded = async () => {
      // best-effort: si RLS no deja SELECT, no rompe
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
   * 3️⃣ Capturar y subir foto (SOLO UPLOAD)
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
      const filePath = `${user.id}/maquinaria/${today}/inicio/${revisionId}/${tipo}.webp`;

      // 🔐 SUBIR A STORAGE (bucket PRIVADO recomendado)
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

      // 🧾 GUARDAR SOLO METADATA (SIN URL)
      const { error: upsertErr } = await supabase
        .from("revision_maquinaria_fotos")
        .upsert(
          {
            revision_id: revisionId,
            user_id: user.id,
            foto_tipo: tipo,
            foto_path: filePath,
            foto_url: null, // ✅ mantener null para evitar leaks
          },
          // ⚠️ onConflict requiere UNIQUE/PK en DB. Si no lo tienes, esto FALLA.
          // Recomendado: unique (revision_id, foto_tipo)
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
   * 4️⃣ Finalizar revisión (offline OK)
   * ---------------------------------------------------------*/
  const finalizar = () => {
    if (completas !== FOTO_TIPOS.length) return;

    const today = new Date().toISOString().split("T")[0];
    localStorage.setItem(
      `maq_revision_complete:${user?.id}:${today}:inicio`,
      "1"
    );

    navigate("/OperarioMaquinaria");
  };

  return (
    <div className="p-4 max-w-lg mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} disabled={loading}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl font-semibold">Revisión inicio turno</h1>
      </div>

      <p className="text-sm text-muted-foreground">
        Debes capturar las <strong>5 fotos obligatorias</strong> de la maquinaria
        antes de continuar.
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
        Finalizar revisión inicio
      </Button>
    </div>
  );
}
