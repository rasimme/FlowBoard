#!/usr/bin/env node
/**
 * Pre-compile the native Control UI entry (T-515-3 / T-515-4).
 *
 * `openclaw plugins build` bundles the Control UI entry, but it compiles JSX
 * in classic mode, does not run Tailwind and does not scope CSS. This step
 * does those three things and writes plain JS + CSS to `.tmp/native-ui/`,
 * which is what `package.json` → `openclaw.controlUi` points at. The official
 * build then only resolves the SDK import and hashes the result.
 *
 * CSS: every selector is prefixed with `.fb-native-root`, so nothing can match
 * a host element. Tokens the host theme also defines are not redeclared, so
 * the dashboard follows the host's light/dark/custom theme; FlowBoard-only
 * tokens (status, note hues, charts) keep their own values. The page paints no
 * background of its own, so the host's page background shows through.
 *
 * Usage: node scripts/build-native-ui.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dash = path.join(rootDir, 'dashboard');
const outDir = path.join(rootDir, '.tmp', 'native-ui');
const require = createRequire(path.join(rootDir, 'package.json'));
const dashRequire = createRequire(path.join(dash, 'package.json'));
const esbuild = require('esbuild');
const postcss = dashRequire('postcss');

export const SCOPE = '.fb-native-root';

/** Tokens the OpenClaw Control UI theme defines under the same name. */
export const HOST_TOKENS = new Set([
  '--bg', '--bg-accent', '--bg-elevated', '--bg-hover', '--card', '--secondary', '--text', '--text-strong',
  '--muted', '--border', '--border-strong', '--accent', '--accent-hover', '--accent-subtle', '--accent-2',
  '--accent-2-subtle', '--ok', '--ok-subtle', '--warn', '--warn-subtle', '--danger', '--danger-subtle',
  '--info', '--info-subtle', '--card-highlight', '--shadow-sm', '--shadow-md', '--shadow-lg', '--radius-sm',
  '--radius-md', '--radius-lg', '--radius-full', '--duration-fast', '--duration-normal', '--duration-slow',
  '--ease-out',
]);

const ROOTISH = /^(:root|html|body)(?![\w-])(.*)$/s;

const scopePlugin = {
  postcssPlugin: 'flowboard-native-scope',
  Rule(rule) {
    for (let p = rule.parent; p; p = p.parent) {
      if (p.type === 'atrule' && /keyframes$/.test(p.name)) return;
    }
    let rootish = false;
    rule.selectors = rule.selectors.map((selector) => {
      const s = selector.trim();
      if (s.startsWith(SCOPE)) return s;
      const match = s.match(ROOTISH);
      if (!match) return `${SCOPE} ${s}`;
      rootish = true;
      return `${SCOPE}${match[2].replace(/^\s*>?\s*body(?![\w-])/, '')}`;
    });
    if (!rootish) return;
    rule.walkDecls((decl) => {
      // Host theme owns these; the page font is the host's as well.
      if (HOST_TOKENS.has(decl.prop) || decl.prop === 'font-family') decl.remove();
      // Note hues were mixed against a fixed dark canvas; follow the host background.
      else if (decl.value.includes('#0a0c10')) decl.value = decl.value.replaceAll('#0a0c10', 'var(--bg)');
    });
  },
};

async function buildCss() {
  const tailwind = execFileSync(
    path.join(dash, 'node_modules', '.bin', 'tailwindcss'),
    ['-i', 'src/index.css', '--minify'],
    { cwd: dash, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] },
  ).toString();
  const sheets = [
    await fs.readFile(path.join(dash, 'styles', 'dashboard.css'), 'utf8'),
    await fs.readFile(dashRequire.resolve('react-grid-layout/css/styles.css'), 'utf8'),
    await fs.readFile(path.join(dash, 'styles', 'overview.css'), 'utf8'),
    await fs.readFile(path.join(dash, 'styles', 'canvas.css'), 'utf8'),
    tailwind,
  ];
  const scoped = (await postcss([scopePlugin]).process(sheets.join('\n'), { from: undefined })).css;
  return `${scoped}
${SCOPE}{position:relative;height:100%;min-height:0;overflow:hidden;color:var(--text);background:transparent}
${SCOPE} .app{height:100%}
${SCOPE} .sidebar,${SCOPE} .tab-bar{background:transparent}
`;
}

async function buildJs() {
  const result = await esbuild.build({
    absWorkingDir: rootDir,
    entryPoints: [path.join(rootDir, 'openclaw', 'native-ui', 'index.jsx')],
    outfile: path.join(outDir, 'index.js'),
    platform: 'browser',
    target: 'es2022',
    format: 'esm',
    bundle: true,
    splitting: false,
    minify: true,
    legalComments: 'none',
    write: false,
    jsx: 'automatic',
    logLevel: 'warning',
    external: ['openclaw/plugin-sdk/*'],
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env.DEV': 'false',
      'import.meta.env.PROD': 'true',
      'import.meta.env.MODE': '"production"',
    },
    loader: { '.svg': 'dataurl', '.png': 'dataurl' },
    nodePaths: [path.join(dash, 'node_modules'), path.join(rootDir, 'node_modules')],
    plugins: [{
      name: 'flowboard-native',
      setup(build) {
        // Styles are compiled and scoped separately (buildCss).
        build.onResolve({ filter: /\.css$/ }, () => ({ path: 'css', namespace: 'fb-empty' }));
        build.onLoad({ filter: /.*/, namespace: 'fb-empty' }, () => ({ contents: '', loader: 'js' }));
        // Vite-style absolute asset import.
        build.onResolve({ filter: /^\/favicon\.svg$/ }, () => ({ path: path.join(dash, 'favicon.svg') }));
      },
    }],
  });
  return result.outputFiles[0].text;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [js, css] = await Promise.all([buildJs(), buildCss()]);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'index.css'), css);
  await fs.writeFile(path.join(outDir, 'index.js'), `import './index.css';\n${js}`);
  console.log(JSON.stringify({ out: path.relative(rootDir, outDir), js: js.length, css: css.length }));
}
