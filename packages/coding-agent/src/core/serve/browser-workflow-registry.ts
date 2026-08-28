import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export type BrowserWorkflowStatus =
	| "draft"
	| "needs-input"
	| "compiled"
	| "validated"
	| "active"
	| "superseded"
	| "invalid"
	| "disabled";

export type BrowserLocatorCandidate =
	| { kind: "role"; role: string; name: string; exact: boolean }
	| { kind: "label"; text: string; exact: boolean }
	| { kind: "test-id"; value: string }
	| { kind: "id"; value: string }
	| { kind: "text"; text: string; exact: boolean };

export interface BrowserFrameTarget {
	name?: string;
	urlPattern?: string;
}

export interface BrowserElementExpectation {
	tag?: string;
	role?: string;
	inputType?: string;
}

export interface BrowserTarget {
	frame: BrowserFrameTarget[];
	candidates: BrowserLocatorCandidate[];
	expected: BrowserElementExpectation;
}

export type BrowserAssertion =
	| { kind: "url"; pattern: string }
	| { kind: "title"; pattern: string }
	| {
			kind: "element";
			state: "visible" | "hidden" | "enabled" | "disabled";
			target: BrowserTarget;
	  }
	| { kind: "text"; text: string; visible: boolean }
	| { kind: "page-ready" }
	| { kind: "download"; namePattern?: string };

export type BrowserValue = { kind: "parameter"; name: string } | { kind: "constant"; value: string };

interface BrowserStepBase {
	id: string;
	preconditions: BrowserAssertion[];
	postconditions: BrowserAssertion[];
	timeoutMs: number;
	evidence: "none" | "failure" | "before-after";
}

export type BrowserWorkflowStep =
	| (BrowserStepBase & { action: "navigate"; urlTemplate: string })
	| (BrowserStepBase & { action: "click" | "scroll-to"; target: BrowserTarget })
	| (BrowserStepBase & { action: "fill" | "select"; target: BrowserTarget; value: BrowserValue })
	| (BrowserStepBase & { action: "press"; key: string; target?: BrowserTarget })
	| (BrowserStepBase & { action: "wait" | "assert"; assertion: BrowserAssertion });

export interface BrowserWorkflowParameter {
	name: string;
	description: string;
	type: "string" | "number" | "boolean" | "url" | "choice" | "secret-ref";
	required: boolean;
	choices?: string[];
	default?: string | number | boolean;
	sensitive: boolean;
}

export interface BrowserWorkflowEntry {
	urlTemplate: string;
	allowedOrigins: string[];
	ready: BrowserAssertion[];
}

export interface BrowserWorkflowRequirements {
	profile: "none" | "authenticated";
	viewport: { width: number; height: number; deviceScaleFactor: number };
	access: "loopback" | "public-web" | "private-network";
}

export interface BrowserWorkflowPolicy {
	deadlineMs: number;
	approval: "inherit" | "always";
}

export interface BrowserWorkflowSource {
	kind: "recording" | "manual";
	captureId?: string;
}

export interface BrowserWorkflowValidationEvidence {
	id: string;
	digest: string;
	completedAt: number;
}

export interface BrowserWorkflowCompileIssue {
	stepId: string;
	code: "missing-target" | "missing-entry" | "unsupported-action";
	message: string;
}

export interface BrowserWorkflowDefinition {
	schema: "pi.browser-workflow.v1";
	id: string;
	version: number;
	name: string;
	description: string;
	status: BrowserWorkflowStatus;
	digest: string;
	entry: BrowserWorkflowEntry;
	parameters: BrowserWorkflowParameter[];
	steps: BrowserWorkflowStep[];
	completion: BrowserAssertion[];
	requirements: BrowserWorkflowRequirements;
	policy: BrowserWorkflowPolicy;
	source: BrowserWorkflowSource;
	compileIssues: BrowserWorkflowCompileIssue[];
	validation?: BrowserWorkflowValidationEvidence;
	createdAt: number;
	updatedAt: number;
}

export type BrowserWorkflowDefinitionInput = Omit<
	BrowserWorkflowDefinition,
	"schema" | "id" | "version" | "status" | "digest" | "validation" | "createdAt" | "updatedAt" | "compileIssues"
