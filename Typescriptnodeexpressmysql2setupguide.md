# Production-Grade TypeScript + Node.js + Express + MySQL2 Setup Guide

A step-by-step reference for setting up a Node.js backend with TypeScript, ESM, ESLint, Express, and MySQL2 — from scratch, based on official documentation.

> Official docs referenced throughout:
> - TypeScript: https://www.typescriptlang.org/docs/
> - TypeScript Modules — Choosing Compiler Options: https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html
> - Node.js: https://nodejs.org/docs/
> - ESLint: https://eslint.org/docs/latest/
> - Express: https://expressjs.com/
> - mysql2: https://github.com/sidorares/node-mysql2
> - dotenv: https://www.npmjs.com/package/dotenv
> - tsx: https://tsx.is/

---

## 0. Prerequisites

- Install Node.js (LTS or current stable) from https://nodejs.org/
- Check your version:
  ```bash
  node -v
  npm -v
  ```
  Node **v20.19+, v22.13+, or v24+** is required for current ESLint/tooling compatibility.

---

## 1. Initialize the project

```bash
mkdir myproject && cd myproject
npm init -y
```

This creates a basic `package.json`.

---

## 2. Decide: CommonJS or ESM?

Modern setups should use **ESM** (`import`/`export`), not CommonJS (`require`).

In `package.json`, set:
```json
"type": "module"
```

This tells Node to treat `.js` files as ES modules by default, and is required for the TypeScript `nodenext` module setting used below.

---

## 3. Install TypeScript

Always check https://www.typescriptlang.org/download for the current stable release before installing — **avoid guessing version numbers**.

```bash
npm install -D typescript
```

> ⚠️ Note (as of 2026): TypeScript has two active lines —
> - **TS 6.x** — last version on the original JS-based compiler. Fully stable, and currently required for compatibility with `typescript-eslint` and most ecosystem tooling.
> - **TS 7.x** — new Go-based native compiler, much faster, but as of its initial releases **lacks a stable programmatic API**, so tools like `typescript-eslint` cannot use it yet.
>
> **For now, pin to the TS 6.x line** unless you've confirmed your tooling (ESLint plugins, framework integrations) explicitly supports 7.x:
> ```bash
> npm install -D typescript@6
> ```

Initialize a starter config (optional, we'll replace it anyway):
```bash
npx tsc --init
```

---

## 4. Install Node types

```bash
npm install -D @types/node
```

`@types/node` versioning tracks TypeScript compatibility, not your Node.js version directly — installing the latest is normally fine and expected.

---

## 5. Choose your dev-run tool: `tsx` (recommended)

Per TypeScript's own official guide (https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html), there are **two different `tsconfig` templates** depending on how your code actually runs. Know which one applies to you:

| Scenario | module setting |
|---|---|
| `tsc` emits the real files Node runs directly (no bundler) | `"module": "nodenext"` |
| A bundler or `tsx` handles execution/transformation at runtime | `"module": "esnext"`, `"moduleResolution": "bundler"`, `"noEmit": true` |

**Why `tsx` over `ts-node`:** ts-node's own docs state plainly that its ESM support "relies on APIs which node can and will break in new versions of node" and is "not recommended for production" (https://typestrong.org/ts-node/docs/imports/). `tsx` is built on esbuild and avoids this issue entirely.

```bash
npm uninstall ts-node nodemon
npm install -D tsx
```

If you see an `esbuild` postinstall script warning from npm, approve it — it's legitimate (downloads esbuild's platform binary).

> **Important:** `npm approve-scripts --allow-scripts-pending` is **read-only** — per npm's own docs, it only *lists* packages with unreviewed install scripts and writes nothing to disk. It does **not** approve anything, even though it looks like it should. Running it repeatedly will just print the same warning forever.
>
> To actually approve a package, name it explicitly:
> ```bash
> npm approve-scripts esbuild
> npm install
> ```
> This writes an `allowScripts` entry into `package.json` (e.g. `"esbuild@0.28.2": true`), then `npm install` runs the now-approved script.
>
> To approve everything currently pending at once (only after reviewing the list):
> ```bash
> npm approve-scripts --all
> ```
> Reference: https://docs.npmjs.com/cli/v11/commands/npm-approve-scripts/

### Important: which tsconfig template do YOU need?

