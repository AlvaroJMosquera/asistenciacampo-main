import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ArrowLeft, Download, Users, LogIn, LogOut, AlertTriangle, Loader2, MapPin, UserX } from 'lucide-react';
import { Link } from 'react-router-dom';

interface AttendanceRecord {
  id: string;
  user_id: string;
  fecha: string;
  tipo_registro: 'entrada' | 'salida';
  timestamp: string;
  latitud: number | null;
  longitud: number | null;
  precision_gps: number | null;
  fuera_zona: boolean;
  foto_url: string | null;
  es_inconsistente: boolean;

  // ✅ nuevos campos (si los agregas en BD)
  hac_ste?: string | null; // Hacienda-Suerte
  suerte_nom?: string | null; // nombre de la suerte (opcional)

  profiles?: { nombre: string } | null;
}

export default function SupervisorDashboard() {
  const { signOut } = useAuth();

  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [users, setUsers] = useState<{ id: string; nombre: string }[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [dateFilter, setDateFilter] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [userFilter, setUserFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');

  const fetchUsers = async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, nombre')
      .eq('activo', true);

    if (error) console.error(error);
    setUsers(data || []);
  };

  const fetchRecords = async () => {
    setIsLoading(true);

    // ✅ importante: traer también hac_ste / suerte_nom si existen en la tabla
    let query = supabase
      .from('registros_asistencia')
      .select('id,user_id,fecha,tipo_registro,timestamp,latitud,longitud,precision_gps,fuera_zona,foto_url,es_inconsistente,hac_ste,suerte_nom')
      .eq('fecha', dateFilter)
      .order('timestamp', { ascending: false });

    if (userFilter !== 'all') query = query.eq('user_id', userFilter);
    if (typeFilter !== 'all') query = query.eq('tipo_registro', typeFilter);

    const { data: recordsData, error: recErr } = await query;

    if (recErr) console.error(recErr);

    if (!recordsData || recordsData.length === 0) {
      setRecords([]);
      setIsLoading(false);
      return;
    }

    // perfiles
    const userIds = [...new Set(recordsData.map((r) => r.user_id))];
    const { data: profilesData, error: profErr } = await supabase
      .from('profiles')
      .select('id, nombre')
      .in('id', userIds);

    if (profErr) console.error(profErr);

    const profilesMap = new Map(profilesData?.map((p) => [p.id, p]) || []);

    const merged: AttendanceRecord[] = (recordsData as AttendanceRecord[]).map((r) => ({
      ...r,
      profiles: profilesMap.get(r.user_id) || null,
    }));

    setRecords(merged);
    setIsLoading(false);
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  useEffect(() => {
    fetchRecords();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFilter, userFilter, typeFilter]);

  // ---------------------- STATS NUEVAS ----------------------
  const stats = useMemo(() => {
  const totalActivosPerfil = users.length;

  // total personas con algún registro (únicos)
  const totalPersonas = new Set(records.map((r) => r.user_id)).size;

  // inconsistentes por usuario único
  const inconsistentesUnicos = new Set(records.filter((r) => r.es_inconsistente).map((r) => r.user_id)).size;

  // usuarios con entrada / salida (solo presencia, no estado final)
  const entradasUnicas = new Set(records.filter((r) => r.tipo_registro === 'entrada').map((r) => r.user_id));
  const salidasUnicas = new Set(records.filter((r) => r.tipo_registro === 'salida').map((r) => r.user_id));

  // ✅ Activos sin salida (estado final): último evento del usuario = "entrada"
  const lastEventByUser = new Map<string, AttendanceRecord>();

  // aseguramos orden ascendente para que el último sobreescriba bien
  const ordered = [...records].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  for (const r of ordered) {
    lastEventByUser.set(r.user_id, r);
  }

  const activosSinSalida = Array.from(lastEventByUser.values()).filter(
    (r) => r.tipo_registro === 'entrada'
  ).length;

  // ✅ Inactivos (sin entrada): profiles activos - usuarios que marcaron al menos 1 entrada
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

  // ---------------------------------------------------------

  // ✅ CSV con columna Ubicación (Hacienda-Suerte)
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
    ];

    const rows = records.map((r) => [
      r.fecha,
      format(new Date(r.timestamp), 'HH:mm:ss'),
      (r.profiles?.nombre || 'N/A').replaceAll(',', ' '),
      r.tipo_registro,
      (r.hac_ste || '—').replaceAll(',', ' '),
      (r.suerte_nom || '—').replaceAll(',', ' '),
      r.latitud != null && r.longitud != null ? `${r.latitud},${r.longitud}` : 'Sin GPS',
      r.precision_gps != null ? String(Math.round(r.precision_gps)) : '—',
      r.es_inconsistente ? 'Sí' : 'No',
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
          <Button variant="outline" size="sm">Mapa</Button>
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

          {/* ✅ Req 2 */}
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <MapPin className="h-8 w-8 text-primary" />
              <div>
                <p className="text-2xl font-bold">{stats.activosSinSalida}</p>
                <p className="text-xs text-muted-foreground">Activos sin salida</p>
              </div>
            </CardContent>
          </Card>

          {/* ✅ Req 3 */}
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
                      <TableCell>
                        <span className={r.tipo_registro === 'entrada' ? 'text-success' : 'text-destructive'}>
                          {r.tipo_registro}
                        </span>
                      </TableCell>

                      {/* ✅ Req 1 */}
                      <TableCell>
                        <div className="text-sm">
                          <div className="font-medium">{r.hac_ste || '—'}</div>
                          <div className="text-xs text-muted-foreground">{r.suerte_nom || ''}</div>
                        </div>
                      </TableCell>

                      <TableCell>{r.latitud ? `±${Math.round(r.precision_gps || 0)}m` : '—'}</TableCell>
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

        {/* Nota pequeña para contexto */}
        <p className="text-xs text-muted-foreground">
          * “Inactivos” se calcula usando <code>profiles.activo=true</code> menos “usuarios con entrada” del día.
        </p>
      </main>
    </div>
  );
}
