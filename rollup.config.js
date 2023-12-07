import resolve from '@rollup/plugin-node-resolve'

export default {
  input: './dist-ts/index.js',
  plugins: [
    resolve({
      preferBuiltins: true,
    }),
  ],
  output: [
    { format: 'esm', file: './dist/index.mjs' },
    { format: 'cjs', file: './dist/index.cjs' },
  ],
  external: [
    // peer deps
    'aws-sdk',
    'graphql',
    'graphql/execution/execute',
    'graphql/execution/values',
    // actual deps
    'debug',
    'streaming-iterables',
    // we only use a string and types from this package so lets import it
    // 'graphql-ws',
  ],
}