> & { id?: string; compileIssues?: BrowserWorkflowCompileIssue[] };

interface BrowserWorkflowMetadata {
	id: string;
	name: string;
	latestVersion: number;
	activeVersion?: number;
	updatedAt: number;
}

/** Owns browser-workflow schema validation, versioning, lifecycle, and persistence. */
export class BrowserWorkflowRegistry {
	readonly #root: string;
	readonly #queue = new SerialOperationQueue();
	readonly #definitions = new Map<string, Map<number, BrowserWorkflowDefinition>>();

	constructor(root: string) {
		this.#root = resolve(root);
	}

	async initialize(): Promise<void> {
		await mkdir(this.#root, { recursive: true });
		this.#definitions.clear();
		for (const entry of await readdir(this.#root, { withFileTypes: true })) {
			if (!entry.isDirectory() || !isIdentifier(entry.name)) continue;
			const versionsDirectory = resolve(this.#root, entry.name, "versions");
			let files: string[];
			try {
				files = (await readdir(versionsDirectory)).filter((file) => /^\d+\.json$/.test(file));
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") continue;
				throw error;
			}
			for (const file of files.sort((left, right) => Number(left.slice(0, -5)) - Number(right.slice(0, -5)))) {
				try {
					const definition = normalizePersistedDefinition(
						JSON.parse(await readFile(resolve(versionsDirectory, file), "utf8")),
					);
					if (definition.id !== entry.name) continue;
					this.#store(definition);
				} catch {
					// Malformed versions remain on disk as evidence but are never exposed.
				}
			}
		}
	}

	list(): BrowserWorkflowDefinition[] {
		return [...this.#definitions.values()]
			.map((versions) => versions.get(Math.max(...versions.keys())))
			.filter((definition): definition is BrowserWorkflowDefinition => definition !== undefined)
			.sort((left, right) => left.name.localeCompare(right.name))
			.map(cloneDefinition);
	}

	get(id: string, version?: number): BrowserWorkflowDefinition | undefined {
		assertIdentifier(id, "workflow id");
		const versions = this.#definitions.get(id);
		if (!versions) return undefined;
		const resolvedVersion = version ?? Math.max(...versions.keys());
		const definition = versions.get(resolvedVersion);
		return definition ? cloneDefinition(definition) : undefined;
	}

	getActive(id: string): BrowserWorkflowDefinition | undefined {
		assertIdentifier(id, "workflow id");
		const definition = [...(this.#definitions.get(id)?.values() ?? [])].find((entry) => entry.status === "active");
		return definition ? cloneDefinition(definition) : undefined;
	}

	getByCapture(captureId: string): BrowserWorkflowDefinition | undefined {
		const definition = this.list().find(
			(entry) => entry.source.kind === "recording" && entry.source.captureId === captureId,
		);
		return definition ? cloneDefinition(definition) : undefined;
	}

	async saveDraft(input: BrowserWorkflowDefinitionInput): Promise<BrowserWorkflowDefinition> {
		return this.#queue.run(async () => {
			await mkdir(this.#root, { recursive: true });
			const normalized = normalizeInput(input);
			const versions = this.#definitions.get(normalized.id);
			const latestVersion = versions ? Math.max(...versions.keys()) : 0;
			const now = Date.now();
			const definition: BrowserWorkflowDefinition = {
				...normalized,
				schema: "pi.browser-workflow.v1",
				version: latestVersion + 1,
				status: "draft",
				digest: executableDigest(normalized),
				createdAt: now,
				updatedAt: now,
			};
			await this.#persist(definition);
			this.#store(definition);
			return cloneDefinition(definition);
		});
	}

	async setStatus(
		id: string,
		version: number,
		status: Exclude<BrowserWorkflowStatus, "validated" | "active" | "superseded">,
	): Promise<BrowserWorkflowDefinition> {
		return this.#queue.run(async () => {
			const definition = this.#required(id, version);
			assertTransition(definition.status, status);
			const updated = { ...definition, status, updatedAt: Date.now() };
			await this.#persist(updated);
			this.#store(updated);
			return cloneDefinition(updated);
		});
	}

	async markValidated(
		id: string,
		version: number,
		evidence: BrowserWorkflowValidationEvidence,
	): Promise<BrowserWorkflowDefinition> {
		return this.#queue.run(async () => {
			const definition = this.#required(id, version);
			assertTransition(definition.status, "validated");
			if (evidence.digest !== definition.digest)
				throw new Error("Validation digest does not match workflow content");
			const validation = normalizeValidationEvidence(evidence);
			const updated = { ...definition, status: "validated" as const, validation, updatedAt: Date.now() };
			await this.#persist(updated);
			this.#store(updated);
			return cloneDefinition(updated);
		});
	}

	async activate(id: string, version: number): Promise<BrowserWorkflowDefinition> {
		return this.#queue.run(async () => {
			const definition = this.#required(id, version);
			assertTransition(definition.status, "active");
			if (!definition.validation || definition.validation.digest !== definition.digest) {
				throw new Error("Workflow must have current validation evidence before activation");
			}
			const versions = this.#definitions.get(id);
			for (const current of versions?.values() ?? []) {
				if (current.status !== "active" || current.version === version) continue;
				const superseded = { ...current, status: "superseded" as const, updatedAt: Date.now() };
				await this.#persist(superseded);
				this.#store(superseded);
			}
			const active = { ...definition, status: "active" as const, updatedAt: Date.now() };
			await this.#persist(active);
			this.#store(active);
			return cloneDefinition(active);
		});
	}

	async delete(id: string): Promise<boolean> {
		return this.#queue.run(async () => {
			assertIdentifier(id, "workflow id");
			if (!this.#definitions.has(id)) return false;
			const directory = resolve(this.#root, id);
			if (dirname(directory) !== this.#root) throw new Error("Browser workflow escapes the workflow root");
			await rm(directory, { recursive: true });
			this.#definitions.delete(id);
			return true;
		});
	}

	#required(id: string, version: number): BrowserWorkflowDefinition {
		assertIdentifier(id, "workflow id");
		if (!Number.isSafeInteger(version) || version < 1) throw new Error("workflow version must be a positive integer");
		const definition = this.#definitions.get(id)?.get(version);
		if (!definition) throw new Error(`Browser workflow ${id} version ${version} was not found`);
		return definition;
	}

	#store(definition: BrowserWorkflowDefinition): void {
		let versions = this.#definitions.get(definition.id);
		if (!versions) {
			versions = new Map();
			this.#definitions.set(definition.id, versions);
		}
		versions.set(definition.version, definition);
	}

	async #persist(definition: BrowserWorkflowDefinition): Promise<void> {
		const directory = resolve(this.#root, definition.id);
		await writeAtomic(
			resolve(directory, "versions", `${definition.version}.json`),
			`${JSON.stringify(definition, null, 2)}\n`,
		);
		const versions = this.#definitions.get(definition.id);
		const active =
			definition.status === "active"
				? definition.version
				: [...(versions?.values() ?? [])].find((entry) => entry.status === "active")?.version;
		const metadata: BrowserWorkflowMetadata = {
			id: definition.id,
			name: definition.name,
			latestVersion: Math.max(definition.version, ...(versions?.keys() ?? [])),
			activeVersion: active,
			updatedAt: definition.updatedAt,
		};
		await writeAtomic(resolve(directory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
	}
}

function normalizeInput(
	value: unknown,
): BrowserWorkflowDefinitionInput & { id: string; compileIssues: BrowserWorkflowCompileIssue[] } {
	const input = object(value, "browser workflow");
	const name = requiredString(input.name, "workflow.name", 160);
	const id = input.id === undefined ? slugify(name) : requiredIdentifier(input.id, "workflow.id");
	const entry = normalizeEntry(input.entry);
	const parameters = normalizeParameters(input.parameters);
	const parameterNames = new Set(parameters.map((parameter) => parameter.name));
	const steps = normalizeSteps(input.steps, parameterNames);
	const sensitiveParameterNames = new Set(
		parameters.filter((parameter) => parameter.sensitive).map((parameter) => parameter.name),
	);
	assertUrlTemplate(entry.urlTemplate, parameterNames, sensitiveParameterNames, "workflow.entry.urlTemplate");
	for (const step of steps) {
		if (step.action === "navigate") {
			assertUrlTemplate(step.urlTemplate, parameterNames, sensitiveParameterNames, `${step.id}.urlTemplate`);
		}
	}
	return {
		id,
		name,
		description: requiredString(input.description, "workflow.description", 2_000),
		entry,
		parameters,
		steps,
		completion: normalizeAssertions(input.completion, "workflow.completion"),
		requirements: normalizeRequirements(input.requirements),
		policy: normalizePolicy(input.policy),
		source: normalizeSource(input.source),
		compileIssues: normalizeCompileIssues(input.compileIssues),
	};
}

function normalizePersistedDefinition(value: unknown): BrowserWorkflowDefinition {
	const input = object(value, "persisted browser workflow");
	if (input.schema !== "pi.browser-workflow.v1") throw new Error("Unsupported browser workflow schema");
	const normalized = normalizeInput(input);
	const version = positiveInteger(input.version, "workflow.version", Number.MAX_SAFE_INTEGER);
	const status = oneOf(
		input.status,
		["draft", "needs-input", "compiled", "validated", "active", "superseded", "invalid", "disabled"],
		"workflow.status",
	);
	const digest = requiredDigest(input.digest);
	if (digest !== executableDigest(normalized)) throw new Error("Browser workflow digest does not match content");
	return {
		...normalized,
		schema: "pi.browser-workflow.v1",
		version,
		status,
		digest,
		validation: input.validation === undefined ? undefined : normalizeValidationEvidence(input.validation),
		createdAt: requiredTimestamp(input.createdAt, "workflow.createdAt"),
		updatedAt: requiredTimestamp(input.updatedAt, "workflow.updatedAt"),
	};
}

function normalizeEntry(value: unknown): BrowserWorkflowEntry {
	const input = object(value, "workflow.entry");
	const allowedOrigins = stringArray(input.allowedOrigins, "workflow.entry.allowedOrigins", 32).map((origin) => {
		const parsed = new URL(origin);
		if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
			throw new Error("workflow.entry.allowedOrigins must contain HTTP(S) origins without paths");
		}
		return parsed.origin;
	});
	if (allowedOrigins.length === 0) throw new Error("workflow.entry.allowedOrigins must not be empty");
	return {
		urlTemplate: requiredString(input.urlTemplate, "workflow.entry.urlTemplate", 4_000),
		allowedOrigins: [...new Set(allowedOrigins)],
		ready: normalizeAssertions(input.ready, "workflow.entry.ready"),
	};
}

