import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

type AppRole =
  | 'operario'
  | 'operario_maquinaria'
  | 'operario_cuadrilla'
  | 'supervisor'
  | 'supervisor_cuadrilla';

interface Profile {
  id: string;
  nombre: string;
  activo: boolean;
}

function toSlug(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .toLowerCase()
    .slice(0, 50);
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  role: AppRole | null;
  isLoading: boolean;
  isSupervisor: boolean;
  isOperarioMaquinaria: boolean;
  isOperarioCuadrilla: boolean;
  isSupervisorCuadrilla: boolean;
  /** Slug del nombre del usuario para usar en paths de Storage.
   *  Ej: "Juan García" → "juan_garcia"
   *  Fallback: user.id (si el perfil aún no cargó) */
  userSlug: string;

  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (email: string, password: string, nombre: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [role, setRole] = useState<AppRole | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchProfile = async (userId: string) => {
    try {
      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

      if (profileError) {
        console.error('Error fetching profile:', profileError);
        setIsLoading(false);
        return;
      }

      setProfile(profileData);

      const { data: roleData, error: roleError } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', userId)
        .single();

      if (roleError) {
        console.error('Error fetching role:', roleError);
        setIsLoading(false);
        return;
      }

      setRole(roleData.role as AppRole);
      setIsLoading(false);
    } catch (error) {
      console.error('Error in fetchProfile:', error);
      setIsLoading(false);
    }
  };

  const refreshProfile = async () => {
    if (user) {
      await fetchProfile(user.id);
    }
  };

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      setUser(session?.user ?? null);

      if (session?.user) {
        setTimeout(() => {
          fetchProfile(session.user.id);
        }, 0);
      } else {
        setProfile(null);
        setRole(null);
      }

      if (event === 'SIGNED_OUT') {
        setProfile(null);
        setRole(null);
      }

      setIsLoading(false);
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);

      if (session?.user) {
        fetchProfile(session.user.id);
      }

      setIsLoading(false);
    });

    const timeout = setTimeout(() => {
      if (isLoading) {
        console.warn('Auth loading timeout - forcing load complete');
        setIsLoading(false);
      }
    }, 10000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error };
  };

  const signUp = async (email: string, password: string, nombre: string) => {
    const redirectUrl = `${window.location.origin}/`;
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectUrl,
        data: { nombre },
      },
    });
    return { error };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
    setProfile(null);
    setRole(null);
  };

  // ✅ userSlug: nombre sanitizado si ya cargó el perfil, si no fallback a user.id
  const userSlug = profile?.nombre
    ? toSlug(profile.nombre) || user?.id || 'unknown'
    : user?.id || 'unknown';

  const value: AuthContextType = {
    user,
    session,
    profile,
    role,
    isLoading,
    isSupervisor: role === 'supervisor',
    isOperarioMaquinaria: role === 'operario_maquinaria',
    isOperarioCuadrilla: role === 'operario_cuadrilla',
    isSupervisorCuadrilla: role === 'supervisor_cuadrilla',
    userSlug,  // ✅ nuevo

    signIn,
    signUp,
    signOut,
    refreshProfile,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}