If your **production build** actually compiles with `tsc` and runs the output with plain `node` (the common, simplest setup) — e.g.:
```json
"build": "tsc",
"start": "node dist/index.js"
```
...then your **real runtime is Node.js**, not a bundler. Even though `tsx` is used for local dev convenience, your `tsconfig.json` should follow the **Node.js template (`nodenext`)**, not the bundler/tsx template — because that's what actually gets type-checked and shipped. `tsx` (esbuild) is permissive enough to also correctly run `nodenext`-style code, but the reverse isn't guaranteed safe.

---

## 6. `tsconfig.json` (Node.js production template)

```jsonc
{
  "compilerOptions": {
    // File Layout
    "rootDir": "./src",
    "outDir": "./dist",

    // Environment Settings — per TS docs: "I'm compiling and running the outputs in Node.js"
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "esModuleInterop": true,
    "target": "esnext",
    "lib": ["esnext"],
    "types": ["node"],

    // Other Outputs
    "sourceMap": true,
    "declaration": false,
    "declarationMap": false,

    // Stricter Typechecking Options
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,

    // Style Options
    "noImplicitReturns": true,
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,

    // Recommended Options
    "strict": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "noUncheckedSideEffectImports": true,
    "moduleDetection": "force",
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Consequence of `verbatimModuleSyntax` + `nodenext`:** all relative imports need explicit `.js` extensions, even though the source files are `.ts`:
```typescript
import { env } from "./config/env.js"; // correct, even though the file is env.ts
```

Do **not** add `noEmit`, `allowImportingTsExtensions`, or `allowArbitraryExtensions` to this config — those belong only to the bundler/tsx-as-runtime template, and will silently break your `tsc` build (e.g. `noEmit: true` means `npm run build` produces no files at all).

---

## 7. Set up ESLint

Use the official ESLint config wizard: https://eslint.org/docs/latest/use/getting-started

```bash
npm init @eslint/config@latest
```

Answer the prompts:

| Prompt | Answer for this stack |
|---|---|
| What do you want to lint? | JavaScript |
| How would you like to use ESLint? | To check syntax and find problems |
| What type of modules does your project use? | JavaScript modules (import/export) — since we use ESM |
| Which framework does your project use? | None of these |
| Does your project use TypeScript? | Yes |
| Where does your code run? | Node (**not** Browser — watch for this default!) |
| Config file language? | JavaScript (simplest) or TypeScript (if you want full TS, note it needs a loader like `jiti`) |
| Install dependencies now? | Yes |
| Package manager? | npm |

This installs `eslint`, `@eslint/js`, `globals`, and `typescript-eslint`, and generates `eslint.config.js` (or `.mts`/`.ts`).

> **If you chose a `.ts`/`.mts`/`.cts` config file:** ESLint needs an extra loader to execute it. Per the official docs (https://eslint.org/docs/latest/use/configure/configuration-files): "for Node.js, you must install the optional dev dependency `jiti` in version 2.2.0 or later — this dependency is not automatically installed by ESLint." Without it, `npx eslint .` fails with `Error: The 'jiti' library is required for loading TypeScript configuration files.`
> ```bash
> npm install -D jiti
> ```
> This applies even on newer Node.js versions with native TypeScript support — ESLint 10.x still requires `jiti` explicitly rather than relying on Node's native stripping.

### If you hit a version conflict (ERESOLVE) during install

This usually means your installed `typescript` version is incompatible with `typescript-eslint`'s peer requirement. Check https://www.npmjs.com/package/typescript-eslint for its currently supported TypeScript version range, and pin `typescript` accordingly (see step 3).

### Sample `eslint.config.ts` for Node + TypeScript + ESM

```typescript
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist", "node_modules"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
    },
  }
);
```

Verify:
```bash
npx eslint .
```

---

## 8. Install runtime dependencies

```bash
npm install express mysql2 dotenv cors helmet cookie-parser
npm install -D @types/express @types/cors @types/cookie-parser
```

> **Note on `dotenv`:** do **not** install `@types/dotenv` — it's officially deprecated. Per its own npm page: "dotenv provides its own type definitions, so you do not need this installed." (https://www.npmjs.com/package/@types/dotenv)

---

## 9. Folder structure

```
src/
  config/
    env.ts
    db.ts
  routes/
  controllers/
  middlewares/
    errorHandler.ts
  types/
  app.ts
  index.ts
