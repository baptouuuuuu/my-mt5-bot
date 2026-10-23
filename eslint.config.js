import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/data/**'] },
  js.configs.recommended,
  { files: ['backend/**/*.js', 'eslint.config.js'], languageOptions: { globals: globals.node } },
  { files: ['frontend/src/**/*.js'], languageOptions: { globals: globals.browser } },
  { files: ['frontend/vite.config.js'], languageOptions: { globals: globals.node } },
];