function normalizeParameters(value: unknown): BrowserWorkflowParameter[] {
	if (!Array.isArray(value)) throw new Error("workflow.parameters must be an array");
	const parameters = value.map((entry, index) => {
		const input = object(entry, `workflow.parameters[${index}]`);
		const name = requiredParameterName(input.name, `workflow.parameters[${index}].name`);
		const type = oneOf(
			input.type,
			["string", "number", "boolean", "url", "choice", "secret-ref"],
			`workflow.parameters[${index}].type`,
		);
		if (typeof input.required !== "boolean" || typeof input.sensitive !== "boolean") {
			throw new Error(`workflow.parameters[${index}] required and sensitive must be booleans`);
		}
		if (type === "secret-ref" && !input.sensitive) throw new Error("secret-ref parameters must be sensitive");
		const choices = input.choices === undefined ? undefined : stringArray(input.choices, "parameter.choices", 100);
		if (type === "choice" && (!choices || choices.length === 0)) throw new Error("choice parameters require choices");
		if (input.default !== undefined && !["string", "number", "boolean"].includes(typeof input.default)) {
			throw new Error("parameter.default must be a string, number, or boolean");
		}
		if (input.sensitive && input.default !== undefined) throw new Error("Sensitive parameters cannot have defaults");
		return {
			name,
			description: requiredString(input.description, `workflow.parameters[${index}].description`, 1_000),
			type,
			required: input.required,
			choices,
			default: input.default as string | number | boolean | undefined,
			sensitive: input.sensitive,
		};
	});
	if (new Set(parameters.map((parameter) => parameter.name)).size !== parameters.length) {
		throw new Error("workflow parameter names must be unique");
	}
	return parameters;
}

