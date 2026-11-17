// Sealing keeps the hidden material (reference apps, graders) and each attempt's results
// unreadable on disk while later attempts run: AES-256-GCM over a gzipped file map.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

export const newKey = () => randomBytes(32)

/** `tree` encrypted with `key`: a 12-byte nonce, the 16-byte tag, then the ciphertext. */
export function seal(tree, key) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const files = Object.fromEntries(
    Object.entries(tree).map(([path, content]) => [
      path,
      Buffer.from(content).toString('base64'),
    ]),
  )
  const body = Buffer.concat([
    cipher.update(gzipSync(JSON.stringify(files))),
    cipher.final(),
  ])
  return Buffer.concat([nonce, cipher.getAuthTag(), body])
}

/** The tree `sealed` holds; throws when the key is wrong or the data changed. */
export function unseal(sealed, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12))
  decipher.setAuthTag(sealed.subarray(12, 28))
  const json = gunzipSync(
    Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]),
  )
  return Object.fromEntries(
    Object.entries(JSON.parse(json)).map(([path, content]) => [
      path,
      Buffer.from(content, 'base64'),
    ]),
  )
}
