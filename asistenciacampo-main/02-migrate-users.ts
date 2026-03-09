/**
 * SCRIPT 02: Migrar usuarios de cuenta Personal → Empresarial
 * Preserva los UUID originales para mantener todas las FK intactas.
 *
 * Ejecutar desde el Codespace:
 *   bun run scripts/migration/02-migrate-users.ts
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

// Cargar variables de entorno desde .env
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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function migrateUsers() {
  log('🚀 Iniciando migración de usuarios...')

  // 1. Obtener todos los usuarios de la cuenta Personal
  const { data: usersData, error: listError } = await personalClient.auth.admin.listUsers({
    perPage: 1000,
  })

  if (listError) {
    console.error('❌ Error obteniendo usuarios de cuenta Personal:', listError)
    process.exit(1)
  }

  const users = usersData.users
  log(`📋 Usuarios encontrados en cuenta Personal: ${users.length}`)

  let migrated = 0
  let skipped = 0
  let failed = 0

  // 2. Crear cada usuario en la cuenta Empresarial
  for (const user of users) {
    try {
      // Verificar si el usuario ya existe en Empresarial
      const { data: existing } = await empresarialClient.auth.admin.getUserById(user.id)

      if (existing?.user) {
        log(`⏭️  Usuario ya existe, omitiendo: ${user.email} (${user.id})`)
        skipped++
        continue
      }

      // Crear usuario preservando el UUID original
      const { error: createError } = await empresarialClient.auth.admin.createUser({
        id: user.id,                          // ← UUID original preservado
        email: user.email,
        phone: user.phone || undefined,
        email_confirm: true,                  // Marcar email como confirmado
        user_metadata: user.user_metadata,
        app_metadata: user.app_metadata,
      })

      if (createError) {
        // Si ya existe con ese UUID, no es un error real
        if (createError.message?.includes('already exists') || createError.message?.includes('already been registered')) {
          log(`⏭️  Usuario ya registrado: ${user.email}`)
          skipped++
        } else {
          console.error(`❌ Error creando usuario ${user.email}:`, createError.message)
          failed++
        }
      } else {
        log(`✅ Migrado: ${user.email} (${user.id})`)
        migrated++
      }

      // Pequeña pausa para no saturar la API
      await sleep(100)

    } catch (err) {
      console.error(`❌ Error inesperado con usuario ${user.email}:`, err)
      failed++
    }
  }

  // 3. Resumen
  console.log('\n' + '='.repeat(50))
  console.log('📊 RESUMEN DE MIGRACIÓN DE USUARIOS')
  console.log('='.repeat(50))
  console.log(`✅ Migrados exitosamente : ${migrated}`)
  console.log(`⏭️  Omitidos (ya existen): ${skipped}`)
  console.log(`❌ Fallidos              : ${failed}`)
  console.log(`📋 Total procesados      : ${users.length}`)
  console.log('='.repeat(50))

  if (failed > 0) {
    console.log('\n⚠️  Hay usuarios fallidos. Revisa los errores antes de continuar.')
    process.exit(1)
  } else {
    console.log('\n🎉 Migración de usuarios completada exitosamente.')
    console.log('➡️  Siguiente paso: ejecutar 03-migrate-data.ts')
  }
}

migrateUsers()