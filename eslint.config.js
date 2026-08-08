// @ts-check
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'web/**', 'src/generated/**'] },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
      globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-undef': 'off',
      // Проглоченная ошибка в оптимизаторе стоит денег клиента — запрещаем пустые catch.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
  prettier,
];
