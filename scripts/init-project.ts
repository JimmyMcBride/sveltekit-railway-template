#!/usr/bin/env bun

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
	ALLOWED_TEMPLATE_ROOT_ENTRIES,
	APP_SERVICE_NAME,
	BOOTSTRAP_STATE_DIR,
	BOOTSTRAP_STATE_PATH,
	NODE_ENGINE,
	OPTIONAL_TEMPLATES,
	type OptionalTemplateKey
} from "./bootstrap-config";

type Command = "init" | "sync-urls";

type CliOptions = {
	command: Command;
	convex: boolean;
	help: boolean;
	plausible: boolean;
};

type BootstrapState = {
	version: 2;
	projectName: string;
	packageName: string;
	repoSlug: string;
	rootDir: string;
	options: {
		convex: boolean;
		plausible: boolean;
	};
	railway: {
		projectId?: string;
		projectName: string;
		appService: {
			name: string;
			url?: string;
		};
		convex?: {
			serviceName: string;
			templateCode: string;
			url?: string;
		};
		plausible?: {
			serviceName: string;
			templateCode: string;
			url?: string;
		};
	};
};

type CommandResult = {
	exitCode: number;
	stderr: string;
	stdout: string;
};

type InitContext = {
	packageName: string;
	projectName: string;
	repoSlug: string;
	rootDir: string;
};

const options = parseArgs(Bun.argv.slice(2));

if (options.help) {
	printHelp(0);
}

