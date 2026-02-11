// src/pages/SupervisorDashboard.tsx
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

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

type EventType = 'entrada' | 'salida' | 'rev_inicio' | 'rev_fin';

type FotoTipo =
  | 'frente'
  | 'lado_derecho'
  | 'lado_izquierdo'
  | 'trasera'
  | 'cabina';

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

  // revisión
  rev_id_real?: string | null; // id real de revision_maquinaria
  rev_fotos_count?: number;
  rev_fotos_required?: number;

  profiles?: { nombre: string } | null;
}

type RevPhotoRow = {
  revision_id: string;
  foto_tipo: FotoTipo;
  foto_path: string;
};

type SignedPhoto = {
  foto_tipo: FotoTipo;
  signedUrl: string;
};

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

  // -------- Modal fotos revisión ----------
  const [revModalOpen, setRevModalOpen] = useState(false);
  const [revModalTitle, setRevModalTitle] = useState<string>('Fotos de revisión');
  const [revModalLoading, setRevModalLoading] = useState(false);
  const [revModalError, setRevModalError] = useState<string | null>(null);
  const [revPhotos, setRevPhotos] = useState<SignedPhoto[]>([]);

  const fetchUsers = async () => {
    const { data, error } = await supabase.from('profiles').select('id, nombre').eq('activo', true);
    if (error) console.error(error);
    setUsers(data || []);
  };

  // firmar URL (bucket privado recomendado)
  async function signPhoto(path: string) {
    const { data, error } = await supabase.storage
      .from('attendance-photos')
      .createSignedUrl(path, 60 * 30); // 30 min

    if (error) throw error;
    return data.signedUrl;
  }

  // abrir modal y cargar 5 fotos por revision_id
  const openRevisionPhotos = async (revisionId: string, label: string) => {
    setRevModalTitle(label);
    setRevModalOpen(true);
    setRevModalLoading(true);
    setRevModalError(null);
    setRevPhotos([]);

    try {
      // trae paths
      const { data, error } = await supabase
        .from('revision_maquinaria_fotos')
        .select('revision_id,foto_tipo,foto_path')
        .eq('revision_id', revisionId);

      if (error) throw error;

      const rows = (data || []) as RevPhotoRow[];
      // orden “bonito”
      const order: FotoTipo[] = ['frente', 'lado_derecho', 'lado_izquierdo', 'trasera', 'cabina'];
      rows.sort((a, b) => order.indexOf(a.foto_tipo) - order.indexOf(b.foto_tipo));

      // firmar todas
      const signed: SignedPhoto[] = [];
      for (const r of rows) {
        const url = await signPhoto(r.foto_path);
        signed.push({ foto_tipo: r.foto_tipo, signedUrl: url });
      }

      setRevPhotos(signed);
    } catch (e: any) {
      console.error(e);
      setRevModalError(e?.message ? String(e.message) : 'No se pudieron cargar las fotos de la revisión');
    } finally {
      setRevModalLoading(false);
    }
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
      tipo_evento: r.tipo_registro,
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
    // ✅ AQUÍ ESTABA EL PROBLEMA: no estabas trayendo geo ni gps
    let revQuery = supabase
      .from('revision_maquinaria')
      .select(
        'id,user_id,tipo,timestamp,created_at,latitud,longitud,precision_gps,fuera_zona,hac_ste,suerte_nom'
      )
      .gte('timestamp', `${dateFilter} 00:00:00`)
      .lte('timestamp', `${dateFilter} 23:59:59`)
      .order('timestamp', { ascending: false });

    if (userFilter !== 'all') revQuery = revQuery.eq('user_id', userFilter);

    const { data: revData, error: revErr } = await revQuery;
    if (revErr) console.error(revErr);

    // contar fotos por revisión (y opcionalmente usarlo en UI)
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
      id: `rev_${r.id}`,
      rev_id_real: r.id,
      user_id: r.user_id,
      fecha: dateFilter,
      tipo_evento: r.tipo === 'inicio' ? 'rev_inicio' : 'rev_fin',
      // ✅ usa timestamp (siempre debería estar) y fallback a created_at
      timestamp: r.timestamp ?? r.created_at,
      // ✅ ubicación + gps de la revisión
      latitud: r.latitud ?? null,
      longitud: r.longitud ?? null,
      precision_gps: r.precision_gps ?? null,
      fuera_zona: r.fuera_zona ?? false,
      hac_ste: r.hac_ste ?? null,
      suerte_nom: r.suerte_nom ?? null,
      rev_fotos_count: revCountMap.get(r.id) ?? 0,
      rev_fotos_required: REQUIRED_MAQUINARIA_PHOTOS,
      // foto_url queda null: se verá con modal
      foto_url: null,
      es_inconsistente: false,
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
    const { data: profilesData, error: profErr } = await supabase
      .from('profiles')
      .select('id, nombre')
      .in('id', userIds);

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

  // ---------------------- STATS (solo asistencia) ----------------------
  const stats = useMemo(() => {
    const totalActivosPerfil = users.length;

    const attendanceOnly = records.filter((r) => r.tipo_evento === 'entrada' || r.tipo_evento === 'salida');

    const totalPersonas = new Set(attendanceOnly.map((r) => r.user_id)).size;

    const inconsistentesUnicos = new Set(
      attendanceOnly.filter((r) => r.es_inconsistente).map((r) => r.user_id)
    ).size;

    const entradasUnicas = new Set(attendanceOnly.filter((r) => r.tipo_evento === 'entrada').map((r) => r.user_id));
    const salidasUnicas = new Set(attendanceOnly.filter((r) => r.tipo_evento === 'salida').map((r) => r.user_id));

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

  // ✅ CSV: incluye revisiones también (ya incluye ubicación de revisiones)
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
      typeof r.rev_fotos_count === 'number'
        ? `${r.rev_fotos_count}/${r.rev_fotos_required ?? REQUIRED_MAQUINARIA_PHOTOS}`
        : '—',
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

  const renderFotoCell = (r: SupervisorEventRow) => {
    // asistencia: usa foto_url pública/guardada
    if (r.tipo_evento === 'entrada' || r.tipo_evento === 'salida') {
      return r.foto_url ? (
        <a href={r.foto_url} target="_blank" rel="noreferrer" className="text-primary underline">
          Ver
        </a>
      ) : (
        '—'
      );
    }

    // revisiones: modal con signed urls
    const revId = r.rev_id_real;
    const label = r.tipo_evento === 'rev_inicio' ? 'Fotos revisión INICIO' : 'Fotos revisión FIN';

    if (!revId) return '—';

    return (
      <Button
        variant="link"
        className="px-0"
        onClick={() => openRevisionPhotos(revId, label)}
      >
        Ver
      </Button>
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
                        {r.latitud != null && r.precision_gps != null
                          ? `±${Math.round(r.precision_gps)}m`
                          : r.latitud != null
                            ? 'GPS'
                            : '—'}
                      </TableCell>

                      <TableCell>{renderFotoCell(r)}</TableCell>
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

      {/* Modal fotos revisión */}
      <Dialog open={revModalOpen} onOpenChange={setRevModalOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{revModalTitle}</DialogTitle>
            <DialogDescription>
              Se muestran URLs firmadas (expiran). Si aparece 403, revisa policies de Storage/DB para supervisor.
            </DialogDescription>
          </DialogHeader>

          {revModalLoading ? (
            <div className="py-8 flex items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : revModalError ? (
            <div className="p-3 rounded bg-muted text-sm">{revModalError}</div>
          ) : revPhotos.length === 0 ? (
            <div className="p-3 rounded bg-muted text-sm">No hay fotos para esta revisión.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {revPhotos.map((p) => (
                <div key={p.foto_tipo} className="rounded border p-2">
                  <div className="text-xs font-medium mb-2 capitalize">{p.foto_tipo.replace('_', ' ')}</div>
                  <a href={p.signedUrl} target="_blank" rel="noreferrer" className="text-primary underline text-sm">
                    Ver imagen
                  </a>
                </div>
              ))}
            </div>
          )}

          <DialogFooter>
            <Button onClick={() => setRevModalOpen(false)}>Cerrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
