import { retrievalBenchmark } from '../test/helpers/retrieval-benchmark.ts'
console.log(JSON.stringify(await retrievalBenchmark(), null, 2))
