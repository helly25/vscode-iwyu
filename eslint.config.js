const typescriptParser = require('@typescript-eslint/parser');
const typescriptPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
    {
        ignores: ["**/out", "**/dist", "**/*.d.ts"]
    },
    {
        files: [
            "src/*.ts",
            "src/**/*.ts"
        ],
        ignores: [
            "eslint.config.js"
        ],
        plugins: {
            "@typescript-eslint": typescriptPlugin
        },

        languageOptions: {
            sourceType: "module",
            parser: typescriptParser,
            parserOptions: {
                ecmaVersion: 2020
            }
        },

        rules: {
            "@typescript-eslint/naming-convention": "warn",
            curly: "warn",
            eqeqeq: "warn",
            "no-throw-literal": "warn",
            semi: "error",
            "prefer-const": "error"
        }
    },
    {
        files: [
            "src/*.ts",
            "src/**/*.ts"
        ],
        languageOptions: {
            parserOptions: {
                project: ["./tsconfig.json"]
            }
        }
    }
];
