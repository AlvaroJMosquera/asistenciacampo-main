import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Camera, CheckCircle, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useCamera } from "@/hooks/useCamera";
import { useGeolocation } from "@/hooks/useGeolocation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type FotoTipo = "frente" | "lado_derecho" | "lado_izquierdo" | "trasera" | "cabina";

const FOTO_TIPOS: { key: FotoTipo; label: string }[] = [
  { key: "frente", label: "Foto frontal maquina" },
  { key: "lado_derecho", label: "Foto lado derecho maquina" },
  { key: "lado_izquierdo", label: "Foto lado izquierdo maquina" },
  { key: "trasera", label: "Foto trasera maquina" },
  { key: "cabina", label: "Foto interior de cabina" },
];

type GeoResult = { nom: string; hac_ste: string } | null;

function toIsoDate(d = new Date()) {
  return d.toISOString().split("T")[0];
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

async function resolveGeoRPC(lat: number, lon: number): Promise<GeoResult> {
  const { data, error } = await supabase.rpc("get_hacienda_by_point", { lat, lon });
  if (error || !data || data.length === 0) return null;
  return { nom: data[0].nom, hac_ste: data[0].hac_ste };
}

/**
 * ✅ Extrae coordenadas sin importar el shape del objeto que devuelva tu hook.
 * Soporta:
 * - { latitude, longitude, accuracy }
 * - { lat, lon, accuracy }
 * - { coords: { latitude, longitude, accuracy } }
 */
function pickCoords(pos: any): { lat: number | null; lon: number | null; accuracy: number | null } {
  const lat =
    pos?.lat ??
    pos?.latitude ??
    pos?.coords?.latitude ??
    null;

  const lon =
    pos?.lon ??
    pos?.lng ?? // por si viene como lng
    pos?.longitude ??
    pos?.coords?.longitude ??
    null;

  const accuracy =
    pos?.accuracy ??
    pos?.coords?.accuracy ??
    null;

  return {
    lat: typeof lat === "number" ? lat : null,
    lon: typeof lon === "number" ? lon : null,
    accuracy: typeof accuracy === "number" ? accuracy : null,
  };
}

// ---------- Local state for photo completion ----------
function fotosLocalKey(userId: string, entradaId: string, tipo: "inicio" | "fin") {
  return `maq_fotos_local:${userId}:${entradaId}:${tipo}`;
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
function writeLocalSubidas(userId: string, entradaId: string, tipo: "inicio" | "fin", subidas: Record<string, boolean>) {
  try {
    localStorage.setItem(fotosLocalKey(userId, entradaId, tipo), JSON.stringify(subidas));
  } catch {}
}

// ---------- Maestro maquinaria ----------
type MaestroEquipo = {
  cod_equipo: string;
  descripcion_equipo: string | null;
  marca?: string | null;
  modelo?: string | null;
  potencia_hp?: number | null;
  seguimiento?: string | null;
};

export default function OperarioMaquinariaInicio() {
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

  // Maestro maquinaria
  const [equipos, setEquipos] = useState<MaestroEquipo[]>([]);
  const [equiposLoading, setEquiposLoading] = useState(false);
  const [equipoCodigo, setEquipoCodigo] = useState<string>("");

  const equipoSeleccionado = useMemo(
    () => equipos.find((e) => e.cod_equipo === equipoCodigo) ?? null,
    [equipos, equipoCodigo]
  );

  // carga estado local de subidas
  useEffect(() => {
    if (!user?.id || !entradaId) return;
    const local = readLocalSubidas(user.id, entradaId, "inicio");
    if (!local) return;

    const next: Record<FotoTipo, boolean> = {} as any;
    for (const f of FOTO_TIPOS) if (local[f.key]) next[f.key] = true;
    setSubidas((prev) => ({ ...prev, ...next }));
  }, [user?.id, entradaId]);

  const completas = useMemo(() => FOTO_TIPOS.filter((f) => subidas[f.key]).length, [subidas]);

  // 0) Cargar maestro maquinaria (dropdown)
  useEffect(() => {
    const loadMaestro = async () => {
      setEquiposLoading(true);
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        if (!sessionData.session) {
          console.warn("Sin sesión aún; no consulto maestro_maquinaria");
          setEquipos([]);
          return;
        }

        const { data, error } = await supabase
          .from("maestro_maquinaria")
          .select("cod_equipo, descripcion_equipo, marca, modelo, potencia_hp, seguimiento")
          .eq("activo", true)
          .order("cod_equipo", { ascending: true });

        if (error) {
          console.error("[maestro_maquinaria select]", error.message);
          setEquipos([]);
          return;
        }

        setEquipos((data || []) as MaestroEquipo[]);
      } finally {
        setEquiposLoading(false);
      }
    };

    loadMaestro();
  }, []);

  // ✅ Captura geo (silencioso) + cache
  const captureAndResolveGeo = async (): Promise<GeoInfo> => {
    // default
    let geoPayload: GeoInfo = {
      lat: null,
      lon: null,
      accuracy: null,
      hac_ste: null,
      suerte_nom: null,
      fuera_zona: false,
      at: new Date().toISOString(),
    };

    if (!user?.id || !entradaId) return geoPayload;

    // si hay cache y tiene coords, úsalo (evita repetir GPS)
    const cached = readGeoCache(user.id, entradaId, "inicio");
    if (cached?.lat != null && cached?.lon != null) return cached;

    try {
      const pos = await getCurrentPosition();
      const coords = pickCoords(pos);

      // si no hay coords, cachea null
      if (coords.lat == null || coords.lon == null) {
        writeGeoCache(user.id, entradaId, "inicio", geoPayload);
        return geoPayload;
      }

      // resolver nombre SOLO si online
      const resolved = navigator.onLine ? await resolveGeoRPC(coords.lat, coords.lon) : null;

      geoPayload = {
        lat: coords.lat,
        lon: coords.lon,
        accuracy: coords.accuracy,
        hac_ste: resolved?.hac_ste ?? null,
        suerte_nom: resolved?.nom ?? null,
        fuera_zona: resolved ? false : true,
        at: new Date().toISOString(),
      };

      writeGeoCache(user.id, entradaId, "inicio", geoPayload);
      return geoPayload;
    } catch {
      // cachea nulls
      writeGeoCache(user.id, entradaId, "inicio", geoPayload);
      return geoPayload;
    }
  };

  /**
   * 1) Crear o recuperar revisión INICIO
   * - Si existe y no tiene geo, lo actualiza
   */
  useEffect(() => {
    if (!user?.id || !entradaId) return;

    const loadOrCreateRevision = async () => {
      setCreating(true);
      try {
        const { data: existing, error: selErr } = await supabase
          .from("revision_maquinaria")
          .select("id, equipo_codigo, latitud, longitud, hac_ste, suerte_nom")
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

        // ✅ si ya existe
        if (existing?.[0]?.id) {
          const row = existing[0];
          setRevisionId(row.id);

          if (row.equipo_codigo && row.equipo_codigo !== "SIN_DEFINIR") {
            setEquipoCodigo(row.equipo_codigo);
          }

          // ✅ si NO tiene coords/nombre, intenta capturar y actualizar
          const missingGeo =
            row.latitud == null ||
            row.longitud == null ||
            row.hac_ste == null ||
            row.suerte_nom == null;

          if (missingGeo) {
            const geo = await captureAndResolveGeo();
            // solo update si por lo menos hay coords
            if (geo.lat != null && geo.lon != null) {
              const { error: upErr } = await supabase
                .from("revision_maquinaria")
                .update({
                  latitud: geo.lat,
                  longitud: geo.lon,
                  precision_gps: geo.accuracy,
                  fuera_zona: geo.fuera_zona,
                  hac_ste: geo.hac_ste,
                  suerte_nom: geo.suerte_nom,
                  timestamp: new Date().toISOString(),
                })
                .eq("id", row.id);

              if (upErr) console.error("[revision_maquinaria update geo]", upErr.message);
            }
          }

          return;
        }

        // ✅ crear nueva: captura geo (silencioso)
        const geo = await captureAndResolveGeo();

        const { data: created, error: insErr } = await supabase
          .from("revision_maquinaria")
          .insert({
            user_id: user.id,
            entrada_id: entradaId,
            tipo: "inicio",
            equipo_codigo: "SIN_DEFINIR",
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, entradaId]);

  // actualizar equipo_codigo
  const onSelectEquipo = async (cod: string) => {
    setEquipoCodigo(cod);
    if (!revisionId) return;

    const { error } = await supabase
      .from("revision_maquinaria")
      .update({ equipo_codigo: cod })
      .eq("id", revisionId);

    if (error) console.error("[revision_maquinaria update equipo_codigo]", error.message);
  };

  // Capturar y subir foto
  const handleCapture = async (tipo: FotoTipo) => {
    if (!revisionId || !user?.id || !entradaId) return;

    try {
      setLoading(true);

      if (!equipoCodigo) {
        console.error("Debe seleccionar equipo antes de subir fotos");
        return;
      }

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
      const filePath = `${user.id}/maquinaria/${today}/inicio/${revisionId}/${tipo}.webp`;

      const { error: uploadErr } = await supabase.storage
        .from("attendance-photos")
        .upload(filePath, blob, { upsert: true, contentType: "image/webp" });

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
      writeLocalSubidas(user.id, entradaId, "inicio", next);
    } finally {
      setLoading(false);
    }
  };

  const finalizar = () => {
    if (completas !== FOTO_TIPOS.length) return;
    const today = toIsoDate();
    localStorage.setItem(`maq_revision_complete:${user?.id}:${today}:inicio`, "1");
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
        Debes capturar las <strong>5 fotos obligatorias</strong> de la maquinaria antes de continuar.
      </p>

      {/* Equipo (dropdown) */}
      <div className="rounded-lg border p-3 space-y-2">
        <div className="text-sm font-medium">Equipo</div>

        <Select value={equipoCodigo} onValueChange={onSelectEquipo} disabled={equiposLoading || !revisionId}>
          <SelectTrigger>
            <SelectValue placeholder={equiposLoading ? "Cargando equipos..." : "Selecciona el código de equipo"} />
          </SelectTrigger>
          <SelectContent>
            {equipos.map((e) => (
              <SelectItem key={e.cod_equipo} value={e.cod_equipo}>
                {e.cod_equipo}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="text-xs text-muted-foreground">
          {equipoSeleccionado ? (
            <div className="space-y-1">
              <div>
                <span className="font-medium text-foreground">Descripción: </span>
                {equipoSeleccionado.descripcion_equipo ?? "—"}
              </div>
              {(equipoSeleccionado.marca || equipoSeleccionado.modelo) && (
                <div>
                  {equipoSeleccionado.marca ?? "—"} {equipoSeleccionado.modelo ?? ""}
                </div>
              )}
            </div>
          ) : (
            "Selecciona un equipo para ver la descripción."
          )}
        </div>

        {creating ? <p className="text-xs text-muted-foreground">Preparando revisión…</p> : null}
      </div>

      {/* ✅ UBICACIÓN QUITADA DEL FRONT (NO SE MUESTRA) */}

      <div className="space-y-3">
        {FOTO_TIPOS.map((f) => (
          <Button
            key={f.key}
            className="w-full justify-start"
            variant={subidas[f.key] ? "secondary" : "outline"}
            disabled={loading || !revisionId || !equipoCodigo}
            onClick={() => handleCapture(f.key)}
          >
            {subidas[f.key] ? (
              <CheckCircle className="h-4 w-4 mr-2 text-success" />
            ) : (
              <Camera className="h-4 w-4 mr-2" />
            )}
            {f.label}
            {!equipoCodigo ? <span className="ml-auto text-xs text-muted-foreground">(elige equipo)</span> : null}
          </Button>
        ))}
      </div>

      <p className="text-xs text-muted-foreground text-center">
        Progreso: {completas} / {FOTO_TIPOS.length}
      </p>

      <Button className="w-full" disabled={completas !== FOTO_TIPOS.length} onClick={finalizar}>
        Finalizar revisión inicio
      </Button>
    </div>
  );
}