main().catch((error) => {
	console.error("");
	console.error(`Bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});

async function main() {
	if (options.command === "init") {
		await runInit(options);
		return;
	}

	await runSyncUrls();
}

function parseArgs(argv: string[]): CliOptions {
	let command: Command | undefined;
	const parsed: CliOptions = {
		command: "init",
		convex: false,
		help: false,
		plausible: false
	};

	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}

		if (arg === "init" || arg === "sync-urls") {
			command = arg;
			continue;
		}

		if (arg === "--convex") {
			parsed.convex = true;
			continue;
		}

		if (arg === "--plausible") {
			parsed.plausible = true;
			continue;
		}

		if (arg === "--no-convex") {
			parsed.convex = false;
			continue;
		}

		if (arg === "--no-plausible") {
			parsed.plausible = false;
			continue;
		}

		throw new Error(`Unknown argument: ${arg}`);
	}

	parsed.command = command ?? "init";
	return parsed;
}

function printHelp(exitCode: number) {
	console.log(`Usage:
  bun run init -- [--convex] [--plausible]
  bun run sync-urls

Commands:
  init         scaffold SvelteKit in the current template clone and provision Railway
  sync-urls    refresh Railway public domains and rewrite app env values

Options:
  --convex     add the self-hosted Convex Railway template
  --plausible  add the self-hosted Plausible Railway template
  --help, -h   show this message

Template defaults:
  Convex template code: ${OPTIONAL_TEMPLATES.convex.code}
  Plausible template code: ${OPTIONAL_TEMPLATES.plausible.code}`);

	process.exit(exitCode);
}

async function runInit(cliOptions: CliOptions) {
	const context = validateInitEnvironment();
	assertTemplateRepoShape(context.rootDir);

	if (existsSync(resolve(context.rootDir, BOOTSTRAP_STATE_PATH))) {
		throw new Error("This repo already looks initialized. Run `bun run sync-urls` instead.");
	}

	logStep(`Scaffolding ${context.projectName}`);
	run(
		[
			"bunx",
			"sv@latest",
			"create",
			".",
			"--template",
			"minimal",
			"--types",
			"ts",
			"--add",
			"tailwindcss=plugins:none",
			"sveltekit-adapter=adapter:node",
			"--install",
			"bun",
			"--no-dir-check",
			"--no-download-check"
		],
		context.rootDir
	);

	const state = createBootstrapState(context, cliOptions);

	patchGeneratedProject(context.rootDir, state);
	saveState(context.rootDir, state);

	logStep("Creating Railway project");
	run(["railway", "init", "--name", state.railway.projectName], context.rootDir);

	logStep("Adding the app service");
	run(["railway", "add", "--service", state.railway.appService.name, "--repo", state.repoSlug], context.rootDir);

	if (state.options.convex) {
		await deployTemplate(context.rootDir, "convex");
	}

	if (state.options.plausible) {
		await deployTemplate(context.rootDir, "plausible");
	}

	await syncUrls(context.rootDir, state);
	printInitSummary(state);
}

async function runSyncUrls() {
	const rootDir = validateCommonEnvironment();
	const state = loadState(rootDir);
	await ensureRailwayLinked(rootDir, state);
	await syncUrls(rootDir, state);
	printSyncSummary(state);
}

function validateInitEnvironment(): InitContext {
	const rootDir = validateCommonEnvironment();
	const repoUrl = runCapture(["git", "remote", "get-url", "origin"], rootDir).stdout.trim();
	const repoSlug = parseGitHubRepoSlug(repoUrl);
	const projectName = basename(rootDir);
	const packageName = toPackageName(projectName);

	return {
		packageName,
		projectName,
		repoSlug,
		rootDir
	};
}

function validateCommonEnvironment() {
	const rootDir = runCapture(["git", "rev-parse", "--show-toplevel"], process.cwd()).stdout.trim();
	requireCommand("bun");
	requireCommand("bunx");
	requireCommand("git");
	requireCommand("railway");
	runCapture(["railway", "whoami"], rootDir);
	return rootDir;
}

function assertTemplateRepoShape(rootDir: string) {
	const entries = readdirSync(rootDir);

	for (const entry of entries) {
		if (!ALLOWED_TEMPLATE_ROOT_ENTRIES.has(entry)) {
			throw new Error(
				`Template repo is not clean enough to scaffold into root. Unexpected entry: ${entry}`
			);
		}
	}
}

function createBootstrapState(context: InitContext, cliOptions: CliOptions): BootstrapState {
	return {
		version: 2,
		projectName: context.projectName,
		packageName: context.packageName,
		repoSlug: context.repoSlug,
		rootDir: context.rootDir,
		options: {
			convex: cliOptions.convex,
			plausible: cliOptions.plausible
		},
		railway: {
			projectName: context.projectName,
			appService: {
				name: APP_SERVICE_NAME
			},
			convex: cliOptions.convex
				? {
						serviceName: OPTIONAL_TEMPLATES.convex.publicService,
						templateCode: OPTIONAL_TEMPLATES.convex.code
					}
				: undefined,
			plausible: cliOptions.plausible
				? {
						serviceName: OPTIONAL_TEMPLATES.plausible.publicService,
						templateCode: OPTIONAL_TEMPLATES.plausible.code
					}
				: undefined
		}
	};
}

function patchGeneratedProject(rootDir: string, state: BootstrapState) {
	const packageJsonPath = resolve(rootDir, "package.json");
	const packageJson = readJson<Record<string, any>>(packageJsonPath);

	packageJson.name = state.packageName;
	packageJson.engines = {
		node: NODE_ENGINE
	};
	packageJson.scripts = {
		...packageJson.scripts,
		start: "node build",
		init: "bun run scripts/init-project.ts init",
		"sync-urls": "bun run scripts/init-project.ts sync-urls"
	};

	writeJson(packageJsonPath, packageJson);
	writeFileSync(resolve(rootDir, ".env.example"), envExampleContents(state.options));
	writeFileSync(resolve(rootDir, ".env.local"), envLocalContents());
	appendUniqueLine(resolve(rootDir, ".gitignore"), ".bootstrap/");
	writeFileSync(resolve(rootDir, "README.md"), generatedReadme(state));
	writeFileSync(resolve(rootDir, "src", "routes", "+layout.svelte"), generatedLayout(state.options.plausible));
	writeFileSync(resolve(rootDir, "src", "routes", "+page.svelte"), generatedPage(state));
}

async function deployTemplate(rootDir: string, key: OptionalTemplateKey) {
	const template = OPTIONAL_TEMPLATES[key];

	if (!template.code) {
		throw new Error(`No Railway template code is configured for ${template.displayName}`);
	}

	const variables = await collectTemplateVariables(template.displayName);
	const command = ["railway", "deploy", "-t", template.code];

	for (const variable of variables) {
		command.push("-v", variable);
	}

	logStep(`Deploying ${template.displayName}`);
	run(command, rootDir);
}

async function collectTemplateVariables(displayName: string) {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout
	});

	const variables: string[] = [];
	console.log("");
	console.log(`${displayName} template variables: enter KEY=VALUE pairs if needed, one per line. Press Enter on an empty line when finished.`);

	while (true) {
		const answer = (await rl.question("> ")).trim();
		if (!answer) {
			break;
		}

		if (!answer.includes("=")) {
			console.log("  Expected KEY=VALUE. Try again.");
			continue;
		}

		variables.push(answer);
	}

	rl.close();
	return variables;
}

async function syncUrls(rootDir: string, state: BootstrapState) {
	const appUrl = await ensureServiceUrl(rootDir, state.railway.appService.name);
	state.railway.appService.url = appUrl;

	const railwayVariables = [`PUBLIC_APP_URL=${appUrl}`];
	const localEnvEntries: Record<string, string> = {
		PUBLIC_APP_URL: appUrl
	};

	if (state.railway.convex) {
		const convexUrl = await ensureServiceUrl(rootDir, state.railway.convex.serviceName);
		state.railway.convex.url = convexUrl;
		railwayVariables.push(`${OPTIONAL_TEMPLATES.convex.envVar}=${convexUrl}`);
		localEnvEntries[OPTIONAL_TEMPLATES.convex.envVar] = convexUrl;
	}

	if (state.railway.plausible) {
		const plausibleUrl = await ensureServiceUrl(rootDir, state.railway.plausible.serviceName);
		state.railway.plausible.url = plausibleUrl;
		railwayVariables.push(`${OPTIONAL_TEMPLATES.plausible.envVar}=${plausibleUrl}`);
		localEnvEntries[OPTIONAL_TEMPLATES.plausible.envVar] = plausibleUrl;
	}

	logStep("Writing Railway app variables");
	run(["railway", "variable", "set", "--service", state.railway.appService.name, ...railwayVariables], rootDir);

	upsertEnvFile(resolve(rootDir, ".env.local"), localEnvEntries);
	saveState(rootDir, state);
}

async function ensureRailwayLinked(rootDir: string, state: BootstrapState) {
	const currentStatus = runCapture(["railway", "status", "--json"], rootDir, true);
	if (currentStatus.exitCode === 0) {
		return;
	}

	const targetProject = state.railway.projectId ?? state.railway.projectName;
	logStep("Linking the local repo back to Railway");
	run(
		["railway", "link", "--project", targetProject, "--service", state.railway.appService.name],
		rootDir
	);
}

async function ensureServiceUrl(rootDir: string, serviceName: string) {
	const domainResult = runCapture(["railway", "domain", "--service", serviceName, "--json"], rootDir, true);
	const directUrl = extractRailwayUrl(domainResult.stdout) ?? extractRailwayUrl(domainResult.stderr);

	if (directUrl) {
		return normalizeUrl(directUrl);
	}

	const statusResult = runCapture(["railway", "status", "--json"], rootDir, true);
	const fromStatus =
		findServiceUrlInJson(statusResult.stdout, serviceName) ?? extractRailwayUrl(statusResult.stderr);

	if (fromStatus) {
		return normalizeUrl(fromStatus);
	}

	throw new Error(`Could not determine a public Railway URL for service "${serviceName}"`);
}

function findServiceUrlInJson(contents: string, serviceName: string) {
	try {
		const parsed = JSON.parse(contents);
		const serviceNode = findNodeByName(parsed, serviceName);
		if (!serviceNode) {
			return undefined;
		}

		const strings = collectStrings(serviceNode);
		return strings.find((value) => value.includes(".up.railway.app")) ?? strings.find((value) => isRailwayUrl(value));
	} catch {
		return undefined;
	}
}

function findNodeByName(value: unknown, serviceName: string): unknown {
	if (Array.isArray(value)) {
		for (const entry of value) {
			const found = findNodeByName(entry, serviceName);
			if (found) {
				return found;
			}
		}
		return undefined;
	}

	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (record.name === serviceName || record.service === serviceName) {
			return value;
		}

		for (const nested of Object.values(record)) {
			const found = findNodeByName(nested, serviceName);
			if (found) {
				return found;
			}
		}
	}

	return undefined;
}

function collectStrings(value: unknown, output: string[] = []) {
	if (typeof value === "string") {
		output.push(value);
		return output;
	}

	if (Array.isArray(value)) {
		for (const entry of value) {
			collectStrings(entry, output);
		}
		return output;
	}

	if (value && typeof value === "object") {
		for (const nested of Object.values(value as Record<string, unknown>)) {
			collectStrings(nested, output);
		}
	}

	return output;
}

function extractRailwayUrl(contents: string) {
	const httpMatch = contents.match(/https?:\/\/[^\s"'`]+/);
	if (httpMatch) {
		return httpMatch[0];
	}

	const domainMatch = contents.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.up\.railway\.app/);
	if (domainMatch) {
		return `https://${domainMatch[0]}`;
	}

	return undefined;
}