function normalizeSteps(value: unknown, parameterNames: Set<string>): BrowserWorkflowStep[] {
	if (!Array.isArray(value)) throw new Error("workflow.steps must be an array");
	const steps = value.map((entry, index): BrowserWorkflowStep => {
		const input = object(entry, `workflow.steps[${index}]`);
		const base: BrowserStepBase = {
			id: requiredIdentifier(input.id, `workflow.steps[${index}].id`),
			preconditions: normalizeAssertions(input.preconditions, `workflow.steps[${index}].preconditions`),
			postconditions: normalizeAssertions(input.postconditions, `workflow.steps[${index}].postconditions`),
			timeoutMs: positiveInteger(input.timeoutMs, `workflow.steps[${index}].timeoutMs`, 120_000),
			evidence: oneOf(input.evidence, ["none", "failure", "before-after"], "step.evidence"),
		};
		const action = oneOf(
			input.action,
			["navigate", "click", "fill", "select", "press", "scroll-to", "wait", "assert"],
			`workflow.steps[${index}].action`,
		);
		switch (action) {
			case "navigate":
				return { ...base, action, urlTemplate: requiredString(input.urlTemplate, "step.urlTemplate", 4_000) };
			case "click":
			case "scroll-to":
				return { ...base, action, target: normalizeTarget(input.target, "step.target") };
			case "fill":
			case "select":
				return {
					...base,
					action,
					target: normalizeTarget(input.target, "step.target"),
					value: normalizeValue(input.value, parameterNames),
				};
			case "press":
				return {
					...base,
					action,
					key: requiredString(input.key, "step.key", 80),
					target: input.target === undefined ? undefined : normalizeTarget(input.target, "step.target"),
				};
			case "wait":
			case "assert":
				return { ...base, action, assertion: normalizeAssertion(input.assertion, "step.assertion") };
		}
		throw new Error(`Unsupported browser workflow action: ${action}`);
	});
	if (new Set(steps.map((step) => step.id)).size !== steps.length) throw new Error("workflow step ids must be unique");
	if (steps.length > 200) throw new Error("workflow.steps exceeds the 200 step limit");
	return steps;
}

