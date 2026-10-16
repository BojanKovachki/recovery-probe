import js from '@eslint/js'
import prettier from 'eslint-config-prettier/flat'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// Functions in these modules are serialized with page.evaluate and run in the browser,
// so they use browser globals. Keep those functions self-contained: no imports or closures.
const typeScriptFiles = ['**/*.{ts,mts,cts}']

const inPageModules = [
  'src/ipc-check.mjs',
  'src/ipc-observation.mts',
  'src/observation-kit.mts',
  'src/observe-steps.mts',
  'src/pick-marker.mjs',
  'src/refresh.mjs',
  'src/visibility.mts',
]

export default [
  {
    ignores: [
      'node_modules/',
      'artifacts/',
      '.recovery-probe/',
      'dist/',
      // Hand-written declarations for JavaScript modules; generated ones replace them.
      'src/**/*.d.{ts,mts,cts}',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: typeScriptFiles,
  })),
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
  {
    // Tests pass page.evaluate callbacks too.
    files: [...inPageModules, 'test/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    rules: {
      // Empty catch blocks are deliberate best-effort cleanup and polling.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
          caughtErrors: 'none',
        },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: typeScriptFiles,
    languageOptions: { globals: globals.node },
    rules: {
      // The TypeScript rule understands type-only uses; the base rule does not.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  prettier,
]
