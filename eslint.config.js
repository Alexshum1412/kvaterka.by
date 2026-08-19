// @ts-check
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/**
 * Flat config, because ESLint 9 no longer reads `.eslintrc`.
 *
 * There was no config file at all, so `npm run lint` — and therefore
 * `npm run verify`, which chains typecheck + lint + test — failed on every
 * run regardless of the code. A verification command that cannot pass is a
 * verification command nobody runs.
 *
 * Deliberately narrow: it uses only what is already installed (no
 * `eslint-config-next`, no new dependency) and it does NOT duplicate the
 * type checker. `tsc --noEmit` runs in the same `verify` chain and is the
 * authority on types; rules that merely restate a TypeScript error would
 * make the output twice as long and no more informative.
 *
 * What is left on is the small set of things tsc does not catch and that
 * have actually mattered in this codebase: an unused binding left behind by
 * a refactor, a `catch` that swallows silently by accident, a `==` that
 * should be `===`.
 */
export default [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      '.pgdata/**',
      '.media/**',
      'coverage/**',
      'next-env.d.ts',
      // Editor/agent tooling that ships its own scripts. Not this project's
      // source, and linting it produced 124 of the first run's 137 findings.
      '.claude/**',
    ],
  },

  js.configs.recommended,

  /**
   * A stub for the one Next.js rule this codebase references.
   *
   * Several components use a raw `<img>` on purpose — the photos are
   * user-uploaded and served by our own `/media` route, and `next/image`
   * would need a loader and host allowlist that are not configured while
   * object storage is still unbuilt. Each of those lines carries an
   * `eslint-disable-next-line @next/next/no-img-element` comment.
   *
   * `eslint-config-next` is not installed, so those directives referenced a
   * rule that did not exist, and ESLint 9 treats that as an error — nine of
   * them. Rather than stub the rule as a no-op (which would then report nine
   * "unused disable directive" warnings instead), it is implemented here in
   * the few lines it actually takes. It does the same job as the real one:
   * flag a raw `<img>` so that using one stays a deliberate, annotated
   * choice rather than a habit. Replace this block with the real plugin if
   * `eslint-config-next` is ever added.
   */
  {
    plugins: {
      '@next/next': {
        rules: {
          'no-img-element': {
            meta: {
              schema: [],
              messages: { noImg: 'Use next/image, or annotate why a raw <img> is correct here.' },
            },
            create: (context) => ({
              JSXOpeningElement(node) {
                if (node.name?.type === 'JSXIdentifier' && node.name.name === 'img') {
                  context.report({ node, messageId: 'noImg' });
                }
              },
            }),
          },
        },
      },
    },
    rules: { '@next/next/no-img-element': 'warn' },
  },

  {
    files: ['**/*.{ts,tsx,mts}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        Buffer: 'readonly',
        crypto: 'readonly',
        AbortSignal: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        // Browser globals used by the client components.
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLFormElement: 'readonly',
        HTMLDivElement: 'readonly',
        Event: 'readonly',
        FormData: 'readonly',
        File: 'readonly',
        Blob: 'readonly',
        FileReader: 'readonly',
        Image: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
        React: 'readonly',
        JSX: 'readonly',
        NodeJS: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      // tsc owns types; these would be duplicate reports.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-redeclare': 'off',
      'no-dupe-class-members': 'off',

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none', // `catch {}` and `catch (e)` are both fine.
          ignoreRestSiblings: true,
        },
      ],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      'require-atomic-updates': 'off', // too noisy on legitimate await sequences
    },
  },

  {
    files: ['tests/**/*.ts', '**/*.test.ts', '**/*.test.tsx'],
    languageOptions: {
      globals: { describe: 'readonly', it: 'readonly', expect: 'readonly',
                 beforeAll: 'readonly', afterAll: 'readonly',
                 beforeEach: 'readonly', afterEach: 'readonly', vi: 'readonly' },
    },
  },

  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        // Node 18+ web platform globals, used by the scheduler script. They
        // are as much a part of the runtime as `process`; without them a
        // dependency-free script that calls `fetch` reads as four errors.
        fetch: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
];
