/**
 * SCRIPT 03b: Migrar geo_lotes_stg (tabla sin PK) Personal → Empresarial
 * Usa INSERT directo en batches ya que no tiene constraint único.
 *
 * Ejecutar desde la raíz del proyecto:
 *   npx tsx 03b-migrate-geo-stg.ts
 *
 * IMPORTANTE: Ejecutar primero en SQL Editor Empresarial:
 *   TRUNCATE TABLE public.geo_lotes_stg;
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config()

const personalClient = createClient(
  process.env.PERSONAL_SUPABASE_URL!,
  process.env.PERSONAL_SERVICE_ROLE_KEY!
)

const empresarialClient = createClient(
  process.env.EMPRESARIAL_SUPABASE_URL!,
  process.env.EMPRESARIAL_SERVICE_ROLE_KEY!
)

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function migrateGeoLotesStg() {
  log('🚀 Migrando geo_lotes_stg...')

  const batchSize = 500
  let offset = 0
  let totalInserted = 0

  while (true) {
    // Leer batch desde Personal
    const { data, error: fetchError } = await personalClient
      .from('geo_lotes_stg')
      .select('*')
      .range(offset, offset + batchSize - 1)

    if (fetchError) {
      console.error('❌ Error leyendo geo_lotes_stg:', fetchError.message)
      process.exit(1)
    }

    if (!data || data.length === 0) break

    // INSERT directo sin upsert (no hay PK)
    const { error: insertError } = await empresarialClient
      .from('geo_lotes_stg')
      .insert(data)

    if (insertError) {
      console.error('❌ Error insertando en geo_lotes_stg:', insertError.message)
      process.exit(1)
    }

    totalInserted += data.length
    log(`✅ Batch ${offset}–${offset + data.length - 1}: ${data.length} registros`)

    if (data.length < batchSize) break
    offset += batchSize
    await sleep(200)
  }

  console.log('\n' + '='.repeat(50))
  console.log(`✅ geo_lotes_stg: ${totalInserted} registros migrados exitosamente`)
  console.log('='.repeat(50))
  console.log('\n🎉 Listo. Ahora ejecuta: 04-migrate-storage.ts')
}

migrateGeoLotesStg()