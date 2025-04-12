import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // --- Global Ignores ---
  {
    ignores: ['dist/**/*', 'node_modules/**/*'], // Global ignores for dist and node_modules
  },

  // --- TypeScript Configuration ---
  {
    name: 'typescript-config', // Name for this configuration object (optional, but good practice)
    files: ['src/**/*.{ts,tsx}'], // Target TypeScript files in src
    languageOptions: {
      parser: tseslint.parser, // Use TypeScript parser
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        // project: "./tsconfig.json", // Uncomment for type-aware linting if needed
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin, // Use TypeScript plugin
    },
    rules: {
      ...tseslint.configs.recommended.rules, // Extend recommended TypeScript rules
      // --- Rule Overrides/Customizations ---
      '@typescript-eslint/no-unused-vars': ['warn'], // Example: Override rule severity
      '@typescript-eslint/explicit-function-return-type': 'off', // Example: Turn off a rule
      '@typescript-eslint/no-non-null-assertion': 'off', // Keep this rule turned off as before
      '@typescript-eslint/no-require-imports': 'off', // Keep this off or adjust as needed
    },
  },
]);
