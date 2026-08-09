import { requireAuth } from '@/lib/auth'
import Importer from './importer'

export default async function ImportPage() {
  await requireAuth()
  return <Importer />
}
