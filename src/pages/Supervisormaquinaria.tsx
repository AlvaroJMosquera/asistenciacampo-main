import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  RefreshCw, LogOut, Users, CheckCircle2, AlertTriangle,
  XCircle, Wrench, ClipboardCheck, Camera,
} from 'lucide-react';

// ─── Tipos ───────────────────────────────────────────────────────────────────

type OperarioRow = {
  user_id: string;
  nombre: string | null;
};

type AttendanceRow = {
  id: string;
  user_id: string;
  tipo_registro: 'entrada' | 'salida';
  timestamp: string;
};

type RevisionRow = {
  id: string;
  user_id: string;
  tipo: 'inicio' | 'fin';
  created_at: string;
};

type FotoCount = {
  revision_id: string;
  count: number;
};

type EvidenciaRow = {
  user_id: string;
  entrada_id: string;
  evidencia_n: 1 | 2;
};

// ─── Constantes ──────────────────────────────────────────────────────────────

const REQUIRED_MAQ = 5;   // fotos revisión maquinaria
const REQUIRED_IMP = 2;   // fotos revisión implemento

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayISO() {
  return format(new Date(), 'yyyy-MM-dd');
}

function statusBadge(complete: boolean, label: string, partial?: string) {
  if (complete)
    return <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">{label} ✅</Badge>;
  return (
    <Badge variant="outline" className="text-muted-foreground text-xs">
      {partial ?? `Sin ${label}`}
    </Badge>
  );
}

// ─── Componente ──────────────────────────────────────────────────────────────