function isRailwayUrl(value: string) {
	return value.includes(".up.railway.app") || value.startsWith("https://");
}

function normalizeUrl(value: string) {
	return value.replace(/\/+$/, "");
}

function parseGitHubRepoSlug(remote: string) {
	const httpsMatch = remote.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i);
	if (httpsMatch) {
		return httpsMatch[1];
	}

	const sshMatch = remote.match(/^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i);
	if (sshMatch) {
		return sshMatch[1];
	}

	throw new Error("`origin` must point to a GitHub repository");
}

function loadState(rootDir: string) {
	const statePath = resolve(rootDir, BOOTSTRAP_STATE_PATH);
	if (!existsSync(statePath)) {
		throw new Error(`No bootstrap state found at ${BOOTSTRAP_STATE_PATH}`);
	}

	return readJson<BootstrapState>(statePath);
}

function saveState(rootDir: string, state: BootstrapState) {
	const stateDir = resolve(rootDir, BOOTSTRAP_STATE_DIR);
	mkdirSync(stateDir, { recursive: true });
	writeJson(resolve(rootDir, BOOTSTRAP_STATE_PATH), state);
}

function requireCommand(command: string) {
	runCapture(["which", command], process.cwd());
}

function run(cmd: string[], cwd: string) {
	const result = Bun.spawnSync({
		cmd,
		cwd,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit"
	});

	if (result.exitCode !== 0) {
		throw new Error(`Command failed: ${cmd.join(" ")}`);
	}
}

