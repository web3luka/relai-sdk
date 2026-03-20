import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/server.ts',
    'src/client.ts',
    'src/crossmint.ts',
    'src/react/index.ts',
    'src/utils/index.ts',
    'src/management.ts',
    'src/plugins.ts',
    'src/relay-feedback.ts',
    'src/mpp/evm-method.ts',
    'src/mpp/evm-server.ts',
    'src/mpp/evm-client.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  target: 'es2020',
  external: ['react', '8004-solana'],
});