function assertUrlTemplate(
	template: string,
	parameterNames: Set<string>,
	sensitiveParameterNames: Set<string>,
	name: string,
): void {
	for (const match of template.matchAll(/\$\{([^}]+)\}/g)) {
		const parameter = match[1];
		if (!parameter || !parameterNames.has(parameter)) throw new Error(`${name} references undeclared parameter`);
		if (sensitiveParameterNames.has(parameter)) throw new Error(`${name} cannot reference a sensitive parameter`);
	}
}

function normalizeCompileIssues(value: unknown): BrowserWorkflowCompileIssue[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 200) throw new Error("workflow.compileIssues must be a bounded array");
	return value.map((entry, index) => {
		const input = object(entry, `workflow.compileIssues[${index}]`);
		return {
			stepId: requiredIdentifier(input.stepId, `workflow.compileIssues[${index}].stepId`),
			code: oneOf(
				input.code,
				["missing-target", "missing-entry", "unsupported-action"],
				`workflow.compileIssues[${index}].code`,
			),
			message: requiredString(input.message, `workflow.compileIssues[${index}].message`, 1_000),
		};
	});
}

function normalizeTarget(value: unknown, name: string): BrowserTarget {
	const input = object(value, name);
	if (!Array.isArray(input.frame)) throw new Error(`${name}.frame must be an array`);
	const frame = input.frame.map((entry, index) => {
		const frameInput = object(entry, `${name}.frame[${index}]`);
		const frameTarget = {
			name: optionalString(frameInput.name, `${name}.frame[${index}].name`, 240),
			urlPattern: optionalString(frameInput.urlPattern, `${name}.frame[${index}].urlPattern`, 1_000),
		};
		if (!frameTarget.name && !frameTarget.urlPattern) throw new Error(`${name}.frame[${index}] needs a name or URL`);
		if (frameTarget.urlPattern) assertRegularExpression(frameTarget.urlPattern, `${name}.frame[${index}].urlPattern`);
		return frameTarget;
	});
	const expectedInput = object(input.expected, `${name}.expected`);
	const expected: BrowserElementExpectation = {
		tag: optionalString(expectedInput.tag, `${name}.expected.tag`, 80),
		role: optionalString(expectedInput.role, `${name}.expected.role`, 80),
		inputType: optionalString(expectedInput.inputType, `${name}.expected.inputType`, 80),
	};
	return { frame, candidates: normalizeCandidates(input.candidates, name), expected };
}

