import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/constants.ts'],
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  dts: true,
  clean: true
})
