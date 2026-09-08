import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Type, { type Static } from "typebox";
import { Compile } from "typebox/compile";
import { BrowserPolicy } from "./browser-policy.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

const id = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" });
export const browserSetupSchema = Type.Object(
	{
		profiles: Type.Array(
			Type.Object(
				{
					id,
					name: Type.String({ minLength: 1, maxLength: 100 }),
					access: Type.Union([
						Type.Literal("public-web"),
						Type.Literal("loopback"),
						Type.Literal("private-network"),
					]),
					runtime: Type.Union([Type.Literal("managed-chromium"), Type.Literal("installed-chrome")]),
				},
				{ additionalProperties: false },
			),
			{ maxItems: 64 },
		),
		sites: Type.Array(
			Type.Object(
				{
					id,
					name: Type.String({ minLength: 1, maxLength: 100 }),
					url: Type.String({ minLength: 1, maxLength: 4096 }),
					mode: Type.Union([
						Type.Literal("browser"),
						Type.Literal("markdown"),
						Type.Literal("llms"),
						Type.Literal("connection"),
					]),
					contentUrl: Type.Optional(Type.String({ maxLength: 4096 })),
					connectionToolId: Type.Optional(Type.String({ maxLength: 256 })),
				},
				{ additionalProperties: false },
			),
			{ maxItems: 128 },
		),
	},
	{ additionalProperties: false },
);
export type BrowserSetup = Static<typeof browserSetupSchema>;
const validator = Compile(browserSetupSchema);

/** Non-secret, reusable configuration. Profile cookies remain in BrowserProfileStore. */
export class BrowserSetupStore {
	readonly #root: string;
	readonly #queue = new SerialOperationQueue();
	#state: BrowserSetup = { profiles: [], sites: [] };
	constructor(root: string) {
		this.#root = root;
	}
	async initialize(): Promise<void> {
		await mkdir(this.#root, { recursive: true });
		try {
			this.#state = this.#parse(JSON.parse(await readFile(join(this.#root, "setup.json"), "utf8")));
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
	snapshot(): BrowserSetup {
		return structuredClone(this.#state);
	}
	/** Upserts named entries; unrelated profiles and site preferences are preserved. */
	async save(value: unknown): Promise<BrowserSetup> {
		const update = this.#parse(value);
		return this.#queue.run(async () => {
			const next = this.#parse({
				profiles: [
					...new Map([...this.#state.profiles, ...update.profiles].map((entry) => [entry.id, entry])).values(),
				],
				sites: [...new Map([...this.#state.sites, ...update.sites].map((entry) => [entry.id, entry])).values()],
			});
			const temporary = join(this.#root, `${randomUUID()}.tmp`);
			await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
			await rename(temporary, join(this.#root, "setup.json"));
			this.#state = next;
			return this.snapshot();
		});
	}
	#parse(value: unknown): BrowserSetup {
		if (!validator.Check(value)) throw new Error("Invalid browser setup");
		for (const entries of [value.profiles, value.sites])
			if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
				throw new Error("Duplicate browser setup ID");
		for (const site of value.sites) {
			for (const address of [site.url, site.contentUrl].filter((entry): entry is string => !!entry)) {
				const url = new BrowserPolicy("public-web").assertNavigation(address);
				if (url.username || url.password) throw new Error("Site preferences must not contain credentials");
			}
			if (site.mode === "connection" && !site.connectionToolId)
				throw new Error("Select an existing connection tool");
		}
		return structuredClone(value);
	}
}
