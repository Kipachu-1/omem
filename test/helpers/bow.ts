import type { Embedder } from '../../src/embed.ts'

/** Deterministic test embeddings; no network or downloaded model. */
export const bow: Embedder = {
  model: 'quality-bow',
  async embed(texts) {
    return texts.map(text => {
      const v = new Float32Array(256)
      for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        let hash = 5381
        for (const char of word) hash = (hash * 33 + char.codePointAt(0)!) >>> 0
        v[hash % v.length]++
      }
      const norm = Math.hypot(...v) || 1
      return v.map(x => x / norm)
    })
  },
}
