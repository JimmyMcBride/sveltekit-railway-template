export const NODE_ENGINE = "^20.19.0 || >=22.12.0";
export const BOOTSTRAP_STATE_DIR = ".bootstrap";
export const BOOTSTRAP_STATE_PATH = `${BOOTSTRAP_STATE_DIR}/state.json`;

export const ALLOWED_TEMPLATE_ROOT_ENTRIES = new Set([
	".git",
	".gitignore",
	".npmrc",
	".DS_Store",
	".idea",
	".vscode",
	"README.md",
	"package.json",
	"bun.lock",
	"bun.lockb",
	"node_modules",
	"scripts",
	"skills"
]);

export type OptionalTemplateKey = "convex" | "plausible";

export const OPTIONAL_TEMPLATES: Record<
	OptionalTemplateKey,
	{
		code: string;
		displayName: string;
		envVar: string;
		publicService: string;
	}
> = {
	convex: {
		code: Bun.env.RAILWAY_TEMPLATE_CONVEX ?? "convex",
		displayName: "Convex",
		envVar: "PUBLIC_CONVEX_URL",
		publicService: "Convex Backend"
	},
	plausible: {
		code: Bun.env.RAILWAY_TEMPLATE_PLAUSIBLE ?? "mzYEXO",
		displayName: "Plausible",
		envVar: "PUBLIC_PLAUSIBLE_HOST",
		publicService: "Plausible Analytics CE"
	}
};