export default function SupervisorMaquinaria() {
  const { signOut } = useAuth();

  const [dateISO, setDateISO] = useState(todayISO());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  // Datos crudos
  const [operarios, setOperarios] = useState<OperarioRow[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRow[]>([]);
  const [maqRevisions, setMaqRevisions] = useState<RevisionRow[]>([]);
  const [maqFotoCounts, setMaqFotoCounts] = useState<FotoCount[]>([]);
  const [impRevisions, setImpRevisions] = useState<RevisionRow[]>([]);
  const [impFotoCounts, setImpFotoCounts] = useState<FotoCount[]>([]);
  const [evidencias, setEvidencias] = useState<EvidenciaRow[]>([]);

  // ── Carga principal ────────────────────────────────────────────────────────
  const load = async () => {
    setLoading(true);
    setError(null);

    try {
      // 0) Verificar sesión
      const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
      if (sessionErr || !sessionData.session) {
        await supabase.auth.signOut();
        await signOut();
        return;
      }

      // 1) IDs de operarios de maquinaria
      const { data: roles, error: rErr } = await supabase
        .from('user_roles')
        .select('user_id')
        .eq('role', 'operario_maquinaria');

      if (rErr) throw new Error(rErr.message);

      const ids = (roles || []).map((x: any) => x.user_id).filter(Boolean) as string[];

      if (ids.length === 0) {
        setOperarios([]);
        setAttendance([]);
        setMaqRevisions([]);
        setMaqFotoCounts([]);
        setImpRevisions([]);
        setImpFotoCounts([]);
        setEvidencias([]);
        return;
      }

      // 2) Perfiles
      const { data: profs, error: pErr } = await supabase
        .from('profiles')
        .select('id, nombre')
        .in('id', ids);

      if (pErr) throw new Error(pErr.message);

      const nameById = new Map<string, string | null>();
      for (const p of profs || []) nameById.set((p as any).id, (p as any).nombre ?? null);
      setOperarios(ids.map((id) => ({ user_id: id, nombre: nameById.get(id) ?? null })));

      const startOfDay = `${dateISO} 00:00:00`;
      const endOfDay   = `${dateISO} 23:59:59`;

      // 3) Asistencia del día
      const { data: att, error: aErr } = await supabase
        .from('registros_asistencia')
        .select('id, user_id, tipo_registro, timestamp')
        .eq('fecha', dateISO)
        .in('user_id', ids);

      if (aErr) throw new Error(aErr.message);
      setAttendance((att || []) as AttendanceRow[]);

      // 4) Revisiones maquinaria del día
      const { data: maqRev, error: maqRevErr } = await supabase
        .from('revision_maquinaria')
        .select('id, user_id, tipo, created_at')
        .in('user_id', ids)
        .gte('created_at', startOfDay)
        .lte('created_at', endOfDay);

      if (maqRevErr) throw new Error(maqRevErr.message);
      const maqRevList = (maqRev || []) as RevisionRow[];
      setMaqRevisions(maqRevList);

      // 5) Conteo de fotos maquinaria
      const maqRevIds = maqRevList.map((r) => r.id);
      let maqCounts: FotoCount[] = [];
      if (maqRevIds.length > 0) {
        const { data: maqFotos, error: mfErr } = await supabase
          .from('revision_maquinaria_fotos')
          .select('revision_id')
          .in('revision_id', maqRevIds);

        if (mfErr) throw new Error(mfErr.message);

        const countMap = new Map<string, number>();
        for (const f of maqFotos || []) {
          countMap.set(f.revision_id, (countMap.get(f.revision_id) ?? 0) + 1);
        }
        maqCounts = Array.from(countMap.entries()).map(([revision_id, count]) => ({ revision_id, count }));
      }
      setMaqFotoCounts(maqCounts);

      // 6) Revisiones implemento del día
      const { data: impRev, error: impRevErr } = await supabase
        .from('revision_implemento')
        .select('id, user_id, tipo, created_at')
        .in('user_id', ids)
        .gte('created_at', startOfDay)
        .lte('created_at', endOfDay);

      if (impRevErr) throw new Error(impRevErr.message);
      const impRevList = (impRev || []) as RevisionRow[];
      setImpRevisions(impRevList);

      // 7) Conteo de fotos implemento
      const impRevIds = impRevList.map((r) => r.id);
      let impCounts: FotoCount[] = [];
      if (impRevIds.length > 0) {
        const { data: impFotos, error: ifErr } = await supabase
          .from('revision_implemento_fotos')
          .select('revision_id')
          .in('revision_id', impRevIds);

        if (ifErr) throw new Error(ifErr.message);

        const countMap = new Map<string, number>();
        for (const f of impFotos || []) {
          countMap.set(f.revision_id, (countMap.get(f.revision_id) ?? 0) + 1);
        }
        impCounts = Array.from(countMap.entries()).map(([revision_id, count]) => ({ revision_id, count }));
      }
      setImpFotoCounts(impCounts);

      // 8) Evidencias (seguimiento_fotos) del día
      const entradaIds = (att || [])
        .filter((a: any) => a.tipo_registro === 'entrada')
        .map((a: any) => a.id);

      let evRows: EvidenciaRow[] = [];
      if (entradaIds.length > 0) {
        const { data: evData, error: evErr } = await supabase
          .from('seguimiento_fotos')
          .select('user_id, entrada_id, evidencia_n')
          .in('entrada_id', entradaIds);

        if (evErr) throw new Error(evErr.message);
        evRows = (evData || []) as EvidenciaRow[];
      }
      setEvidencias(evRows);

      setLastRefresh(new Date());
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : 'Error cargando datos';
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

  useEffect(() => {
    const interval = setInterval(() => { void load(); }, 60_000);
    return () => clearInterval(interval);
  }, [dateISO]);

  // ── Estado por operario ────────────────────────────────────────────────────
  const operariosConEstado = useMemo(() => {
    return operarios.map((op) => {
      // Asistencia
      const attRows = attendance.filter((a) => a.user_id === op.user_id);
      const entrada = attRows.find((a) => a.tipo_registro === 'entrada') ?? null;
      const salida  = attRows.find((a) => a.tipo_registro === 'salida')  ?? null;

      // Revisión maquinaria
      const maqRevUser = maqRevisions.filter((r) => r.user_id === op.user_id);
      const maqInicio  = maqRevUser.find((r) => r.tipo === 'inicio') ?? null;
      const maqFin     = maqRevUser.find((r) => r.tipo === 'fin')    ?? null;

      const maqInicioFotos = maqInicio
        ? (maqFotoCounts.find((f) => f.revision_id === maqInicio.id)?.count ?? 0) : 0;
      const maqFinFotos = maqFin
        ? (maqFotoCounts.find((f) => f.revision_id === maqFin.id)?.count ?? 0) : 0;

      const maqInicioOk = maqInicioFotos >= REQUIRED_MAQ;
      const maqFinOk    = maqFinFotos    >= REQUIRED_MAQ;

      // Revisión implemento
      const impRevUser = impRevisions.filter((r) => r.user_id === op.user_id);
      const impInicio  = impRevUser.find((r) => r.tipo === 'inicio') ?? null;
      const impFin     = impRevUser.find((r) => r.tipo === 'fin')    ?? null;

      const impInicioFotos = impInicio
        ? (impFotoCounts.find((f) => f.revision_id === impInicio.id)?.count ?? 0) : 0;
      const impFinFotos = impFin
        ? (impFotoCounts.find((f) => f.revision_id === impFin.id)?.count ?? 0) : 0;

      const impInicioOk = impInicioFotos >= REQUIRED_IMP;
      const impFinOk    = impFinFotos    >= REQUIRED_IMP;

      // Evidencias
      const evUser  = evidencias.filter((e) => e.user_id === op.user_id);
      const hasEv1  = evUser.some((e) => e.evidencia_n === 1);
      const hasEv2  = evUser.some((e) => e.evidencia_n === 2);

      // Flujo completo
      const flujoCompleto = !!entrada && maqInicioOk && impInicioOk && hasEv1 && hasEv2 && impFinOk && maqFinOk && !!salida;

      return {
        ...op,
        entrada, salida,
        maqInicioOk, maqInicioFotos,
        maqFinOk,    maqFinFotos,
        impInicioOk, impInicioFotos,
        impFinOk,    impFinFotos,
        hasEv1, hasEv2,
        flujoCompleto,
      };
    }).sort((a, b) => (a.nombre ?? '').localeCompare(b.nombre ?? ''));
  }, [operarios, attendance, maqRevisions, maqFotoCounts, impRevisions, impFotoCounts, evidencias]);

  // ── Métricas resumen ───────────────────────────────────────────────────────
  const metrics = useMemo(() => {
    const total          = operariosConEstado.length;
    const conEntrada     = operariosConEstado.filter((o) => !!o.entrada).length;
    const sinEntrada     = total - conEntrada;
    const maqInicioOk    = operariosConEstado.filter((o) => o.maqInicioOk).length;
    const impInicioOk    = operariosConEstado.filter((o) => o.impInicioOk).length;
    const ev1Ok          = operariosConEstado.filter((o) => o.hasEv1).length;
    const ev2Ok          = operariosConEstado.filter((o) => o.hasEv2).length;
    const impFinOk       = operariosConEstado.filter((o) => o.impFinOk).length;
    const maqFinOk       = operariosConEstado.filter((o) => o.maqFinOk).length;
    const conSalida      = operariosConEstado.filter((o) => !!o.salida).length;
    const flujoCompleto  = operariosConEstado.filter((o) => o.flujoCompleto).length;

    return { total, conEntrada, sinEntrada, maqInicioOk, impInicioOk, ev1Ok, ev2Ok, impFinOk, maqFinOk, conSalida, flujoCompleto };
  }, [operariosConEstado]);

  const prettyDate = useMemo(() => {
    try { return format(new Date(dateISO + 'T00:00:00'), "EEEE, d 'de' MMMM yyyy", { locale: es }); }
    catch { return dateISO; }
  }, [dateISO]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 bg-card border-b px-4 py-3 shadow-sm">
        <div className="max-w-6xl mx-auto w-full flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-base font-semibold">Supervisor Maquinaria</p>
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

      <main className="max-w-6xl mx-auto w-full p-4 space-y-5">

        {/* Filtro fecha */}
        <div className="flex items-end gap-3 flex-wrap">
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

        {/* ── Cards métricas ── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">

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
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Con entrada
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-bold text-emerald-700">{metrics.conEntrada}</CardContent>
          </Card>

          <Card className="border-destructive/30 bg-destructive/5">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <XCircle className="h-3.5 w-3.5 text-destructive" /> Sin ingreso
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-bold text-destructive">{metrics.sinEntrada}</CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <ClipboardCheck className="h-3.5 w-3.5" /> Rev. Maq. Inicio ✓
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-bold">{metrics.maqInicioOk}</CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <Wrench className="h-3.5 w-3.5" /> Rev. Imp. Inicio ✓
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-bold">{metrics.impInicioOk}</CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <Camera className="h-3.5 w-3.5" /> Evidencia 1 ✓
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-bold">{metrics.ev1Ok}</CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <Camera className="h-3.5 w-3.5" /> Evidencia 2 ✓
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-bold">{metrics.ev2Ok}</CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <Wrench className="h-3.5 w-3.5" /> Rev. Imp. Fin ✓
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-bold">{metrics.impFinOk}</CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <ClipboardCheck className="h-3.5 w-3.5" /> Rev. Maq. Fin ✓
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-bold">{metrics.maqFinOk}</CardContent>
          </Card>

          <Card className="border-emerald-500/30 bg-emerald-500/5">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Con salida
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-bold text-emerald-700">{metrics.conSalida}</CardContent>
          </Card>

          <Card className="col-span-2 border-emerald-500/30 bg-emerald-500/5">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Flujo completo
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-bold text-emerald-700">{metrics.flujoCompleto}</CardContent>
          </Card>

        </div>

        {/* ── Tabla detalle ── */}
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Detalle por operario</h2>

          {loading && operariosConEstado.length === 0 ? (
            <p className="text-sm text-muted-foreground">Cargando...</p>
          ) : operariosConEstado.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay operarios de maquinaria registrados.</p>
          ) : (
            <div className="rounded-lg border overflow-x-auto">
              <table className="w-full text-xs sm:text-sm min-w-[800px]">
                <thead className="bg-muted/50 border-b">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Nombre</th>
                    <th className="text-center px-2 py-2 font-medium text-muted-foreground">Entrada</th>
                    <th className="text-center px-2 py-2 font-medium text-muted-foreground">
                      <span className="flex items-center justify-center gap-1">
                        <ClipboardCheck className="h-3 w-3" /> Maq. Ini.
                      </span>
                    </th>
                    <th className="text-center px-2 py-2 font-medium text-muted-foreground">
                      <span className="flex items-center justify-center gap-1">
                        <Wrench className="h-3 w-3" /> Imp. Ini.
                      </span>
                    </th>
                    <th className="text-center px-2 py-2 font-medium text-muted-foreground">
                      <span className="flex items-center justify-center gap-1">
                        <Camera className="h-3 w-3" /> Ev. 1
                      </span>
                    </th>
                    <th className="text-center px-2 py-2 font-medium text-muted-foreground">
                      <span className="flex items-center justify-center gap-1">
                        <Camera className="h-3 w-3" /> Ev. 2
                      </span>
                    </th>
                    <th className="text-center px-2 py-2 font-medium text-muted-foreground">
                      <span className="flex items-center justify-center gap-1">
                        <Wrench className="h-3 w-3" /> Imp. Fin
                      </span>
                    </th>
                    <th className="text-center px-2 py-2 font-medium text-muted-foreground">
                      <span className="flex items-center justify-center gap-1">
                        <ClipboardCheck className="h-3 w-3" /> Maq. Fin
                      </span>
                    </th>
                    <th className="text-center px-2 py-2 font-medium text-muted-foreground">Salida</th>
                  </tr>
                </thead>
                <tbody>
                  {operariosConEstado.map((op, i) => (
                    <tr
                      key={op.user_id}
                      className={`${i % 2 === 0 ? 'bg-background' : 'bg-muted/20'} ${
                        op.flujoCompleto ? 'border-l-2 border-l-emerald-500' : ''
                      }`}
                    >
                      {/* Nombre */}
                      <td className="px-3 py-2 font-medium truncate max-w-[140px]">
                        {op.nombre ?? <span className="text-muted-foreground italic">Sin nombre</span>}
                        {op.flujoCompleto && (
                          <span className="ml-1 text-emerald-600 text-xs">✅</span>
                        )}
                      </td>

                      {/* Entrada */}
                      <td className="px-2 py-2 text-center">
                        {op.entrada ? (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">
                            {format(new Date(op.entrada.timestamp), 'HH:mm')}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground text-xs">—</Badge>
                        )}
                      </td>

                      {/* Revisión maquinaria inicio */}
                      <td className="px-2 py-2 text-center">
                        {op.maqInicioOk ? (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">
                            {REQUIRED_MAQ}/{REQUIRED_MAQ}
                          </Badge>
                        ) : op.maqInicioFotos > 0 ? (
                          <Badge className="bg-amber-500 hover:bg-amber-500 text-xs">
                            {op.maqInicioFotos}/{REQUIRED_MAQ}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground text-xs">—</Badge>
                        )}
                      </td>

                      {/* Revisión implemento inicio */}
                      <td className="px-2 py-2 text-center">
                        {op.impInicioOk ? (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">
                            {REQUIRED_IMP}/{REQUIRED_IMP}
                          </Badge>
                        ) : op.impInicioFotos > 0 ? (
                          <Badge className="bg-amber-500 hover:bg-amber-500 text-xs">
                            {op.impInicioFotos}/{REQUIRED_IMP}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground text-xs">—</Badge>
                        )}
                      </td>

                      {/* Evidencia 1 */}
                      <td className="px-2 py-2 text-center">
                        {op.hasEv1 ? (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">✓</Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground text-xs">—</Badge>
                        )}
                      </td>

                      {/* Evidencia 2 */}
                      <td className="px-2 py-2 text-center">
                        {op.hasEv2 ? (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">✓</Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground text-xs">—</Badge>
                        )}
                      </td>

                      {/* Revisión implemento fin */}
                      <td className="px-2 py-2 text-center">
                        {op.impFinOk ? (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">
                            {REQUIRED_IMP}/{REQUIRED_IMP}
                          </Badge>
                        ) : op.impFinFotos > 0 ? (
                          <Badge className="bg-amber-500 hover:bg-amber-500 text-xs">
                            {op.impFinFotos}/{REQUIRED_IMP}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground text-xs">—</Badge>
                        )}
                      </td>

                      {/* Revisión maquinaria fin */}
                      <td className="px-2 py-2 text-center">
                        {op.maqFinOk ? (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">
                            {REQUIRED_MAQ}/{REQUIRED_MAQ}
                          </Badge>
                        ) : op.maqFinFotos > 0 ? (
                          <Badge className="bg-amber-500 hover:bg-amber-500 text-xs">
                            {op.maqFinFotos}/{REQUIRED_MAQ}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground text-xs">—</Badge>
                        )}
                      </td>

                      {/* Salida */}
                      <td className="px-2 py-2 text-center">
                        {op.salida ? (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">
                            {format(new Date(op.salida.timestamp), 'HH:mm')}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground text-xs">—</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Leyenda */}
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground pt-1">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded bg-emerald-600" /> Completo
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded bg-amber-500" /> Parcial
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded border border-muted-foreground/30" /> Sin registrar
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-1 h-4 rounded bg-emerald-500" /> Fila con flujo completo
          </span>
        </div>
      </main>
    </div>
  );
}