export interface Embedder {
  model: string
  embed(texts: string[], kind: 'doc' | 'query'): Promise<Float32Array[]>
}

// asymmetric models need task prefixes or retrieval quality quietly drops
const PREFIXES: [RegExp, { doc: string; query: string }][] = [
  [/e5/i, { doc: 'passage: ', query: 'query: ' }],
  [/nomic-embed/i, { doc: 'search_document: ', query: 'search_query: ' }],
]
const NONE = { doc: '', query: '' }

export const FALLBACK_MODEL = 'Xenova/multilingual-e5-small'
// resolved at call time, not import time — env/config loading must not race module evaluation
export const defaultModel = (): string => process.env.OMEM_EMBED_MODEL ?? FALLBACK_MODEL

// In-process ONNX via transformers.js: no server, model auto-downloads once (~30MB).
export function localEmbedder(model: string = defaultModel()): Embedder {
  const prefix = PREFIXES.find(([re]) => re.test(model))?.[1] ?? NONE
  let pipePromise: Promise<(texts: string[], opts: object) => Promise<{ dims: number[]; data: Float32Array }>> | undefined
  return {
    model,
    async embed(texts, kind) {
      // lazy dynamic import: keyword-only commands never pay onnxruntime startup
      pipePromise ??= import('@huggingface/transformers')
        .then(({ pipeline }) => pipeline('feature-extraction', model, { dtype: 'q8' }) as never)
        .catch(e => {
          pipePromise = undefined // don't cache a failed load; long-running watch retries next time
          throw e
        })
      const pipe = await pipePromise
      const out = await pipe(texts.map(t => prefix[kind] + t), { pooling: 'mean', normalize: true })
      const [n, dim] = out.dims
      return Array.from({ length: n }, (_, i) => out.data.slice(i * dim, (i + 1) * dim))
    },
  }
}

export function vecToBuf(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}

export function bufToVec(b: Buffer): Float32Array {
  // copy: Buffers from the sqlite pool are not guaranteed 4-byte aligned
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}
