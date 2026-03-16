import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';
import * as path from 'path';

config();

const SUPABASE_URL = process.env.EMPRESARIAL_SUPABASE_URL!;
const SERVICE_KEY  = process.env.EMPRESARIAL_SERVICE_ROLE_KEY!;
const APPLY        = process.argv.includes('--apply');
const ZONA_TARGET  = 'Centro';
const ROLE_TARGET  = 'operario_maquinaria';
const EXCEL_PATH   = path.resolve('operarios_con_correos.xlsx');

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('❌ Faltan variables de entorno EMPRESARIAL_SUPABASE_URL / EMPRESARIAL_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  console.log(`\n🚀 Modo: ${APPLY ? '⚠️  APPLY (escribe en DB)' : 'DRY-RUN (sin cambios)'}`);
  console.log(`🎯 Zona: "${ZONA_TARGET}" → role: "${ROLE_TARGET}"\n`);

  // 1) Leer Excel y extraer correos de zona Centro
  const wb = XLSX.readFile(EXCEL_PATH);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<any>(ws);

  const correosCentro: string[] = rows
    .filter((r: any) => r.zona === ZONA_TARGET && r.correo)
    .map((r: any) => String(r.correo).trim().toLowerCase());

  console.log(`📋 Usuarios zona "${ZONA_TARGET}" en Excel: ${correosCentro.length}`);
  correosCentro.forEach(c => console.log(`   - ${c}`));

  if (correosCentro.length === 0) {
    console.log('\n⚠️  No se encontraron usuarios. Verifica el nombre de columna "zona" y el valor "Centro".');
    return;
  }

  // 2) Buscar user_id en auth.users por email (usando admin API)
  console.log('\n🔍 Buscando user_ids en Supabase...\n');

  let actualizados = 0;
  let noEncontrados = 0;
  let errores = 0;

  for (const correo of correosCentro) {
    // Buscar en profiles por nombre no es confiable → usamos listUsers y filtramos por email
    const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });

    if (listErr) {
      console.error('❌ Error listando usuarios:', listErr.message);
      process.exit(1);
    }

    const authUser = users.find(u => u.email?.toLowerCase() === correo);

    if (!authUser) {
      console.log(`  ⚠️  No encontrado en auth: ${correo}`);
      noEncontrados++;
      continue;
    }

    const userId = authUser.id;

    // 3) Verificar role actual
    const { data: roleRow, error: roleErr } = await supabase
      .from('user_roles')
      .select('id, role')
      .eq('user_id', userId)
      .maybeSingle();

    if (roleErr) {
      console.error(`  ❌ Error leyendo role de ${correo}:`, roleErr.message);
      errores++;
      continue;
    }

    const roleActual = roleRow?.role ?? '(sin role)';

    if (roleActual === ROLE_TARGET) {
      console.log(`  ✅ Ya tiene role correcto: ${correo} → ${roleActual}`);
      continue;
    }

    console.log(`  ${APPLY ? '→' : '[dry]'} ${correo} | role: "${roleActual}" → "${ROLE_TARGET}"`);

    if (!APPLY) continue;

    if (roleRow) {
      // UPDATE
      const { error: updErr } = await supabase
        .from('user_roles')
        .update({ role: ROLE_TARGET })
        .eq('id', roleRow.id);

      if (updErr) {
        console.error(`    ❌ Error UPDATE: ${updErr.message}`);
        errores++;
      } else {
        actualizados++;
      }
    } else {
      // INSERT (no tenía role)
      const { error: insErr } = await supabase
        .from('user_roles')
        .insert({ user_id: userId, role: ROLE_TARGET });

      if (insErr) {
        console.error(`    ❌ Error INSERT: ${insErr.message}`);
        errores++;
      } else {
        actualizados++;
      }
    }
  }

  // 4) Resumen
  console.log('\n─────────────────────────────────────');
  console.log(`📊 Resumen:`);
  console.log(`   Encontrados en Excel:     ${correosCentro.length}`);
  console.log(`   No encontrados en auth:   ${noEncontrados}`);
  console.log(`   Errores:                  ${errores}`);
  if (APPLY) {
    console.log(`   ✅ Actualizados/insertados: ${actualizados}`);
  } else {
    console.log(`\n💡 Ejecuta con --apply para aplicar los cambios.`);
  }
  console.log('─────────────────────────────────────\n');
}

main().catch(e => { console.error('❌ Fatal:', e); process.exit(1); });