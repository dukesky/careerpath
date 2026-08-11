import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // `.claude/**` covers git worktrees created under `.claude/worktrees/`:
    // their build output is not matched by the root-anchored `.next/**` above,
    // so without this a worktree that has been built once makes `npm run lint`
    // in the main checkout fail on thousands of generated files.
    // `extension/**` is the sibling Chrome extension package: it has its own
    // eslint.config.mjs and build output (extension/dist), neither of which
    // the Next.js config should ever walk into.
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      ".claude/**",
      "extension/**",
    ],
  },
];

export default eslintConfig;
