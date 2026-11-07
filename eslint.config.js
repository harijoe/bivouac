import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default [
  { ignores: ['**/dist/**', '**/node_modules/**', 'packages/shared/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } },
  { files: ['**/*.mjs', '**/*.js', 'packages/task-image/**'], languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', fetch: 'readonly', Response: 'readonly', document: 'readonly', Headers: 'readonly' } } },
];
