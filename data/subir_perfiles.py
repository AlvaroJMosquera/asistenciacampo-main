import os
import re
import pandas as pd
from supabase import create_client, Client

# ========= CONFIG =========
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://javtaiuvkvkqiofqmzda.supabase.co")
SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphdnRhaXV2a3ZrcWlvZnFtemRhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2ODU3NjE1NywiZXhwIjoyMDg0MTUyMTU3fQ.Ju5ghDBWbIiZuvnFvpXf5Z5C5Z1GOhZfQkZSrGcf8c0")

EXCEL_PATH = "/workspaces/asistenciacampo-main/data/operarios_con_correos.xlsx"  # <-- tu archivo

# ✅ Todos serán operario (debe existir en tu enum)
FORCED_ROLE = "operario"

# ========= HELPERS =========
def normalize_email(email: str) -> str:
    return (email or "").strip().lower()

def normalize_text(x):
    return None if pd.isna(x) else str(x).strip()

def safe_password_from_ficha(ficha: str) -> str:
    f = re.sub(r"\s+", "", str(ficha))
    # Si quieres que sea exactamente la ficha, déjalo así:
    return f

# ========= MAIN =========
def main():
    if "TU_SERVICE_ROLE_KEY" in SERVICE_ROLE_KEY:
        raise RuntimeError("Configura SUPABASE_SERVICE_ROLE_KEY (Service Role) antes de ejecutar.")

    supabase: Client = create_client(SUPABASE_URL, SERVICE_ROLE_KEY)

    df = pd.read_excel(EXCEL_PATH, dtype=str).fillna("")

    required_cols = ["ficha", "nombre", "cargo", "telefono", "zona", "correo", "contrasena"]
    missing = [c for c in required_cols if c not in df.columns]
    if missing:
        raise RuntimeError(f"Faltan columnas en el Excel: {missing}")

    created = 0
    existed = 0
    errors = []

    for i, row in df.iterrows():
        ficha = normalize_text(row["ficha"])
        nombre = normalize_text(row["nombre"])
        cargo = normalize_text(row["cargo"])
        telefono = normalize_text(row["telefono"])
        zona = normalize_text(row["zona"])
        correo = normalize_email(row["correo"])

        if not correo:
            errors.append((i, "correo vacío"))
            continue
        if not ficha:
            errors.append((i, f"{correo}: ficha vacía (la usas como contraseña)"))
            continue

        password = safe_password_from_ficha(ficha)
        role = FORCED_ROLE

        try:
            # 1) Crear usuario en Auth (Admin)
            user_id = None
            try:
                resp = supabase.auth.admin.create_user({
                    "email": correo,
                    "password": password,
                    "email_confirm": True
                })
                user_id = resp.user.id
                created += 1
            except Exception as e_create:
                # Ya existe o error: buscar por email
                users_page = supabase.auth.admin.list_users()
                found = None
                for u in users_page.users:
                    if (u.email or "").lower() == correo:
                        found = u
                        break
                if not found:
                    raise RuntimeError(f"No se pudo crear y tampoco encontrar el usuario {correo}. Error: {e_create}")
                user_id = found.id
                existed += 1

            # 2) Upsert en profiles
            profile_payload = {
                "id": user_id,
                "nombre": nombre or correo.split("@")[0],
                "activo": True,
                "ficha": ficha,
                "cargo": cargo,
                "telefono": telefono,
                "zona": zona,
            }
            supabase.table("profiles").upsert(profile_payload, on_conflict="id").execute()

            # 3) Upsert/Insert en user_roles
            role_payload = {"user_id": user_id, "role": role}

            # Si tienes UNIQUE(user_id) -> esto funciona perfecto
            try:
                supabase.table("user_roles").upsert(role_payload, on_conflict="user_id").execute()
            except Exception:
                # Si NO tienes UNIQUE(user_id), esto puede duplicar
                supabase.table("user_roles").insert(role_payload).execute()

            print(f"OK -> {correo} | id={user_id} | role={role}")

        except Exception as e:
            errors.append((i, f"{correo}: {str(e)}"))

    print("\n==== RESUMEN ====")
    print(f"Creados nuevos: {created}")
    print(f"Ya existían: {existed}")
    print(f"Errores: {len(errors)}")
    if errors:
        print("\n-- Detalle errores --")
        for idx, msg in errors[:50]:
            print(f"Fila {idx+2}: {msg}")  # +2 por encabezado + base 0

if __name__ == "__main__":
    main()