// src/pages/OperarioMaquinariaFin.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Camera, CheckCircle, ArrowLeft, ChevronsUpDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useCamera } from "@/hooks/useCamera";
import { useGeolocation } from "@/hooks/useGeolocation";

// ✅ Combobox buscable (shadcn)
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from "@/components/ui/command";

type FotoTipo = "frente" | "lado_derecho" | "lado_izquierdo" | "trasera" | "cabina";

const FOTO_TIPOS: { key: FotoTipo; label: string }[] = [
  { key: "frente", label: "Foto frontal maquina" },
  { key: "lado_derecho", label: "Foto lado derecho maquina" },
  { key: "lado_izquierdo", label: "Foto lado izquierdo maquina" },
  { key: "trasera", label: "Foto trasera maquina" },
  { key: "cabina", label: "Foto interior de cabina" },
];

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

async function resolveGeoRPC(lat: number, lon: number): Promise<{ nom: string; hac_ste: string } | null> {
  const { data, error } = await supabase.rpc("get_hacienda_by_point", { lat, lon });
  if (error || !data || data.length === 0) return null;
  return { nom: data[0].nom, hac_ste: data[0].hac_ste };
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

// ---------- Maestro maquinaria ----------
type MaestroEquipo = {
  cod_equipo: string;
  descripcion_equipo: string | null;
  marca?: string | null;
  modelo?: string | null;
  potencia_hp?: number | null;
  seguimiento?: string | null;
};

export default function OperarioMaquinariaFin() {
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

  // ✅ no mostrar ubicación al usuario, pero sí guardarla
  const [geoMsg, setGeoMsg] = useState<string | null>(null);

  // Maestro maquinaria
  const [equipos, setEquipos] = useState<MaestroEquipo[]>([]);
  const [equiposLoading, setEquiposLoading] = useState(false);
  const [equipoCodigo, setEquipoCodigo] = useState<string>("");

  // ✅ combobox state
  const [openEquipo, setOpenEquipo] = useState(false);

  const equipoSeleccionado = useMemo(
    () => equipos.find((e) => e.cod_equipo === equipoCodigo) ?? null,
    [equipos, equipoCodigo]
  );

  const completas = useMemo(() => FOTO_TIPOS.filter((f) => subidas[f.key]).length, [subidas]);

  // 0) Cargar maestro maquinaria
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

  // 0.1) Cargar estado local de subidas
  useEffect(() => {
    if (!user?.id || !entradaId) return;
    const local = readLocalSubidas(user.id, entradaId, "fin");
    if (!local) return;

    const next: Record<FotoTipo, boolean> = {} as any;
    for (const f of FOTO_TIPOS) if (local[f.key]) next[f.key] = true;
    setSubidas((prev) => ({ ...prev, ...next }));
  }, [user?.id, entradaId]);

  const persistLocalSubidas = useCallback(
    (next: Record<FotoTipo, boolean>) => {
      if (!user?.id || !entradaId) return;
      writeLocalSubidas(user.id, entradaId, "fin", next);
    },
    [user?.id, entradaId]
  );

  /**
   * 1) Crear o recuperar revisión FIN
   * - Si existe y le faltan datos de geo -> intenta completar y hace UPDATE
   * - Si crea -> inserta geo completo
   */
  useEffect(() => {
    if (!user?.id || !entradaId) return;

    const loadOrCreateRevision = async () => {
      setCreating(true);
      try {
        const { data: existing, error: selErr } = await supabase
          .from("revision_maquinaria")
          .select("id, equipo_codigo, latitud, longitud, hac_ste, suerte_nom, precision_gps, fuera_zona")
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

        const getGeoPayload = async (): Promise<GeoInfo> => {
          const cached = readGeoCache(user.id, entradaId, "fin");
          if (cached) return cached;

          let geoPayload: GeoInfo = {
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
            const hasCoords = pos?.latitude != null && pos?.longitude != null;

            if (!hasCoords) {
              setGeoMsg("No se pudo obtener GPS (sin coordenadas).");
              writeGeoCache(user.id, entradaId, "fin", geoPayload);
              return geoPayload;
            }

            const resolved = navigator.onLine ? await resolveGeoRPC(pos.latitude, pos.longitude) : null;

            geoPayload = {
              lat: pos.latitude,
              lon: pos.longitude,
              accuracy: pos.accuracy ?? null,
              hac_ste: resolved?.hac_ste ?? null,
              suerte_nom: resolved?.nom ?? null,
              fuera_zona: resolved ? false : true,
              at: new Date().toISOString(),
            };

            if (!resolved) setGeoMsg("GPS OK, pero no se resolvió suerte/hacienda (fuera de zona o sin internet).");
            else setGeoMsg(null);

            writeGeoCache(user.id, entradaId, "fin", geoPayload);
            return geoPayload;
          } catch {
            setGeoMsg("No se pudo obtener GPS. Revisa permisos de ubicación.");
            writeGeoCache(user.id, entradaId, "fin", geoPayload);
            return geoPayload;
          }
        };

        // SI EXISTE
        if (existing?.[0]?.id) {
          const row = existing[0];
          setRevisionId(row.id);

          if (row.equipo_codigo && row.equipo_codigo !== "SIN_DEFINIR") {
            setEquipoCodigo(row.equipo_codigo);
          }

          const faltaGeo =
            row.latitud == null ||
            row.longitud == null ||
            row.hac_ste == null ||
            row.suerte_nom == null;

          if (faltaGeo) {
            const geoPayload = await getGeoPayload();

            if (geoPayload.lat != null && geoPayload.lon != null) {
              const { error: updErr } = await supabase
                .from("revision_maquinaria")
                .update({
                  timestamp: new Date().toISOString(), // opcional
                  latitud: geoPayload.lat,
                  longitud: geoPayload.lon,
                  precision_gps: geoPayload.accuracy,
                  fuera_zona: geoPayload.fuera_zona,
                  hac_ste: geoPayload.hac_ste,
                  suerte_nom: geoPayload.suerte_nom,
                })
                .eq("id", row.id);

              if (updErr) console.error("[revision_maquinaria update geo]", updErr.message);
            }
          }

          return;
        }

        // NO EXISTE -> crear con geo
        const geoPayload = await getGeoPayload();

        const { data: created, error: insErr } = await supabase
          .from("revision_maquinaria")
          .insert({
            user_id: user.id,
            entrada_id: entradaId,
            tipo: "fin",
            equipo_codigo: "SIN_DEFINIR",
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

  // ✅ Seleccionar equipo => update equipo_codigo
  const onSelectEquipo = async (cod: string) => {
    setEquipoCodigo(cod);
    if (!revisionId) return;

    const { error } = await supabase.from("revision_maquinaria").update({ equipo_codigo: cod }).eq("id", revisionId);
    if (error) console.error("[revision_maquinaria update equipo_codigo]", error.message);
  };

  /**
   * 2) Capturar y subir foto
   */
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
      const filePath = `${user.id}/maquinaria/${today}/fin/${revisionId}/${tipo}.webp`;

      const { error: uploadErr } = await supabase.storage.from("attendance-photos").upload(filePath, blob, {
        upsert: true,
        contentType: "image/webp",
      });
      if (uploadErr) {
        console.error("[storage upload]", uploadErr.message);
        return;
      }

      const { error: upsertErr } = await supabase.from("revision_maquinaria_fotos").upsert(
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
   * 3) Finalizar revisión
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
        <h1 className="text-xl font-semibold">Revisión final Maquinaria</h1>
      </div>

      <p className="text-sm text-muted-foreground">
        Captura las <strong>5 fotos obligatorias</strong> al entregar la maquinaria.
      </p>

      {/* ✅ Equipo (combobox buscable) */}
      <div className="rounded-lg border p-3 space-y-2">
        <div className="text-sm font-medium">Equipo</div>

        <Popover open={openEquipo} onOpenChange={setOpenEquipo}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={openEquipo}
              className="w-full justify-between"
              disabled={equiposLoading || !revisionId}
            >
              {equipoCodigo
                ? (() => {
                    const e = equipos.find((x) => x.cod_equipo === equipoCodigo);
                    return e ? `${e.cod_equipo} — ${e.descripcion_equipo ?? "—"}` : equipoCodigo;
                  })()
                : equiposLoading
                  ? "Cargando equipos..."
                  : "Selecciona el equipo..."}
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>

          <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
            <Command
              filter={(value, search) => {
                const v = value.toLowerCase();
                const s = search.toLowerCase();
                return v.includes(s) ? 1 : 0;
              }}
            >
              <CommandInput placeholder="Buscar por código o descripción..." />
              <CommandEmpty>No se encontraron equipos.</CommandEmpty>

              <CommandGroup className="max-h-64 overflow-auto">
                {equipos.map((e) => {
                  const itemValue = `${e.cod_equipo} ${e.descripcion_equipo ?? ""}`;
                  return (
                    <CommandItem
                      key={e.cod_equipo}
                      value={itemValue}
                      onSelect={async () => {
                        await onSelectEquipo(e.cod_equipo);
                        setOpenEquipo(false);
                      }}
                    >
                      <Check
                        className={cn("mr-2 h-4 w-4", equipoCodigo === e.cod_equipo ? "opacity-100" : "opacity-0")}
                      />
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
      </div>

      {/* ✅ NO mostramos la ubicación al usuario (pero sí se guarda). 
          Si quieres debug temporal, descomenta:
          {geoMsg ? <p className="text-xs text-muted-foreground">{geoMsg}</p> : null}
      */}
      {false && geoMsg ? <p className="text-xs text-muted-foreground">{geoMsg}</p> : null}

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
        Finalizar revisión fin
      </Button>
    </div>
  );
}
