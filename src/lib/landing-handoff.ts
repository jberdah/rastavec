const DATABASE = 'rastavec-landing-handoff'
const STORE = 'files'
const MAX_AGE_MS = 10 * 60 * 1000

interface StoredImageHandoff {
  blob: Blob
  name: string
  type: string
  lastModified: number
  createdAt: number
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open the local image handoff.'))
    request.onblocked = () => reject(new Error('The local image handoff is blocked by another tab.'))
  })
}

/** Consume a same-origin image saved by a converter landing page, then remove it. */
export async function consumeLandingImage(id: string): Promise<File | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id) || typeof indexedDB === 'undefined') return null

  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite')
    const images = transaction.objectStore(STORE)
    const request = images.get(id)
    let image: File | null = null

    request.onsuccess = () => {
      const stored = request.result as StoredImageHandoff | undefined
      if (stored) {
        if (Date.now() - stored.createdAt <= MAX_AGE_MS && stored.blob instanceof Blob && stored.name) {
          image = new File([stored.blob], stored.name, { type: stored.type, lastModified: stored.lastModified })
        }
        images.delete(id)
      }
    }
    transaction.oncomplete = () => {
      database.close()
      resolve(image)
    }
    transaction.onerror = () => {
      database.close()
      reject(transaction.error ?? new Error('Could not read the local image handoff.'))
    }
    transaction.onabort = () => {
      database.close()
      reject(transaction.error ?? new Error('The local image handoff was cancelled.'))
    }
  })
}
