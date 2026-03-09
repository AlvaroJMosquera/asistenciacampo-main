/**
 * SCRIPT 07: Actualizar contraseña de un usuario específico
 * Ejecutar desde la raíz del proyecto:
 *   npx tsx 07-update-password.ts
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config()

const empresarialClient = createClient(
  process.env.EMPRESARIAL_SUPABASE_URL!,
  process.env.EMPRESARIAL_SERVICE_ROLE_KEY!
)

// ── EDITA AQUÍ ────────────────────────────────────────────────
const USUARIOS: { email: string; password: string }[] = [
  //{ email: 'maquinaria@prueba.com', password: '123456' },
  { email: 'supervisormaquinaria@prueba.com', password: '123456' },
  //{ email: 'prueba@prueba.com', password: '123456' },
 // { email: 'sacorreaca@unal.edu.co', password: '123456' },

]
// ─────────────────────────────────────────────────────────────

async function updatePasswords() {
  console.log('🚀 Actualizando contraseñas...\n')

  // Cargar usuarios una sola vez
  const { data: listData, error: listError } = await empresarialClient.auth.admin.listUsers({ perPage: 1000 })
  if (listError) {
    console.error('❌ Error listando usuarios:', listError.message)
    process.exit(1)
  }

  const userMap = new Map(listData.users.map(u => [u.email?.toLowerCase(), u.id]))

  let updated = 0
  let failed = 0

  for (const { email, password } of USUARIOS) {
    const userId = userMap.get(email.toLowerCase())

    if (!userId) {
      console.log(`⚠️  No encontrado: ${email}`)
      failed++
      continue
    }

    const { error } = await empresarialClient.auth.admin.updateUserById(userId, { password })

    if (error) {
      console.error(`❌ Error en ${email}:`, error.message)
      failed++
    } else {
      console.log(`✅ ${email} → contraseña actualizada`)
      updated++
    }
  }

  console.log('\n' + '='.repeat(45))
  console.log(`✅ Actualizados : ${updated}`)
  console.log(`❌ Fallidos     : ${failed}`)
  console.log('='.repeat(45))
}

updatePasswords()