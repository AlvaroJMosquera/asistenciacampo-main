import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

type OperarioRow = {
  user_id: string;
  nombre: string | null;
};

type AttendanceRow = {
  id: string;
  user_id: string;
  fecha: string; // "YYYY-MM-DD"
  tipo_registro: 'entrada' | 'salida';
  llegada_estado: 'temprano_o_a_tiempo' | 'tarde' | null;
  salida_estado: 'a_tiempo' | 'se_fue_antes_30' | 'se_fue_antes_mas_30' | null;
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function SupervisorCuadrilla() {
  const { signOut } = useAuth();

  const [dateISO, setDateISO] = useState(todayISO());
  const [loading, setLoading] = useState(false);
  const [operarios, setOperarios] = useState<OperarioRow[]>([]);
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        // 1) IDs de operarios de cuadrilla desde user_roles
        const { data: roles, error: rErr } = await supabase
          .from('user_roles')
          .select('user_id')
          .eq('role', 'operario_cuadrilla');

        if (rErr) throw new Error(rErr.message);

        const ids = (roles || []).map((x: any) => x.user_id).filter(Boolean) as string[];

        if (ids.length === 0) {
          setOperarios([]);
          setRows([]);
          return;
        }

        // 2) Perfiles (nombres) desde profiles
        const { data: profs, error: pErr } = await supabase
          .from('profiles')
          .select('id,nombre')
          .in('id', ids);

        if (pErr) throw new Error(pErr.message);

        const nameById = new Map<string, string | null>();
        for (const p of profs || []) {
          nameById.set((p as any).id, (p as any).nombre ?? null);
        }

        const ops: OperarioRow[] = ids.map((id) => ({
          user_id: id,
          nombre: nameById.get(id) ?? null,
        }));

        setOperarios(ops);

        // 3) Registros del día para esos usuarios
        const { data: att, error: aErr } = await supabase
          .from('registros_asistencia')
          .select('id,user_id,fecha,tipo_registro,llegada_estado,salida_estado')
          .eq('fecha', dateISO)
          .in('user_id', ids);

        if (aErr) throw new Error(aErr.message);

        setRows((att || []) as AttendanceRow[]);
      } catch (e: any) {
        setError(e?.message ? String(e.message) : 'Error cargando dashboard');
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [dateISO]);

  // Agrupar por usuario (entrada/salida)
  const byUser = useMemo(() => {
    const map = new Map<string, { entrada?: AttendanceRow; salida?: AttendanceRow }>();
    for (const r of rows) {
      const cur = map.get(r.user_id) || {};
      if (r.tipo_registro === 'entrada') cur.entrada = r;
      if (r.tipo_registro === 'salida') cur.salida = r;
      map.set(r.user_id, cur);
    }
    return map;
  }, [rows]);

  const metrics = useMemo(() => {
    const total = operarios.length;

    let aTiempo = 0;
    let tarde = 0;
    let noIngreso = 0;

    let salieronATiempo = 0;
    let salieronAntes = 0; // (según tu lógica: se_fue_antes_30 o se_fue_antes_mas_30)
    let noSalida = 0;

    for (const p of operarios) {
      const st = byUser.get(p.user_id);

      // ingreso
      if (!st?.entrada) {
        noIngreso++;
      } else {
        if (st.entrada.llegada_estado === 'tarde') tarde++;
        else aTiempo++;
      }

      // salida
      if (!st?.salida) {
        noSalida++;
      } else {
        if (st.salida.salida_estado === 'a_tiempo') salieronATiempo++;
        else salieronAntes++;
      }
    }

    return { total, aTiempo, tarde, noIngreso, salieronATiempo, salieronAntes, noSalida };
  }, [operarios, byUser]);

  const prettyDate = useMemo(() => {
    try {
      return format(new Date(dateISO + 'T00:00:00'), "EEEE, d 'de' MMMM", { locale: es });
    } catch {
      return dateISO;
    }
  }, [dateISO]);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 bg-card border-b px-4 py-3 shadow-sm">
        <div className="max-w-5xl mx-auto w-full flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-base font-semibold">Supervisor Cuadrilla</p>
            <p className="text-sm text-muted-foreground capitalize">{prettyDate}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={signOut}>
            Salir
          </Button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto w-full p-4 space-y-4">
        <div className="flex items-end gap-3">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Filtro fecha</p>
            <Input
              type="date"
              value={dateISO}
              onChange={(e) => setDateISO(e.target.value)}
              className="w-[200px]"
            />
          </div>

          {loading && <p className="text-sm text-muted-foreground">Cargando...</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">Operarios cuadrilla</CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold">{metrics.total}</CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">Llegaron a tiempo</CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold">{metrics.aTiempo}</CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">Llegaron tarde</CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold">{metrics.tarde}</CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">No reportan ingreso</CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold">{metrics.noIngreso}</CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">Salieron a tiempo</CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold">{metrics.salieronATiempo}</CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">Salieron antes</CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold">{metrics.salieronAntes}</CardContent>
          </Card>

          <Card className="md:col-span-3">
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">No reportan salida</CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold">{metrics.noSalida}</CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
