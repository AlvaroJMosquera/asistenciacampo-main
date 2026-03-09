/**
 * SCRIPT 03: Migrar datos de todas las tablas Personal → Empresarial
 * Respeta el orden de Foreign Keys para evitar errores de integridad.
 *
 * Ejecutar desde la raíz del proyecto:
 *   npx tsx 03-migrate-data.ts
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config()

// ── Clientes ──────────────────────────────────────────────────────────────────

const personalClient = createClient(
  process.env.PERSONAL_SUPABASE_URL!,
  process.env.PERSONAL_SERVICE_ROLE_KEY!
)

const empresarialClient = createClient(
  process.env.EMPRESARIAL_SUPABASE_URL!,
  process.env.EMPRESARIAL_SERVICE_ROLE_KEY!
)

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function migrateTable(tableName: string, batchSize = 500) {
  log(`\n📦 Migrando tabla: ${tableName}`)

  let offset = 0
  let totalInserted = 0
  let totalSkipped = 0

  while (true) {
    // Leer batch desde Personal
    const { data, error: fetchError } = await personalClient
      .from(tableName)
      .select('*')
      .range(offset, offset + batchSize - 1)

    if (fetchError) {
      console.error(`❌ Error leyendo ${tableName}:`, fetchError.message)
      return { inserted: totalInserted, skipped: totalSkipped, error: true }
    }

    if (!data || data.length === 0) break

    // Insertar en Empresarial (ignorar duplicados)
    const { error: insertError, count } = await empresarialClient
      .from(tableName)
      .upsert(data, { onConflict: 'id', ignoreDuplicates: true })

    if (insertError) {
      console.error(`❌ Error insertando en ${tableName}:`, insertError.message)
      return { inserted: totalInserted, skipped: totalSkipped, error: true }
    }

    totalInserted += data.length
    log(`   ✅ Batch ${offset}–${offset + data.length - 1}: ${data.length} registros`)

    if (data.length < batchSize) break
    offset += batchSize
    await sleep(200)
  }

  log(`   📊 ${tableName}: ${totalInserted} registros procesados`)
  return { inserted: totalInserted, skipped: totalSkipped, error: false }
}

// ── Tablas especiales sin columna 'id' ────────────────────────────────────────

async function migrateTableNoPK(tableName: string, conflictColumn: string, batchSize = 500) {
  log(`\n📦 Migrando tabla (sin id): ${tableName}`)

  let offset = 0
  let totalInserted = 0

  while (true) {
    const { data, error: fetchError } = await personalClient
      .from(tableName)
      .select('*')
      .range(offset, offset + batchSize - 1)

    if (fetchError) {
      console.error(`❌ Error leyendo ${tableName}:`, fetchError.message)
      return { inserted: totalInserted, error: true }
    }

    if (!data || data.length === 0) break

    const { error: insertError } = await empresarialClient
      .from(tableName)
      .upsert(data, { onConflict: conflictColumn, ignoreDuplicates: true })

    if (insertError) {
      console.error(`❌ Error insertando en ${tableName}:`, insertError.message)
      return { inserted: totalInserted, error: true }
    }

    totalInserted += data.length
    log(`   ✅ Batch ${offset}–${offset + data.length - 1}: ${data.length} registros`)

    if (data.length < batchSize) break
    offset += batchSize
    await sleep(200)
  }

  log(`   📊 ${tableName}: ${totalInserted} registros procesados`)
  return { inserted: totalInserted, error: false }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function migrateAllData() {
  log('🚀 Iniciando migración de datos...')

  const results: Record<string, any> = {}

  // ── ORDEN ESTRICTO POR FK ──────────────────────────────────────────────────

  // 1. Tablas sin dependencias
  results['actividades']       = await migrateTableNoPK('actividades', 'codigo')
  results['maestro_maquinaria']= await migrateTable('maestro_maquinaria')
  results['geo_lotes']         = await migrateTable('geo_lotes')
  results['geo_lotes_stg']     = await migrateTableNoPK('geo_lotes_stg', 'nom')

  // 2. Tablas que dependen de auth.users
  results['profiles']          = await migrateTable('profiles')
  results['user_roles']        = await migrateTable('user_roles')

  // 3. Tabla principal de asistencia
  results['registros_asistencia'] = await migrateTable('registros_asistencia')

  // 4. Tablas dependientes de registros_asistencia
  results['revision_implemento']  = await migrateTable('revision_implemento')
  results['revision_maquinaria']  = await migrateTable('revision_maquinaria')
  results['tracking_ubicaciones'] = await migrateTable('tracking_ubicaciones')
  results['seguimiento_fotos']    = await migrateTable('seguimiento_fotos')

  // 5. Tablas de fotos (últimas)
  results['revision_implemento_fotos'] = await migrateTable('revision_implemento_fotos')
  results['revision_maquinaria_fotos'] = await migrateTable('revision_maquinaria_fotos')

  // ── RESUMEN FINAL ──────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(55))
  console.log('📊 RESUMEN DE MIGRACIÓN DE DATOS')
  console.log('='.repeat(55))

  let hasErrors = false
  for (const [table, result] of Object.entries(results)) {
    const status = result.error ? '❌' : '✅'
    console.log(`${status} ${table.padEnd(35)} ${result.inserted ?? 0} registros`)
    if (result.error) hasErrors = true
  }

  console.log('='.repeat(55))

  if (hasErrors) {
    console.log('\n⚠️  Hubo errores en algunas tablas. Revisa los logs.')
    process.exit(1)
  } else {
    console.log('\n🎉 Migración de datos completada exitosamente.')
    console.log('➡️  Siguiente paso: ejecutar 04-migrate-storage.ts')
  }
}

migrateAllData()