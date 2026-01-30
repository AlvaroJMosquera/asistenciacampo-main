import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, Loader2, Map as MapIcon, Navigation, Route as RouteIcon, Clock, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

// ✅ Leaflet
import { MapContainer, TileLayer, Marker, Popup, Polyline } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

// ✅ Fix íconos Leaflet en Vite (para los defaults)
import L from 'leaflet';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

type ViewMode = 'last' | 'hour' | 'route';

type TrackingPoint = {
  id: string;
  user_id: string;
  fecha: string; // YYYY-MM-DD
  entrada_id: string | null;
  recorded_at: string; // timestamptz ISO
  latitud: number | null;
  longitud: number | null;
  precision_gps: number | null;
  hac_ste: string | null;
  suerte_nom: string | null;
  fuera_zona: boolean;
  source: 'hourly' | 'entrada' | 'salida' | 'manual';
  profiles?: { nombre: string } | null;
};

export default function SupervisorTracking() {
  const navigate = useNavigate();
  const { signOut } = useAuth();

  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // filtros
  const [dateFilter, setDateFilter] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [userFilter, setUserFilter] = useState<string>('all');
  const [mode, setMode] = useState<ViewMode>('last');

  // modo "a una hora"
  const [hourFilter, setHourFilter] = useState<string>('09:00'); // HH:mm

  // jornada (entrada_id) para modo route
  const [jornadaFilter, setJornadaFilter] = useState<string>('all');
  const [jornadas, setJornadas] = useState<{ entrada_id: string; label: string }[]>([]);

  // data
  const [users, setUsers] = useState<{ id: string; nombre: string }[]>([]);
  const [points, setPoints] = useState<TrackingPoint[]>([]);

  // mapa
  const [center, setCenter] = useState<[number, number]>([3.45, -76.53]); // Cali default
  const [zoom, setZoom] = useState(12);

  // ✅ Iconos custom: DEBEN venir desde /public (ruta web)
  // Pon tus archivos en:
  //   public/worker_ok.png
  //   public/worker_alert.png
  const { iconOk, iconFuera } = useMemo(() => {
    const base = {
      iconSize: [38, 38] as [number, number],
      iconAnchor: [19, 38] as [number, number],
      popupAnchor: [0, -38] as [number, number],
    };

    return {
      iconOk: L.icon({
        ...base,
        iconUrl: '/worker_ok.png',
      }),
      iconFuera: L.icon({
        ...base,
        iconUrl: '/worker_alert.png',
      }),
    };
  }, []);

  const fetchUsers = async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, nombre')
      .eq('activo', true)
      .order('nombre', { ascending: true });

    if (error) console.error(error);
    setUsers((data as any) || []);
  };

  // helper: adjuntar perfiles
  const attachProfiles = async (arr: TrackingPoint[]) => {
    const ids = [...new Set(arr.map((x) => x.user_id))];
    if (ids.length === 0) return arr;

    const { data: profs } = await supabase.from('profiles').select('id,nombre').in('id', ids);
    const pm = new Map((profs || []).map((p: any) => [p.id, p]));

    return arr.map((p) => ({ ...p, profiles: pm.get(p.user_id) || null }));
  };

  // cargar jornadas para (user + date)
  const fetchJornadas = async () => {
    if (userFilter === 'all') {
      setJornadas([]);
      setJornadaFilter('all');
      return;
    }

    const { data, error } = await supabase
      .from('tracking_ubicaciones')
      .select('entrada_id, recorded_at')
      .eq('user_id', userFilter)
      .eq('fecha', dateFilter)
      .not('entrada_id', 'is', null)
      .order('recorded_at', { ascending: true });

    if (error) {
      console.error(error);
      setJornadas([]);
      setJornadaFilter('all');
      return;
    }

    const seen = new Set<string>();
    const out: { entrada_id: string; label: string }[] = [];

    for (const row of (data as any[]) || []) {
      const eid = row.entrada_id as string | null;
      if (!eid) continue;
      if (seen.has(eid)) continue;
      seen.add(eid);

      const t = row.recorded_at ? format(new Date(row.recorded_at), 'HH:mm') : '';
      out.push({ entrada_id: eid, label: `Jornada ${t ? `(${t})` : ''} - ${eid.slice(0, 8)}` });
    }

    setJornadas(out);

    if (jornadaFilter !== 'all' && !out.some((x) => x.entrada_id === jornadaFilter)) {
      setJornadaFilter('all');
    }
  };

  // ======= QUERIES =======
  const fetchLastLocations = async (): Promise<TrackingPoint[]> => {
    let q = supabase
      .from('tracking_ubicaciones')
      .select(
        'id,user_id,fecha,entrada_id,recorded_at,latitud,longitud,precision_gps,hac_ste,suerte_nom,fuera_zona,source'
      )
      .eq('fecha', dateFilter)
      .order('recorded_at', { ascending: false });

    if (userFilter !== 'all') q = q.eq('user_id', userFilter);

    const { data, error } = await q;
    if (error) throw error;

    const raw = (data as TrackingPoint[]) || [];

    const map = new Map<string, TrackingPoint>();
    for (const p of raw) {
      if (!map.has(p.user_id)) map.set(p.user_id, p);
    }

    return attachProfiles(Array.from(map.values()));
  };

  const fetchLocationsByHour = async (): Promise<TrackingPoint[]> => {
    let q = supabase
      .from('tracking_ubicaciones')
      .select(
        'id,user_id,fecha,entrada_id,recorded_at,latitud,longitud,precision_gps,hac_ste,suerte_nom,fuera_zona,source'
      )
      .eq('fecha', dateFilter)
      .order('recorded_at', { ascending: true });

    if (userFilter !== 'all') q = q.eq('user_id', userFilter);

    const { data, error } = await q;
    if (error) throw error;

    const raw = (data as TrackingPoint[]) || [];
    const target = new Date(`${dateFilter}T${hourFilter}:00`).getTime();

    const best = new Map<string, { p: TrackingPoint; diff: number }>();
    for (const p of raw) {
      const t = new Date(p.recorded_at).getTime();
      const diff = Math.abs(t - target);
      const cur = best.get(p.user_id);
      if (!cur || diff < cur.diff) best.set(p.user_id, { p, diff });
    }

    return attachProfiles(Array.from(best.values()).map((x) => x.p));
  };

  const fetchRoute = async (): Promise<TrackingPoint[]> => {
    if (userFilter === 'all') return [];

    let q = supabase
      .from('tracking_ubicaciones')
      .select(
        'id,user_id,fecha,entrada_id,recorded_at,latitud,longitud,precision_gps,hac_ste,suerte_nom,fuera_zona,source'
      )
      .eq('fecha', dateFilter)
      .eq('user_id', userFilter)
      .order('recorded_at', { ascending: true });

    if (jornadaFilter !== 'all') q = q.eq('entrada_id', jornadaFilter);

    const { data, error } = await q;
    if (error) throw error;

    const { data: prof } = await supabase.from('profiles').select('id,nombre').eq('id', userFilter).maybeSingle();
    const nombre = (prof as any)?.nombre ?? null;

    return ((data as TrackingPoint[]) || []).map((p) => ({
      ...p,
      profiles: nombre ? ({ nombre } as any) : null,
    }));
  };

  const routeLine = useMemo(() => {
    if (mode !== 'route') return [];
    return points
      .filter((p) => p.latitud != null && p.longitud != null)
      .map((p) => [p.latitud as number, p.longitud as number] as [number, number]);
  }, [mode, points]);

  const load = async () => {
    setIsLoading(true);
    setErrorMsg(null);

    try {
      if (mode === 'route') await fetchJornadas();
      else {
        setJornadas([]);
        setJornadaFilter('all');
      }

      let data: TrackingPoint[] = [];
      if (mode === 'last') data = await fetchLastLocations();
      if (mode === 'hour') data = await fetchLocationsByHour();
      if (mode === 'route') data = await fetchRoute();

      setPoints(data);

      const first = data.find((p) => p.latitud != null && p.longitud != null);
      if (first) {
        setCenter([first.latitud as number, first.longitud as number]);
        setZoom(mode === 'route' ? 14 : 12);
      }
    } catch (e: any) {
      console.error(e);
      setPoints([]);
      setErrorMsg(e?.message ? String(e.message) : 'Error cargando el mapa');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await load();
    setIsRefreshing(false);
  };

  const handleSignOut = async () => {
    await signOut();
    navigate('/auth');
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, dateFilter, userFilter, hourFilter, jornadaFilter]);

  useEffect(() => {
    if (mode === 'route') fetchJornadas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, userFilter, dateFilter]);

  // ====== Métricas simples arriba ======
  const metrics = useMemo(() => {
    const withCoords = points.filter((p) => p.latitud != null && p.longitud != null);
    const usersShown = new Set(points.map((p) => p.user_id)).size;
    const fueraZona = points.filter((p) => p.fuera_zona).length;

    const times = withCoords.map((p) => new Date(p.recorded_at).getTime()).sort((a, b) => a - b);
    const start = times.length ? format(new Date(times[0]), 'HH:mm') : '—';
    const end = times.length ? format(new Date(times[times.length - 1]), 'HH:mm') : '—';

    return { withCoords: withCoords.length, usersShown, fueraZona, start, end };
  }, [points]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header estilo GeoVisor */}
      <header className="bg-card border-b px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/supervisor')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2">
            <MapIcon className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-bold">Mapa de Operarios</h1>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
            Actualizar
          </Button>
          <Button variant="outline" size="sm" onClick={handleSignOut}>
            Salir
          </Button>
        </div>
      </header>

      {/* Main content estilo GeoVisor */}
      <div className="flex-1 flex flex-col p-4 gap-4 overflow-hidden">
        {/* Metrics panel */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Operarios en vista</p>
              <p className="text-2xl font-bold">{metrics.usersShown}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Puntos con GPS</p>
              <p className="text-2xl font-bold">{metrics.withCoords}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Fuera de zona</p>
              <p className="text-2xl font-bold">{metrics.fueraZona}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Rango (route)</p>
              <p className="text-sm font-semibold">{mode === 'route' ? `${metrics.start} → ${metrics.end}` : '—'}</p>
            </CardContent>
          </Card>
        </div>

        <div className="flex-1 flex flex-col lg:flex-row gap-4 min-h-0">
          {/* Sidebar con filtros */}
          <div className="lg:w-80 h-72 lg:h-auto flex-shrink-0">
            <Card className="h-full">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Filtros</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Fecha</span>
                  <Input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} />
                </div>

                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Operario</span>
                  <Select value={userFilter} onValueChange={setUserFilter}>
                    <SelectTrigger>
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
                </div>

                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Modo</span>
                  <Select value={mode} onValueChange={(v) => setMode(v as ViewMode)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="last">
                        <span className="flex items-center gap-2">
                          <Navigation className="h-4 w-4" /> Última ubicación
                        </span>
                      </SelectItem>
                      <SelectItem value="hour">
                        <span className="flex items-center gap-2">
                          <Clock className="h-4 w-4" /> Ubicación a una hora
                        </span>
                      </SelectItem>
                      <SelectItem value="route">
                        <span className="flex items-center gap-2">
                          <RouteIcon className="h-4 w-4" /> Recorrido completo
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {mode === 'hour' && (
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">Hora</span>
                    <Input type="time" value={hourFilter} onChange={(e) => setHourFilter(e.target.value)} />
                  </div>
                )}

                {mode === 'route' && (
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">Jornada</span>
                    <Select value={jornadaFilter} onValueChange={setJornadaFilter} disabled={userFilter === 'all'}>
                      <SelectTrigger>
                        <SelectValue placeholder="Jornada" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Todas</SelectItem>
                        {jornadas.map((j) => (
                          <SelectItem key={j.entrada_id} value={j.entrada_id}>
                            {j.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {userFilter === 'all' && (
                      <p className="text-xs text-muted-foreground">Para “recorrido”, selecciona un operario.</p>
                    )}
                  </div>
                )}

                <p className="text-[11px] text-muted-foreground">
                  Fuente: <code>tracking_ubicaciones</code>.
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Map */}
          <div className="flex-1 min-h-[420px] lg:min-h-0">
            {isLoading ? (
              <Skeleton className="h-full w-full rounded-lg" />
            ) : errorMsg ? (
              <div className="h-full flex items-center justify-center bg-card rounded-lg border">
                <div className="text-center p-4">
                  <p className="text-destructive mb-2">{errorMsg}</p>
                  <Button variant="outline" onClick={handleRefresh}>
                    Reintentar
                  </Button>
                </div>
              </div>
            ) : (
              <Card className="h-full">
                <CardContent className="p-0 h-full">
                  <div className="h-full min-h-[420px] w-full">
                    <MapContainer center={center} zoom={zoom} style={{ height: '100%', width: '100%' }}>
                      <TileLayer
                        attribution="&copy; OpenStreetMap contributors"
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                      />

                      {/* Línea del recorrido */}
                      {mode === 'route' && routeLine.length >= 2 && <Polyline positions={routeLine} />}

                      {/* Puntos */}
                      {points.map((p) => {
                        if (p.latitud == null || p.longitud == null) return null;

                        return (
                          <Marker
                            key={p.id}
                            position={[p.latitud, p.longitud]}
                            icon={p.fuera_zona ? iconFuera : iconOk}
                          >
                            <Popup>
                              <div className="space-y-1">
                                <div className="font-semibold">{p.profiles?.nombre || p.user_id}</div>
                                <div className="text-xs">
                                  {format(new Date(p.recorded_at), 'HH:mm:ss')} · {p.source}
                                </div>
                                <div className="text-xs">{p.hac_ste || '—'}</div>
                                <div className="text-xs text-muted-foreground">{p.suerte_nom || ''}</div>
                                {p.precision_gps != null && <div className="text-xs">±{Math.round(p.precision_gps)} m</div>}
                                {p.entrada_id && (
                                  <div className="text-[11px] text-muted-foreground">jornada: {p.entrada_id.slice(0, 8)}</div>
                                )}
                              </div>
                            </Popup>
                          </Marker>
                        );
                      })}
                    </MapContainer>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {isRefreshing && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Actualizando…
          </div>
        )}
      </div>
    </div>
  );
}
