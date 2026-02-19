import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, LogOut, Users, Clock, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';

type OperarioRow = {
  user_id: string;
  nombre: string | null;
};

type AttendanceRow = {
  id: string;
  user_id: string;
  fecha: string;
  tipo_registro: 'entrada' | 'salida';
  llegada_estado: 'temprano_o_a_tiempo' | 'tarde' | null;
  salida_estado: 'a_tiempo' | 'se_fue_antes_30' | 'se_fue_antes_mas_30' | null;
};

// ✅ FIX: usa fecha local, no UTC
function todayISO() {
  return format(new Date(), 'yyyy-MM-dd');
}

export default function SupervisorCuadrilla() {
  const { signOut } = useAuth();

  const [dateISO, setDateISO] = useState(todayISO());
  const [loading, setLoading] = useState(false);
  const [operarios, setOperarios] = useState<OperarioRow[]>([]);
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const load = async () => {
    setLoading(true);
    setError(null);

    try {
      // ✅ FIX: verificar sesión antes de cualquier query
      const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
      if (sessionErr || !sessionData.session) {
        // Token inválido -> forzar sign out para limpiar estado corrupto
        await supabase.auth.signOut();
        await signOut();
        return;
      }

      // 1) IDs de operarios de cuadrilla
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

      // 2) Perfiles
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

      // 3) Registros del día
      const { data: att, error: aErr } = await supabase
        .from('registros_asistencia')
        .select('id,user_id,fecha,tipo_registro,llegada_estado,salida_estado')
        .eq('fecha', dateISO)
        .in('user_id', ids);

      if (aErr) throw new Error(aErr.message);

      setRows((att || []) as AttendanceRow[]);
      setLastRefresh(new Date());
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : 'Error cargando dashboard';
      // ✅ Si es error de token, limpiar sesión
      if (msg.toLowerCase().includes('refresh token') || msg.toLowerCase().includes('jwt')) {
        await supabase.auth.signOut();
        await signOut();
        return;
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [dateISO]);

  // ✅ Auto-refresh cada 60 segundos
  useEffect(() => {
    const interval = setInterval(() => { void load(); }, 60_000);
    return () => clearInterval(interval);
  }, [dateISO]);

  // Agrupar por usuario
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
    let aTiempo = 0, tarde = 0, noIngreso = 0;
    let salieronATiempo = 0, salieronAntes = 0, noSalida = 0;

    for (const p of operarios) {
      const st = byUser.get(p.user_id);
      if (!st?.entrada) { noIngreso++; }
      else if (st.entrada.llegada_estado === 'tarde') tarde++;
      else aTiempo++;

      if (!st?.salida) { noSalida++; }
      else if (st.salida.salida_estado === 'a_tiempo') salieronATiempo++;
      else salieronAntes++;
    }

    return { total, aTiempo, tarde, noIngreso, salieronATiempo, salieronAntes, noSalida };
  }, [operarios, byUser]);

  const prettyDate = useMemo(() => {
    try {
      return format(new Date(dateISO + 'T00:00:00'), "EEEE, d 'de' MMMM yyyy", { locale: es });
    } catch { return dateISO; }
  }, [dateISO]);

  // Estado de cada operario para la tabla
  const operariosConEstado = useMemo(() => {
    return operarios.map((op) => {
      const st = byUser.get(op.user_id);
      return { ...op, entrada: st?.entrada ?? null, salida: st?.salida ?? null };
    }).sort((a, b) => (a.nombre ?? '').localeCompare(b.nombre ?? ''));
  }, [operarios, byUser]);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 bg-card border-b px-4 py-3 shadow-sm">
        <div className="max-w-5xl mx-auto w-full flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-base font-semibold">Supervisor Cuadrilla</p>
            <p className="text-sm text-muted-foreground capitalize">{prettyDate}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button variant="ghost" size="sm" onClick={signOut}>
              <LogOut className="h-4 w-4 mr-1" /> Salir
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto w-full p-4 space-y-5">

        {/* Filtro fecha */}
        <div className="flex items-end gap-3">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Fecha</p>
            <Input
              type="date"
              value={dateISO}
              onChange={(e) => setDateISO(e.target.value)}
              className="w-[180px]"
            />
          </div>
          <p className="text-xs text-muted-foreground pb-2">
            Actualizado: {format(lastRefresh, 'HH:mm:ss')}
          </p>
          {error && <p className="text-sm text-destructive pb-2">{error}</p>}
        </div>

        {/* Cards métricas */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <Users className="h-3.5 w-3.5" /> Total operarios
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-bold">{metrics.total}</CardContent>
          </Card>

          <Card className="border-emerald-500/30 bg-emerald-500/5">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Llegaron a tiempo
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-bold text-emerald-700">{metrics.aTiempo}</CardContent>
          </Card>

          <Card className="border-destructive/30 bg-destructive/5">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <AlertTriangle className="h-3.5 w-3.5 text-destructive" /> Llegaron tarde
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-bold text-destructive">{metrics.tarde}</CardContent>
          </Card>

          <Card className="border-muted">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <XCircle className="h-3.5 w-3.5" /> Sin ingreso
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-bold">{metrics.noIngreso}</CardContent>
          </Card>

          <Card className="border-emerald-500/30 bg-emerald-500/5">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Salieron a tiempo
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-bold text-emerald-700">{metrics.salieronATiempo}</CardContent>
          </Card>

          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3.5 w-3.5 text-amber-600" /> Salieron antes
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-bold text-amber-700">{metrics.salieronAntes}</CardContent>
          </Card>

          <Card className="col-span-2 md:col-span-3 border-muted">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <XCircle className="h-3.5 w-3.5" /> Sin salida registrada
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-bold">{metrics.noSalida}</CardContent>
          </Card>
        </div>

        {/* Tabla de operarios */}
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Detalle por operario</h2>

          {loading && operariosConEstado.length === 0 ? (
            <p className="text-sm text-muted-foreground">Cargando...</p>
          ) : operariosConEstado.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay operarios de cuadrilla registrados.</p>
          ) : (
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 border-b">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Nombre</th>
                    <th className="text-center px-3 py-2 font-medium text-muted-foreground">Entrada</th>
                    <th className="text-center px-3 py-2 font-medium text-muted-foreground">Salida</th>
                  </tr>
                </thead>
                <tbody>
                  {operariosConEstado.map((op, i) => (
                    <tr key={op.user_id} className={i % 2 === 0 ? 'bg-background' : 'bg-muted/20'}>
                      <td className="px-3 py-2 font-medium truncate max-w-[160px]">
                        {op.nombre ?? <span className="text-muted-foreground italic">Sin nombre</span>}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {!op.entrada ? (
                          <Badge variant="outline" className="text-muted-foreground">Sin ingreso</Badge>
                        ) : op.entrada.llegada_estado === 'tarde' ? (
                          <Badge variant="destructive">Tarde</Badge>
                        ) : (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600">A tiempo</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {!op.salida ? (
                          <Badge variant="outline" className="text-muted-foreground">Sin salida</Badge>
                        ) : op.salida.salida_estado === 'a_tiempo' ? (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600">A tiempo</Badge>
                        ) : op.salida.salida_estado === 'se_fue_antes_30' ? (
                          <Badge className="bg-amber-500 hover:bg-amber-500">Antes ≤30 min</Badge>
                        ) : (
                          <Badge variant="destructive">Antes &gt;30 min</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}