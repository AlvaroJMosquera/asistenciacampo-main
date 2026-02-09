import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  ArrowLeft,
  Download,
  Users,
  LogIn,
  LogOut,
  AlertTriangle,
  Loader2,
  MapPin,
  UserX,
  ClipboardCheck,
} from 'lucide-react';
import { Link } from 'react-router-dom';

type EventType = 'entrada' | 'salida' | 'rev_inicio' | 'rev_fin';

interface SupervisorEventRow {
  id: string;
  user_id: string;
  fecha: string;
  tipo_evento: EventType;
  timestamp: string;

  // asistencia
  latitud?: number | null;
  longitud?: number | null;
  precision_gps?: number | null;
  fuera_zona?: boolean;
  foto_url?: string | null;
  es_inconsistente?: boolean;

  // ubicación
  hac_ste?: string | null;
  suerte_nom?: string | null;

  // revisión (opcional)
  rev_fotos_count?: number;
  rev_fotos_required?: number;

  profiles?: { nombre: string } | null;
}

export default function SupervisorDashboard() {
  const { signOut } = useAuth();

  const [records, setRecords] = useState<SupervisorEventRow[]>([]);
  const [users, setUsers] = useState<{ id: string; nombre: string }[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [dateFilter, setDateFilter] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [userFilter, setUserFilter] = useState<string>('all');

  // ⚠️ este filtro aplica SOLO a asistencia (entrada/salida)
  const [typeFilter, setTypeFilter] = useState<string>('all');

  const REQUIRED_MAQUINARIA_PHOTOS = 5;

  const fetchUsers = async () => {
    const { data, error } = await supabase.from('profiles').select('id, nombre').eq('activo', true);
    if (error) console.error(error);
    setUsers(data || []);
  };

  const fetchRecords = async () => {
    setIsLoading(true);

    // ----------------- 1) Asistencia (entrada/salida) -----------------
    let attQuery = supabase
      .from('registros_asistencia')
      .select(
        'id,user_id,fecha,tipo_registro,timestamp,latitud,longitud,precision_gps,fuera_zona,foto_url,es_inconsistente,hac_ste,suerte_nom'
      )
      .eq('fecha', dateFilter)
      .order('timestamp', { ascending: false });

    if (userFilter !== 'all') attQuery = attQuery.eq('user_id', userFilter);
    if (typeFilter !== 'all') attQuery = attQuery.eq('tipo_registro', typeFilter);

    const { data: attData, error: attErr } = await attQuery;
    if (attErr) console.error(attErr);

    const attendanceRows: SupervisorEventRow[] = (attData || []).map((r: any) => ({
      id: r.id,
      user_id: r.user_id,
      fecha: r.fecha,
      tipo_evento: r.tipo_registro, // 'entrada' | 'salida'
      timestamp: r.timestamp,
      latitud: r.latitud ?? null,
      longitud: r.longitud ?? null,
      precision_gps: r.precision_gps ?? null,
      fuera_zona: r.fuera_zona ?? false,
      foto_url: r.foto_url ?? null,
      es_inconsistente: !!r.es_inconsistente,
      hac_ste: r.hac_ste ?? null,
      suerte_nom: r.suerte_nom ?? null,
    }));

    // ----------------- 2) Revisiones (inicio/fin) -----------------
    // Las revisiones se muestran siempre (no dependen de typeFilter)
    let revQuery = supabase
      .from('revision_maquinaria')
      .select('id,user_id,tipo,created_at')
      .gte('created_at', `${dateFilter} 00:00:00`)
      .lte('created_at', `${dateFilter} 23:59:59`)
      .order('created_at', { ascending: false });

    if (userFilter !== 'all') revQuery = revQuery.eq('user_id', userFilter);

    const { data: revData, error: revErr } = await revQuery;
    if (revErr) console.error(revErr);

    // (Opcional) contar fotos por revisión
    const revIds = (revData || []).map((r: any) => r.id);
    const revCountMap = new Map<string, number>();

    if (revIds.length > 0) {
      const { data: fotos, error: fotosErr } = await supabase
        .from('revision_maquinaria_fotos')
        .select('revision_id')
        .in('revision_id', revIds);

      if (fotosErr) console.warn(fotosErr);

      (fotos || []).forEach((f: any) => {
        revCountMap.set(f.revision_id, (revCountMap.get(f.revision_id) ?? 0) + 1);
      });
    }

    const revisionRows: SupervisorEventRow[] = (revData || []).map((r: any) => ({
      id: `rev_${r.id}`, // para no chocar con ids de asistencia
      user_id: r.user_id,
      fecha: dateFilter,
      tipo_evento: r.tipo === 'inicio' ? 'rev_inicio' : 'rev_fin',
      timestamp: r.created_at,
      rev_fotos_count: revCountMap.get(r.id) ?? 0,
      rev_fotos_required: REQUIRED_MAQUINARIA_PHOTOS,
    }));

    // ----------------- 3) Merge + perfiles -----------------
    const mergedAll = [...attendanceRows, ...revisionRows].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    if (mergedAll.length === 0) {
      setRecords([]);
      setIsLoading(false);
      return;
    }

    const userIds = [...new Set(mergedAll.map((r) => r.user_id))];
    const { data: profilesData, error: profErr } = await supabase.from('profiles').select('id, nombre').in('id', userIds);
    if (profErr) console.error(profErr);

    const profilesMap = new Map(profilesData?.map((p: any) => [p.id, p]) || []);

    setRecords(
      mergedAll.map((r) => ({
        ...r,
        profiles: profilesMap.get(r.user_id) || null,
      }))
    );

    setIsLoading(false);
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  useEffect(() => {
    fetchRecords();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFilter, userFilter, typeFilter]);

  // ---------------------- STATS (solo asistencia para entradas/salidas) ----------------------
  const stats = useMemo(() => {
    const totalActivosPerfil = users.length;

    const attendanceOnly = records.filter((r) => r.tipo_evento === 'entrada' || r.tipo_evento === 'salida');

    const totalPersonas = new Set(attendanceOnly.map((r) => r.user_id)).size;

    const inconsistentesUnicos = new Set(
      attendanceOnly.filter((r) => r.es_inconsistente).map((r) => r.user_id)
    ).size;

    const entradasUnicas = new Set(attendanceOnly.filter((r) => r.tipo_evento === 'entrada').map((r) => r.user_id));
    const salidasUnicas = new Set(attendanceOnly.filter((r) => r.tipo_evento === 'salida').map((r) => r.user_id));

    // Activos sin salida: último evento de asistencia por usuario = entrada
    const lastEventByUser = new Map<string, SupervisorEventRow>();
    const ordered = [...attendanceOnly].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    for (const r of ordered) lastEventByUser.set(r.user_id, r);

    const activosSinSalida = Array.from(lastEventByUser.values()).filter((r) => r.tipo_evento === 'entrada').length;

    const inactivos = Math.max(0, totalActivosPerfil - entradasUnicas.size);

    return {
      totalPersonas,
      entradas: entradasUnicas.size,
      salidas: salidasUnicas.size,
      inconsistentes: inconsistentesUnicos,
      activosSinSalida,
      inactivos,
      totalActivosPerfil,
    };
  }, [records, users]);

  // ✅ CSV: incluye revisiones también
  const exportCSV = () => {
    const headers = [
      'Fecha',
      'Hora',
      'Usuario',
      'Tipo',
      'Ubicacion(Hacienda-Suerte)',
      'Suerte',
      'GPS',
      'Precision(m)',
      'Inconsistente',
      'RevisionFotos',
    ];

    const rows = records.map((r) => [
      r.fecha,
      format(new Date(r.timestamp), 'HH:mm:ss'),
      (r.profiles?.nombre || 'N/A').replaceAll(',', ' '),
      r.tipo_evento,
      (r.hac_ste || '—').replaceAll(',', ' '),
      (r.suerte_nom || '—').replaceAll(',', ' '),
      r.latitud != null && r.longitud != null ? `${r.latitud},${r.longitud}` : 'Sin GPS',
      r.precision_gps != null ? String(Math.round(r.precision_gps)) : '—',
      r.es_inconsistente ? 'Sí' : 'No',
      typeof r.rev_fotos_count === 'number' ? `${r.rev_fotos_count}/${r.rev_fotos_required ?? REQUIRED_MAQUINARIA_PHOTOS}` : '—',
    ]);

    const csv = [headers, ...rows].map((row) => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `asistencia_${dateFilter}.csv`;
    a.click();

    URL.revokeObjectURL(url);
  };

  const renderTipo = (r: SupervisorEventRow) => {
    if (r.tipo_evento === 'entrada') return <span className="text-success font-medium">entrada</span>;
    if (r.tipo_evento === 'salida') return <span className="text-destructive font-medium">salida</span>;

    const label = r.tipo_evento === 'rev_inicio' ? 'revisión inicio' : 'revisión fin';
    const count = typeof r.rev_fotos_count === 'number' ? r.rev_fotos_count : undefined;
    const req = r.rev_fotos_required ?? REQUIRED_MAQUINARIA_PHOTOS;

    return (
      <span className="text-primary font-medium inline-flex items-center gap-2">
        <ClipboardCheck className="h-4 w-4" />
        {label}
        {typeof count === 'number' ? (
          <span className="text-xs text-muted-foreground">({Math.min(count, req)}/{req})</span>
        ) : null}
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 bg-card border-b px-4 py-3">
        <div className="flex items-center justify-between max-w-6xl mx-auto">
          <div className="flex items-center gap-3">
            <Link to="/">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <h1 className="text-xl font-bold">Panel Supervisor</h1>
          </div>
          <Button variant="ghost" size="sm" onClick={signOut}>
            Salir
          </Button>
        </div>
      </header>

      <main className="p-4 max-w-6xl mx-auto space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Users className="h-8 w-8 text-primary" />
              <div>
                <p className="text-2xl font-bold">{stats.totalPersonas}</p>
                <p className="text-xs text-muted-foreground">Total con registro</p>
              </div>
            </CardContent>
          </Card>

          <Link to="/supervisor/tracking">
            <Button variant="outline" size="sm">
              Mapa
            </Button>
          </Link>

          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <LogIn className="h-8 w-8 text-success" />
              <div>
                <p className="text-2xl font-bold">{stats.entradas}</p>
                <p className="text-xs text-muted-foreground">Usuarios con entrada</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <LogOut className="h-8 w-8 text-destructive" />
              <div>
                <p className="text-2xl font-bold">{stats.salidas}</p>
                <p className="text-xs text-muted-foreground">Usuarios con salida</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <AlertTriangle className="h-8 w-8 text-warning" />
              <div>
                <p className="text-2xl font-bold">{stats.inconsistentes}</p>
                <p className="text-xs text-muted-foreground">Inconsistentes</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <MapPin className="h-8 w-8 text-primary" />
              <div>
                <p className="text-2xl font-bold">{stats.activosSinSalida}</p>
                <p className="text-xs text-muted-foreground">Activos sin salida</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <UserX className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="text-2xl font-bold">{stats.inactivos}</p>
                <p className="text-xs text-muted-foreground">Inactivos (sin entrada)</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Filtros</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            <Input
              type="date"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="w-40"
            />

            <Select value={userFilter} onValueChange={setUserFilter}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Usuario" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.nombre}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* ⚠️ Aplica solo a asistencia */}
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-32">
                <SelectValue placeholder="Tipo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="entrada">Entrada</SelectItem>
                <SelectItem value="salida">Salida</SelectItem>
              </SelectContent>
            </Select>

            <Button variant="outline" onClick={exportCSV}>
              <Download className="h-4 w-4 mr-2" />
              CSV
            </Button>
          </CardContent>
        </Card>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center p-8">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Hora</TableHead>
                    <TableHead>Usuario</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Ubicación</TableHead>
                    <TableHead>GPS</TableHead>
                    <TableHead>Foto</TableHead>
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {records.map((r) => (
                    <TableRow key={r.id} className={r.es_inconsistente ? 'bg-warning/10' : ''}>
                      <TableCell>{format(new Date(r.timestamp), 'HH:mm')}</TableCell>
                      <TableCell>{r.profiles?.nombre || 'N/A'}</TableCell>

                      <TableCell>{renderTipo(r)}</TableCell>

                      <TableCell>
                        <div className="text-sm">
                          <div className="font-medium">{r.hac_ste || '—'}</div>
                          <div className="text-xs text-muted-foreground">{r.suerte_nom || ''}</div>
                        </div>
                      </TableCell>

                      <TableCell>
                        {r.latitud != null ? `±${Math.round(r.precision_gps || 0)}m` : '—'}
                      </TableCell>

                      <TableCell>
                        {r.foto_url ? (
                          <a href={r.foto_url} target="_blank" rel="noreferrer" className="text-primary underline">
                            Ver
                          </a>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                    </TableRow>
                  ))}

                  {records.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                        Sin registros
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground">
          * “Inactivos” se calcula usando <code>profiles.activo=true</code> menos “usuarios con entrada” del día (solo asistencia).
        </p>
      </main>
    </div>
  );
}
