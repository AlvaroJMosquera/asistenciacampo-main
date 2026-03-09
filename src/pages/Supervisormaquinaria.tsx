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
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  RefreshCw, LogOut, Users, CheckCircle2,
  XCircle, Wrench, ClipboardCheck, Camera, Loader2, Eye,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader,
  DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';

// ─── Tipos ───────────────────────────────────────────────────────────────────

type OperarioRow = {
  user_id: string;
  nombre: string | null;
  zona: string | null;
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
  foto_url: string | null;
  timestamp: string;
};

// ─── Tipos modal ─────────────────────────────────────────────────────────────

type FotoTipoMaq = 'frente' | 'lado_derecho' | 'lado_izquierdo' | 'trasera' | 'cabina';
type FotoTipoImp = 'implemento_frente' | 'implemento_lateral';
type FotoModalItem = { label: string; url: string };
type ModalState = { open: boolean; title: string; loading: boolean; error: string | null; fotos: FotoModalItem[] };

const MODAL_INICIAL: ModalState = { open: false, title: '', loading: false, error: null, fotos: [] };

// ─── Constantes ──────────────────────────────────────────────────────────────

const REQUIRED_MAQ = 5;
const REQUIRED_IMP = 2;
const ORDER_MAQ: FotoTipoMaq[] = ['frente', 'lado_derecho', 'lado_izquierdo', 'trasera', 'cabina'];
const ORDER_IMP: FotoTipoImp[] = ['implemento_frente', 'implemento_lateral'];
const LABEL_MAQ: Record<FotoTipoMaq, string> = {
  frente: 'Frontal', lado_derecho: 'Lado derecho',
  lado_izquierdo: 'Lado izquierdo', trasera: 'Trasera', cabina: 'Interior cabina',
};
const LABEL_IMP: Record<FotoTipoImp, string> = {
  implemento_frente: 'Implemento frontal', implemento_lateral: 'Implemento lateral',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayISO() { return format(new Date(), 'yyyy-MM-dd'); }

async function signPath(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from('attendance-photos').createSignedUrl(path, 60 * 30);
  if (error) throw error;
  return data.signedUrl;
}

// ─── Componente ──────────────────────────────────────────────────────────────

export default function SupervisorMaquinaria() {
  const { signOut } = useAuth();

  const [dateISO, setDateISO] = useState(todayISO());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  // ✅ Filtros
  const [zonaFilter, setZonaFilter] = useState<string>('all');
  const [nombreFilter, setNombreFilter] = useState<string>('');

  // Datos crudos
  const [operarios, setOperarios] = useState<OperarioRow[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRow[]>([]);
  const [maqRevisions, setMaqRevisions] = useState<RevisionRow[]>([]);
  const [maqFotoCounts, setMaqFotoCounts] = useState<FotoCount[]>([]);
  const [impRevisions, setImpRevisions] = useState<RevisionRow[]>([]);
  const [impFotoCounts, setImpFotoCounts] = useState<FotoCount[]>([]);
  const [evidencias, setEvidencias] = useState<EvidenciaRow[]>([]);

  // Modal
  const [modal, setModal] = useState<ModalState>(MODAL_INICIAL);

  // ✅ Zonas únicas extraídas de los operarios cargados
  const zonas = useMemo(() => {
    const set = new Set<string>();
    for (const op of operarios) if (op.zona) set.add(op.zona);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [operarios]);

  // ── Modales ───────────────────────────────────────────────────────────────

  const openMaqPhotos = async (revisionId: string, label: string) => {
    setModal({ open: true, title: label, loading: true, error: null, fotos: [] });
    try {
      const { data, error: dbErr } = await supabase
        .from('revision_maquinaria_fotos').select('foto_tipo, foto_path').eq('revision_id', revisionId);
      if (dbErr) throw dbErr;
      const rows = (data || []) as { foto_tipo: FotoTipoMaq; foto_path: string }[];
      rows.sort((a, b) => ORDER_MAQ.indexOf(a.foto_tipo) - ORDER_MAQ.indexOf(b.foto_tipo));
      const fotos: FotoModalItem[] = [];
      for (const r of rows) fotos.push({ label: LABEL_MAQ[r.foto_tipo] ?? r.foto_tipo, url: await signPath(r.foto_path) });
      setModal((p) => ({ ...p, loading: false, fotos }));
    } catch (e: any) {
      setModal((p) => ({ ...p, loading: false, error: e?.message ?? 'Error cargando fotos' }));
    }
  };

  const openImpPhotos = async (revisionId: string, label: string) => {
    setModal({ open: true, title: label, loading: true, error: null, fotos: [] });
    try {
      const { data, error: dbErr } = await supabase
        .from('revision_implemento_fotos').select('foto_tipo, foto_path').eq('revision_id', revisionId);
      if (dbErr) throw dbErr;
      const rows = (data || []) as { foto_tipo: FotoTipoImp; foto_path: string }[];
      rows.sort((a, b) => ORDER_IMP.indexOf(a.foto_tipo) - ORDER_IMP.indexOf(b.foto_tipo));
      const fotos: FotoModalItem[] = [];
      for (const r of rows) fotos.push({ label: LABEL_IMP[r.foto_tipo] ?? r.foto_tipo, url: await signPath(r.foto_path) });
      setModal((p) => ({ ...p, loading: false, fotos }));
    } catch (e: any) {
      setModal((p) => ({ ...p, loading: false, error: e?.message ?? 'Error cargando fotos' }));
    }
  };

  const openEvidenciaPhotos = async (userId: string, entradaId: string, nombre: string | null) => {
    setModal({ open: true, title: `Evidencias — ${nombre ?? 'Operario'}`, loading: true, error: null, fotos: [] });
    try {
      const { data, error: dbErr } = await supabase
        .from('seguimiento_fotos').select('evidencia_n, foto_url, timestamp')
        .eq('entrada_id', entradaId).eq('user_id', userId).order('evidencia_n', { ascending: true });
      if (dbErr) throw dbErr;
      const rows = (data || []) as { evidencia_n: 1 | 2; foto_url: string | null; timestamp: string }[];
      const fotos: FotoModalItem[] = rows
        .filter((r) => !!r.foto_url)
        .map((r) => ({ label: `Evidencia ${r.evidencia_n} — ${format(new Date(r.timestamp), 'HH:mm')}`, url: r.foto_url! }));
      setModal((p) => ({ ...p, loading: false, fotos }));
    } catch (e: any) {
      setModal((p) => ({ ...p, loading: false, error: e?.message ?? 'Error cargando evidencias' }));
    }
  };

  // ── Carga principal ───────────────────────────────────────────────────────

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
      if (sessionErr || !sessionData.session) { await supabase.auth.signOut(); await signOut(); return; }

      const { data: roles, error: rErr } = await supabase
        .from('user_roles').select('user_id').eq('role', 'operario_maquinaria');
      if (rErr) throw new Error(rErr.message);

      const ids = (roles || []).map((x: any) => x.user_id).filter(Boolean) as string[];

      if (ids.length === 0) {
        setOperarios([]); setAttendance([]); setMaqRevisions([]);
        setMaqFotoCounts([]); setImpRevisions([]); setImpFotoCounts([]); setEvidencias([]);
        return;
      }

      // ✅ Incluye zona en la query de perfiles
      const { data: profs, error: pErr } = await supabase
        .from('profiles').select('id, nombre, zona').in('id', ids);
      if (pErr) throw new Error(pErr.message);

      const profileById = new Map<string, { nombre: string | null; zona: string | null }>();
      for (const p of profs || []) profileById.set((p as any).id, { nombre: (p as any).nombre ?? null, zona: (p as any).zona ?? null });

      setOperarios(ids.map((id) => ({
        user_id: id,
        nombre: profileById.get(id)?.nombre ?? null,
        zona: profileById.get(id)?.zona ?? null,
      })));

      const startOfDay = `${dateISO} 00:00:00`;
      const endOfDay   = `${dateISO} 23:59:59`;

      const { data: att, error: aErr } = await supabase
        .from('registros_asistencia').select('id, user_id, tipo_registro, timestamp')
        .eq('fecha', dateISO).in('user_id', ids);
      if (aErr) throw new Error(aErr.message);
      setAttendance((att || []) as AttendanceRow[]);

      const { data: maqRev, error: maqRevErr } = await supabase
        .from('revision_maquinaria').select('id, user_id, tipo, created_at')
        .in('user_id', ids).gte('created_at', startOfDay).lte('created_at', endOfDay);
      if (maqRevErr) throw new Error(maqRevErr.message);
      const maqRevList = (maqRev || []) as RevisionRow[];
      setMaqRevisions(maqRevList);

      const maqRevIds = maqRevList.map((r) => r.id);
      let maqCounts: FotoCount[] = [];
      if (maqRevIds.length > 0) {
        const { data: maqFotos, error: mfErr } = await supabase
          .from('revision_maquinaria_fotos').select('revision_id').in('revision_id', maqRevIds);
        if (mfErr) throw new Error(mfErr.message);
        const cm = new Map<string, number>();
        for (const f of maqFotos || []) cm.set(f.revision_id, (cm.get(f.revision_id) ?? 0) + 1);
        maqCounts = Array.from(cm.entries()).map(([revision_id, count]) => ({ revision_id, count }));
      }
      setMaqFotoCounts(maqCounts);

      const { data: impRev, error: impRevErr } = await supabase
        .from('revision_implemento').select('id, user_id, tipo, created_at')
        .in('user_id', ids).gte('created_at', startOfDay).lte('created_at', endOfDay);
      if (impRevErr) throw new Error(impRevErr.message);
      const impRevList = (impRev || []) as RevisionRow[];
      setImpRevisions(impRevList);

      const impRevIds = impRevList.map((r) => r.id);
      let impCounts: FotoCount[] = [];
      if (impRevIds.length > 0) {
        const { data: impFotos, error: ifErr } = await supabase
          .from('revision_implemento_fotos').select('revision_id').in('revision_id', impRevIds);
        if (ifErr) throw new Error(ifErr.message);
        const cm = new Map<string, number>();
        for (const f of impFotos || []) cm.set(f.revision_id, (cm.get(f.revision_id) ?? 0) + 1);
        impCounts = Array.from(cm.entries()).map(([revision_id, count]) => ({ revision_id, count }));
      }
      setImpFotoCounts(impCounts);

      const entradaIds = (att || []).filter((a: any) => a.tipo_registro === 'entrada').map((a: any) => a.id);
      let evRows: EvidenciaRow[] = [];
      if (entradaIds.length > 0) {
        const { data: evData, error: evErr } = await supabase
          .from('seguimiento_fotos').select('user_id, entrada_id, evidencia_n, foto_url, timestamp')
          .in('entrada_id', entradaIds);
        if (evErr) throw new Error(evErr.message);
        evRows = (evData || []) as EvidenciaRow[];
      }
      setEvidencias(evRows);
      setLastRefresh(new Date());
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : 'Error cargando datos';
      if (msg.toLowerCase().includes('refresh token') || msg.toLowerCase().includes('jwt')) {
        await supabase.auth.signOut(); await signOut(); return;
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

  // ── Estado por operario ───────────────────────────────────────────────────

  const operariosConEstado = useMemo(() => {
    return operarios.map((op) => {
      const attRows = attendance.filter((a) => a.user_id === op.user_id);
      const entrada = attRows.find((a) => a.tipo_registro === 'entrada') ?? null;
      const salida  = attRows.find((a) => a.tipo_registro === 'salida')  ?? null;

      const maqRevUser  = maqRevisions.filter((r) => r.user_id === op.user_id);
      const maqInicio   = maqRevUser.find((r) => r.tipo === 'inicio') ?? null;
      const maqFin      = maqRevUser.find((r) => r.tipo === 'fin')    ?? null;
      const maqInicioFotos = maqInicio ? (maqFotoCounts.find((f) => f.revision_id === maqInicio.id)?.count ?? 0) : 0;
      const maqFinFotos    = maqFin    ? (maqFotoCounts.find((f) => f.revision_id === maqFin.id)?.count    ?? 0) : 0;
      const maqInicioOk = maqInicioFotos >= REQUIRED_MAQ;
      const maqFinOk    = maqFinFotos    >= REQUIRED_MAQ;

      const impRevUser  = impRevisions.filter((r) => r.user_id === op.user_id);
      const impInicio   = impRevUser.find((r) => r.tipo === 'inicio') ?? null;
      const impFin      = impRevUser.find((r) => r.tipo === 'fin')    ?? null;
      const impInicioFotos = impInicio ? (impFotoCounts.find((f) => f.revision_id === impInicio.id)?.count ?? 0) : 0;
      const impFinFotos    = impFin    ? (impFotoCounts.find((f) => f.revision_id === impFin.id)?.count    ?? 0) : 0;
      const impInicioOk = impInicioFotos >= REQUIRED_IMP;
      const impFinOk    = impFinFotos    >= REQUIRED_IMP;

      const evUser   = evidencias.filter((e) => e.user_id === op.user_id);
      const hasEv1   = evUser.some((e) => e.evidencia_n === 1);
      const hasEv2   = evUser.some((e) => e.evidencia_n === 2);
      const entradaId = entrada?.id ?? null;

      const flujoCompleto = !!entrada && maqInicioOk && impInicioOk && hasEv1 && hasEv2 && impFinOk && maqFinOk && !!salida;

      return {
        ...op, entrada, salida, entradaId,
        maqInicio, maqFin, maqInicioOk, maqInicioFotos, maqFinOk, maqFinFotos,
        impInicio, impFin, impInicioOk, impInicioFotos, impFinOk, impFinFotos,
        hasEv1, hasEv2, flujoCompleto,
      };
    }).sort((a, b) => (a.nombre ?? '').localeCompare(b.nombre ?? ''));
  }, [operarios, attendance, maqRevisions, maqFotoCounts, impRevisions, impFotoCounts, evidencias]);

  // ✅ Filtros aplicados en memoria (no requieren nueva query)
  const operariosFiltrados = useMemo(() => {
    return operariosConEstado.filter((op) => {
      const passZona   = zonaFilter === 'all' || op.zona === zonaFilter;
      const passNombre = nombreFilter.trim() === '' ||
        (op.nombre ?? '').toLowerCase().includes(nombreFilter.trim().toLowerCase());
      return passZona && passNombre;
    });
  }, [operariosConEstado, zonaFilter, nombreFilter]);

  // ── Métricas sobre lista filtrada ─────────────────────────────────────────
  const metrics = useMemo(() => {
    const l = operariosFiltrados;
    return {
      total:         l.length,
      conEntrada:    l.filter((o) => !!o.entrada).length,
      sinEntrada:    l.filter((o) => !o.entrada).length,
      maqInicioOk:   l.filter((o) => o.maqInicioOk).length,
      impInicioOk:   l.filter((o) => o.impInicioOk).length,
      ev1Ok:         l.filter((o) => o.hasEv1).length,
      ev2Ok:         l.filter((o) => o.hasEv2).length,
      impFinOk:      l.filter((o) => o.impFinOk).length,
      maqFinOk:      l.filter((o) => o.maqFinOk).length,
      conSalida:     l.filter((o) => !!o.salida).length,
      flujoCompleto: l.filter((o) => o.flujoCompleto).length,
    };
  }, [operariosFiltrados]);

  const prettyDate = useMemo(() => {
    try { return format(new Date(dateISO + 'T00:00:00'), "EEEE, d 'de' MMMM yyyy", { locale: es }); }
    catch { return dateISO; }
  }, [dateISO]);

  function badgeConFotos(count: number, required: number, onVer: () => void) {
    const ok = count >= required;
    const partial = count > 0 && !ok;
    return (
      <div className="flex flex-col items-center gap-1">
        {ok ? (
          <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">{required}/{required}</Badge>
        ) : partial ? (
          <Badge className="bg-amber-500 hover:bg-amber-500 text-xs">{count}/{required}</Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground text-xs">—</Badge>
        )}
        {count > 0 && (
          <button onClick={onVer} className="flex items-center gap-0.5 text-[10px] text-primary hover:underline leading-none">
            <Eye className="h-2.5 w-2.5" /> Ver
          </button>
        )}
      </div>
    );
  }

  const hayFiltros = zonaFilter !== 'all' || nombreFilter.trim() !== '';

  // ── Render ────────────────────────────────────────────────────────────────
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

        {/* ── Filtros ── */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Fecha</p>
            <Input type="date" value={dateISO} onChange={(e) => setDateISO(e.target.value)} className="w-[160px]" />
          </div>

          {/* ✅ Zona dropdown */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Zona</p>
            <Select value={zonaFilter} onValueChange={setZonaFilter}>
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="Todas las zonas" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas las zonas</SelectItem>
                {zonas.map((z) => (
                  <SelectItem key={z} value={z}>{z}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* ✅ Nombre búsqueda libre */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Buscar operario</p>
            <Input
              placeholder="Nombre..."
              value={nombreFilter}
              onChange={(e) => setNombreFilter(e.target.value)}
              className="w-[180px]"
            />
          </div>

          <div className="pb-0.5 flex flex-col gap-0.5">
            <p className="text-xs text-muted-foreground">
              Actualizado: {format(lastRefresh, 'HH:mm:ss')}
              {hayFiltros && (
                <button
                  onClick={() => { setZonaFilter('all'); setNombreFilter(''); }}
                  className="ml-2 text-primary hover:underline"
                >
                  Limpiar filtros
                </button>
              )}
            </p>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </div>

        {/* Indicador filtros activos */}
        {hayFiltros && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/40 rounded px-3 py-1.5">
            <span>Mostrando {operariosFiltrados.length} de {operariosConEstado.length} operarios</span>
            {zonaFilter !== 'all' && <Badge variant="secondary" className="text-xs">Zona: {zonaFilter}</Badge>}
            {nombreFilter.trim() !== '' && <Badge variant="secondary" className="text-xs">Nombre: "{nombreFilter}"</Badge>}
          </div>
        )}

        {/* ── Cards métricas (reflejan filtros) ── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground flex items-center gap-1"><Users className="h-3.5 w-3.5" /> Total operarios</CardTitle></CardHeader>
            <CardContent className="text-3xl font-bold">{metrics.total}</CardContent>
          </Card>
          <Card className="border-emerald-500/30 bg-emerald-500/5">
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Con entrada</CardTitle></CardHeader>
            <CardContent className="text-3xl font-bold text-emerald-700">{metrics.conEntrada}</CardContent>
          </Card>
          <Card className="border-destructive/30 bg-destructive/5">
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground flex items-center gap-1"><XCircle className="h-3.5 w-3.5 text-destructive" /> Sin ingreso</CardTitle></CardHeader>
            <CardContent className="text-3xl font-bold text-destructive">{metrics.sinEntrada}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground flex items-center gap-1"><ClipboardCheck className="h-3.5 w-3.5" /> Rev. Maq. Inicio ✓</CardTitle></CardHeader>
            <CardContent className="text-3xl font-bold">{metrics.maqInicioOk}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground flex items-center gap-1"><Wrench className="h-3.5 w-3.5" /> Rev. Imp. Inicio ✓</CardTitle></CardHeader>
            <CardContent className="text-3xl font-bold">{metrics.impInicioOk}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground flex items-center gap-1"><Camera className="h-3.5 w-3.5" /> Evidencia 1 ✓</CardTitle></CardHeader>
            <CardContent className="text-3xl font-bold">{metrics.ev1Ok}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground flex items-center gap-1"><Camera className="h-3.5 w-3.5" /> Evidencia 2 ✓</CardTitle></CardHeader>
            <CardContent className="text-3xl font-bold">{metrics.ev2Ok}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground flex items-center gap-1"><Wrench className="h-3.5 w-3.5" /> Rev. Imp. Fin ✓</CardTitle></CardHeader>
            <CardContent className="text-3xl font-bold">{metrics.impFinOk}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground flex items-center gap-1"><ClipboardCheck className="h-3.5 w-3.5" /> Rev. Maq. Fin ✓</CardTitle></CardHeader>
            <CardContent className="text-3xl font-bold">{metrics.maqFinOk}</CardContent>
          </Card>
          <Card className="border-emerald-500/30 bg-emerald-500/5">
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Con salida</CardTitle></CardHeader>
            <CardContent className="text-3xl font-bold text-emerald-700">{metrics.conSalida}</CardContent>
          </Card>
          <Card className="col-span-2 border-emerald-500/30 bg-emerald-500/5">
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Flujo completo</CardTitle></CardHeader>
            <CardContent className="text-3xl font-bold text-emerald-700">{metrics.flujoCompleto}</CardContent>
          </Card>
        </div>

        {/* ── Tabla ── */}
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Detalle por operario</h2>

          {loading && operariosFiltrados.length === 0 ? (
            <p className="text-sm text-muted-foreground">Cargando...</p>
          ) : operariosFiltrados.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {operariosConEstado.length === 0
                ? 'No hay operarios de maquinaria registrados.'
                : 'Ningún operario coincide con los filtros aplicados.'}
            </p>
          ) : (
            <div className="rounded-lg border overflow-x-auto">
              <table className="w-full text-xs sm:text-sm min-w-[960px]">
                <thead className="bg-muted/50 border-b">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Nombre</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground">Zona</th>
                    <th className="text-center px-2 py-2 font-medium text-muted-foreground">Entrada</th>
                    <th className="text-center px-2 py-2 font-medium text-muted-foreground"><span className="flex items-center justify-center gap-1"><ClipboardCheck className="h-3 w-3" /> Maq. Ini.</span></th>
                    <th className="text-center px-2 py-2 font-medium text-muted-foreground"><span className="flex items-center justify-center gap-1"><Wrench className="h-3 w-3" /> Imp. Ini.</span></th>
                    <th className="text-center px-2 py-2 font-medium text-muted-foreground"><span className="flex items-center justify-center gap-1"><Camera className="h-3 w-3" /> Ev. 1</span></th>
                    <th className="text-center px-2 py-2 font-medium text-muted-foreground"><span className="flex items-center justify-center gap-1"><Camera className="h-3 w-3" /> Ev. 2</span></th>
                    <th className="text-center px-2 py-2 font-medium text-muted-foreground"><span className="flex items-center justify-center gap-1"><Wrench className="h-3 w-3" /> Imp. Fin</span></th>
                    <th className="text-center px-2 py-2 font-medium text-muted-foreground"><span className="flex items-center justify-center gap-1"><ClipboardCheck className="h-3 w-3" /> Maq. Fin</span></th>
                    <th className="text-center px-2 py-2 font-medium text-muted-foreground">Salida</th>
                  </tr>
                </thead>
                <tbody>
                  {operariosFiltrados.map((op, i) => (
                    <tr key={op.user_id} className={`${i % 2 === 0 ? 'bg-background' : 'bg-muted/20'} ${op.flujoCompleto ? 'border-l-2 border-l-emerald-500' : ''}`}>
                      <td className="px-3 py-2 font-medium truncate max-w-[130px]">
                        {op.nombre ?? <span className="text-muted-foreground italic">Sin nombre</span>}
                        {op.flujoCompleto && <span className="ml-1 text-emerald-600 text-xs">✅</span>}
                      </td>
                      {/* ✅ Zona visible en tabla */}
                      <td className="px-2 py-2 text-muted-foreground text-xs truncate max-w-[90px]">
                        {op.zona ?? <span className="italic">—</span>}
                      </td>
                      <td className="px-2 py-2 text-center">
                        {op.entrada ? (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">{format(new Date(op.entrada.timestamp), 'HH:mm')}</Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground text-xs">—</Badge>
                        )}
                      </td>
                      <td className="px-2 py-2 text-center">
                        {badgeConFotos(op.maqInicioFotos, REQUIRED_MAQ, () => op.maqInicio && openMaqPhotos(op.maqInicio.id, `Maq. Inicio — ${op.nombre ?? ''}`))}
                      </td>
                      <td className="px-2 py-2 text-center">
                        {badgeConFotos(op.impInicioFotos, REQUIRED_IMP, () => op.impInicio && openImpPhotos(op.impInicio.id, `Imp. Inicio — ${op.nombre ?? ''}`))}
                      </td>
                      <td className="px-2 py-2 text-center">
                        <div className="flex flex-col items-center gap-1">
                          {op.hasEv1 ? <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">✓</Badge> : <Badge variant="outline" className="text-muted-foreground text-xs">—</Badge>}
                          {op.hasEv1 && op.entradaId && (
                            <button onClick={() => openEvidenciaPhotos(op.user_id, op.entradaId!, op.nombre)} className="flex items-center gap-0.5 text-[10px] text-primary hover:underline leading-none">
                              <Eye className="h-2.5 w-2.5" /> Ver
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-center">
                        <div className="flex flex-col items-center gap-1">
                          {op.hasEv2 ? <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">✓</Badge> : <Badge variant="outline" className="text-muted-foreground text-xs">—</Badge>}
                          {op.hasEv2 && op.entradaId && (
                            <button onClick={() => openEvidenciaPhotos(op.user_id, op.entradaId!, op.nombre)} className="flex items-center gap-0.5 text-[10px] text-primary hover:underline leading-none">
                              <Eye className="h-2.5 w-2.5" /> Ver
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-center">
                        {badgeConFotos(op.impFinFotos, REQUIRED_IMP, () => op.impFin && openImpPhotos(op.impFin.id, `Imp. Fin — ${op.nombre ?? ''}`))}
                      </td>
                      <td className="px-2 py-2 text-center">
                        {badgeConFotos(op.maqFinFotos, REQUIRED_MAQ, () => op.maqFin && openMaqPhotos(op.maqFin.id, `Maq. Fin — ${op.nombre ?? ''}`))}
                      </td>
                      <td className="px-2 py-2 text-center">
                        {op.salida ? (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">{format(new Date(op.salida.timestamp), 'HH:mm')}</Badge>
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
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-emerald-600" /> Completo</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-amber-500" /> Parcial</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded border border-muted-foreground/30" /> Sin registrar</span>
          <span className="flex items-center gap-1"><span className="inline-block w-1 h-4 rounded bg-emerald-500" /> Fila con flujo completo</span>
          <span className="flex items-center gap-1"><Eye className="h-3 w-3 text-primary" /> Ver fotos disponibles</span>
        </div>
      </main>

      {/* ── Modal fotos ── */}
      <Dialog open={modal.open} onOpenChange={(open) => !open && setModal(MODAL_INICIAL)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{modal.title}</DialogTitle>
            <DialogDescription>Fotos registradas por el operario</DialogDescription>
          </DialogHeader>
          {modal.loading ? (
            <div className="py-10 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : modal.error ? (
            <div className="p-3 rounded bg-destructive/10 text-sm text-destructive">{modal.error}</div>
          ) : modal.fotos.length === 0 ? (
            <div className="p-3 rounded bg-muted text-sm text-muted-foreground">No hay fotos disponibles para esta revisión.</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto pr-1">
              {modal.fotos.map((f, idx) => (
                <div key={idx} className="rounded-lg border overflow-hidden bg-muted/30">
                  <div className="px-3 py-1.5 text-xs font-medium border-b bg-muted/50 capitalize">{f.label}</div>
                  <div className="p-2">
                    <img src={f.url} alt={f.label}
                      className="w-full h-40 object-cover rounded cursor-pointer hover:opacity-90 transition-opacity"
                      onClick={() => window.open(f.url, '_blank')}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                    <a href={f.url} target="_blank" rel="noreferrer" className="block text-center text-xs text-primary hover:underline mt-1">
                      Abrir en pantalla completa
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setModal(MODAL_INICIAL)}>Cerrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}