-- Create role enum
CREATE TYPE public.app_role AS ENUM ('operario', 'supervisor');

-- Create profiles table
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create user_roles table (separate for security)
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, role)
);

-- Create registros_asistencia table
CREATE TABLE public.registros_asistencia (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fecha DATE NOT NULL DEFAULT CURRENT_DATE,
  tipo_registro TEXT NOT NULL CHECK (tipo_registro IN ('entrada', 'salida')),
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  latitud DOUBLE PRECISION,
  longitud DOUBLE PRECISION,
  precision_gps DOUBLE PRECISION,
  fuera_zona BOOLEAN NOT NULL DEFAULT false,
  foto_url TEXT,
  estado_sync TEXT NOT NULL DEFAULT 'sincronizado' CHECK (estado_sync IN ('sincronizado', 'pendiente_sync')),
  es_inconsistente BOOLEAN NOT NULL DEFAULT false,
  nota_inconsistencia TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registros_asistencia ENABLE ROW LEVEL SECURITY;

-- Security definer function to check roles (avoids RLS recursion)
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;

-- Function to check if user is first (for auto-admin)
CREATE OR REPLACE FUNCTION public.is_first_user()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (SELECT COUNT(*) FROM public.profiles) = 0
$$;

-- Function to handle new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  is_first BOOLEAN;
  user_role app_role;
  user_name TEXT;
BEGIN
  -- Check if this is the first user
  SELECT (SELECT COUNT(*) FROM public.profiles) = 0 INTO is_first;
  
  -- Determine role based on whether first user or not
  IF is_first THEN
    user_role := 'supervisor';
  ELSE
    user_role := 'operario';
  END IF;
  
  -- Get name from metadata or use email
  user_name := COALESCE(
    NEW.raw_user_meta_data ->> 'nombre',
    NEW.raw_user_meta_data ->> 'full_name',
    split_part(NEW.email, '@', 1)
  );
  
  -- Insert profile
  INSERT INTO public.profiles (id, nombre)
  VALUES (NEW.id, user_name);
  
  -- Insert role
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, user_role);
  
  RETURN NEW;
END;
$$;

-- Trigger to create profile and role on signup
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Trigger for profiles updated_at
CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- RLS Policies for profiles
CREATE POLICY "Users can view own profile"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Supervisors can view all profiles"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'supervisor'));

CREATE POLICY "Users can update own profile"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Supervisors can update any profile"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'supervisor'));

-- RLS Policies for user_roles
CREATE POLICY "Users can view own role"
  ON public.user_roles
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Supervisors can view all roles"
  ON public.user_roles
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'supervisor'));

CREATE POLICY "Supervisors can manage roles"
  ON public.user_roles
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'supervisor'));

-- RLS Policies for registros_asistencia
CREATE POLICY "Users can view own records"
  ON public.registros_asistencia
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own records"
  ON public.registros_asistencia
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Supervisors can view all records"
  ON public.registros_asistencia
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'supervisor'));

CREATE POLICY "Supervisors can update any record"
  ON public.registros_asistencia
  FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'supervisor'));

-- Create indexes for performance
CREATE INDEX idx_registros_user_fecha ON public.registros_asistencia(user_id, fecha);
CREATE INDEX idx_registros_fecha ON public.registros_asistencia(fecha);
CREATE INDEX idx_registros_tipo ON public.registros_asistencia(tipo_registro);
CREATE INDEX idx_user_roles_user_id ON public.user_roles(user_id);

-- Create storage bucket for attendance photos
INSERT INTO storage.buckets (id, name, public)
VALUES ('attendance-photos', 'attendance-photos', true);

-- Storage policies for attendance photos
CREATE POLICY "Users can upload own photos"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'attendance-photos' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can view own photos"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'attendance-photos' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Supervisors can view all photos"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'attendance-photos' AND public.has_role(auth.uid(), 'supervisor'));

CREATE POLICY "Public can view attendance photos"
  ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'attendance-photos');