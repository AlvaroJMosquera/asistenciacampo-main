// src/pages/OperarioMaquinariaFin.tsx
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Camera, CheckCircle, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useCamera } from "@/hooks/useCamera";

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

export default function OperarioMaquinariaFin() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const entradaId = params.get("entrada_id");

  const { user } = useAuth();
  const { capturePhoto } = useCamera();

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
   * ---------------------------------------------------------*/
  useEffect(() => {
    if (!user?.id || !entradaId) return;

    const loadOrCreateRevision = async () => {
      const { data, error } = await supabase
        .from("revision_maquinaria")
        .select("id")
        .eq("user_id", user.id)
        .eq("tipo", "fin")
        .eq("entrada_id", entradaId)
        .maybeSingle();

      if (error) {
        console.error("[revision_maquinaria select]", error.message);
        return;
      }

      if (data?.id) {
        setRevisionId(data.id);
        return;
      }

      const { data: created, error: createErr } = await supabase
        .from("revision_maquinaria")
        .insert({
          user_id: user.id,
          entrada_id: entradaId,
          tipo: "fin",
          equipo_codigo: "SIN_DEFINIR", // ✅ requerido si tu columna es NOT NULL
        })
        .select("id")
        .single();

      if (createErr) {
        console.error("[revision_maquinaria insert]", createErr.message);
        return;
      }

      setRevisionId(created.id);
    };

    loadOrCreateRevision();
  }, [user?.id, entradaId]);

  /* ---------------------------------------------------------
   * 2️⃣ Capturar y subir foto (SOLO UPLOAD + METADATA)
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

      // ✅ IMPORTANTE: aquí debe ser /fin/ (no /inicio/)
      // ✅ UID primero para que coincida con tu policy actual
      const filePath = `${user.id}/maquinaria/${today}/fin/${tipo}.webp`;

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

      // ✅ Guardar SOLO path (operario no necesita URL)
      const { error: upsertErr } = await supabase
        .from("revision_maquinaria_fotos")
        .upsert(
          {
            revision_id: revisionId,
            user_id: user.id,
            foto_tipo: tipo,
            foto_path: filePath,
          },
          { onConflict: "revision_id,foto_tipo" }
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
   * 3️⃣ Finalizar revisión FIN
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
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
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
            disabled={loading}
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
