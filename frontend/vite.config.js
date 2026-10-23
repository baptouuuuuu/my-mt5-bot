import { defineConfig, loadEnv } from 'vite';

// VITE_BASE: public path. Use "/<repo-name>/" for GitHub Pages project sites. Defaults to
// relative assets ("./"), which works on Pages and locally (the app uses hash routing).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return { base: env.VITE_BASE || './' };
});