function normalizeCandidates(value: unknown, name: string): BrowserLocatorCandidate[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error(`${name}.candidates must not be empty`);
	if (value.length > 8) throw new Error(`${name}.candidates exceeds the limit of 8`);
	return value.map((entry, index) => {
		const input = object(entry, `${name}.candidates[${index}]`);
		const kind = oneOf(input.kind, ["role", "label", "test-id", "id", "text"], "locator.kind");
		switch (kind) {
			case "role":
				return {
					kind,
					role: requiredString(input.role, "locator.role", 80),
					name: requiredString(input.name, "locator.name", 240),
					exact: requiredBoolean(input.exact, "locator.exact"),
				};
			case "label":
				return {
					kind,
					text: requiredString(input.text, "locator.text", 240),
					exact: requiredBoolean(input.exact, "locator.exact"),
				};
			case "text":
				return {
					kind,
					text: requiredString(input.text, "locator.text", 240),
					exact: requiredBoolean(input.exact, "locator.exact"),
				};
			case "test-id":
			case "id":
				return { kind, value: requiredString(input.value, "locator.value", 240) };
		}
		throw new Error(`Unsupported browser locator kind: ${kind}`);
	});
}

function normalizeValue(value: unknown, parameterNames: Set<string>): BrowserValue {
	const input = object(value, "step.value");
	const kind = oneOf(input.kind, ["parameter", "constant"], "step.value.kind");
	if (kind === "constant") return { kind, value: requiredString(input.value, "step.value.value", 4_000) };
	const name = requiredParameterName(input.name, "step.value.name");
	if (!parameterNames.has(name)) throw new Error(`step value references undeclared parameter ${name}`);
	return { kind, name };
}

function normalizeAssertions(value: unknown, name: string): BrowserAssertion[] {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	if (value.length > 32) throw new Error(`${name} exceeds the limit of 32`);
	return value.map((entry, index) => normalizeAssertion(entry, `${name}[${index}]`));
}

function normalizeAssertion(value: unknown, name: string): BrowserAssertion {
	const input = object(value, name);
	const kind = oneOf(input.kind, ["url", "title", "element", "text", "page-ready", "download"], `${name}.kind`);
	switch (kind) {
		case "url":
		case "title":
			return { kind, pattern: validatedRegularExpression(input.pattern, `${name}.pattern`) };
		case "element":
			return {
				kind,
				state: oneOf(input.state, ["visible", "hidden", "enabled", "disabled"], `${name}.state`),
				target: normalizeTarget(input.target, `${name}.target`),
			};
		case "text":
			return {
				kind,
				text: requiredString(input.text, `${name}.text`, 1_000),
				visible: requiredBoolean(input.visible, `${name}.visible`),
			};
		case "page-ready":
			return { kind };
		case "download":
			return {
				kind,
				namePattern:
					input.namePattern === undefined
						? undefined
						: validatedRegularExpression(input.namePattern, `${name}.namePattern`),
			};
	}
}

function normalizeRequirements(value: unknown): BrowserWorkflowRequirements {
	const input = object(value, "workflow.requirements");
	const viewport = object(input.viewport, "workflow.requirements.viewport");
	return {
		profile: oneOf(input.profile, ["none", "authenticated"], "workflow.requirements.profile"),
		access: oneOf(input.access, ["loopback", "public-web", "private-network"], "workflow.requirements.access"),
		viewport: {
			width: positiveInteger(viewport.width, "workflow.requirements.viewport.width", 4_096),
			height: positiveInteger(viewport.height, "workflow.requirements.viewport.height", 4_096),
			deviceScaleFactor: positiveNumber(
				viewport.deviceScaleFactor,
				"workflow.requirements.viewport.deviceScaleFactor",
				4,
			),
		},
	};
}

function normalizePolicy(value: unknown): BrowserWorkflowPolicy {
	const input = object(value, "workflow.policy");
	return {
		deadlineMs: positiveInteger(input.deadlineMs, "workflow.policy.deadlineMs", 3_600_000),
		approval: oneOf(input.approval, ["inherit", "always"], "workflow.policy.approval"),
	};
}

