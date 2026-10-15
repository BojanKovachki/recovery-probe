import js from '@eslint/js'
import prettier from 'eslint-config-prettier/flat'
import globals from 'globals'

// Functions in these modules are serialized with page.evaluate and run in the browser,
// so they use browser globals. Keep those functions self-contained: no imports or closures.
const inPageModules = [
  'src/ipc-check.mjs',
  'src/ipc-observation.mjs',
  'src/observation-kit.mjs',
  'src/observe-steps.mjs',
  'src/pick-marker.mjs',
  'src/refresh.mjs',
  'src/visibility.mjs',
]

export default [
  { ignores: ['node_modules/', 'artifacts/', '.recovery-probe/'] },
  js.configs.recommended,
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
  prettier,
]
