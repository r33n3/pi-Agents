import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultCatalogPath = path.join(
	root,
	"packages/coding-agent/src/core/serve/data/bedrock-pricing.us-east-1.json",
);
const defaultModelsPath = path.join(os.homedir(), ".pi", "agent", "models.json");

export function applyBedrockPricing(config, catalog) {
	const next = structuredClone(config);
	next.providers ??= {};
	for (const [modelId, rate] of Object.entries(catalog.models)) {
		const cost = {
			input: rate.input,
			output: rate.output,
			cacheRead: rate.cacheRead,
			cacheWrite: rate.cacheWrite,
		};
		for (const providerId of rate.providers) {
			const provider = next.providers[providerId];
			if (provider?.models) {
				const model = provider.models.find((entry) => entry.id === modelId);
				if (model) model.cost = cost;
			}
			if (providerId === "amazon-bedrock") {
				const configuredProvider = (next.providers[providerId] ??= {});
				configuredProvider.modelOverrides ??= {};
				configuredProvider.modelOverrides[modelId] = {
					...configuredProvider.modelOverrides[modelId],
					cost,
				};
			}
		}
	}
	return next;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const check = process.argv.includes("--check");
	const modelsArgument = process.argv.find((argument) => argument.startsWith("--models="));
	const catalogArgument = process.argv.find((argument) => argument.startsWith("--catalog="));
	const modelsPath = modelsArgument ? path.resolve(modelsArgument.slice("--models=".length)) : defaultModelsPath;
	const catalogPath = catalogArgument
		? path.resolve(catalogArgument.slice("--catalog=".length))
		: defaultCatalogPath;
	const [configText, catalogText] = await Promise.all([
		readFile(modelsPath, "utf8"),
		readFile(catalogPath, "utf8"),
	]);
	const config = JSON.parse(configText);
	const catalog = JSON.parse(catalogText);
	const synchronized = applyBedrockPricing(config, catalog);
	if (check) {
		if (JSON.stringify(config) !== JSON.stringify(synchronized)) {
			console.error(`Bedrock pricing is stale in ${modelsPath}`);
			process.exitCode = 1;
		}
	} else {
		await writeFile(modelsPath, `${JSON.stringify(synchronized, null, 2)}\n`);
		console.log(
			`Applied ${Object.keys(catalog.models).length} ${catalog.region} ${catalog.serviceTier} Bedrock rates to ${modelsPath}`,
		);
	}
}