function normalizeSource(value: unknown): BrowserWorkflowSource {
	const input = object(value, "workflow.source");
	const kind = oneOf(input.kind, ["recording", "manual"], "workflow.source.kind");
	const captureId = optionalString(input.captureId, "workflow.source.captureId", 128);
	if (kind === "recording" && !captureId) throw new Error("Recorded workflows require source.captureId");
	return { kind, captureId };
}

function normalizeValidationEvidence(value: unknown): BrowserWorkflowValidationEvidence {
	const input = object(value, "workflow validation evidence");
	return {
		id: requiredIdentifier(input.id, "validation.id"),
		digest: requiredDigest(input.digest),
		completedAt: requiredTimestamp(input.completedAt, "validation.completedAt"),
	};
}

function executableDigest(
	definition: Pick<
		BrowserWorkflowDefinitionInput,
		"entry" | "parameters" | "steps" | "completion" | "requirements" | "policy"
	>,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				entry: definition.entry,
				parameters: definition.parameters,
				steps: definition.steps,
				completion: definition.completion,
				requirements: definition.requirements,
				policy: definition.policy,
			}),
		)
		.digest("hex");
}

function assertTransition(from: BrowserWorkflowStatus, to: BrowserWorkflowStatus): void {
	const transitions: Record<BrowserWorkflowStatus, readonly BrowserWorkflowStatus[]> = {
		draft: ["needs-input", "compiled", "disabled"],
		"needs-input": ["draft", "compiled", "disabled"],
		compiled: ["draft", "validated", "invalid", "disabled"],
		validated: ["draft", "active", "invalid", "disabled"],
		active: ["superseded", "disabled"],
		superseded: ["disabled"],
		invalid: ["draft", "disabled"],
		disabled: ["draft"],
	};
	if (!transitions[from].includes(to)) throw new Error(`Browser workflow cannot transition from ${from} to ${to}`);
}

function cloneDefinition(definition: BrowserWorkflowDefinition): BrowserWorkflowDefinition {
	return structuredClone(definition);
}

async function writeAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
	await rename(temporary, path);
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function stringArray(value: unknown, name: string, limit: number): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim())) {
		throw new Error(`${name} must be an array of non-empty strings`);
	}
	if (value.length > limit) throw new Error(`${name} exceeds the limit of ${limit}`);
	return value.map((entry) => entry.trim());
}

function requiredString(value: unknown, name: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	const result = value.trim();
	if (result.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
	return result;
}

function optionalString(value: unknown, name: string, maximum: number): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, name, maximum);
}

function requiredIdentifier(value: unknown, name: string): string {
	const id = requiredString(value, name, 64);
	assertIdentifier(id, name);
	return id;
}

function requiredParameterName(value: unknown, name: string): string {
	const result = requiredString(value, name, 80);
	if (!/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(result)) throw new Error(`${name} contains unsupported characters`);
	return result;
}

function assertIdentifier(value: string, name: string): void {
	if (!isIdentifier(value)) throw new Error(`${name} contains unsupported characters`);
}

function isIdentifier(value: string): boolean {
	return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function requiredBoolean(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
	return value;
}

function positiveInteger(value: unknown, name: string, maximum: number): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
		throw new Error(`${name} must be an integer between 1 and ${maximum}`);
	}
	return Number(value);
}

function positiveNumber(value: unknown, name: string, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
		throw new Error(`${name} must be a positive number no greater than ${maximum}`);
	}
	return value;
}

function requiredTimestamp(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} must be a timestamp`);
	return Number(value);
}

function requiredDigest(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("workflow digest is invalid");
	return value;
}

function validatedRegularExpression(value: unknown, name: string): string {
	const pattern = requiredString(value, name, 1_000);
	assertRegularExpression(pattern, name);
	return pattern;
}

function assertRegularExpression(pattern: string, name: string): void {
	try {
		new RegExp(pattern);
	} catch {
		throw new Error(`${name} must be a valid regular expression`);
	}
}

function oneOf<const T extends string>(value: unknown, choices: readonly T[], name: string): T {
	if (typeof value !== "string" || !choices.includes(value as T)) {
		throw new Error(`${name} must be one of: ${choices.join(", ")}`);
	}
	return value as T;
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
	if (!slug) throw new Error("workflow name must contain a letter or number");
	return slug;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
