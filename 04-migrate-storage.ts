/**
 * SCRIPT 04: Migrar fotos Storage Personal → Empresarial
 * Bucket: attendance-photos
 *
 * Ejecutar desde la raíz del proyecto:
 *   npx tsx 04-migrate-storage.ts
 *
 * IMPORTANTE: Antes de ejecutar, crea el bucket en la cuenta Empresarial:
 *   Supabase Dashboard Empresarial → Storage → New bucket → attendance-photos
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

const BUCKET = 'attendance-photos'
const PERSONAL_URL = process.env.PERSONAL_SUPABASE_URL!
const EMPRESARIAL_URL = process.env.EMPRESARIAL_SUPABASE_URL!

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Listar todos los archivos recursivamente dentro de una carpeta
async function listAllFiles(folder: string = ''): Promise<string[]> {
  const { data, error } = await personalClient.storage
    .from(BUCKET)
    .list(folder, { limit: 1000, offset: 0 })

  if (error) {
    console.error(`❌ Error listando carpeta "${folder}":`, error.message)
    return []
  }

  if (!data || data.length === 0) return []

  const files: string[] = []

  for (const item of data) {
    const fullPath = folder ? `${folder}/${item.name}` : item.name

    if (item.metadata === null || item.id === null) {
      // Es una carpeta, explorar recursivamente
      const subFiles = await listAllFiles(fullPath)
      files.push(...subFiles)
    } else {
      // Es un archivo
      files.push(fullPath)
    }
  }

  return files
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function migrateStorage() {
  log(`🚀 Iniciando migración del bucket: ${BUCKET}`)

  // 1. Listar todos los archivos
  log('📋 Listando archivos en bucket Personal...')
  const allFiles = await listAllFiles()
  log(`📋 Total archivos encontrados: ${allFiles.length}`)

  if (allFiles.length === 0) {
    log('⚠️  No se encontraron archivos. Verifica que el bucket existe y tiene contenido.')
    process.exit(0)
  }

  let migrated = 0
  let skipped = 0
  let failed = 0
  const failedFiles: string[] = []

  // 2. Migrar cada archivo
  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i]

    try {
      // Verificar si ya existe en Empresarial
      const { data: existingData } = await empresarialClient.storage
        .from(BUCKET)
        .list(filePath.substring(0, filePath.lastIndexOf('/')), { limit: 1000 })

      const fileName = filePath.split('/').pop()!
      const alreadyExists = existingData?.some(f => f.name === fileName)

      if (alreadyExists) {
        skipped++
        if (skipped % 50 === 0) log(`⏭️  ${skipped} archivos ya existían, omitiendo...`)
        continue
      }

      // Descargar desde Personal
      const { data: fileData, error: downloadError } = await personalClient.storage
        .from(BUCKET)
        .download(filePath)

      if (downloadError || !fileData) {
        console.error(`❌ Error descargando ${filePath}:`, downloadError?.message)
        failed++
        failedFiles.push(filePath)
        continue
      }

      // Subir a Empresarial
      const { error: uploadError } = await empresarialClient.storage
        .from(BUCKET)
        .upload(filePath, fileData, {
          upsert: true,
          contentType: fileData.type || 'application/octet-stream',
        })

      if (uploadError) {
        console.error(`❌ Error subiendo ${filePath}:`, uploadError.message)
        failed++
        failedFiles.push(filePath)
        continue
      }

      migrated++

      // Log de progreso cada 20 archivos
      if (migrated % 20 === 0) {
        log(`📤 Progreso: ${migrated + skipped}/${allFiles.length} (${migrated} migrados, ${skipped} omitidos, ${failed} fallidos)`)
      }

      // Pausa para no saturar la API
      await sleep(50)

    } catch (err) {
      console.error(`❌ Error inesperado con ${filePath}:`, err)
      failed++
      failedFiles.push(filePath)
    }
  }

  // 3. Actualizar URLs en las tablas
  log('\n🔗 Actualizando URLs en las tablas...')
  await updateStorageUrls()

  // 4. Resumen
  console.log('\n' + '='.repeat(55))
  console.log('📊 RESUMEN DE MIGRACIÓN DE STORAGE')
  console.log('='.repeat(55))
  console.log(`✅ Migrados exitosamente : ${migrated}`)
  console.log(`⏭️  Omitidos (ya existen): ${skipped}`)
  console.log(`❌ Fallidos              : ${failed}`)
  console.log(`📋 Total procesados      : ${allFiles.length}`)
  console.log('='.repeat(55))

  if (failedFiles.length > 0) {
    console.log('\n❌ Archivos fallidos:')
    failedFiles.forEach(f => console.log(`   - ${f}`))
  }

  if (failed > 0) {
    console.log('\n⚠️  Algunos archivos no se migraron. Puedes volver a ejecutar el script para reintentarlos.')
  } else {
    console.log('\n🎉 Migración de Storage completada exitosamente.')
    console.log('✅ Migración completa finalizada. El proyecto Empresarial está listo.')
  }
}

// ── Actualizar URLs en tablas ─────────────────────────────────────────────────

async function updateStorageUrls() {
  // Construir las URLs base de ambos proyectos
  const oldBase = `${PERSONAL_URL}/storage/v1/object/public/${BUCKET}`
  const newBase = `${EMPRESARIAL_URL}/storage/v1/object/public/${BUCKET}`

  log(`   Reemplazando: ${oldBase}`)
  log(`   Por:          ${newBase}`)

  const tables = [
    { table: 'registros_asistencia', columns: ['foto_url', 'permiso_foto_url'] },
    { table: 'seguimiento_fotos', columns: ['foto_url'] },
    { table: 'revision_implemento_fotos', columns: ['foto_url'] },
    { table: 'revision_maquinaria_fotos', columns: ['foto_url'] },
  ]

  for (const { table, columns } of tables) {
    for (const column of columns) {
      // Leer registros con URL del proyecto Personal
      const { data, error: fetchError } = await empresarialClient
        .from(table)
        .select(`id, ${column}`)
        .like(column, `${oldBase}%`)

      if (fetchError) {
        console.error(`❌ Error leyendo ${table}.${column}:`, fetchError.message)
        continue
      }

      if (!data || data.length === 0) {
        log(`   ✅ ${table}.${column}: sin URLs que actualizar`)
        continue
      }

      // Actualizar cada registro
      let updated = 0
      for (const row of data) {
        const newUrl = (row[column] as string).replace(oldBase, newBase)
        const { error: updateError } = await empresarialClient
          .from(table)
          .update({ [column]: newUrl })
          .eq('id', row.id)

        if (updateError) {
          console.error(`❌ Error actualizando ${table}.${column} (${row.id}):`, updateError.message)
        } else {
          updated++
        }
      }

      log(`   ✅ ${table}.${column}: ${updated} URLs actualizadas`)
    }
  }
}

migrateStorage()