function runCapture(cmd: string[], cwd: string, allowFailure = false): CommandResult {
	const result = Bun.spawnSync({
		cmd,
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "inherit"
	});

	const stdout = result.stdout ? new TextDecoder().decode(result.stdout) : "";
	const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : "";

	if (result.exitCode !== 0 && !allowFailure) {
		const details = stderr.trim() || stdout.trim() || `exit code ${result.exitCode}`;
		throw new Error(`Command failed: ${cmd.join(" ")}\n${details}`);
	}

	return {
		exitCode: result.exitCode,
		stderr,
		stdout
	};
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown) {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function appendUniqueLine(path: string, line: string) {
	const original = readFileSync(path, "utf8");
	if (original.includes(line)) {
		return;
	}

	const next = `${original.trimEnd()}\n${line}\n`;
	writeFileSync(path, next);
}

function upsertEnvFile(path: string, entries: Record<string, string>) {
	const original = existsSync(path) ? readFileSync(path, "utf8") : "";
	const map = parseEnv(original);

	for (const [key, value] of Object.entries(entries)) {
		map[key] = value;
	}

	const lines = Object.entries(map).map(([key, value]) => `${key}=${value}`);
	writeFileSync(path, `${lines.join("\n")}\n`);
}

function parseEnv(contents: string) {
	const entries: Record<string, string> = {};

	for (const line of contents.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}

		const separatorIndex = trimmed.indexOf("=");
		if (separatorIndex === -1) {
			continue;
		}

		const key = trimmed.slice(0, separatorIndex).trim();
		const value = trimmed.slice(separatorIndex + 1).trim();
		entries[key] = value;
	}

	return entries;
}