.env
.gitignore
```

```bash
mkdir src
mkdir src/config src/routes src/controllers src/middlewares src/types
```

---

## 10. Source files

### `src/config/env.ts`
```typescript
import dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const env = {
  PORT: process.env.PORT ?? "5000",
  DB_HOST: required("DB_HOST"),
  DB_USER: required("DB_USER"),
  DB_PASSWORD: process.env.DB_PASSWORD ?? "",
  DB_NAME: required("DB_NAME"),
  DB_PORT: process.env.DB_PORT ?? "3306",
};
```

### `src/config/db.ts`
Uses `mysql2/promise` for async/await support (official recommended usage: https://github.com/sidorares/node-mysql2#using-promise-wrapper):
```typescript
import mysql from "mysql2/promise";
import { env } from "./env.js";

export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: Number(env.DB_PORT),
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});
```

### `src/middlewares/errorHandler.ts`
```typescript
import type { Request, Response, NextFunction } from "express";

interface AppError extends Error {
  status?: number;
}

export function errorHandler(
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  console.error(err);
  res.status(err.status ?? 500).json({
    message: err.message || "Internal Server Error",
  });
}
```

### `src/app.ts`
```typescript
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { errorHandler } from "./middlewares/errorHandler.js";

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use(errorHandler);

export default app;
```

### `src/index.ts`
```typescript
import app from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./config/db.js";

async function startServer() {
  try {
    const connection = await pool.getConnection();
    connection.release();
    console.log("MySQL connected");

    app.listen(Number(env.PORT), () => {
      console.log(`Server running on port ${env.PORT}`);
    });
  } catch (err) {
    console.error("Failed to connect to DB:", err);
    process.exit(1);
  }
}

startServer();
```

### `.env`
```
PORT=5000
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=yourpassword
DB_NAME=yourdatabase
```

### `.gitignore`
```
node_modules
dist
.env
```

---

## 11. `package.json` scripts

```json
{
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "lint": "eslint ."
  }
}
```

---

## 12. Run it

```bash
npm run dev
```

For production:
```bash
npm run build
npm start
```

---

## Quick reference: common pitfalls this guide avoids

1. **`ts-node` + ESM in production** — officially discouraged by ts-node itself; use `tsx` or Node's native TS stripping instead.
2. **Mixing bundler-style and Node-style `tsconfig` settings** (e.g. `noEmit` + `nodenext` together) — pick one template based on what actually emits/runs your code.
3. **`@types/dotenv`** — deprecated, unnecessary; `dotenv` ships its own types.
4. **ESLint "Where does your code run?" defaulting to Browser** — must be switched to Node for a backend project.
5. **Guessing version numbers** — always verify current stable releases against the official npm page or project site before installing, since AI training data and casual assumptions can be outdated or wrong.
6. **Missing `.js` extensions in relative imports** — required under `nodenext` + `verbatimModuleSyntax`, even for `.ts` source files.
7. **`npm approve-scripts --allow-scripts-pending`** — this flag only *lists* pending install scripts, it doesn't approve them. Use `npm approve-scripts <pkg>` (e.g. `npm approve-scripts esbuild`) followed by `npm install` to actually approve and run a package's install script.
8. **ESLint `.ts`/`.mts` config files need `jiti`** — install it explicitly (`npm install -D jiti`, v2.2.0+) or ESLint will fail with "The 'jiti' library is required for loading TypeScript configuration files," even on Node versions with native TS support.

---

## Where to check things yourself next time

| What | Where |
|---|---|
| TypeScript current stable version | https://www.typescriptlang.org/download or `npm view typescript version` |
| TypeScript compiler option guidance | https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html |
| ESLint setup | https://eslint.org/docs/latest/use/getting-started |
| typescript-eslint supported TS versions | https://typescript-eslint.io/users/dependency-versions/ |
| Node.js LTS schedule | https://nodejs.org/en/about/previous-releases |
| mysql2 usage docs | https://github.com/sidorares/node-mysql2 |
| Express docs | https://expressjs.com/en/guide/routing.html |
| tsx docs | https://tsx.is/ |
| npm approve-scripts / install-scripts policy | https://docs.npmjs.com/cli/v11/commands/npm-approve-scripts/ |