import js from '@eslint/js'
import prettier from 'eslint-config-prettier/flat'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// Functions in these modules are serialized with page.evaluate and run in the browser,
// so they use browser globals. Keep those functions self-contained: no imports or closures.
const typeScriptFiles = ['**/*.{ts,mts,cts}']

const inPageModules = [
  'src/core/screen.mts',
  'src/targets/visibility.mts',
  'src/tools/pick-marker.mts',
  'src/workflows/action.mts',
  'src/workflows/check/ipc.mts',
  'src/workflows/observe/kit.mts',
  'src/workflows/observe/steps.mts',
  'src/workflows/refresh.mts',
]

export default [
  {
    ignores: ['node_modules/', 'artifacts/', '.recovery-probe/', 'dist/'],
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
  {
    // Violations that predate these limits are listed in eslint-suppressions.json;
    // `npm run lint` fails on new ones and on entries that no longer apply.
    files: ['src/**/*.{mts,cts}'],
    rules: {
      'max-lines': [
        'error',
        { max: 300, skipBlankLines: true, skipComments: true },
      ],
      'max-lines-per-function': [
        'error',
        { max: 50, skipBlankLines: true, skipComments: true },
      ],
      complexity: ['error', 12],
      'max-depth': ['error', 4],
      'max-params': ['error', 4],
    },
  },
  prettier,
]