function toPackageName(value: string) {
	const packageName = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

	if (!packageName) {
		throw new Error("The folder name must include at least one letter or number");
	}

	return packageName;
}

function envExampleContents(options: BootstrapState["options"]) {
	const lines = ["PUBLIC_APP_URL="];
	if (options.convex) {
		lines.push(`${OPTIONAL_TEMPLATES.convex.envVar}=`);
	}
	if (options.plausible) {
		lines.push(`${OPTIONAL_TEMPLATES.plausible.envVar}=`);
	}
	return `${lines.join("\n")}\n`;
}

function envLocalContents() {
	return "PUBLIC_APP_URL=\n";
}

function generatedLayout(plausibleEnabled: boolean) {
	const plausibleImports = plausibleEnabled
		? "\timport { PUBLIC_APP_URL, PUBLIC_PLAUSIBLE_HOST } from '$env/static/public';\n"
		: "";
	const plausibleLogic = plausibleEnabled
		? `
\tconst plausibleHost = normalizePublicUrl(PUBLIC_PLAUSIBLE_HOST);
\tconst plausibleScript = plausibleHost ? \`\${plausibleHost}/js/script.js\` : undefined;
\tconst plausibleDomain = deriveHostname(PUBLIC_APP_URL);
`
		: "";
	const plausibleHead = plausibleEnabled
		? `
\t{#if plausibleScript && plausibleDomain}
\t\t<script defer data-domain={plausibleDomain} src={plausibleScript}></script>
\t{/if}
`
		: "";
	const helpers = plausibleEnabled
		? `
function normalizePublicUrl(value: string | undefined) {
\treturn value ? value.replace(/\\/+$/, '') : undefined;
}

function deriveHostname(value: string | undefined) {
\tif (!value) {
\t\treturn undefined;
\t}

\ttry {
\t\treturn new URL(value).hostname;
\t} catch {
\t\treturn undefined;
\t}
}
`
		: "";

	return `<script lang="ts">
\timport './layout.css';
\timport favicon from '$lib/assets/favicon.svg';
${plausibleImports}
\tlet { children } = $props();
${plausibleLogic}${helpers}</script>

<svelte:head>
\t<link rel="icon" href={favicon} />${plausibleHead}
</svelte:head>

{@render children()}
`;
}

function generatedPage(state: BootstrapState) {
	const publicEnvImports = ["PUBLIC_APP_URL"];
	const convexCard = state.options.convex
		? `
\t\t\t<div class="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
\t\t\t\t<p class="text-sm font-medium text-sky-200">Convex URL</p>
\t\t\t\t<p class="mt-3 break-all text-sm leading-6 text-slate-300">{PUBLIC_CONVEX_URL || 'Run bun run sync-urls after Railway is ready.'}</p>
\t\t\t</div>`
		: "";
	const plausibleCard = state.options.plausible
		? `
\t\t\t<div class="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
\t\t\t\t<p class="text-sm font-medium text-sky-200">Plausible Host</p>
\t\t\t\t<p class="mt-3 break-all text-sm leading-6 text-slate-300">{PUBLIC_PLAUSIBLE_HOST || 'Run bun run sync-urls after Railway is ready.'}</p>
\t\t\t</div>`
		: "";

	if (state.options.convex) {
		publicEnvImports.push("PUBLIC_CONVEX_URL");
	}

	if (state.options.plausible) {
		publicEnvImports.push("PUBLIC_PLAUSIBLE_HOST");
	}

	return `<script lang="ts">
\timport { ${publicEnvImports.join(", ")} } from '$env/static/public';
</script>

<svelte:head>
\t<title>${escapeHtml(state.projectName)} | Railway Ready</title>
\t<meta
\t\tname="description"
\t\tcontent="A SvelteKit + Bun + Tailwind starter provisioned from the Railway bootstrap template."
\t/>
</svelte:head>

<div class="min-h-screen bg-[radial-gradient(circle_at_top,rgba(14,165,233,0.18),transparent_40%),linear-gradient(180deg,#020617_0%,#0f172a_52%,#111827_100%)] text-slate-50">
\t<div class="mx-auto flex min-h-screen max-w-5xl flex-col justify-center gap-10 px-6 py-24">
\t\t<div class="space-y-5">
\t\t\t<p class="text-xs font-medium uppercase tracking-[0.4em] text-sky-300">SvelteKit + Bun + Tailwind + Railway</p>
\t\t\t<h1 class="max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-6xl">${escapeHtml(state.projectName)}</h1>
\t\t\t<p class="max-w-2xl text-lg leading-8 text-slate-300">
\t\t\t\tThis app was scaffolded from your GitHub template clone. Railway owns the service wiring, and \`bun run sync-urls\`
\t\t\t\trefreshes the public URLs whenever services or domains change.
\t\t\t</p>
\t\t</div>

\t\t<div class="grid gap-4 md:grid-cols-3">
\t\t\t<div class="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
\t\t\t\t<p class="text-sm font-medium text-sky-200">App URL</p>
\t\t\t\t<p class="mt-3 break-all text-sm leading-6 text-slate-300">{PUBLIC_APP_URL || 'Run bun run sync-urls after Railway is ready.'}</p>
\t\t\t</div>
\t\t\t<div class="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
\t\t\t\t<p class="text-sm font-medium text-sky-200">Workflow</p>
\t\t\t\t<p class="mt-3 text-sm leading-6 text-slate-300">\`bun run dev\` for local work, \`bun run sync-urls\` after Railway changes.</p>
\t\t\t</div>${convexCard}${plausibleCard}
\t\t</div>
\t</div>
</div>
`;
}

