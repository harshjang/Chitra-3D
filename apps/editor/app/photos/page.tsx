import type { Metadata } from 'next'
import { PhotoReconstructionPanel } from './photo-reconstruction-panel'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Chitra | Photos to 3D room',
  description: 'Turn photos of a room into an editable 3D room.',
}

export default function PhotosPage() {
  return <PhotoReconstructionPanel />
}
