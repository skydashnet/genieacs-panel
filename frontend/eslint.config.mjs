import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'node_modules/**']
  },
  {
    // `test` is linted with the same parser and rules as the code it guards: a
    // test that only the runner understands is a test nobody reviews.
    files: ['src/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        }
      },
      globals: { ...globals.browser, ...globals.node }
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,
      ...reactHooks.configs.flat.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'no-undef': 'off',
      'no-empty': 'off',
      // A `const` read inside a callback that runs during render — a filter, a
      // map — is in its temporal dead zone if the declaration comes later in
      // the component, and `tsc` does not see it because the read is in a
      // nested function. It produced a black page for every authenticated
      // route once. `variables: true` is what makes the rule look through the
      // nested function; without it, that case is exactly the one it ignores.
      '@typescript-eslint/no-use-before-define': ['error', { functions: false, classes: false, variables: true }]
    }
  }
];