function generatedReadme(state: BootstrapState) {
	const features = [
		"- SvelteKit minimal",
		"- Bun for local install and dev",
		"- Tailwind CSS v4",
		"- Railway app service linked to this repo"
	];

	if (state.options.convex) {
		features.push("- Self-hosted Convex template in the same Railway project");
	}

	if (state.options.plausible) {
		features.push("- Self-hosted Plausible template in the same Railway project");
	}

	return `# ${state.projectName}

Scaffolded from the Railway bootstrap template.

## Stack

${features.join("\n")}

## Local development

\`\`\`sh
bun run dev
\`\`\`

## URL sync

When Railway rotates domains or you redeploy optional services, refresh the public URLs with:

\`\`\`sh
bun run sync-urls
\`\`\`

That command updates:

- Railway app variables
- \`.env.local\`
- \`${BOOTSTRAP_STATE_PATH}\`

## Public env contract

- \`PUBLIC_APP_URL\`
${state.options.convex ? "- `PUBLIC_CONVEX_URL`\n" : ""}${state.options.plausible ? "- `PUBLIC_PLAUSIBLE_HOST`\n" : ""}`;
}

function printInitSummary(state: BootstrapState) {
	console.log("");
	console.log(`Created ${state.projectName} in ${state.rootDir}`);
	console.log("");
	console.log("Next steps:");
	console.log("  bun run dev");
	console.log("  bun run sync-urls");
	console.log("");
	console.log("Railway:");
	console.log(`  Project: ${state.railway.projectName}`);
	console.log(`  App service: ${state.railway.appService.name}`);
	if (state.railway.appService.url) {
		console.log(`  App URL: ${state.railway.appService.url}`);
	}
	if (state.railway.convex?.url) {
		console.log(`  Convex URL: ${state.railway.convex.url}`);
	}
	if (state.railway.plausible?.url) {
		console.log(`  Plausible URL: ${state.railway.plausible.url}`);
	}
}

function printSyncSummary(state: BootstrapState) {
	console.log("");
	console.log("Synced Railway URLs");
	console.log(`  App: ${state.railway.appService.url ?? "pending"}`);
	if (state.railway.convex) {
		console.log(`  Convex: ${state.railway.convex.url ?? "pending"}`);
	}
	if (state.railway.plausible) {
		console.log(`  Plausible: ${state.railway.plausible.url ?? "pending"}`);
	}
}

function logStep(message: string) {
	console.log("");
	console.log(`==> ${message}`);
}

function escapeHtml(value: string) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
